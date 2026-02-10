import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import path from "node:path";
import fs from "node:fs";
import type { Logger } from "pino";
import * as schema from './db/schema.ts';
import { eq, and, or, like, gte, lt, desc, asc, sql, type SQL } from 'drizzle-orm';

const DATA_DIR = path.join(import.meta.dirname, "..", "data");
const DB_PATH = path.join(DATA_DIR, "whatsapp.db");

// Module-level logger (can be set via setLogger)
let dbLogger: Logger | null = null;

export function setDatabaseLogger(logger: Logger): void {
  dbLogger = logger;
}

function logError(message: string, error?: unknown): void {
  if (dbLogger) {
    dbLogger.error({ err: error }, message);
  } else {
    console.error(message, error);
  }
}

function logInfo(message: string): void {
  if (dbLogger) {
    dbLogger.info(message);
  } else {
    console.log(message);
  }
}

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
  // Media fields (optional, populated for media messages)
  media_type?: string | null;
  mimetype?: string | null;
  media_key?: string | null;
  direct_path?: string | null;
  media_url?: string | null;
  file_length?: number | null;
  file_sha256?: string | null;
  file_enc_sha256?: string | null;
  media_local_path?: string | null;
};

let sqliteInstance: Database.Database | null = null;
let dbInstance: BetterSQLite3Database<typeof schema> | null = null;

function getDb() {
  if (!dbInstance) {
    throw new Error("Database not initialized. Call initializeDatabase() first.");
  }
  return dbInstance;
}

export function initializeDatabase(dbPath?: string): Database.Database {
  // Allow re-initialization (for tests)
  if (sqliteInstance) {
    sqliteInstance.close();
    sqliteInstance = null;
    dbInstance = null;
  }

  if (dbPath === ':memory:') {
    sqliteInstance = new Database(':memory:');
  } else {
    const resolvedPath = dbPath ?? DB_PATH;
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    sqliteInstance = new Database(resolvedPath);
  }
  dbInstance = drizzle(sqliteInstance, { schema });

  const sqlite = sqliteInstance;

  sqlite.pragma("journal_mode = WAL");

  sqlite.exec(`
        CREATE TABLE IF NOT EXISTS chats (
            jid TEXT PRIMARY KEY,
            name TEXT,
            last_message_time TEXT
        );
    `);

  sqlite.exec(`
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT,
            chat_jid TEXT,
            sender TEXT,
            content TEXT,
            timestamp TEXT,
            is_from_me INTEGER,
            PRIMARY KEY (id, chat_jid),
            FOREIGN KEY (chat_jid) REFERENCES chats(jid) ON DELETE CASCADE
        );
    `);

  sqlite.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        jid TEXT PRIMARY KEY,
        name TEXT,
        notify TEXT,
        phone_number TEXT
      );
    `);

  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages (timestamp);`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_messages_chat_jid ON messages (chat_jid);`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages (sender);`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_chats_last_message_time ON chats (last_message_time);`);

  // Media columns migration (safe to run on existing DBs)
  const mediaColumns = [
    ['media_type', 'TEXT'],
    ['mimetype', 'TEXT'],
    ['media_key', 'TEXT'],
    ['direct_path', 'TEXT'],
    ['media_url', 'TEXT'],
    ['file_length', 'INTEGER'],
    ['file_sha256', 'TEXT'],
    ['file_enc_sha256', 'TEXT'],
    ['media_local_path', 'TEXT'],
  ] as const;
  for (const [col, type] of mediaColumns) {
    try {
      sqlite.exec(`ALTER TABLE messages ADD COLUMN ${col} ${type};`);
    } catch {
      // Column already exists — ignore
    }
  }
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_messages_media_type ON messages (media_type);`);

  return sqlite;
}

export function storeChat(chat: Partial<Chat> & { jid: string }): void {
  const db = getDb();
  try {
    db.insert(schema.chats)
      .values({
        jid: chat.jid,
        name: chat.name ?? null,
        lastMessageTime: chat.last_message_time instanceof Date
          ? chat.last_message_time.toISOString()
          : chat.last_message_time === null ? null : String(chat.last_message_time),
      })
      .onConflictDoUpdate({
        target: schema.chats.jid,
        set: {
          name: sql`COALESCE(excluded.name, chats.name)`,
          lastMessageTime: sql`COALESCE(excluded.last_message_time, chats.last_message_time)`,
        },
      })
      .run();
  } catch (error) {
    logError("Error storing chat", error);
  }
}

