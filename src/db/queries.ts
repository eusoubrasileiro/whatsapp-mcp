/**
 * Tenant-aware query functions built on PrismaClient.
 *
 * Every function takes an explicit `tenantId` (no process.env.TENANT_ID
 * fallback). Signatures mirror the old SQLite-based helpers in
 * database.ts so migration in mcp.ts / whatsapp.ts is mechanical.
 *
 * Raw SQL is used only for search_messages (unaccent/ILIKE via pg_trgm
 * index). Every other function is pure Prisma.
 */

import type { Prisma } from "@prisma/client";
import type { Logger } from "pino";
import { getPrisma } from "./client.ts";

let queryLogger: Logger | null = null;
export function setQueriesLogger(logger: Logger): void {
  queryLogger = logger;
}

function logError(message: string, err: unknown): void {
  if (queryLogger) queryLogger.error({ err }, message);
  else console.error(message, err);
}

// ── Domain types (mirror the old DbMessage / DbChat shapes) ─────────

export interface Chat {
  jid: string;
  name?: string | null;
  last_message_time?: Date | null;
  last_message?: string | null;
  last_sender?: string | null;
  last_is_from_me?: boolean | null;
}

export type Message = {
  id: string;
  chat_jid: string;
  sender?: string | null;
  content: string;
  timestamp: Date;
  is_from_me: boolean;
  chat_name?: string | null;
  media_type?: string | null;
  mimetype?: string | null;
  media_key?: string | null;
  direct_path?: string | null;
  media_url?: string | null;
  file_length?: number | null;
  file_sha256?: string | null;
  file_enc_sha256?: string | null;
  media_object_key?: string | null;
};

// ── Row mappers ────────────────────────────────────────────────────

type PrismaMessageRow = {
  id: string;
  chatJid: string;
  sender: string | null;
  content: string | null;
  timestamp: Date;
  isFromMe: boolean;
  mediaType: string | null;
  mimetype: string | null;
  mediaKey: string | null;
  directPath: string | null;
  mediaUrl: string | null;
  fileLength: number | null;
  fileSha256: string | null;
  fileEncSha256: string | null;
  mediaObjectKey: string | null;
};

type PrismaMessageRowWithChat = PrismaMessageRow & { chat?: { name: string | null } | null };

function rowToMessage(row: PrismaMessageRowWithChat): Message {
  return {
    id: row.id,
    chat_jid: row.chatJid,
    sender: row.sender,
    content: row.content ?? "",
    timestamp: row.timestamp,
    is_from_me: row.isFromMe,
    chat_name: row.chat?.name ?? null,
    media_type: row.mediaType,
    mimetype: row.mimetype,
    media_key: row.mediaKey,
    direct_path: row.directPath,
    media_url: row.mediaUrl,
    file_length: row.fileLength,
    file_sha256: row.fileSha256,
    file_enc_sha256: row.fileEncSha256,
    media_object_key: row.mediaObjectKey,
  };
}

// ── Writes ─────────────────────────────────────────────────────────

export async function storeChat(
  tenantId: string,
  chat: Partial<Chat> & { jid: string },
): Promise<void> {
  const prisma = getPrisma();
  try {
    const lastMessageTime = chat.last_message_time instanceof Date
      ? chat.last_message_time
      : chat.last_message_time
        ? new Date(chat.last_message_time)
        : null;

    await prisma.chat.upsert({
      where: { tenantId_jid: { tenantId, jid: chat.jid } },
      create: {
        tenantId,
        jid: chat.jid,
        name: chat.name ?? null,
        lastMessageTime,
      },
      update: {
        // COALESCE semantics: keep existing name if new one is null
        ...(chat.name !== undefined && chat.name !== null ? { name: chat.name } : {}),
        ...(lastMessageTime ? { lastMessageTime } : {}),
      },
    });
  } catch (err) {
    logError("Error storing chat", err);
  }
}

