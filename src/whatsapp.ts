import fs from "node:fs";
import path from "node:path";
import {
  type BaileysClientConfig,
  downloadMedia as baileysDownloadMedia,
  type ConnectionState,
  type DownloadMediaParams,
  type MediaType,
  makeLidResolver,
  mimetypeToExtension,
  normalizeJid,
  type ParsedMessage,
  parseMessage,
  type SocketState,
  sendMediaMessage,
  sendTextMessage,
  startConnection,
} from "@amiticia/baileys-client";
import pLimit from "p-limit";
import type P from "pino";
import { logAckErrors } from "./ack-errors.ts";
import { createConnectionNotifier } from "./connection-notifier.ts";
import {
  getMetaValue,
  listPnChatJids,
  recordJidMapping,
  recordJidPair,
  setMetaValue,
  storeChat,
  storeContact,
  storeMessage,
} from "./database.ts";
import { emitInbound } from "./inbound-bus.ts";
import { assertMimeForType, resolveMediaInput } from "./media-input.ts";
import { createNtfy, type NtfyConfig } from "./ntfy.ts";
import { toFlacMono16k } from "./transcribe/preprocess.ts";
import { transcribeAudio } from "./transcribe/whisper.ts";
import { dispatchInbound } from "./webhooks/delivery.ts";
import { markSentByUs } from "./webhooks/sent-tracker.ts";

/**
 * Base directory for auth_info.
 * If WHATSAPP_MCP_DATA_DIR is set (Docker), resolves paths under it.
 * Otherwise falls back to repo-root/auth_info for local dev.
 */
const BASE_DIR = process.env.WHATSAPP_MCP_DATA_DIR ?? path.join(import.meta.dirname, "..");
const AUTH_DIR = path.join(BASE_DIR, "auth_info");

// Connection state for MCP tool access (reassigned after startConnection returns)
export let connectionState: ConnectionState = {
  status: "disconnected",
  qrCode: null,
  qrAscii: null,
  user: null,
  syncProgress: { chats: 0, contacts: 0, messages: 0, lastBatchAt: null },
};

export let socketState: SocketState = {
  socket: null,
};

/** Live accessor for consumers (e.g. qr-server) that need to read the current state at call time. */
export function getConnectionState(): ConnectionState {
  return connectionState;
}

/**
 * Logout and re-pair: unlinks the device so WhatsApp issues a new device ID
 * on the next QR scan, which triggers a full fresh history sync.
 * The connection-handler detects the `loggedOut` status code, wipes auth_info,
 * and reconnects — producing a new QR code.
 */
export async function triggerRepair(logger: P.Logger): Promise<void> {
  const sock = socketState.socket;
  if (!sock) {
    logger.warn("triggerRepair: no active socket");
    return;
  }
  logger.info("triggerRepair: logging out to force re-pair with fresh history sync");
  await sock.logout();
}

/**
 * Feed a parsed message's LID/phone-number twin identifiers into the alias
 * table so the chat resolves to a single canonical identity. Runs before
 * `storeMessage`, which then writes under the canonical JID.
 */
function reconcileMessageJids(parsed: ParsedMessage): void {
  recordJidPair(parsed.chat_jid, parsed.chat_jid_alt);
  recordJidPair(parsed.sender, parsed.sender_alt);
}

const LID_BACKLOG_MERGED_KEY = "lid_backlog_merged";

/**
 * One-time pass that merges chats fragmented *before* LID-awareness shipped.
 * For every chat still stored under a phone-number JID, ask WhatsApp's LID
 * store for the contact's LID (the protocol-reliable PN→LID direction) and,
 * when found, record the mapping — which physically merges the pair into the
 * canonical identity. Gated by a `schema_meta` sentinel so it runs once.
 */
async function reconcileLidBacklog(logger: P.Logger): Promise<void> {
  if (getMetaValue(LID_BACKLOG_MERGED_KEY) === "1") return;
  const sock = socketState.socket;
  if (!sock) return;

  const resolver = makeLidResolver(sock);
  const pnJids = listPnChatJids();
  logger.info(`LID backlog: resolving ${pnJids.length} phone-number chats…`);

  let merged = 0;
  for (const pnJid of pnJids) {
    try {
      const lid = await resolver.getLIDForPN(pnJid);
      if (lid) {
        recordJidMapping(pnJid, normalizeJid(lid));
        merged++;
      }
    } catch (err) {
      logger.warn({ err, pnJid }, "LID backlog: failed to resolve a chat");
    }
  }

  setMetaValue(LID_BACKLOG_MERGED_KEY, "1");
  logger.info(`LID backlog: merged ${merged} fragmented chat(s) into their LID twin.`);
}

