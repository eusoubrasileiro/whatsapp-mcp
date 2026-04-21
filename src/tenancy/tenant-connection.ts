import {
  startConnection,
  parseMessage,
  type ConnectionState,
  type SocketState,
  type BaileysClientConfig,
} from "@amiticia/baileys-client";
import type P from "pino";
import path from "node:path";
import fs from "node:fs";

import {
  storeMessage,
  storeChat,
  storeContact,
  type Message as DbMessage,
} from "../db/queries.ts";
import { createNtfy, type NtfyConfig } from "../ntfy.ts";
import { createConnectionNotifier } from "../connection-notifier.ts";

export type TenantRow = {
  id: string;
  displayName: string;
  expectedWaNumber: string;
  ntfyTopicUrl: string | null;
  writeToolsEnabled: boolean;
  allowedWriteTools: string[];
  conversionKeywords: string[];
  status: string;
  lastSeenAt: Date | null;
  createdAt: Date;
};

type ParsedMessage = {
  id: string;
  chat_jid: string;
  sender: string | null;
  content: string;
  timestamp: Date;
  is_from_me: boolean;
  media_type: string | null;
  mimetype: string | null;
  media_key: string | null;
  direct_path: string | null;
  media_url: string | null;
  file_length: number | null;
  file_sha256: string | null;
  file_enc_sha256: string | null;
};

function parsedToDbMessage(parsed: ParsedMessage): DbMessage {
  return {
    id: parsed.id,
    chat_jid: parsed.chat_jid,
    sender: parsed.sender,
    content: parsed.content,
    timestamp: parsed.timestamp,
    is_from_me: parsed.is_from_me,
    media_type: parsed.media_type,
    mimetype: parsed.mimetype,
    media_key: parsed.media_key,
    direct_path: parsed.direct_path,
    media_url: parsed.media_url,
    file_length: parsed.file_length,
    file_sha256: parsed.file_sha256,
    file_enc_sha256: parsed.file_enc_sha256,
  };
}

export class TenantConnection {
  readonly tenantId: string;
  readonly displayName: string;
  readonly expectedWaNumber: string;
  readonly authDir: string;

  private _connectionState: ConnectionState = {
    status: "disconnected",
    qrCode: null,
    qrAscii: null,
    user: null,
    syncProgress: { chats: 0, contacts: 0, messages: 0, lastBatchAt: null },
  };

  private _socketState: SocketState = { socket: null };
  private _connectionPromise: Promise<void> | null = null;
  private _logger: P.Logger;
  private _tenant: TenantRow;

  constructor(tenant: TenantRow, baseDir: string, logger: P.Logger) {
    this._tenant = tenant;
    this.tenantId = tenant.id;
    this.displayName = tenant.displayName;
    this.expectedWaNumber = tenant.expectedWaNumber;
    this.authDir = path.join(baseDir, "auth_info", tenant.id);
    this._logger = logger.child({ tenantId: tenant.id });

    fs.mkdirSync(this.authDir, { recursive: true });
  }

  get connectionState(): ConnectionState {
    return this._connectionState;
  }

  get socket() {
    return this._socketState.socket;
  }

  getStatus(): { status: string; user: string | null; hasQr: boolean; displayName: string; lastSeenAt: Date | null } {
    return {
      status: this._connectionState.status,
      user: this._connectionState.user,
      hasQr: this._connectionState.status === "qr_pending" && !!this._connectionState.qrCode,
      displayName: this.displayName,
      lastSeenAt: this._tenant.lastSeenAt,
    };
  }

  async start(): Promise<void> {
    if (this._connectionPromise) {
      this._logger.info("Connection attempt already in progress, waiting...");
      return this._connectionPromise;
    }

    const s = this._connectionState.status;
    if (s === "connected" || s === "syncing" || s === "connecting" || s === "qr_pending" || this._socketState.socket !== null) {
      this._logger.info(`Skipping start: already ${s}`);
      return;
    }

    this._connectionPromise = this._doStart();
    try {
      await this._connectionPromise;
    } finally {
      this._connectionPromise = null;
    }
  }

  stop(): void {
    const sock = this._socketState.socket;
    if (sock && typeof sock.end === "function") {
      try {
        sock.end(undefined);
      } catch {
        // ignore
      }
    }
    this._socketState = { socket: null };
    this._connectionState = {
      status: "disconnected",
      qrCode: null,
      qrAscii: null,
      user: null,
      syncProgress: { chats: 0, contacts: 0, messages: 0, lastBatchAt: null },
    };
    this._connectionPromise = null;
  }

