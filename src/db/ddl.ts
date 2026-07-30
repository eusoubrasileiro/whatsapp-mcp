/**
 * The hand-written schema bootstrap, applied on every `initializeDatabase()`.
 *
 * There is no drizzle-kit runner in this project: `db/schema.ts` describes the
 * tables for the query builder, and this file is what actually creates them at
 * runtime. **Both must agree** — a table declared only in `schema.ts` does not
 * exist in a fresh container, and typed queries against it fail at the first
 * call.
 *
 * Every statement here is idempotent (`IF NOT EXISTS`, or an `ALTER TABLE`
 * wrapped in a try), because it runs against long-lived production databases as
 * well as empty ones — that is the migration strategy.
 *
 * Extracted verbatim from `database.ts`, which the quality-gate ratchet freezes
 * at its current size (splitting it further is separate work — see CLAUDE.md,
 * "What We Won't Build"). Keeping the DDL in its own module means a new table
 * lands next to the existing blocks instead of growing the frozen monolith.
 */

import type Database from "better-sqlite3";

/** Create every table, index and additive column the app expects. Idempotent. */
export function applySchemaDdl(sqlite: Database.Database): void {
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

  // Durable refused-recipient blocklist (src/send-blocklist.ts). A row here
  // outlives the session that earned it, which is the whole point: an in-session
  // "DO NOT RETRY" did not stop three later sessions from re-attempting a
  // recipient WhatsApp had already refused.
  sqlite.exec(`
      CREATE TABLE IF NOT EXISTS send_blocklist (
        jid TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        code TEXT,
        first_refused_at TEXT NOT NULL,
        last_refused_at TEXT NOT NULL,
        refusal_count INTEGER NOT NULL DEFAULT 1,
        detail TEXT
      );
    `);

  sqlite.exec(`
      CREATE TABLE IF NOT EXISTS webhook_subscriptions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        target_url TEXT NOT NULL,
        secret TEXT,
        auth_mode TEXT NOT NULL DEFAULT 'hmac',
        allowed_jids TEXT NOT NULL,
        transcribe INTEGER NOT NULL DEFAULT 1,
        include_from_me INTEGER NOT NULL DEFAULT 0,
        label TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  sqlite.exec(
    `CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_tenant_active ON webhook_subscriptions (tenant_id, active);`,
  );
  // Migration for DBs created before include_from_me existed (safe to re-run).
  try {
    sqlite.exec(
      `ALTER TABLE webhook_subscriptions ADD COLUMN include_from_me INTEGER NOT NULL DEFAULT 0;`,
    );
  } catch {
    // Column already exists — ignore.
  }

  sqlite.exec(
    `CREATE INDEX IF NOT EXISTS idx_jid_aliases_canonical ON jid_aliases (canonical_jid);`,
  );
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages (timestamp);`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_messages_chat_jid ON messages (chat_jid);`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages (sender);`);
  sqlite.exec(
    `CREATE INDEX IF NOT EXISTS idx_chats_last_message_time ON chats (last_message_time);`,
  );

  // Media columns migration (safe to run on existing DBs)
  const mediaColumns = [
    ["media_type", "TEXT"],
    ["mimetype", "TEXT"],
    ["media_key", "TEXT"],
    ["direct_path", "TEXT"],
    ["media_url", "TEXT"],
    ["file_length", "INTEGER"],
    ["file_sha256", "TEXT"],
    ["file_enc_sha256", "TEXT"],
    ["media_object_key", "TEXT"],
  ] as const;
  for (const [col, type] of mediaColumns) {
    try {
      sqlite.exec(`ALTER TABLE messages ADD COLUMN ${col} ${type};`);
    } catch {
      // Column already exists — ignore
    }
  }
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_messages_media_type ON messages (media_type);`);
}