// Prevents concurrent startWhatsAppConnection() calls from racing
let connectionPromise: Promise<void> | null = null;

// Limits parallel media downloads to prevent overwhelming the WhatsApp socket
const downloadLimit = pLimit(2);

export async function startWhatsAppConnection(logger: P.Logger): Promise<void> {
  if (connectionPromise) {
    logger.info("Connection attempt already in progress, waiting for it...");
    return connectionPromise;
  }

  const ACTIVE_STATUSES = new Set(["connected", "syncing", "connecting", "qr_pending"]);
  if (ACTIVE_STATUSES.has(connectionState.status) || socketState.socket !== null) {
    logger.info(`Skipping startWhatsAppConnection: already ${connectionState.status}`);
    return;
  }

  connectionPromise = doStartConnection(logger);
  try {
    await connectionPromise;
  } finally {
    connectionPromise = null;
  }
}

async function doStartConnection(logger: P.Logger): Promise<void> {
  const ntfyConfig: NtfyConfig | null = process.env.NTFY_TOPIC_URL
    ? {
        topicUrl: process.env.NTFY_TOPIC_URL,
        token: process.env.NTFY_TOKEN,
      }
    : null;
  const sendNtfy = createNtfy(logger, ntfyConfig);

  // Webhook push: transcribe an inbound voice note on demand for subscribers
  // that opted in. Delegates to the shared, exported helper (also used by the
  // follow_chat stream); bound to this connection's logger.
  const transcribeInbound = (msg: ParsedMessage): Promise<string | null> =>
    transcribeMediaMessage(msg, logger);

  const notifier = createConnectionNotifier(logger, {
    sendNtfy,
    publicQrUrl: process.env.PUBLIC_QR_URL ?? "https://wa.amiticia.cc/",
    expectedWaNumber: process.env.EXPECTED_WA_NUMBER ?? null,
    onBadPairing: async () => {
      const sock = socketState.socket;
      if (sock) {
        try {
          await sock.logout();
        } catch (err) {
          logger.warn({ err }, "socket.logout() during bad-pairing cleanup failed");
        }
      }
      try {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        fs.mkdirSync(AUTH_DIR, { recursive: true });
      } catch (err) {
        logger.error({ err, AUTH_DIR }, "failed to purge auth_info during bad-pairing cleanup");
      }
    },
  });

  const config: BaileysClientConfig = {
    authDir: AUTH_DIR,
    logger,
    hooks: {
      onQrCode: notifier.onQrCode,
      onConnecting: notifier.onConnecting,
      onConnected: notifier.onConnected,
      onDisconnected: notifier.onDisconnected,

      onGroupsSync: async (groups) => {
        logger.info(`Syncing ${Object.keys(groups).length} groups...`);
        for (const [jid, metadata] of Object.entries(groups)) {
          storeChat({ jid, name: metadata.subject });
        }
        logger.info("Group metadata synced.");
      },

      onHistorySync: async ({ chats, contacts, messages, isLatest }) => {
        if (contacts.length > 0) {
          logger.info(`Storing ${contacts.length} contacts from history sync.`);
          contacts.forEach((c) =>
            storeContact({
              jid: c.id,
              name: c.name ?? null,
              notify: c.notify ?? null,
              phoneNumber: (c as any).phoneNumber ?? null,
            }),
          );
        }

        logger.info(`Storing ${chats.length} chats from history sync.`);
        chats.forEach((chat) => {
          if (!chat.id) return;
          storeChat({
            jid: chat.id,
            name: chat.name,
            last_message_time: chat.conversationTimestamp
              ? new Date(Number(chat.conversationTimestamp) * 1000)
              : undefined,
          });
        });

        let storedCount = 0;
        messages.forEach((msg) => {
          const parsed = parseMessage(msg);
          if (parsed) {
            reconcileMessageJids(parsed);
            storeMessage(parsed);
            storedCount++;
          }
        });
        logger.info(`Stored ${storedCount} messages from history sync.`);
      },

      onContactsUpsert: async (contacts) => {
        for (const c of contacts) {
          storeContact({
            jid: c.id,
            name: c.name ?? null,
            notify: c.notify ?? null,
          });
        }
      },

      onContactsUpdate: async (contacts) => {
        for (const c of contacts) {
          if (c.id) {
            storeContact({
              jid: c.id,
              name: c.name ?? null,
              notify: c.notify ?? null,
            });
          }
        }
      },

      // A send WhatsApp refuses is reported asynchronously, after
      // socket.sendMessage() already resolved — so send_message would otherwise
      // report success for a message that never landed. Surface it in the logs.
      onMessagesUpdate: async (updates) => {
        logAckErrors(updates, logger);
      },

      onMessageUpsert: async (messages, type) => {
        for (const msg of messages) {
          const parsed = parseMessage(msg);
          if (parsed) {
            reconcileMessageJids(parsed);
            logger.info(
              {
                msgId: parsed.id,
                chatId: parsed.chat_jid,
                fromMe: parsed.is_from_me,
                sender: parsed.sender,
              },
              `Storing message: ${parsed.content.substring(0, 50)}...`,
            );
            storeMessage(parsed);
            // Outbound webhook push: live messages only (notify), not history
            // backfill (append). Direction is decided per-subscription inside
            // dispatchInbound (include_from_me) and our own agent replies are
            // suppressed there via the sent-tracker loop guard. Fire-and-forget —
            // dispatchInbound swallows all errors so a down subscriber can't stall
            // ingest or drop the socket.
            if (type === "notify") {
              // Wake any long-poll waiters (wait_for_messages). Emitted AFTER
              // storeMessage so a woken waiter re-querying the DB always sees the
              // row. Minimal payload; the waiter's predicate filters and the DB
              // delta is the source of truth.
              emitInbound({
                id: parsed.id,
                chat_jid: parsed.chat_jid,
                is_from_me: parsed.is_from_me,
              });
              // The account's own JIDs — phone-number (sock.user.id) and LID
              // (sock.user.lid), device suffix stripped — let dispatch detect the
              // self-chat and match it whether you allow-listed your number or LID.
              // NOT connectionState.user, which is the display name ("Alice").
              const u = socketState.socket?.user as { id?: string; lid?: string } | undefined;
              const ownJids = [u?.id, u?.lid]
                .filter((j): j is string => Boolean(j))
                .map(normalizeJid);
              void dispatchInbound(parsed, { logger, transcribe: transcribeInbound, ownJids });
            }
          } else {
            logger.warn(
              { msgId: msg.key?.id, chatId: msg.key?.remoteJid },
              "Skipped storing message (parsing failed or unsupported type)",
            );
          }
        }
      },

      onLidMapping: async ({ lid, pn }) => {
        logger.info({ lid, pn }, "Recording LID↔phone-number mapping");
        recordJidMapping(pn, lid);
      },

      onReady: async () => {
        // History sync is complete and the LID store is populated — safe to
        // run the one-time backlog merge.
        await reconcileLidBacklog(logger);
      },

      onChatsUpdate: async (chats) => {
        for (const chatUpdate of chats) {
          storeChat({
            jid: chatUpdate.id!,
            name: chatUpdate.name,
            last_message_time: chatUpdate.conversationTimestamp
              ? new Date(Number(chatUpdate.conversationTimestamp) * 1000)
              : undefined,
          });
        }
      },
    },
  };

  const result = await startConnection(config);

  // Reassign module-level state so mcp.ts sees the live objects
  connectionState = result.connectionState;
  socketState = result.socketState;
}