export function storeMessage(message: Message): void {
  const db = getDb();
  try {
    storeChat({ jid: message.chat_jid, last_message_time: message.timestamp });

    db.insert(schema.messages)
      .values({
        id: message.id,
        chatJid: message.chat_jid,
        sender: message.sender ?? null,
        content: message.content,
        timestamp: message.timestamp.toISOString(),
        isFromMe: message.is_from_me,
        mediaType: message.media_type ?? null,
        mimetype: message.mimetype ?? null,
        mediaKey: message.media_key ?? null,
        directPath: message.direct_path ?? null,
        mediaUrl: message.media_url ?? null,
        fileLength: message.file_length ?? null,
        fileSha256: message.file_sha256 ?? null,
        fileEncSha256: message.file_enc_sha256 ?? null,
        mediaLocalPath: message.media_local_path ?? null,
      })
      .onConflictDoUpdate({
        target: [schema.messages.id, schema.messages.chatJid],
        set: {
            sender: message.sender ?? null,
            content: message.content,
            timestamp: message.timestamp.toISOString(),
            isFromMe: message.is_from_me,
            mediaType: sql`COALESCE(excluded.media_type, messages.media_type)`,
            mimetype: sql`COALESCE(excluded.mimetype, messages.mimetype)`,
            mediaKey: sql`COALESCE(excluded.media_key, messages.media_key)`,
            directPath: sql`COALESCE(excluded.direct_path, messages.direct_path)`,
            mediaUrl: sql`COALESCE(excluded.media_url, messages.media_url)`,
            fileLength: sql`COALESCE(excluded.file_length, messages.file_length)`,
            fileSha256: sql`COALESCE(excluded.file_sha256, messages.file_sha256)`,
            fileEncSha256: sql`COALESCE(excluded.file_enc_sha256, messages.file_enc_sha256)`,
        }
      })
      .run();

    // Update chat last message time
    db.update(schema.chats)
      .set({
        lastMessageTime: sql`MAX(COALESCE(last_message_time, '1970-01-01T00:00:00.000Z'), ${message.timestamp.toISOString()})`
      })
      .where(eq(schema.chats.jid, message.chat_jid))
      .run();

  } catch (error) {
    logError("Error storing message", error);
  }
}

function parseDateSafe(dateString: string | null | undefined): Date | null {
  if (!dateString) return null;
  try {
    const date = new Date(dateString);
    return isNaN(date.getTime()) ? null : date;
  } catch (e) {
    return null;
  }
}

function rowToMessage(row: any): Message {
  return {
    id: row.id!,
    chat_jid: row.chat_jid!,
    sender: row.sender,
    content: row.content!,
    timestamp: parseDateSafe(row.timestamp)!,
    is_from_me: row.is_from_me ?? false,
    chat_name: row.chat_name,
    media_type: row.media_type ?? null,
    mimetype: row.mimetype ?? null,
    media_key: row.media_key ?? null,
    direct_path: row.direct_path ?? null,
    media_url: row.media_url ?? null,
    file_length: row.file_length ?? null,
    file_sha256: row.file_sha256 ?? null,
    file_enc_sha256: row.file_enc_sha256 ?? null,
    media_local_path: row.media_local_path ?? null,
  };
}

const messageColumns = {
  id: schema.messages.id,
  chat_jid: schema.messages.chatJid,
  sender: schema.messages.sender,
  content: schema.messages.content,
  timestamp: schema.messages.timestamp,
  is_from_me: schema.messages.isFromMe,
  chat_name: schema.chats.name,
  media_type: schema.messages.mediaType,
  mimetype: schema.messages.mimetype,
  media_key: schema.messages.mediaKey,
  direct_path: schema.messages.directPath,
  media_url: schema.messages.mediaUrl,
  file_length: schema.messages.fileLength,
  file_sha256: schema.messages.fileSha256,
  file_enc_sha256: schema.messages.fileEncSha256,
  media_local_path: schema.messages.mediaLocalPath,
};

