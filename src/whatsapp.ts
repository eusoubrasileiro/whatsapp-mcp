import {
  startConnection,
  parseMessage,
  sendTextMessage,
  sendMediaMessage,
  downloadMedia as baileysDownloadMedia,
  mimetypeToExtension,
  type ConnectionState,
  type SocketState,
  type BaileysClientConfig,
  type DownloadMediaParams,
  type MediaType,
} from "@amiticia/baileys-client";
import pLimit from "p-limit";
import type P from "pino";
import path from "node:path";
import fs from "node:fs";

import {
  storeMessage,
  storeChat,
  storeContact,
} from "./database.ts";
import { createNtfy, type NtfyConfig } from "./ntfy.ts";
import { createConnectionNotifier } from "./connection-notifier.ts";

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

// Prevents concurrent startWhatsAppConnection() calls from racing
let connectionPromise: Promise<void> | null = null;

// Limits parallel media downloads to prevent overwhelming the WhatsApp socket
const downloadLimit = pLimit(2);

export async function startWhatsAppConnection(
  logger: P.Logger,
): Promise<void> {
  if (connectionPromise) {
    logger.info("Connection attempt already in progress, waiting for it...");
    return connectionPromise;
  }

  if (connectionState.status === "connected" || connectionState.status === "syncing" || connectionState.status === "connecting" || connectionState.status === "qr_pending" || socketState.socket !== null) {
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

      onMessageUpsert: async (messages, type) => {
        for (const msg of messages) {
          const parsed = parseMessage(msg);
          if (parsed) {
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
          } else {
            logger.warn(
              { msgId: msg.key?.id, chatId: msg.key?.remoteJid },
              "Skipped storing message (parsing failed or unsupported type)",
            );
          }
        }
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
    return { key: { id: result.messageId } };
  }
  return;
}

export async function sendWhatsAppMedia(
  logger: P.Logger,
  recipientJid: string,
  filePath: string,
  caption?: string,
  type: "image" | "video" | "document" | "audio" = "image",
): Promise<{ key: { id: string } } | void> {
  const sock = socketState.socket;
  if (!sock) {
    logger.error("Cannot send media: WhatsApp socket not connected.");
    return;
  }

  if (!fs.existsSync(filePath)) {
    logger.error(`Cannot send media: File not found at ${filePath}`);
    return;
  }

  const fileBuffer = fs.readFileSync(filePath);
  const result = await sendMediaMessage(
    sock,
    recipientJid,
    {
      buffer: Buffer.from(fileBuffer),
      type,
      caption,
      fileName: type === "document" ? path.basename(filePath) : undefined,
    },
    logger,
  );

  if (result.success && result.messageId) {
    return { key: { id: result.messageId } };
  }
  return;
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

export async function downloadMedia(params: DownloadMediaWrapperParams): Promise<{ buffer: Buffer; mimetype: string; ext: string }> {
  const { logger, mediaKey, directPath, mediaUrl, mediaType, mimetype, chatJid, messageId, fromMe } = params;

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
