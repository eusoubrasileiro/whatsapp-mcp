import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import path from "node:path";
import fs from "node:fs";
import type { Logger } from "pino";
import * as schema from './db/schema.ts';
import { eq, and, or, like, gte, lt, desc, asc, inArray, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { isGroupJid, isLidJid } from "@amiticia/baileys-client";

/**
 * Resolves the SQLite DB path with the same precedence as src/whatsapp.ts:34
 * uses for auth_info and media. Exported so tests can verify path logic
 * without touching the filesystem.
 */
export function resolveDbPath(override?: string): string {
  if (override !== undefined) return override;
  const baseDir = process.env.WHATSAPP_MCP_DATA_DIR ?? path.join(import.meta.dirname, "..");
  return path.join(baseDir, "data", "whatsapp.db");
}

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
  media_object_key?: string | null;
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
    const resolvedPath = resolveDbPath(dbPath);
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

  sqlite.exec(`
      CREATE TABLE IF NOT EXISTS jid_aliases (
        jid TEXT PRIMARY KEY,
        canonical_jid TEXT NOT NULL,
        pn_jid TEXT,
        lid_jid TEXT,
        updated_at TEXT
      );
    `);

  sqlite.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);

  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_jid_aliases_canonical ON jid_aliases (canonical_jid);`);
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
    ['media_object_key', 'TEXT'],
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

// --- LID/phone-number canonicalization (BUG-lid-contact-fragmentation.md) ---

/**
 * Resolve any JID to its canonical form. Returns the alias-table
 * `canonical_jid` if a mapping exists, otherwise the JID unchanged. Groups
 * (`@g.us`) always pass through — LID does not apply to group chat JIDs.
 */
export function resolveCanonicalJid(jid: string): string {
  if (!jid || isGroupJid(jid)) return jid;
  try {
    const row = getDb()
      .select({ canonical: schema.jidAliases.canonicalJid })
      .from(schema.jidAliases)
      .where(eq(schema.jidAliases.jid, jid))
      .get();
    return row?.canonical ?? jid;
  } catch (error) {
    logError("Error resolving canonical jid", error);
    return jid;
  }
}

/**
 * All JIDs that share `jid`'s canonical identity (the canonical JID plus every
 * known alias). Used to union a stale JID's chat with its twin on reads.
 */
export function getAliasGroup(jid: string): string[] {
  const canonical = resolveCanonicalJid(jid);
  const group = new Set<string>([jid, canonical]);
  try {
    const rows = getDb()
      .select({ jid: schema.jidAliases.jid })
      .from(schema.jidAliases)
      .where(eq(schema.jidAliases.canonicalJid, canonical))
      .all();
    for (const r of rows) group.add(r.jid);
  } catch (error) {
    logError("Error getting alias group", error);
  }
  return [...group];
}

/**
 * Record a phone-number ↔ LID identity pair. Canonical direction is LID
 * (Baileys v7 guidance: PNs are less reliable). Writes both the PN row and the
 * LID row pointing at the LID, so a lookup by either resolves to canonical.
 */
export function recordJidMapping(pnJid: string, lidJid: string): void {
  if (!pnJid || !lidJid || pnJid === lidJid) return;
  const now = new Date().toISOString();
  try {
    const db = getDb();
    for (const jid of [pnJid, lidJid]) {
      db.insert(schema.jidAliases)
        .values({ jid, canonicalJid: lidJid, pnJid, lidJid, updatedAt: now })
        .onConflictDoUpdate({
          target: schema.jidAliases.jid,
          set: { canonicalJid: lidJid, pnJid, lidJid, updatedAt: now },
        })
        .run();
    }
  } catch (error) {
    logError("Error recording jid mapping", error);
    return;
  }
  // Physically merge the two chats into the canonical identity.
  mergeChatPair(pnJid, lidJid);
}

/**
 * Physically merge a stale chat/contact (`staleJid`) into its canonical twin
 * (`canonicalJid`): re-point every message, fold chat/contact metadata, and
 * drop the now-empty stale rows. Messages are relocated, never deleted (except
 * exact duplicates that exist under both JIDs — the canonical copy is kept).
 *
 * Idempotent: a no-op once the stale rows are gone, so it is safe to call on
 * every message during ingest and to re-run.
 */
export function mergeChatPair(staleJid: string, canonicalJid: string): void {
  if (!staleJid || !canonicalJid || staleJid === canonicalJid) return;
  const sqlite = sqliteInstance;
  if (!sqlite) return;
  try {
    const hasStaleChat = sqlite.prepare("SELECT 1 FROM chats WHERE jid = ?").get(staleJid);
    const hasStaleContact = sqlite.prepare("SELECT 1 FROM contacts WHERE jid = ?").get(staleJid);
    if (!hasStaleChat && !hasStaleContact) return; // nothing to merge

    const merge = sqlite.transaction(() => {
      // Canonical chat row must exist before messages are re-pointed onto it.
      sqlite.prepare("INSERT INTO chats (jid) VALUES (?) ON CONFLICT(jid) DO NOTHING").run(canonicalJid);

      // Drop messages whose (id) already exists under the canonical JID —
      // the canonical copy wins. PK is (id, chat_jid), so this clears the way
      // for the re-point UPDATE below.
      sqlite
        .prepare(
          "DELETE FROM messages WHERE chat_jid = ? AND id IN (SELECT id FROM messages WHERE chat_jid = ?)",
        )
        .run(staleJid, canonicalJid);

      // Relocate the surviving messages and canonicalize the sender column.
      sqlite.prepare("UPDATE messages SET chat_jid = ? WHERE chat_jid = ?").run(canonicalJid, staleJid);
      sqlite.prepare("UPDATE messages SET sender = ? WHERE sender = ?").run(canonicalJid, staleJid);

      // Fold chat metadata onto the canonical row, then drop the empty stale row.
      sqlite
        .prepare(
          `UPDATE chats SET
             name = COALESCE(name, (SELECT name FROM chats WHERE jid = :stale)),
             last_message_time = NULLIF(
               MAX(COALESCE(last_message_time, ''),
                   COALESCE((SELECT last_message_time FROM chats WHERE jid = :stale), '')),
               '')
           WHERE jid = :canon`,
        )
        .run({ stale: staleJid, canon: canonicalJid });
      sqlite.prepare("DELETE FROM chats WHERE jid = ?").run(staleJid);

      // Fold contact metadata onto the canonical row, then drop the stale row.
      sqlite
        .prepare(
          `INSERT INTO contacts (jid, name, notify, phone_number)
             SELECT ?, name, notify, phone_number FROM contacts WHERE jid = ?
           ON CONFLICT(jid) DO UPDATE SET
             name = COALESCE(contacts.name, excluded.name),
             notify = COALESCE(contacts.notify, excluded.notify),
             phone_number = COALESCE(contacts.phone_number, excluded.phone_number)`,
        )
        .run(canonicalJid, staleJid);
      sqlite.prepare("DELETE FROM contacts WHERE jid = ?").run(staleJid);
    });
    merge();
  } catch (error) {
    logError("Error merging chat pair", error);
  }
}

/** Read a value from the schema_meta key/value table. */
export function getMetaValue(key: string): string | null {
  try {
    const row = getDb()
      .select({ value: schema.schemaMeta.value })
      .from(schema.schemaMeta)
      .where(eq(schema.schemaMeta.key, key))
      .get();
    return row?.value ?? null;
  } catch (error) {
    logError("Error reading schema_meta", error);
    return null;
  }
}

/** Write a value into the schema_meta key/value table. */
export function setMetaValue(key: string, value: string): void {
  try {
    getDb()
      .insert(schema.schemaMeta)
      .values({ key, value })
      .onConflictDoUpdate({ target: schema.schemaMeta.key, set: { value } })
      .run();
  } catch (error) {
    logError("Error writing schema_meta", error);
  }
}

/** Every chat JID still stored in phone-number (`@s.whatsapp.net`) form. */
export function listPnChatJids(): string[] {
  try {
    const rows = getDb()
      .select({ jid: schema.chats.jid })
      .from(schema.chats)
      .where(like(schema.chats.jid, "%@s.whatsapp.net"))
      .all();
    return rows.map((r) => r.jid);
  } catch (error) {
    logError("Error listing PN chat jids", error);
    return [];
  }
}

/**
 * Record a mapping from a JID and its twin (e.g. `chat_jid` + `chat_jid_alt`).
 * No-op unless exactly one side is a LID and the other a phone-number JID.
 */
export function recordJidPair(a?: string | null, b?: string | null): void {
  if (!a || !b || a === b) return;
  if (isGroupJid(a) || isGroupJid(b)) return;
  const aLid = isLidJid(a);
  const bLid = isLidJid(b);
  if (aLid === bLid) return;
  recordJidMapping(aLid ? b : a, aLid ? a : b);
}

/** SQL predicate excluding chat/contact rows that are stale (non-canonical) aliases. */
function notStaleAlias(jidColumn: SQLWrapper): SQL {
  return sql`${jidColumn} NOT IN (SELECT jid FROM jid_aliases WHERE jid != canonical_jid)`;
}

export function storeChat(chat: Partial<Chat> & { jid: string }): void {
  const db = getDb();
  try {
    const jid = resolveCanonicalJid(chat.jid);
    db.insert(schema.chats)
      .values({
        jid,
        name: chat.name ?? null,
        lastMessageTime: chat.last_message_time instanceof Date
          ? chat.last_message_time.toISOString()
          : null,
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
    const chatJid = resolveCanonicalJid(message.chat_jid);
    const sender = message.sender ? resolveCanonicalJid(message.sender) : null;
    storeChat({ jid: chatJid, last_message_time: message.timestamp });

    db.insert(schema.messages)
      .values({
        id: message.id,
        chatJid,
        sender,
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
      })
      .onConflictDoUpdate({
        target: [schema.messages.id, schema.messages.chatJid],
        set: {
            sender,
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
      .where(eq(schema.chats.jid, chatJid))
      .run();

  } catch (error) {
    logError("Error storing message", error);
  }
}

function parseDateSafe(dateString: string | null | undefined): Date | null {
  if (!dateString) return null;
  const date = new Date(dateString);
  return isNaN(date.getTime()) ? null : date;
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
    media_object_key: row.media_object_key ?? null,
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
  media_object_key: schema.messages.mediaObjectKey,
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
    .where(inArray(schema.messages.chatJid, getAliasGroup(chatJid)))
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

    // Always exclude stale (non-canonical) alias rows so a LID/PN-merged
    // contact shows once, not twice.
    const chatFilters: SQL[] = [notStaleAlias(schema.chats.jid)];
    if (query) {
        chatFilters.push(
            or(
                like(sql`LOWER(${schema.chats.name})`, `%${query.toLowerCase()}%`),
                like(schema.chats.jid, `%${query}%`),
            ) as SQL,
        );
    }
    baseQuery = baseQuery.where(and(...chatFilters));

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
    // Resolve to the canonical identity and union messages across all twin
    // JIDs, so querying a stale @s.whatsapp.net JID still returns the chat.
    const canonicalJid = resolveCanonicalJid(jid);
    const group = getAliasGroup(jid);

    const lastMessageSq = db.$with('last_message').as(
        db.select({
            chatJid: schema.messages.chatJid,
            content: schema.messages.content,
            sender: schema.messages.sender,
            isFromMe: schema.messages.isFromMe,
        })
        .from(schema.messages)
        .where(inArray(schema.messages.chatJid, group))
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
    .where(eq(schema.chats.jid, canonicalJid));

    if (includeLastMessage) {
        // The subquery yields at most one row — join unconditionally so a
        // latest message stored under a twin JID is still picked up.
        baseQuery = baseQuery.leftJoin(lastMessageSq, sql`1 = 1`);
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
  chatJid: string,
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
    const group = getAliasGroup(chatJid);
    const targetRow = db.select(messageColumns)
    .from(schema.messages)
    .innerJoin(schema.chats, eq(schema.messages.chatJid, schema.chats.jid))
    .where(and(eq(schema.messages.id, messageId), inArray(schema.messages.chatJid, group)))
    .get();

    if (!targetRow) {
      return result;
    }

    result.target = rowToMessage(targetRow);
    const targetTimestamp = targetRow.timestamp!;

    const beforeRows = db.select(messageColumns)
    .from(schema.messages)
    .innerJoin(schema.chats, eq(schema.messages.chatJid, schema.chats.jid))
    .where(and(inArray(schema.messages.chatJid, group), lt(schema.messages.timestamp, targetTimestamp)))
    .orderBy(desc(schema.messages.timestamp))
    .limit(before)
    .all();

    result.before = beforeRows.map(rowToMessage).reverse();

    const afterRows = db.select(messageColumns)
    .from(schema.messages)
    .innerJoin(schema.chats, eq(schema.messages.chatJid, schema.chats.jid))
    .where(and(inArray(schema.messages.chatJid, group), sql`${schema.messages.timestamp} > ${targetTimestamp}`))
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
    .where(and(
      like(sql`LOWER(COALESCE(${schema.contacts.name}, ${schema.contacts.notify}, ${schema.contacts.phoneNumber}, ${schema.contacts.jid}))`, pattern.toLowerCase()),
      notStaleAlias(schema.contacts.jid),
    ))
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
      filters.push(inArray(schema.messages.chatJid, getAliasGroup(chatJid)));
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
      .where(and(eq(schema.messages.id, messageId), inArray(schema.messages.chatJid, getAliasGroup(chatJid))))
      .get();

    return row ? rowToMessage(row) : null;
  } catch (error) {
    logError("Error getting message by id", error);
    return null;
  }
}

export function getLatestMessage(chatJid: string): Message | null {
  const db = getDb();
  try {
    const row = db.select(messageColumns)
      .from(schema.messages)
      .innerJoin(schema.chats, eq(schema.messages.chatJid, schema.chats.jid))
      .where(inArray(schema.messages.chatJid, getAliasGroup(chatJid)))
      .orderBy(desc(schema.messages.timestamp))
      .limit(1)
      .get();
    return row ? rowToMessage(row) : null;
  } catch (error) {
    logError("Error getting latest message", error);
    return null;
  }
}

export function updateMessageMediaObjectKey(messageId: string, chatJid: string, objectKey: string): void {
  const db = getDb();
  try {
    db.update(schema.messages)
      .set({ mediaObjectKey: objectKey })
      .where(and(eq(schema.messages.id, messageId), inArray(schema.messages.chatJid, getAliasGroup(chatJid))))
      .run();
  } catch (error) {
    logError("Error updating media object key", error);
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
        jid: resolveCanonicalJid(contact.jid),
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
    .where(eq(schema.contacts.jid, resolveCanonicalJid(jid)))
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

    const filters: SQL[] = [notStaleAlias(schema.contacts.jid)];
    if (query) {
      filters.push(
        like(
          sql`LOWER(COALESCE(${schema.contacts.name}, ${schema.contacts.notify}, ${schema.contacts.phoneNumber}, ${schema.contacts.jid}))`,
          `%${query.toLowerCase()}%`,
        ),
      );
    }
    q = q.where(and(...filters));

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
      filters.push(inArray(schema.messages.chatJid, getAliasGroup(chatJid)));
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