export async function storeMessage(tenantId: string, message: Message): Promise<void> {
  const prisma = getPrisma();
  try {
    // Ensure parent chat row exists (FK target) — same pattern as the old
    // storeMessage which called storeChat first.
    await storeChat(tenantId, { jid: message.chat_jid, last_message_time: message.timestamp });

    const data = {
      tenantId,
      chatJid: message.chat_jid,
      id: message.id,
      timestamp: message.timestamp,
      sender: message.sender ?? null,
      content: message.content,
      isFromMe: message.is_from_me,
      mediaType: message.media_type ?? null,
      mimetype: message.mimetype ?? null,
      mediaKey: message.media_key ?? null,
      directPath: message.direct_path ?? null,
      mediaUrl: message.media_url ?? null,
      fileLength: message.file_length ?? null,
      fileSha256: message.file_sha256 ?? null,
      fileEncSha256: message.file_enc_sha256 ?? null,
    };

    await prisma.message.upsert({
      where: {
        tenantId_chatJid_id: { tenantId, chatJid: message.chat_jid, id: message.id },
      },
      create: data,
      update: {
        sender: data.sender,
        content: data.content,
        timestamp: data.timestamp,
        isFromMe: data.isFromMe,
        // COALESCE semantics for media fields — only set if incoming is non-null
        ...(data.mediaType !== null ? { mediaType: data.mediaType } : {}),
        ...(data.mimetype !== null ? { mimetype: data.mimetype } : {}),
        ...(data.mediaKey !== null ? { mediaKey: data.mediaKey } : {}),
        ...(data.directPath !== null ? { directPath: data.directPath } : {}),
        ...(data.mediaUrl !== null ? { mediaUrl: data.mediaUrl } : {}),
        ...(data.fileLength !== null ? { fileLength: data.fileLength } : {}),
        ...(data.fileSha256 !== null ? { fileSha256: data.fileSha256 } : {}),
        ...(data.fileEncSha256 !== null ? { fileEncSha256: data.fileEncSha256 } : {}),
      },
    });

    // Advance the chat's last_message_time monotonically.
    await prisma.$executeRaw`
      UPDATE "chats"
      SET "lastMessageTime" = GREATEST(COALESCE("lastMessageTime", 'epoch'::timestamp), ${message.timestamp}::timestamp)
      WHERE "tenantId" = ${tenantId} AND "jid" = ${message.chat_jid}
    `;
  } catch (err) {
    logError("Error storing message", err);
  }
}

export async function storeContact(
  tenantId: string,
  contact: { jid: string; name?: string | null; notify?: string | null; phoneNumber?: string | null },
): Promise<void> {
  const prisma = getPrisma();
  try {
    await prisma.contact.upsert({
      where: { tenantId_jid: { tenantId, jid: contact.jid } },
      create: {
        tenantId,
        jid: contact.jid,
        name: contact.name ?? null,
        notify: contact.notify ?? null,
        phoneNumber: contact.phoneNumber ?? null,
      },
      update: {
        ...(contact.name !== undefined && contact.name !== null ? { name: contact.name } : {}),
        ...(contact.notify !== undefined && contact.notify !== null ? { notify: contact.notify } : {}),
        ...(contact.phoneNumber !== undefined && contact.phoneNumber !== null
          ? { phoneNumber: contact.phoneNumber }
          : {}),
      },
    });
  } catch (err) {
    logError("Error storing contact", err);
  }
}

export async function updateMessageMediaObjectKey(
  tenantId: string,
  messageId: string,
  chatJid: string,
  objectKey: string,
): Promise<void> {
  const prisma = getPrisma();
  try {
    await prisma.message.update({
      where: {
        tenantId_chatJid_id: { tenantId, chatJid, id: messageId },
      },
      data: { mediaObjectKey: objectKey },
    });
  } catch (err) {
    logError("Error updating media object key", err);
  }
}

// ── Reads ──────────────────────────────────────────────────────────

export async function listMessages(
  tenantId: string,
  chatJid: string,
  limit: number = 20,
  page: number = 0,
): Promise<Message[]> {
  const prisma = getPrisma();
  try {
    const rows = await prisma.message.findMany({
      where: { tenantId, chatJid },
      orderBy: { timestamp: "desc" },
      take: limit,
      skip: page * limit,
      include: { chat: { select: { name: true } } },
    });
    return rows.map(rowToMessage);
  } catch (err) {
    logError("Error listing messages", err);
    return [];
  }
}

export async function listMessagesWithDateFilter(
  tenantId: string,
  chatJid?: string | null,
  fromDate?: string | null,
  toDate?: string | null,
  limit: number = 50,
  page: number = 0,
): Promise<Message[]> {
  const prisma = getPrisma();
  try {
    const where: Prisma.MessageWhereInput = { tenantId };
    if (chatJid) where.chatJid = chatJid;
    if (fromDate || toDate) {
      where.timestamp = {};
      if (fromDate) (where.timestamp as Prisma.DateTimeFilter).gte = new Date(fromDate);
      if (toDate) (where.timestamp as Prisma.DateTimeFilter).lt = new Date(toDate);
    }
    const rows = await prisma.message.findMany({
      where,
      orderBy: { timestamp: "desc" },
      take: limit,
      skip: page * limit,
      include: { chat: { select: { name: true } } },
    });
    return rows.map(rowToMessage);
  } catch (err) {
    logError("Error listing messages with date filter", err);
    return [];
  }
}