export function getMessages(
  chatJid: string,
  limit: number = 20,
  page: number = 0,
): Message[] {
  const db = getDb();
  try {
    const offset = page * limit;

    const rows = db.select(messageColumns)
    .from(schema.messages)
    .innerJoin(schema.chats, eq(schema.messages.chatJid, schema.chats.jid))
    .where(eq(schema.messages.chatJid, chatJid))
    .orderBy(desc(schema.messages.timestamp))
    .limit(limit)
    .offset(offset)
    .all();

    return rows.map(rowToMessage);
  } catch (error) {
    logError("Error getting messages", error);
    return [];
  }
}

export function getChats(
  limit: number = 20,
  page: number = 0,
  sortBy: "last_active" | "name" = "last_active",
  query?: string | null,
  includeLastMessage: boolean = true,
): Chat[] {
  const db = getDb();
  try {
    const offset = page * limit;

    // In better-sqlite3 we can use a simpler approach for last message if needed,
    // but Drizzle's subquery/with should work.

    const lastMessageSq = db.$with('last_messages').as(
        db.select({
            chatJid: schema.messages.chatJid,
            content: schema.messages.content,
            sender: schema.messages.sender,
            isFromMe: schema.messages.isFromMe,
            row_num: sql`row_number() OVER (PARTITION BY ${schema.messages.chatJid} ORDER BY ${schema.messages.timestamp} DESC)`.as('row_num')
        })
        .from(schema.messages)
    );

    let baseQuery: any = db.with(lastMessageSq).select({
        jid: schema.chats.jid,
        name: schema.chats.name,
        last_message_time: schema.chats.lastMessageTime,
        last_message: includeLastMessage ? lastMessageSq.content : sql`NULL`,
        last_sender: includeLastMessage ? lastMessageSq.sender : sql`NULL`,
        last_is_from_me: includeLastMessage ? lastMessageSq.isFromMe : sql`NULL`,
    })
    .from(schema.chats);

    if (includeLastMessage) {
        baseQuery = baseQuery.leftJoin(lastMessageSq, and(eq(schema.chats.jid, lastMessageSq.chatJid), eq(lastMessageSq.row_num, 1)));
    }

    if (query) {
        baseQuery = baseQuery.where(or(
            like(sql`LOWER(${schema.chats.name})`, `%${query.toLowerCase()}%`),
            like(schema.chats.jid, `%${query}%`)
        ));
    }

    const orderBy = sortBy === "last_active"
        ? [desc(schema.chats.lastMessageTime), asc(schema.chats.jid)]
        : [asc(schema.chats.name), asc(schema.chats.jid)];

    const rows = baseQuery
        .orderBy(...orderBy)
        .limit(limit)
        .offset(offset)
        .all();

    return rows.map((row: any) => ({
        jid: row.jid,
        name: row.name,
        last_message_time: parseDateSafe(row.last_message_time as string),
        last_message: row.last_message as string | null,
        last_sender: row.last_sender as string | null,
        last_is_from_me: row.last_is_from_me as boolean | null,
    }));
  } catch (error) {
    logError("Error getting chats", error);
    return [];
  }
}

export function getChat(
  jid: string,
  includeLastMessage: boolean = true,
): Chat | null {
  const db = getDb();
  try {
    const lastMessageSq = db.$with('last_message').as(
        db.select({
            chatJid: schema.messages.chatJid,
            content: schema.messages.content,
            sender: schema.messages.sender,
            isFromMe: schema.messages.isFromMe,
        })
        .from(schema.messages)
        .where(eq(schema.messages.chatJid, jid))
        .orderBy(desc(schema.messages.timestamp))
        .limit(1)
    );

    let baseQuery: any = db.with(lastMessageSq).select({
        jid: schema.chats.jid,
        name: schema.chats.name,
        last_message_time: schema.chats.lastMessageTime,
        last_message: includeLastMessage ? lastMessageSq.content : sql`NULL`,
        last_sender: includeLastMessage ? lastMessageSq.sender : sql`NULL`,
        last_is_from_me: includeLastMessage ? lastMessageSq.isFromMe : sql`NULL`,
    })
    .from(schema.chats)
    .where(eq(schema.chats.jid, jid));

    if (includeLastMessage) {
        baseQuery = baseQuery.leftJoin(lastMessageSq, eq(schema.chats.jid, lastMessageSq.chatJid));
    }

    const row: any = baseQuery.get();

    if (!row) return null;

    return {
        jid: row.jid,
        name: row.name,
        last_message_time: parseDateSafe(row.last_message_time as string),
        last_message: row.last_message as string | null,
        last_sender: row.last_sender as string | null,
        last_is_from_me: row.last_is_from_me as boolean | null,
    };
  } catch (error) {
    logError("Error getting chat", error);
    return null;
  }
}

