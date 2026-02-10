import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import path from "node:path";
import fs from "node:fs";
import type { Logger } from "pino";
import * as schema from './db/schema.ts';
import { eq, and, or, like, desc, asc, sql } from 'drizzle-orm';

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
};

let sqliteInstance: Database.Database | null = null;
let dbInstance: BetterSQLite3Database<typeof schema> | null = null;

function getDb() {
  if (!dbInstance) {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    sqliteInstance = new Database(DB_PATH);
    dbInstance = drizzle(sqliteInstance, { schema });
  }
  return dbInstance;
}

export function initializeDatabase(): Database.Database {
  const db = getDb();
  const sqlite = sqliteInstance!;

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
      })
      .onConflictDoUpdate({
        target: [schema.messages.id, schema.messages.chatJid],
        set: {
            sender: message.sender ?? null,
            content: message.content,
            timestamp: message.timestamp.toISOString(),
            isFromMe: message.is_from_me,
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

export function getMessages(
  chatJid: string,
  limit: number = 20,
  page: number = 0,
): Message[] {
  const db = getDb();
  try {
    const offset = page * limit;

    const rows = db.select({
        id: schema.messages.id,
        chat_jid: schema.messages.chatJid,
        sender: schema.messages.sender,
        content: schema.messages.content,
        timestamp: schema.messages.timestamp,
        is_from_me: schema.messages.isFromMe,
        chat_name: schema.chats.name,
    })
    .from(schema.messages)
    .innerJoin(schema.chats, eq(schema.messages.chatJid, schema.chats.jid))
    .where(eq(schema.messages.chatJid, chatJid))
    .orderBy(desc(schema.messages.timestamp))
    .limit(limit)
    .offset(offset)
    .all();

    return rows.map((row: any) => ({
        ...row,
        timestamp: parseDateSafe(row.timestamp)!,
        is_from_me: row.is_from_me ?? false,
        chat_jid: row.chat_jid!,
        id: row.id!,
    }));
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
    const targetRow: any = db.select({
        id: schema.messages.id,
        chat_jid: schema.messages.chatJid,
        sender: schema.messages.sender,
        content: schema.messages.content,
        timestamp: schema.messages.timestamp,
        is_from_me: schema.messages.isFromMe,
        chat_name: schema.chats.name,
    })
    .from(schema.messages)
    .innerJoin(schema.chats, eq(schema.messages.chatJid, schema.chats.jid))
    .where(eq(schema.messages.id, messageId))
    .get();

    if (!targetRow) {
      return result;
    }

    result.target = {
        ...targetRow,
        timestamp: parseDateSafe(targetRow.timestamp)!,
        is_from_me: targetRow.is_from_me ?? false,
        chat_jid: targetRow.chat_jid!,
        id: targetRow.id!,
    };

    const targetTimestamp = targetRow.timestamp!;
    const chatJid = targetRow.chat_jid!;

    const beforeRows = db.select({
        id: schema.messages.id,
        chat_jid: schema.messages.chatJid,
        sender: schema.messages.sender,
        content: schema.messages.content,
        timestamp: schema.messages.timestamp,
        is_from_me: schema.messages.isFromMe,
        chat_name: schema.chats.name,
    })
    .from(schema.messages)
    .innerJoin(schema.chats, eq(schema.messages.chatJid, schema.chats.jid))
    .where(and(eq(schema.messages.chatJid, chatJid), sql`${schema.messages.timestamp} < ${targetTimestamp}`))
    .orderBy(desc(schema.messages.timestamp))
    .limit(before)
    .all();

    result.before = beforeRows.map((row: any) => ({
        ...row,
        timestamp: parseDateSafe(row.timestamp)!,
        is_from_me: row.is_from_me ?? false,
        chat_jid: row.chat_jid!,
        id: row.id!,
    })).reverse();

    const afterRows = db.select({
        id: schema.messages.id,
        chat_jid: schema.messages.chatJid,
        sender: schema.messages.sender,
        content: schema.messages.content,
        timestamp: schema.messages.timestamp,
        is_from_me: schema.messages.isFromMe,
        chat_name: schema.chats.name,
    })
    .from(schema.messages)
    .innerJoin(schema.chats, eq(schema.messages.chatJid, schema.chats.jid))
    .where(and(eq(schema.messages.chatJid, chatJid), sql`${schema.messages.timestamp} > ${targetTimestamp}`))
    .orderBy(asc(schema.messages.timestamp))
    .limit(after)
    .all();

    result.after = afterRows.map((row: any) => ({
        ...row,
        timestamp: parseDateSafe(row.timestamp)!,
        is_from_me: row.is_from_me ?? false,
        chat_jid: row.chat_jid!,
        id: row.id!,
    }));

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
  limit: number = 10,
  page: number = 0,
): Message[] {
  const db = getDb();
  try {
    const offset = page * limit;
    const searchPattern = `%${searchQuery}%`;

    let whereClause = like(sql`LOWER(${schema.messages.content})`, searchPattern.toLowerCase());

    if (chatJid) {
      whereClause = and(whereClause, eq(schema.messages.chatJid, chatJid)) as any;
    }

    const rows = db.select({
        id: schema.messages.id,
        chat_jid: schema.messages.chatJid,
        sender: schema.messages.sender,
        content: schema.messages.content,
        timestamp: schema.messages.timestamp,
        is_from_me: schema.messages.isFromMe,
        chat_name: schema.chats.name,
    })
    .from(schema.messages)
    .innerJoin(schema.chats, eq(schema.messages.chatJid, schema.chats.jid))
    .where(whereClause)
    .orderBy(desc(schema.messages.timestamp))
    .limit(limit)
    .offset(offset)
    .all();

    return rows.map((row: any) => ({
        ...row,
        timestamp: parseDateSafe(row.timestamp)!,
        is_from_me: row.is_from_me ?? false,
        chat_jid: row.chat_jid!,
        id: row.id!,
    }));
  } catch (error) {
    logError("Error searching messages", error);
    return [];
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