export async function sendWhatsAppMessage(
  logger: P.Logger,
  recipientJid: string,
  text: string,
): Promise<{ key: { id: string } } | void> {
  const sock = socketState.socket;
  if (!sock) {
    logger.error("Cannot send message: WhatsApp socket not connected.");
    return;
  }
  const result = await sendTextMessage(sock, recipientJid, text, logger);
  if (result.success && result.messageId) {
    // Loop guard: remember our own sends so the webhook never forwards an agent
    // reply back to the agent when a self-chat subscription has include_from_me.
    markSentByUs(result.messageId);
    return { key: { id: result.messageId } };
  }
  return;
}

export async function sendWhatsAppMedia(
  logger: P.Logger,
  recipientJid: string,
  filePathOrUrl: string,
  caption?: string,
  type: "image" | "video" | "document" | "audio" = "image",
): Promise<{ key: { id: string } } | void> {
  const sock = socketState.socket;
  if (!sock) {
    logger.error("Cannot send media: WhatsApp socket not connected.");
    return;
  }

  const { buffer, fileName, mimetype } = await resolveMediaInput(filePathOrUrl);
  assertMimeForType(type, mimetype);

  const result = await sendMediaMessage(
    sock,
    recipientJid,
    {
      buffer,
      type,
      caption,
      fileName: type === "document" ? fileName : undefined,
      mimetype,
    },
    logger,
  );

  if (result.success && result.messageId) {
    markSentByUs(result.messageId); // loop guard — see sendWhatsAppMessage
    return { key: { id: result.messageId } };
  }
  return;
}

