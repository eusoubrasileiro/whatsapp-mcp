import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import Database from "better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

import {
  setPrismaClient,
  resetPrismaClient,
} from "../db/client.ts";

/**
 * Tests for the SQLite -> Postgres migration script.
 *
 * Requires a real Postgres instance (docker-compose.dev.yaml).
 * Skip when no DB URL is set.
 *
 * Run with:
 *   docker compose -f docker-compose.dev.yaml up -d postgres
 *   pnpm exec prisma migrate deploy
 *   RUN_DB_TESTS=1 DATABASE_URL=postgresql://whatsapp_mcp:whatsapp_mcp_dev@localhost:5432/whatsapp_mcp pnpm test src/__tests__/migrate-sqlite-to-postgres.test.ts
 */

const runDbTests = process.env.RUN_DB_TESTS === "1" && !!process.env.DATABASE_URL;

describe.skipIf(!runDbTests)("migrate-sqlite-to-postgres", () => {
  let prisma: PrismaClient;
  let sqliteDb: InstanceType<typeof Database>;

  beforeAll(async () => {
    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
    prisma = new PrismaClient({ adapter });
    setPrismaClient(prisma);
    await prisma.$queryRawUnsafe("SELECT 1");
  });

  afterAll(async () => {
    await prisma.$disconnect();
    resetPrismaClient();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "messages", "chats", "contacts", "tenants" RESTART IDENTITY CASCADE`,
    );

    sqliteDb = new Database(":memory:");
    sqliteDb.exec(`
      CREATE TABLE chats (
        jid TEXT PRIMARY KEY,
        name TEXT,
        last_message_time TEXT
      );

      CREATE TABLE messages (
        id TEXT,
        chat_jid TEXT REFERENCES chats(jid),
        sender TEXT,
        content TEXT,
        timestamp TEXT,
        is_from_me INTEGER,
        media_type TEXT,
        mimetype TEXT,
        media_key TEXT,
        direct_path TEXT,
        media_url TEXT,
        file_length INTEGER,
        file_sha256 TEXT,
        file_enc_sha256 TEXT,
        media_object_key TEXT,
        PRIMARY KEY (id, chat_jid)
      );

      CREATE TABLE contacts (
        jid TEXT PRIMARY KEY,
        name TEXT,
        notify TEXT,
        phone_number TEXT
      );
    `);
  });

  function seedSqlite() {
    sqliteDb.prepare(
      `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
    ).run("5531@s.whatsapp.net", "Carlos", "2026-04-01T12:00:00.000Z");

    sqliteDb.prepare(
      `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
    ).run("group1@g.us", "Team Chat", "2026-04-01T14:00:00.000Z");

    sqliteDb.prepare(
      `INSERT INTO messages (id, chat_jid, sender, content, timestamp, is_from_me, media_type, mimetype, media_key, direct_path, media_url, file_length, file_sha256, file_enc_sha256, media_object_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("m1", "5531@s.whatsapp.net", "5531@s.whatsapp.net", "Hello!", "2026-04-01T12:00:00.000Z", 0, null, null, null, null, null, null, null, null, null);

    sqliteDb.prepare(
      `INSERT INTO messages (id, chat_jid, sender, content, timestamp, is_from_me, media_type, mimetype, media_key, direct_path, media_url, file_length, file_sha256, file_enc_sha256, media_object_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("m2", "5531@s.whatsapp.net", null, "Reply", "2026-04-01T12:01:00.000Z", 1, null, null, null, null, null, null, null, null, null);

    sqliteDb.prepare(
      `INSERT INTO messages (id, chat_jid, sender, content, timestamp, is_from_me, media_type, mimetype, media_key, direct_path, media_url, file_length, file_sha256, file_enc_sha256, media_object_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("m3", "5531@s.whatsapp.net", "5531@s.whatsapp.net", "Photo", "2026-04-01T12:02:00.000Z", 0, "image", "image/jpeg", "abc123", "/media/enc", "https://cdn.whatsapp.net/img", 4096, "sha256hash", "encsha256", "t/default/5531/m3.jpg");

    sqliteDb.prepare(
      `INSERT INTO contacts (jid, name, notify, phone_number) VALUES (?, ?, ?, ?)`,
    ).run("5531@s.whatsapp.net", "Carlos Silva", "Carlinho", "5531999999999");

    sqliteDb.prepare(
      `INSERT INTO contacts (jid, name, notify, phone_number) VALUES (?, ?, ?, ?)`,
    ).run("5511@s.whatsapp.net", null, "Denis", null);
  }

  it("migrates chats, messages, and contacts from SQLite to Postgres under tenant 'default'", async () => {
    seedSqlite();

    const { migrateSqliteToPostgres } = await import("../../scripts/migrate-sqlite-to-postgres.ts");
    const stats = await migrateSqliteToPostgres(sqliteDb, prisma, "default");

    expect(stats.chats).toBe(2);
    expect(stats.messages).toBe(3);
    expect(stats.contacts).toBe(2);

    const chats = await prisma.chat.findMany({ where: { tenantId: "default" } });
    expect(chats).toHaveLength(2);
    const carlosChat = chats.find((c) => c.jid === "5531@s.whatsapp.net");
    expect(carlosChat?.name).toBe("Carlos");
    expect(carlosChat?.lastMessageTime?.toISOString()).toBe("2026-04-01T12:00:00.000Z");

    const messages = await prisma.message.findMany({
      where: { tenantId: "default" },
      orderBy: { timestamp: "asc" },
    });
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe("Hello!");
    expect(messages[0].isFromMe).toBe(false);
    expect(messages[2].mediaType).toBe("image");
    expect(messages[2].mediaObjectKey).toBe("t/default/5531/m3.jpg");

    const contacts = await prisma.contact.findMany({ where: { tenantId: "default" } });
    expect(contacts).toHaveLength(2);
    const carlos = contacts.find((c) => c.jid === "5531@s.whatsapp.net");
    expect(carlos?.name).toBe("Carlos Silva");
    expect(carlos?.notify).toBe("Carlinho");
    expect(carlos?.phoneNumber).toBe("5531999999999");
  });

  it("creates the tenant row if it does not exist", async () => {
    seedSqlite();

    const { migrateSqliteToPostgres } = await import("../../scripts/migrate-sqlite-to-postgres.ts");
    await migrateSqliteToPostgres(sqliteDb, prisma, "default");

    const tenant = await prisma.tenant.findUnique({ where: { id: "default" } });
    expect(tenant).not.toBeNull();
    expect(tenant!.displayName).toBe("Default (migrated)");
  });

  it("is idempotent — re-running does not duplicate rows", async () => {
    seedSqlite();

    const { migrateSqliteToPostgres } = await import("../../scripts/migrate-sqlite-to-postgres.ts");
    await migrateSqliteToPostgres(sqliteDb, prisma, "default");
    await migrateSqliteToPostgres(sqliteDb, prisma, "default");

    const chats = await prisma.chat.findMany({ where: { tenantId: "default" } });
    expect(chats).toHaveLength(2);

    const messages = await prisma.message.findMany({ where: { tenantId: "default" } });
    expect(messages).toHaveLength(3);

    const contacts = await prisma.contact.findMany({ where: { tenantId: "default" } });
    expect(contacts).toHaveLength(2);
  });

  it("handles empty SQLite database gracefully", async () => {
    const { migrateSqliteToPostgres } = await import("../../scripts/migrate-sqlite-to-postgres.ts");
    const stats = await migrateSqliteToPostgres(sqliteDb, prisma, "default");

    expect(stats.chats).toBe(0);
    expect(stats.messages).toBe(0);
    expect(stats.contacts).toBe(0);
  });

  it("migrates messages with NULL content", async () => {
    sqliteDb.prepare(
      `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
    ).run("c1@s.whatsapp.net", "Test", "2026-04-01T12:00:00.000Z");

    sqliteDb.prepare(
      `INSERT INTO messages (id, chat_jid, sender, content, timestamp, is_from_me)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("m-null", "c1@s.whatsapp.net", null, null, "2026-04-01T12:00:00.000Z", 1);

    const { migrateSqliteToPostgres } = await import("../../scripts/migrate-sqlite-to-postgres.ts");
    const stats = await migrateSqliteToPostgres(sqliteDb, prisma, "default");

    expect(stats.messages).toBe(1);
    const msg = await prisma.message.findFirst({
      where: { tenantId: "default", id: "m-null" },
    });
    expect(msg?.content).toBeNull();
  });
});