export async function listChats(
  tenantId: string,
  limit: number = 20,
  page: number = 0,
  sortBy: "last_active" | "name" = "last_active",
  query?: string | null,
  includeLastMessage: boolean = true,
): Promise<Chat[]> {
  const prisma = getPrisma();
  try {
    const where: Prisma.ChatWhereInput = { tenantId };
    if (query) {
      where.OR = [
        { name: { contains: query, mode: "insensitive" } },
        { jid: { contains: query, mode: "insensitive" } },
      ];
    }

    const orderBy: Prisma.ChatOrderByWithRelationInput[] =
      sortBy === "last_active"
        ? [{ lastMessageTime: "desc" }, { jid: "asc" }]
        : [{ name: "asc" }, { jid: "asc" }];

    const rows = await prisma.chat.findMany({
      where,
      orderBy,
      take: limit,
      skip: page * limit,
      include: includeLastMessage
        ? {
            messages: {
              orderBy: { timestamp: "desc" },
              take: 1,
              select: { content: true, sender: true, isFromMe: true },
            },
          }
        : undefined,
    });

    return rows.map((row) => {
      const last = includeLastMessage
        ? (row as unknown as { messages: { content: string | null; sender: string | null; isFromMe: boolean }[] }).messages[0]
        : undefined;
      return {
        jid: row.jid,
        name: row.name,
        last_message_time: row.lastMessageTime,
        last_message: last?.content ?? null,
        last_sender: last?.sender ?? null,
        last_is_from_me: last?.isFromMe ?? null,
      };
    });
  } catch (err) {
    logError("Error listing chats", err);
    return [];
  }
}

export async function getChat(
  tenantId: string,
  jid: string,
  includeLastMessage: boolean = true,
): Promise<Chat | null> {
  const prisma = getPrisma();
  try {
    const row = await prisma.chat.findUnique({
      where: { tenantId_jid: { tenantId, jid } },
      include: includeLastMessage
        ? {
            messages: {
              orderBy: { timestamp: "desc" },
              take: 1,
              select: { content: true, sender: true, isFromMe: true },
            },
          }
        : undefined,
    });
    if (!row) return null;
    const last = includeLastMessage
      ? (row as unknown as { messages: { content: string | null; sender: string | null; isFromMe: boolean }[] }).messages[0]
      : undefined;
    return {
      jid: row.jid,
      name: row.name,
      last_message_time: row.lastMessageTime,
      last_message: last?.content ?? null,
      last_sender: last?.sender ?? null,
      last_is_from_me: last?.isFromMe ?? null,
    };
  } catch (err) {
    logError("Error getting chat", err);
    return null;
  }
}

export async function getMessagesAround(
  tenantId: string,
  messageId: string,
  before: number = 5,
  after: number = 5,
): Promise<{ before: Message[]; target: Message | null; after: Message[] }> {
  const prisma = getPrisma();
  const result: { before: Message[]; target: Message | null; after: Message[] } = {
    before: [],
    target: null,
    after: [],
  };

  try {
    // Lookup target (we don't know chatJid up front, so search by id within tenant).
    const targetRow = await prisma.message.findFirst({
      where: { tenantId, id: messageId },
      include: { chat: { select: { name: true } } },
    });
    if (!targetRow) return result;

    result.target = rowToMessage(targetRow);
    const targetTs = targetRow.timestamp;
    const chatJid = targetRow.chatJid;

    const beforeRows = await prisma.message.findMany({
      where: { tenantId, chatJid, timestamp: { lt: targetTs } },
      orderBy: { timestamp: "desc" },
      take: before,
      include: { chat: { select: { name: true } } },
    });
    result.before = beforeRows.map(rowToMessage).reverse();

    const afterRows = await prisma.message.findMany({
      where: { tenantId, chatJid, timestamp: { gt: targetTs } },
      orderBy: { timestamp: "asc" },
      take: after,
      include: { chat: { select: { name: true } } },
    });
    result.after = afterRows.map(rowToMessage);
    return result;
  } catch (err) {
    logError("Error getting messages around", err);
    return result;
  }
}