/** Minimal media fields needed to fetch + transcribe a voice note. Satisfied by
 * both baileys `ParsedMessage` and a DB `Message` row (same snake_case shape). */
export interface TranscribableMessage {
  id: string;
  chat_jid: string;
  media_key?: string | null;
  direct_path?: string | null;
  media_url?: string | null;
  media_type?: string | null;
  mimetype?: string | null;
  is_from_me: boolean;
}

/**
 * Download an inbound voice note and return its Whisper transcript, or `null`
 * when the message has no downloadable audio or transcription fails. Composes
 * the existing download → ffmpeg → Whisper path. Never throws — a transcription
 * failure must not break webhook delivery or the follow_chat stream.
 */
export async function transcribeMediaMessage(
  msg: TranscribableMessage,
  logger: P.Logger,
): Promise<string | null> {
  if (!msg.media_key || !msg.direct_path || !msg.media_type) return null;
  try {
    const { buffer } = await downloadMedia({
      logger,
      mediaKey: msg.media_key,
      directPath: msg.direct_path,
      mediaUrl: msg.media_url ?? null,
      mediaType: msg.media_type as MediaType,
      mimetype: msg.mimetype ?? null,
      chatJid: msg.chat_jid,
      messageId: msg.id,
      fromMe: msg.is_from_me,
    });
    const flac = await toFlacMono16k(buffer);
    const { text } = await transcribeAudio({ buffer: flac, filename: `${msg.id}.flac`, logger });
    return text;
  } catch (err) {
    logger.warn({ err, msgId: msg.id }, "media transcription failed");
    return null;
  }
}

type DownloadMediaWrapperParams = {
  logger: P.Logger;
  mediaKey: string;
  directPath: string;
  mediaUrl: string | null;
  mediaType: MediaType;
  mimetype: string | null;
  chatJid: string;
  messageId: string;
  fromMe: boolean;
};

export async function downloadMedia(
  params: DownloadMediaWrapperParams,
): Promise<{ buffer: Buffer; mimetype: string; ext: string }> {
  const {
    logger,
    mediaKey,
    directPath,
    mediaUrl,
    mediaType,
    mimetype,
    chatJid,
    messageId,
    fromMe,
  } = params;

  return downloadLimit(async () => {
    const sock = socketState.socket;
    if (!sock) {
      throw new Error("Cannot download media: WhatsApp socket not connected.");
    }

    logger.info({ messageId, mediaType, directPath }, "Downloading media");

    const downloadParams: DownloadMediaParams = {
      mediaKey,
      directPath,
      mediaUrl,
      mediaType,
      messageId,
      chatJid,
      fromMe,
    };

    const buffer = await baileysDownloadMedia(sock, downloadParams, logger);
    const resolvedMimetype = mimetype ?? "application/octet-stream";
    const ext = (mimetype && mimetypeToExtension[mimetype]) || "bin";

    logger.info({ messageId, size: buffer.length, ext }, "Media downloaded successfully");

    return { buffer, mimetype: resolvedMimetype, ext };
  });
}
