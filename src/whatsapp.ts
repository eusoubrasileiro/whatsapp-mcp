import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  downloadContentFromMessage,
  toBuffer,
  getUrlFromDirectPath,
  type WAMessage,
  type MediaType,
  isJidGroup,
  jidNormalizedUser,
} from "@whiskeysockets/baileys";
import pRetry from "p-retry";
import P from "pino";
import path from "node:path";
import fs from "node:fs";
import qrcode from "qrcode-terminal";

import {
  storeMessage,
  storeChat,
  storeContact,
  type Message as DbMessage,
} from "./database.ts";

const AUTH_DIR = path.join(import.meta.dirname, "..", "auth_info");
const DATA_DIR = path.join(import.meta.dirname, "..", "data");

export type MediaInfo = {
  media_type: string;
  mimetype: string | null;
  media_key: string | null;  // base64
  direct_path: string | null;
  media_url: string | null;
  file_length: number | null;
  file_sha256: string | null;    // base64
  file_enc_sha256: string | null; // base64
};

function uint8ArrayToBase64(arr: Uint8Array | Buffer | null | undefined): string | null {
  if (!arr) return null;
  return Buffer.from(arr).toString('base64');
}

const mimetypeToExtension: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'audio/ogg': 'ogg',
  'audio/ogg; codecs=opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/zip': 'zip',
  'text/plain': 'txt',
};

export function extractMediaInfo(message: WAMessage['message']): MediaInfo | null {
  if (!message) return null;

  const mediaTypes = [
    { key: 'imageMessage' as const, type: 'image' },
    { key: 'videoMessage' as const, type: 'video' },
    { key: 'audioMessage' as const, type: 'audio' },
    { key: 'documentMessage' as const, type: 'document' },
    { key: 'stickerMessage' as const, type: 'sticker' },
  ];

  for (const { key, type } of mediaTypes) {
    const media = message[key];
    if (!media) continue;

    let mediaType = type;
    // Voice notes (ptt) use 'ptt' mediaType, not 'audio'
    if (key === 'audioMessage' && (media as any).ptt === true) {
      mediaType = 'ptt';
    }

    return {
      media_type: mediaType,
      mimetype: (media as any).mimetype ?? null,
      media_key: uint8ArrayToBase64((media as any).mediaKey),
      direct_path: (media as any).directPath ?? null,
      media_url: (media as any).url ?? null,
      file_length: (media as any).fileLength ? Number((media as any).fileLength) : null,
      file_sha256: uint8ArrayToBase64((media as any).fileSha256),
      file_enc_sha256: uint8ArrayToBase64((media as any).fileEncSha256),
    };
  }

  return null;
}

export type WhatsAppSocket = ReturnType<typeof makeWASocket>;

// Connection state for MCP tool access
export type ConnectionStatus = 'disconnected' | 'qr_pending' | 'connecting' | 'connected';

export const connectionState = {
  status: 'disconnected' as ConnectionStatus,
  qrCode: null as string | null,
  qrAscii: null as string | null,
  user: null as string | null,
};

// Socket state container (updated on reconnect)
export const socketState = {
  socket: null as WhatsAppSocket | null,
};

// Generate ASCII QR code
function generateAsciiQR(data: string): Promise<string> {
  return new Promise((resolve) => {
    qrcode.generate(data, { small: true }, (qr: string) => {
      resolve(qr);
    });
  });
}

export function parseMessageForDb(msg: WAMessage): DbMessage | null {
  if (!msg.message || !msg.key || !msg.key.remoteJid) {
    return null;
  }

  let content: string | null = null;

  if (msg.message.conversation) {
    content = msg.message.conversation;
  } else if (msg.message.extendedTextMessage?.text) {
    content = msg.message.extendedTextMessage.text;
  } else if (msg.message.imageMessage?.caption) {
    content = `[Image] ${msg.message.imageMessage.caption}`;
  } else if (msg.message.videoMessage?.caption) {
    content = `[Video] ${msg.message.videoMessage.caption}`;
  } else if (msg.message.documentMessage?.caption || msg.message.documentMessage?.fileName) {
    content = `[Document] ${
      msg.message.documentMessage.caption ||
      msg.message.documentMessage.fileName ||
      ""
    }`;
  } else if (msg.message.audioMessage) {
    content = `[Audio]`;
  } else if (msg.message.stickerMessage) {
    content = `[Sticker]`;
  } else if (msg.message.locationMessage?.address) {
    content = `[Location] ${msg.message.locationMessage.address}`;
  } else if (msg.message.contactMessage?.displayName) {
    content = `[Contact] ${msg.message.contactMessage.displayName}`;
  } else if (msg.message.pollCreationMessage?.name) {
    content = `[Poll] ${msg.message.pollCreationMessage.name}`;
  }

  if (!content) {
    // Media without captions — still record them
    if (msg.message.imageMessage) content = "[Image]";
    else if (msg.message.videoMessage) content = "[Video]";
    else if (msg.message.documentMessage) content = "[Document]";
    else if (msg.message.audioMessage) content = "[Audio]";
    else return null;
  }

  // Use WhatsApp's original message timestamp (seconds since epoch)
  let timestampSeconds: number;

  if (msg.messageTimestamp != null) {
    timestampSeconds = Number(msg.messageTimestamp);
  } else {
    timestampSeconds = Date.now() / 1000;
  }

  const timestamp = new Date(timestampSeconds * 1000);

  let senderJid: string | null | undefined = msg.key.participant;
  if (!msg.key.fromMe && !senderJid && !isJidGroup(msg.key.remoteJid)) {
    senderJid = msg.key.remoteJid;
  }
  if (msg.key.fromMe && !isJidGroup(msg.key.remoteJid)) {
    senderJid = null;
  }

  const mediaInfo = extractMediaInfo(msg.message);

  return {
    id: msg.key.id!,
    chat_jid: msg.key.remoteJid,
    sender: senderJid ? jidNormalizedUser(senderJid) : null,
    content: content,
    timestamp: timestamp,
    is_from_me: msg.key.fromMe ?? false,
    media_type: mediaInfo?.media_type ?? null,
    mimetype: mediaInfo?.mimetype ?? null,
    media_key: mediaInfo?.media_key ?? null,
    direct_path: mediaInfo?.direct_path ?? null,
    media_url: mediaInfo?.media_url ?? null,
    file_length: mediaInfo?.file_length ?? null,
    file_sha256: mediaInfo?.file_sha256 ?? null,
    file_enc_sha256: mediaInfo?.file_enc_sha256 ?? null,
  };
}