  async getQrPng(): Promise<Buffer | null> {
    if (this._connectionState.status !== "qr_pending" || !this._connectionState.qrCode) {
      return null;
    }
    const QRCode = await import("qrcode");
    return QRCode.default.toBuffer(this._connectionState.qrCode, {
      errorCorrectionLevel: "M",
      width: 512,
      margin: 2,
    });
  }

  private async _doStart(): Promise<void> {
    const tenantId = this.tenantId;
    const logger = this._logger;

    const ntfyConfig: NtfyConfig | null = (this._tenant.ntfyTopicUrl ?? process.env.NTFY_TOPIC_URL)
      ? {
          topicUrl: (this._tenant.ntfyTopicUrl ?? process.env.NTFY_TOPIC_URL)!,
          token: process.env.NTFY_TOKEN,
        }
      : null;
    const sendNtfy = createNtfy(logger, ntfyConfig);

    const notifier = createConnectionNotifier(logger, {
      sendNtfy,
      publicQrUrl: process.env.PUBLIC_QR_URL ?? "https://wa.amiticia.cc/",
      expectedWaNumber: this.expectedWaNumber || null,
      onBadPairing: async () => {
        const sock = this._socketState.socket;
        if (sock) {
          try {
            await sock.logout();
          } catch (err) {
            logger.warn({ err }, "socket.logout() during bad-pairing cleanup failed");
          }
        }
        try {
          fs.rmSync(this.authDir, { recursive: true, force: true });
          fs.mkdirSync(this.authDir, { recursive: true });
        } catch (err) {
          logger.error({ err, authDir: this.authDir }, "failed to purge auth_info during bad-pairing cleanup");
        }
      },
    });

    const config: BaileysClientConfig = {
      authDir: this.authDir,
      logger,
      hooks: {
        onQrCode: notifier.onQrCode,
        onConnecting: notifier.onConnecting,
        onConnected: notifier.onConnected,
        onDisconnected: notifier.onDisconnected,

        onGroupsSync: async (groups) => {
          logger.info(`Syncing ${Object.keys(groups).length} groups...`);
          for (const [jid, metadata] of Object.entries(groups)) {
            await storeChat(tenantId, { jid, name: metadata.subject });
          }
          logger.info("Group metadata synced.");
        },

        onHistorySync: async ({ chats, contacts, messages }) => {
          if (contacts.length > 0) {
            logger.info(`Storing ${contacts.length} contacts from history sync.`);
            for (const c of contacts) {
              await storeContact(tenantId, {
                jid: c.id,
                name: c.name ?? null,
                notify: c.notify ?? null,
                phoneNumber: (c as any).phoneNumber ?? null,
              });
            }
          }

          logger.info(`Storing ${chats.length} chats from history sync.`);
          for (const chat of chats) {
            if (!chat.id) continue;
            await storeChat(tenantId, {
              jid: chat.id,
              name: chat.name,
              last_message_time: chat.conversationTimestamp
                ? new Date(Number(chat.conversationTimestamp) * 1000)
                : undefined,
            });
          }

          let storedCount = 0;
          for (const msg of messages) {
            const parsed = parseMessage(msg);
            if (parsed) {
              await storeMessage(tenantId, parsedToDbMessage(parsed));
              storedCount++;
            }
          }
          logger.info(`Stored ${storedCount} messages from history sync.`);
        },

        onContactsUpsert: async (contacts) => {
          for (const c of contacts) {
            await storeContact(tenantId, {
              jid: c.id,
              name: c.name ?? null,
              notify: c.notify ?? null,
            });
          }
        },

        onContactsUpdate: async (contacts) => {
          for (const c of contacts) {
            if (c.id) {
              await storeContact(tenantId, {
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
                { msgId: parsed.id, chatId: parsed.chat_jid, fromMe: parsed.is_from_me },
                `Storing message: ${parsed.content.substring(0, 50)}...`,
              );
              await storeMessage(tenantId, parsedToDbMessage(parsed));
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
            await storeChat(tenantId, {
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
    this._connectionState = result.connectionState;
    this._socketState = result.socketState;
  }
}
