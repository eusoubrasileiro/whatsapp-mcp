#!/usr/bin/env node --experimental-strip-types
/**
 * SQLite -> Postgres migration script.
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." node --experimental-strip-types scripts/migrate-sqlite-to-postgres.ts /path/to/whatsapp.db
 *
 * Steps:
 *   1. Opens SQLite via better-sqlite3 (devDep).
 *   2. Upserts tenant "default" with displayName="Default (migrated)", writeToolsEnabled=true.
 *   3. Reads chats -> messages -> contacts from SQLite, batch-inserts into Postgres
 *      via Prisma (createMany skipDuplicates, batches of 1000).
 *   4. Optionally moves auth_info/ -> auth_info/default/.
 *   5. Prints verification counts.
 */

import type Database from "better-sqlite3";
import type { PrismaClient } from "@prisma/client";
import path from "node:path";
import fs from "node:fs";
import {
  transformChat,
  transformMessage,
  transformContact,
  type SqliteChatRow,
  type SqliteMessageRow,
  type SqliteContactRow,
} from "../src/scripts/migrate-transforms.ts";

const BATCH_SIZE = 1000;

export type MigrationStats = {
  chats: number;
  messages: number;
  contacts: number;
};

export async function migrateSqliteToPostgres(
  db: InstanceType<typeof Database>,
  prisma: PrismaClient,
  tenantId: string,
): Promise<MigrationStats> {
  // 1. Upsert tenant
  await prisma.tenant.upsert({
    where: { id: tenantId },
    create: {
      id: tenantId,
      displayName: "Default (migrated)",
      expectedWaNumber: process.env.EXPECTED_WA_NUMBER ?? "",
      writeToolsEnabled: true,
    },
    update: {},
  });

  // 2. Migrate chats
  const chatRows = db.prepare("SELECT jid, name, last_message_time FROM chats").all() as SqliteChatRow[];

  for (let i = 0; i < chatRows.length; i += BATCH_SIZE) {
    const batch = chatRows.slice(i, i + BATCH_SIZE).map((r) => transformChat(tenantId, r));
    await prisma.chat.createMany({ data: batch, skipDuplicates: true });
  }

  // 3. Migrate messages
  const msgStmt = db.prepare(`
    SELECT id, chat_jid, sender, content, timestamp, is_from_me,
           media_type, mimetype, media_key, direct_path, media_url,
           file_length, file_sha256, file_enc_sha256, media_object_key
    FROM messages
  `);

  let msgBatch: ReturnType<typeof transformMessage>[] = [];
  let msgTotal = 0;

  for (const row of msgStmt.iterate() as Iterable<SqliteMessageRow>) {
    msgBatch.push(transformMessage(tenantId, row));
    if (msgBatch.length >= BATCH_SIZE) {
      await prisma.message.createMany({ data: msgBatch, skipDuplicates: true });
      msgTotal += msgBatch.length;
      msgBatch = [];
    }
  }
  if (msgBatch.length > 0) {
    await prisma.message.createMany({ data: msgBatch, skipDuplicates: true });
    msgTotal += msgBatch.length;
  }

  // 4. Migrate contacts
  const contactRows = db.prepare("SELECT jid, name, notify, phone_number FROM contacts").all() as SqliteContactRow[];

  for (let i = 0; i < contactRows.length; i += BATCH_SIZE) {
    const batch = contactRows.slice(i, i + BATCH_SIZE).map((r) => transformContact(tenantId, r));
    await prisma.contact.createMany({ data: batch, skipDuplicates: true });
  }

  return {
    chats: chatRows.length,
    messages: msgTotal,
    contacts: contactRows.length,
  };
}

// CLI entry point
async function main() {
  const sqlitePath = process.argv[2];
  if (!sqlitePath) {
    console.error("Usage: node --experimental-strip-types scripts/migrate-sqlite-to-postgres.ts <path-to-whatsapp.db>");
    process.exit(1);
  }

  if (!fs.existsSync(sqlitePath)) {
    console.error(`SQLite database not found: ${sqlitePath}`);
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }

  const BetterSqlite3 = (await import("better-sqlite3")).default;
  const { PrismaClient } = await import("@prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");

  console.log(`Opening SQLite: ${sqlitePath}`);
  const db = new BetterSqlite3(sqlitePath, { readonly: true });

  console.log("Connecting to Postgres...");
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter });
  await prisma.$queryRawUnsafe("SELECT 1");
  console.log("Postgres connection ready.");

  const tenantId = "default";
  const stats = await migrateSqliteToPostgres(db, prisma, tenantId);

  // Move auth_info/ -> auth_info/default/ if flat layout exists
  const baseDir = path.dirname(sqlitePath).replace(/\/data$/, "");
  const authDir = path.join(baseDir, "auth_info");
  const tenantAuthDir = path.join(authDir, tenantId);

  if (fs.existsSync(authDir) && !fs.existsSync(tenantAuthDir)) {
    const entries = fs.readdirSync(authDir);
    if (entries.length > 0 && !entries.includes(tenantId)) {
      console.log(`Moving auth_info/ contents into auth_info/${tenantId}/`);
      fs.mkdirSync(tenantAuthDir, { recursive: true });
      for (const entry of entries) {
        fs.renameSync(path.join(authDir, entry), path.join(tenantAuthDir, entry));
      }
      console.log("auth_info reorganized for multi-tenant.");
    }
  }

  // Verification
  const pgChats = await prisma.chat.count({ where: { tenantId } });
  const pgMessages = await prisma.message.count({ where: { tenantId } });
  const pgContacts = await prisma.contact.count({ where: { tenantId } });

  console.log("\n=== Migration complete ===");
  console.log(`  SQLite chats:    ${stats.chats}  ->  Postgres: ${pgChats}`);
  console.log(`  SQLite messages: ${stats.messages}  ->  Postgres: ${pgMessages}`);
  console.log(`  SQLite contacts: ${stats.contacts}  ->  Postgres: ${pgContacts}`);

  db.close();
  await prisma.$disconnect();
}

// Only run main() when executed directly (not imported as a module)
const isDirectExecution = process.argv[1]?.includes("migrate-sqlite-to-postgres");
if (isDirectExecution) {
  main().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
