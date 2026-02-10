import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  type WAMessage,
  isJidGroup,
  jidNormalizedUser,
  downloadMediaMessage,
} from "@whiskeysockets/baileys";
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
const DOWNLOAD_DIR = path.join(import.meta.dirname, "..", "downloads");

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

// Reconnection backoff state
const reconnectState = {
  attempts: 0,
  maxAttempts: 10,
  baseDelayMs: 1000,
  maxDelayMs: 60000,
};

function getReconnectDelay(): number {
  const delay = Math.min(
    reconnectState.baseDelayMs * Math.pow(2, reconnectState.attempts),
    reconnectState.maxDelayMs
  );
  return delay;
}

function resetReconnectState(): void {
  reconnectState.attempts = 0;
}

// Generate ASCII QR code
function generateAsciiQR(data: string): Promise<string> {
  return new Promise((resolve) => {
    qrcode.generate(data, { small: true }, (qr: string) => {
      resolve(qr);
    });
  });
}

function parseMessageForDb(msg: WAMessage): DbMessage | null {
  if (!msg.message || !msg.key || !msg.key.remoteJid) {
    return null;
  }

  let content: string | null = null;
  const messageType = Object.keys(msg.message)[0];

  if (msg.message.conversation) {
    content = msg.message.conversation;
  } else if (msg.message.extendedTextMessage?.text) {
    content = msg.message.extendedTextMessage.text;
  } else if (msg.message.imageMessage?.caption) {
    content = `[Image] ${msg.message.imageMessage.caption || ""}`;
  } else if (msg.message.videoMessage?.caption) {
    content = `[Video] ${msg.message.videoMessage.caption || ""}`;
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
    // Media messages might not have captions but we still want to record them
    if (msg.message.imageMessage) content = "[Image]";
    else if (msg.message.videoMessage) content = "[Video]";
    else if (msg.message.documentMessage) content = "[Document]";
    else if (msg.message.audioMessage) content = "[Audio]";
    else return null;
  }

  // Use WhatsApp's original message timestamp (seconds since epoch)
  let timestampSeconds: number;

  if (msg.messageTimestamp != null) {
    // Handles number, bigint, and Long-like objects
    timestampSeconds = Number(msg.messageTimestamp);
  } else {
    // Fallback only if WA didn't give us a timestamp at all
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

  return {
    id: msg.key.id!,
    chat_jid: msg.key.remoteJid,
    sender: senderJid ? jidNormalizedUser(senderJid) : null,
    content: content,
    timestamp: timestamp,
    is_from_me: msg.key.fromMe ?? false,
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
        // Also print to stderr so it shows in terminal
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
          reconnectState.attempts++;
          if (reconnectState.attempts > reconnectState.maxAttempts) {
            logger.error(
              `Max reconnection attempts (${reconnectState.maxAttempts}) exceeded. Giving up.`
            );
            process.exit(1);
          }
          const delay = getReconnectDelay();
          logger.info(
            `Reconnecting in ${delay}ms (attempt ${reconnectState.attempts}/${reconnectState.maxAttempts})...`
          );
          setTimeout(() => startWhatsAppConnection(logger), delay);
        } else {
          logger.error(
            "Connection closed: Logged Out. Please delete auth_info and restart."
          );
          process.exit(1);
        }
      } else if (connection === "open") {
        // Only mark as connected when sock.user is available
        if (sock.user) {
          connectionState.status = 'connected';
          connectionState.qrCode = null;
          connectionState.qrAscii = null;
          connectionState.user = sock.user.name ?? null;
          resetReconnectState(); // Reset backoff on successful connection
          logger.info(`Connection opened. WA user: ${sock.user.name}`);
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
      const { chats, contacts, messages, isLatest, progress, syncType } =
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
        logger.info(`Stored ${contacts.length} contacts from history sync.`);
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

export async function downloadWhatsAppMedia(
  logger: P.Logger,
  messageId: string,
  chatJid: string
): Promise<string | void> {
  const sock = socketState.socket;
  if (!sock) {
    logger.error("Cannot download media: WhatsApp socket not connected.");
    return;
  }

  try {
    // We need the full WAMessage object to download.
    // Baileys doesn't have a getMessageById, so we might need to rely on what's in our DB or wait for it.
    // However, we can construct a partial WAMessage if we have the media keys.
    // For simplicity, this tool might be limited to recently received messages in memory if not careful.

    // Better approach: In a real world, we'd fetch from DB but DB doesn't store the media keys.
    // Baileys typically needs the original message object from its internal store or from the event.

    // For now, let's assume we can only download if the message is "fresh" or we have a way to fetch it.
    // Actually, many MCP servers for WhatsApp just don't support downloading old media easily without a full store.

    // BUT, we can try to fetch it from WhatsApp if Baileys supports it.
    // Baileys doesn't have a direct "fetch message by id" from server yet.

    logger.warn("Download media requested but fetching old messages from server is not fully supported in this version of Baileys without a store.");
    return;
  } catch (error) {
    logger.error({ err: error, messageId }, "Failed to download media");
    return;
  }
}