export function getMessagesAround(
  messageId: string,
  before: number = 5,
  after: number = 5,
): { before: Message[]; target: Message | null; after: Message[] } {
  const db = getDb();
  const result: {
    before: Message[];
    target: Message | null;
    after: Message[];
  } = { before: [], target: null, after: [] };

  try {
    const targetRow = db.select(messageColumns)
    .from(schema.messages)
    .innerJoin(schema.chats, eq(schema.messages.chatJid, schema.chats.jid))
    .where(eq(schema.messages.id, messageId))
    .get();

    if (!targetRow) {
      return result;
    }

    result.target = rowToMessage(targetRow);
    const targetTimestamp = targetRow.timestamp!;
    const chatJid = targetRow.chat_jid!;

    const beforeRows = db.select(messageColumns)
    .from(schema.messages)
    .innerJoin(schema.chats, eq(schema.messages.chatJid, schema.chats.jid))
    .where(and(eq(schema.messages.chatJid, chatJid), lt(schema.messages.timestamp, targetTimestamp)))
    .orderBy(desc(schema.messages.timestamp))
    .limit(before)
    .all();

    result.before = beforeRows.map(rowToMessage).reverse();

    const afterRows = db.select(messageColumns)
    .from(schema.messages)
    .innerJoin(schema.chats, eq(schema.messages.chatJid, schema.chats.jid))
    .where(and(eq(schema.messages.chatJid, chatJid), sql`${schema.messages.timestamp} > ${targetTimestamp}`))
    .orderBy(asc(schema.messages.timestamp))
    .limit(after)
    .all();

    result.after = afterRows.map(rowToMessage);

    return result;
  } catch (error) {
    logError("Error getting messages around", error);
    return result;
  }
}

export function searchDbForContacts(
  query: string,
  limit: number = 20
): { jid: string; name: string | null }[] {
  const db = getDb();
  try {
    const pattern = `%${query}%`;

    const rows = db.select({
        jid: schema.contacts.jid,
        display_name: sql`COALESCE(${schema.contacts.name}, ${schema.contacts.notify}, ${schema.contacts.phoneNumber}, ${schema.contacts.jid})`
    })
    .from(schema.contacts)
    .where(like(sql`LOWER(COALESCE(${schema.contacts.name}, ${schema.contacts.notify}, ${schema.contacts.phoneNumber}, ${schema.contacts.jid}))`, pattern.toLowerCase()))
    .limit(limit)
    .all();

    return rows.map((r: any) => ({
      jid: r.jid,
      name: r.display_name as string | null,
    }));
  } catch (error) {
    logError("Error searching contacts", error);
    return [];
  }
}

export function searchMessages(
  searchQuery: string,
  chatJid?: string | null,
  fromDate?: string | null,
  toDate?: string | null,
  limit: number = 10,
  page: number = 0,
): Message[] {
  const db = getDb();
  try {
    const offset = page * limit;
    const searchPattern = `%${searchQuery}%`;
    const filters: SQL[] = [
      like(sql`LOWER(${schema.messages.content})`, searchPattern.toLowerCase()),
    ];

    if (chatJid) {
      filters.push(eq(schema.messages.chatJid, chatJid));
    }
    if (fromDate) {
      filters.push(gte(schema.messages.timestamp, fromDate));
    }
    if (toDate) {
      filters.push(lt(schema.messages.timestamp, toDate));
    }

    const rows = db.select(messageColumns)
    .from(schema.messages)
    .innerJoin(schema.chats, eq(schema.messages.chatJid, schema.chats.jid))
    .where(and(...filters))
    .orderBy(desc(schema.messages.timestamp))
    .limit(limit)
    .offset(offset)
    .all();

    return rows.map(rowToMessage);
  } catch (error) {
    logError("Error searching messages", error);
    return [];
  }
}