export async function startWhatsAppConnection(
  logger: P.Logger
): Promise<WhatsAppSocket> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  logger.info(`Using WA v${version.join(".")}, isLatest: ${isLatest}`);

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    generateHighQualityLinkPreview: true,
    shouldIgnoreJid: (jid) => isJidGroup(jid),
  });

  // Update shared socket reference for use by MCP tools
  socketState.socket = sock;

  sock.ev.process(async (events) => {
    if (events["connection.update"]) {
      const update = events["connection.update"];
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        connectionState.status = 'qr_pending';
        connectionState.qrCode = qr;
        connectionState.qrAscii = await generateAsciiQR(qr);
        logger.info("QR Code Received. Use get_connection_status tool to retrieve the QR code.");
        console.error("\n" + connectionState.qrAscii);
      }

      if (connection === "connecting") {
        connectionState.status = 'connecting';
        connectionState.qrCode = null;
        connectionState.qrAscii = null;
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        connectionState.status = 'disconnected';
        connectionState.qrCode = null;
        connectionState.qrAscii = null;
        connectionState.user = null;
        socketState.socket = null;
        logger.warn(
          { err: lastDisconnect?.error },
          `Connection closed. Reason: ${
            DisconnectReason[statusCode as number] || "Unknown"
          }`
        );
        if (statusCode !== DisconnectReason.loggedOut) {
          pRetry(() => startWhatsAppConnection(logger), {
            retries: 10,
            minTimeout: 1000,
            maxTimeout: 60000,
            factor: 2,
            onFailedAttempt: (err) => {
              logger.warn(`Reconnect attempt ${err.attemptNumber} failed, ${err.retriesLeft} retries left`);
            },
          }).catch((err) => {
            logger.error({ err }, "All reconnection attempts failed. Exiting.");
            process.exit(1);
          });
        } else {
          logger.error(
            "Connection closed: Logged Out. Please delete auth_info and restart."
          );
          process.exit(1);
        }
      } else if (connection === "open") {
        if (sock.user) {
          connectionState.status = 'connected';
          connectionState.qrCode = null;
          connectionState.qrAscii = null;
          connectionState.user = sock.user.name ?? null;
          logger.info(`Connection opened. WA user: ${sock.user.name}`);

          // Sync group metadata
          try {
            const groups = await sock.groupFetchAllParticipating();
            logger.info(`Syncing ${Object.keys(groups).length} groups...`);
            for (const [jid, metadata] of Object.entries(groups)) {
              storeChat({ jid, name: metadata.subject });
            }
            logger.info("Group metadata synced.");
          } catch (err) {
            logger.warn({ err }, "Failed to sync group metadata");
          }
        } else {
          connectionState.status = 'connecting';
          logger.info("Connection opened but waiting for user info...");
        }
      }
    }

    if (events["creds.update"]) {
      await saveCreds();
      logger.info("Credentials saved.");
    }

    if (events["messaging-history.set"]) {
      const { chats, contacts, messages } =
        events["messaging-history.set"];
      if (contacts.length > 0) {
        logger.info(`Storing ${contacts.length} contacts from history sync.`);
        contacts.forEach((c) =>
          storeContact({
            jid: c.id,
            name: c.name ?? null,
            notify: c.notify ?? null,
            phoneNumber: (c as any).phoneNumber ?? null,
          })
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
        const parsed = parseMessageForDb(msg);
        if (parsed) {
          storeMessage(parsed);
          storedCount++;
        }
      });
      logger.info(`Stored ${storedCount} messages from history sync.`);
    }

    if (events["contacts.upsert"]) {
      const contacts = events["contacts.upsert"];
      logger.info({ count: contacts.length }, "Received contacts.upsert event");
      for (const c of contacts) {
        storeContact({
          jid: c.id,
          name: c.name ?? null,
          notify: c.notify ?? null,
        });
      }
    }

    if (events["contacts.update"]) {
      const contacts = events["contacts.update"];
      logger.info({ count: contacts.length }, "Received contacts.update event");
      for (const c of contacts) {
        if (c.id) {
          storeContact({
            jid: c.id,
            name: c.name ?? null,
            notify: c.notify ?? null,
          });
        }
      }
    }

    if (events["messages.upsert"]) {
      const { messages, type } = events["messages.upsert"];
      logger.info(
        { type, count: messages.length },
        "Received messages.upsert event"
      );

      if (type === "notify" || type === "append") {
        for (const msg of messages) {
          const parsed = parseMessageForDb(msg);
          if (parsed) {
            logger.info(
              {
                msgId: parsed.id,
                chatId: parsed.chat_jid,
                fromMe: parsed.is_from_me,
                sender: parsed.sender,
              },
              `Storing message: ${parsed.content.substring(0, 50)}...`
            );
            storeMessage(parsed);
          } else {
            logger.warn(
              { msgId: msg.key?.id, chatId: msg.key?.remoteJid },
              "Skipped storing message (parsing failed or unsupported type)"
            );
          }
        }
      }
    }

    if (events["chats.update"]) {
      logger.info(
        { count: events["chats.update"].length },
        "Received chats.update event"
      );
      for (const chatUpdate of events["chats.update"]) {
        storeChat({
          jid: chatUpdate.id!,
          name: chatUpdate.name,
          last_message_time: chatUpdate.conversationTimestamp
            ? new Date(Number(chatUpdate.conversationTimestamp) * 1000)
            : undefined,
        });
      }
    }
  });

  return sock;
}