export async function searchContacts(
  tenantId: string,
  query: string,
  limit: number = 20,
): Promise<{ jid: string; name: string | null }[]> {
  const prisma = getPrisma();
  try {
    const rows = await prisma.contact.findMany({
      where: {
        tenantId,
        OR: [
          { name: { contains: query, mode: "insensitive" } },
          { notify: { contains: query, mode: "insensitive" } },
          { phoneNumber: { contains: query, mode: "insensitive" } },
          { jid: { contains: query, mode: "insensitive" } },
        ],
      },
      take: limit,
    });
    return rows.map((r) => ({
      jid: r.jid,
      name: r.name ?? r.notify ?? r.phoneNumber ?? r.jid,
    }));
  } catch (err) {
    logError("Error searching contacts", err);
    return [];
  }
}

export async function searchMessages(
  tenantId: string,
  searchQuery: string,
  chatJid?: string | null,
  fromDate?: string | null,
  toDate?: string | null,
  limit: number = 10,
  page: number = 0,
): Promise<Message[]> {
  const prisma = getPrisma();
  try {
    // Accent- and case-insensitive ILIKE via unaccent + pg_trgm GIN index.
    const offset = page * limit;
    const pattern = `%${searchQuery}%`;

    const conditions: string[] = [`"tenantId" = $1`];
    const params: unknown[] = [tenantId];
    params.push(pattern);
    conditions.push(`immutable_unaccent(lower("content")) LIKE immutable_unaccent(lower($${params.length}))`);

    if (chatJid) {
      params.push(chatJid);
      conditions.push(`"chatJid" = $${params.length}`);
    }
    if (fromDate) {
      params.push(new Date(fromDate));
      conditions.push(`"timestamp" >= $${params.length}`);
    }
    if (toDate) {
      params.push(new Date(toDate));
      conditions.push(`"timestamp" < $${params.length}`);
    }

    params.push(limit);
    const limitPlaceholder = `$${params.length}`;
    params.push(offset);
    const offsetPlaceholder = `$${params.length}`;

    const sql = `
      SELECT m.*, c."name" AS "chat_name"
      FROM "messages" m
      LEFT JOIN "chats" c ON c."tenantId" = m."tenantId" AND c."jid" = m."chatJid"
      WHERE ${conditions.join(" AND ")}
      ORDER BY m."timestamp" DESC
      LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}
    `;

    const rows = await prisma.$queryRawUnsafe<(PrismaMessageRow & { chat_name: string | null })[]>(sql, ...params);
    return rows.map((r) =>
      rowToMessage({
        ...r,
        chat: r.chat_name !== null && r.chat_name !== undefined ? { name: r.chat_name } : null,
      }),
    );
  } catch (err) {
    logError("Error searching messages", err);
    return [];
  }
}

export async function getMessageById(
  tenantId: string,
  messageId: string,
  chatJid: string,
): Promise<Message | null> {
  const prisma = getPrisma();
  try {
    const row = await prisma.message.findUnique({
      where: { tenantId_chatJid_id: { tenantId, chatJid, id: messageId } },
      include: { chat: { select: { name: true } } },
    });
    return row ? rowToMessage(row) : null;
  } catch (err) {
    logError("Error getting message by id", err);
    return null;
  }
}

export async function getContactName(tenantId: string, jid: string): Promise<string | null> {
  const prisma = getPrisma();
  try {
    const row = await prisma.contact.findUnique({
      where: { tenantId_jid: { tenantId, jid } },
      select: { name: true, notify: true, phoneNumber: true },
    });
    return row?.name ?? row?.notify ?? row?.phoneNumber ?? null;
  } catch (err) {
    logError("Error getting contact name", err);
    return null;
  }
}

export async function listContacts(
  tenantId: string,
  query?: string,
  limit: number = 50,
): Promise<{ jid: string; name: string }[]> {
  const prisma = getPrisma();
  try {
    const where: Prisma.ContactWhereInput = { tenantId };
    if (query) {
      where.OR = [
        { name: { contains: query, mode: "insensitive" } },
        { notify: { contains: query, mode: "insensitive" } },
        { phoneNumber: { contains: query, mode: "insensitive" } },
        { jid: { contains: query, mode: "insensitive" } },
      ];
    }
    const rows = await prisma.contact.findMany({
      where,
      orderBy: { name: "asc" },
      take: limit,
    });
    return rows.map((r) => ({
      jid: r.jid,
      name: r.name ?? r.notify ?? r.phoneNumber ?? r.jid,
    }));
  } catch (err) {
    logError("Error listing contacts", err);
    return [];
  }
}