export function getMessageById(messageId: string, chatJid: string): Message | null {
  const db = getDb();
  try {
    const row = db.select(messageColumns)
      .from(schema.messages)
      .innerJoin(schema.chats, eq(schema.messages.chatJid, schema.chats.jid))
      .where(and(eq(schema.messages.id, messageId), eq(schema.messages.chatJid, chatJid)))
      .get();

    return row ? rowToMessage(row) : null;
  } catch (error) {
    logError("Error getting message by id", error);
    return null;
  }
}

export function updateMessageMediaLocalPath(messageId: string, chatJid: string, localPath: string): void {
  const db = getDb();
  try {
    db.update(schema.messages)
      .set({ mediaLocalPath: localPath })
      .where(and(eq(schema.messages.id, messageId), eq(schema.messages.chatJid, chatJid)))
      .run();
  } catch (error) {
    logError("Error updating media local path", error);
  }
}

export function closeDatabase(): void {
  if (sqliteInstance) {
    try {
      sqliteInstance.close();
      sqliteInstance = null;
      dbInstance = null;
      logInfo("Database connection closed.");
    } catch (error) {
      logError("Error closing database", error);
    }
  }
}

export function storeContact(contact: {
  jid: string;
  name?: string | null;
  notify?: string | null;
  phoneNumber?: string | null;
}): void {
  const db = getDb();
  try {
    db.insert(schema.contacts)
      .values({
        jid: contact.jid,
        name: contact.name ?? null,
        notify: contact.notify ?? null,
        phoneNumber: contact.phoneNumber ?? null,
      })
      .onConflictDoUpdate({
        target: schema.contacts.jid,
        set: {
            name: sql`COALESCE(excluded.name, contacts.name)`,
            notify: sql`COALESCE(excluded.notify, contacts.notify)`,
            phoneNumber: sql`COALESCE(excluded.phone_number, contacts.phone_number)`,
        }
      })
      .run();
  } catch (error) {
    logError("Error storing contact", error);
  }
}

export function getContactName(jid: string): string | null {
  const db = getDb();
  try {
    const row: any = db.select({
      display_name: sql`COALESCE(${schema.contacts.name}, ${schema.contacts.notify}, ${schema.contacts.phoneNumber})`,
    })
    .from(schema.contacts)
    .where(eq(schema.contacts.jid, jid))
    .get();
    return row?.display_name ?? null;
  } catch (error) {
    logError("Error getting contact name", error);
    return null;
  }
}

export function getContacts(query?: string, limit: number = 50): { jid: string; name: string }[] {
  const db = getDb();
  try {
    let q = db.select({
      jid: schema.contacts.jid,
      name: sql`COALESCE(${schema.contacts.name}, ${schema.contacts.notify}, ${schema.contacts.phoneNumber}, ${schema.contacts.jid})`.as('name'),
    })
    .from(schema.contacts)
    .$dynamic();

    if (query) {
      q = q.where(
        like(
          sql`LOWER(COALESCE(${schema.contacts.name}, ${schema.contacts.notify}, ${schema.contacts.phoneNumber}, ${schema.contacts.jid}))`,
          `%${query.toLowerCase()}%`
        )
      );
    }

    return q.orderBy(sql`name`).limit(limit).all() as { jid: string; name: string }[];
  } catch (error) {
    logError("Error getting contacts", error);
    return [];
  }
}

export function getMessagesWithDateFilter(
  chatJid?: string | null,
  fromDate?: string | null,
  toDate?: string | null,
  limit: number = 50,
  page: number = 0
): Message[] {
  const db = getDb();
  try {
    const offset = page * limit;
    const filters: SQL[] = [];

    if (chatJid) {
      filters.push(eq(schema.messages.chatJid, chatJid));
    }
    if (fromDate) {
      filters.push(gte(schema.messages.timestamp, fromDate));
    }
    if (toDate) {
      filters.push(lt(schema.messages.timestamp, toDate));
    }

    const rows = db.select(messageColumns)
    .from(schema.messages)
    .innerJoin(schema.chats, eq(schema.messages.chatJid, schema.chats.jid))
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(schema.messages.timestamp))
    .limit(limit)
    .offset(offset)
    .all();

    return rows.map(rowToMessage);
  } catch (error) {
    logError("Error getting messages with date filter", error);
    return [];
  }
}

export function resetDatabase(): void {
  if (sqliteInstance) {
    sqliteInstance.close();
    sqliteInstance = null;
    dbInstance = null;
  }
}