export async function sendWhatsAppMessage(
  logger: P.Logger,
  recipientJid: string,
  text: string
): Promise<WAMessage | void> {
  const sock = socketState.socket;
  if (!sock || !sock.user) {
    logger.error("Cannot send message: WhatsApp socket not connected.");
    return;
  }
  try {
    const normalizedJid = jidNormalizedUser(recipientJid);
    const result = await sock.sendMessage(normalizedJid, { text: text });
    return result;
  } catch (error) {
    logger.error({ err: error, recipientJid }, "Failed to send message");
    return;
  }
}

export async function sendWhatsAppMedia(
  logger: P.Logger,
  recipientJid: string,
  filePath: string,
  caption?: string,
  type: 'image' | 'video' | 'document' | 'audio' = 'image'
): Promise<WAMessage | void> {
  const sock = socketState.socket;
  if (!sock || !sock.user) {
    logger.error("Cannot send media: WhatsApp socket not connected.");
    return;
  }

  if (!fs.existsSync(filePath)) {
    logger.error(`Cannot send media: File not found at ${filePath}`);
    return;
  }

  try {
    const normalizedJid = jidNormalizedUser(recipientJid);
    let messageContent: any = {};

    const fileBuffer = fs.readFileSync(filePath);

    if (type === 'image') messageContent = { image: fileBuffer, caption };
    else if (type === 'video') messageContent = { video: fileBuffer, caption };
    else if (type === 'audio') messageContent = { audio: fileBuffer, mimetype: 'audio/mp4' };
    else if (type === 'document') messageContent = { document: fileBuffer, caption, fileName: path.basename(filePath) };

    const result = await sock.sendMessage(normalizedJid, messageContent);
    return result;
  } catch (error) {
    logger.error({ err: error, recipientJid, filePath }, "Failed to send media");
    return;
  }
}

export async function downloadMedia(
  logger: P.Logger,
  mediaKey: string,       // base64-encoded
  directPath: string,
  mediaUrl: string | null,
  mediaType: string,
  mimetype: string | null,
  chatJid: string,
  messageId: string,
): Promise<string> {
  // Create media directory
  const sanitizedChatJid = chatJid.replace(/[^a-zA-Z0-9@._-]/g, '_');
  const mediaDir = path.join(DATA_DIR, 'media', sanitizedChatJid);
  fs.mkdirSync(mediaDir, { recursive: true });

  // Convert base64 mediaKey back to Uint8Array
  const mediaKeyBuffer = new Uint8Array(Buffer.from(mediaKey, 'base64'));

  // Refresh URL from directPath
  const refreshedUrl = getUrlFromDirectPath(directPath);

  logger.info({ messageId, mediaType, directPath }, "Downloading media");

  const stream = await downloadContentFromMessage(
    { mediaKey: mediaKeyBuffer, directPath, url: refreshedUrl || mediaUrl || undefined },
    mediaType as MediaType,
  );
  const buffer = await toBuffer(stream);

  // Determine file extension
  const ext = (mimetype && mimetypeToExtension[mimetype]) || 'bin';
  const fileName = `${messageId}.${ext}`;
  const filePath = path.join(mediaDir, fileName);

  fs.writeFileSync(filePath, buffer);
  logger.info({ filePath, size: buffer.length }, "Media downloaded successfully");

  return filePath;
}
