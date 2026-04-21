import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

import {
  setPrismaClient,
  resetPrismaClient,
  disconnectPrisma,
} from "../db/client.ts";
import {
  storeChat,
  storeMessage,
  storeContact,
  updateMessageMediaObjectKey,
  listMessages,
  listMessagesWithDateFilter,
  listChats,
  getChat,
  getMessagesAround,
  searchContacts,
  searchMessages,
  getMessageById,
  getContactName,
  listContacts,
  type Message,
} from "../db/queries.ts";

/**
 * Tenant-isolation tests for the Prisma query layer.
 *
 * These run against a real Postgres (the local dev `postgres` service or any
 * DATABASE_URL). The migration must already be applied. Skip when no DB URL
 * is set — keeps the default `pnpm test` fast and docker-free.
 *
 * Run with:
 *   docker compose -f docker-compose.dev.yaml up -d postgres
 *   pnpm exec prisma migrate deploy
 *   RUN_DB_TESTS=1 pnpm test src/__tests__/queries.test.ts
 */

const runDbTests = process.env.RUN_DB_TESTS === "1" && !!process.env.DATABASE_URL;

describe.skipIf(!runDbTests)("queries (multi-tenant, Postgres)", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
    prisma = new PrismaClient({ adapter });
    setPrismaClient(prisma);

    // Ensure schema applied.
    await prisma.$queryRawUnsafe("SELECT 1");
  });

  afterAll(async () => {
    await prisma.$disconnect();
    resetPrismaClient();
    await disconnectPrisma();
  });

  beforeEach(async () => {
    // Truncate in FK-safe order.
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "messages", "chats", "contacts", "tenants" RESTART IDENTITY CASCADE`,
    );
    await prisma.tenant.createMany({
      data: [
        { id: "t-alice", displayName: "Alice", expectedWaNumber: "5531" },
        { id: "t-bob", displayName: "Bob", expectedWaNumber: "5511" },
      ],
    });
  });

  function msg(overrides: Partial<Message> & { id: string; chat_jid: string; content: string }): Message {
    return {
      timestamp: new Date("2026-04-01T12:00:00Z"),
      is_from_me: false,
      sender: "5531@s.whatsapp.net",
      ...overrides,
    };
  }

  describe("storeChat / getChat / listChats", () => {
    it("isolates chats between tenants", async () => {
      await storeChat("t-alice", { jid: "alice-chat@s.whatsapp.net", name: "Alice's chat" });
      await storeChat("t-bob", { jid: "bob-chat@s.whatsapp.net", name: "Bob's chat" });

      const aliceChats = await listChats("t-alice", 10, 0, "last_active", null, false);
      const bobChats = await listChats("t-bob", 10, 0, "last_active", null, false);

      expect(aliceChats).toHaveLength(1);
      expect(aliceChats[0].jid).toBe("alice-chat@s.whatsapp.net");
      expect(bobChats).toHaveLength(1);
      expect(bobChats[0].jid).toBe("bob-chat@s.whatsapp.net");
    });

    it("upsert preserves name when new name is null", async () => {
      await storeChat("t-alice", { jid: "c1@s.whatsapp.net", name: "Original" });
      await storeChat("t-alice", { jid: "c1@s.whatsapp.net" });
      const chat = await getChat("t-alice", "c1@s.whatsapp.net", false);
      expect(chat?.name).toBe("Original");
    });

    it("getChat returns null for a chat in another tenant", async () => {
      await storeChat("t-alice", { jid: "c1@s.whatsapp.net", name: "X" });
      expect(await getChat("t-bob", "c1@s.whatsapp.net", false)).toBeNull();
    });
  });

  describe("storeMessage / listMessages / listMessagesWithDateFilter", () => {
    it("isolates messages between tenants and advances chat.last_message_time", async () => {
      await storeMessage("t-alice", msg({ id: "m1", chat_jid: "c1@s.whatsapp.net", content: "Hi Alice", timestamp: new Date("2026-04-01T10:00:00Z") }));
      await storeMessage("t-alice", msg({ id: "m2", chat_jid: "c1@s.whatsapp.net", content: "Later", timestamp: new Date("2026-04-01T11:00:00Z") }));
      await storeMessage("t-bob", msg({ id: "m3", chat_jid: "c1@s.whatsapp.net", content: "Hi Bob", timestamp: new Date("2026-04-01T09:00:00Z") }));

      const aliceMsgs = await listMessages("t-alice", "c1@s.whatsapp.net");
      const bobMsgs = await listMessages("t-bob", "c1@s.whatsapp.net");
      expect(aliceMsgs.map((m) => m.content)).toEqual(["Later", "Hi Alice"]);
      expect(bobMsgs.map((m) => m.content)).toEqual(["Hi Bob"]);

      const aliceChat = await getChat("t-alice", "c1@s.whatsapp.net", false);
      expect(aliceChat?.last_message_time?.toISOString()).toBe(new Date("2026-04-01T11:00:00Z").toISOString());
    });

    it("listMessagesWithDateFilter respects fromDate/toDate", async () => {
      await storeMessage("t-alice", msg({ id: "a", chat_jid: "c1@s.whatsapp.net", content: "old", timestamp: new Date("2026-01-01T00:00:00Z") }));
      await storeMessage("t-alice", msg({ id: "b", chat_jid: "c1@s.whatsapp.net", content: "recent", timestamp: new Date("2026-04-01T00:00:00Z") }));
      const out = await listMessagesWithDateFilter(
        "t-alice",
        "c1@s.whatsapp.net",
        "2026-03-01T00:00:00Z",
        null,
      );
      expect(out.map((m) => m.content)).toEqual(["recent"]);
    });
  });

  describe("searchMessages (accent-insensitive ILIKE)", () => {
    it("finds matches in the right tenant only", async () => {
      await storeMessage("t-alice", msg({ id: "a1", chat_jid: "c1@s.whatsapp.net", content: "pagamento via Pix" }));
      await storeMessage("t-bob", msg({ id: "b1", chat_jid: "c1@s.whatsapp.net", content: "pagamento via Pix" }));

      const aliceHits = await searchMessages("t-alice", "pix");
      const bobHits = await searchMessages("t-bob", "pix");
      expect(aliceHits).toHaveLength(1);
      expect(bobHits).toHaveLength(1);
      expect(aliceHits[0].id).toBe("a1");
    });

    it("ignores accents", async () => {
      await storeMessage("t-alice", msg({ id: "a", chat_jid: "c1@s.whatsapp.net", content: "confirmação enviada" }));
      const hits = await searchMessages("t-alice", "confirmacao");
      expect(hits).toHaveLength(1);
    });
  });

  describe("contacts", () => {
    it("storeContact + searchContacts + listContacts + getContactName isolate by tenant", async () => {
      await storeContact("t-alice", { jid: "5531@s.whatsapp.net", name: "Carlos" });
      await storeContact("t-bob", { jid: "5511@s.whatsapp.net", name: "Denis" });

      expect((await searchContacts("t-alice", "Car")).length).toBe(1);
      expect((await searchContacts("t-bob", "Car")).length).toBe(0);

      expect(await getContactName("t-alice", "5531@s.whatsapp.net")).toBe("Carlos");
      expect(await getContactName("t-bob", "5531@s.whatsapp.net")).toBeNull();

      expect((await listContacts("t-alice")).length).toBe(1);
    });
  });

  describe("getMessagesAround / getMessageById / updateMessageMediaObjectKey", () => {
    it("returns before/target/after only from the target's tenant", async () => {
      const chat = "cc@s.whatsapp.net";
      await storeMessage("t-alice", msg({ id: "a1", chat_jid: chat, content: "1", timestamp: new Date("2026-04-01T10:00:00Z") }));
      await storeMessage("t-alice", msg({ id: "a2", chat_jid: chat, content: "2", timestamp: new Date("2026-04-01T10:01:00Z") }));
      await storeMessage("t-alice", msg({ id: "a3", chat_jid: chat, content: "3 target", timestamp: new Date("2026-04-01T10:02:00Z") }));
      await storeMessage("t-alice", msg({ id: "a4", chat_jid: chat, content: "4", timestamp: new Date("2026-04-01T10:03:00Z") }));
      await storeMessage("t-bob", msg({ id: "a3", chat_jid: chat, content: "bob-conflict", timestamp: new Date("2026-04-01T10:02:00Z") }));

      const ctx = await getMessagesAround("t-alice", "a3", 2, 1);
      expect(ctx.target?.content).toBe("3 target");
      expect(ctx.before.map((m) => m.content)).toEqual(["1", "2"]);
      expect(ctx.after.map((m) => m.content)).toEqual(["4"]);
    });

    it("getMessageById scopes to tenant", async () => {
      const chat = "cc@s.whatsapp.net";
      await storeMessage("t-alice", msg({ id: "x", chat_jid: chat, content: "alice only" }));
      expect((await getMessageById("t-alice", "x", chat))?.content).toBe("alice only");
      expect(await getMessageById("t-bob", "x", chat)).toBeNull();
    });

    it("updateMessageMediaObjectKey only affects the correct tenant row", async () => {
      const chat = "cc@s.whatsapp.net";
      await storeMessage("t-alice", msg({ id: "m", chat_jid: chat, content: "alice", media_type: "image", media_key: "k", direct_path: "/p" }));
      await storeMessage("t-bob", msg({ id: "m", chat_jid: chat, content: "bob", media_type: "image", media_key: "k", direct_path: "/p" }));

      await updateMessageMediaObjectKey("t-alice", "m", chat, "t/alice/key.jpg");
      const a = await getMessageById("t-alice", "m", chat);
      const b = await getMessageById("t-bob", "m", chat);
      expect(a?.media_object_key).toBe("t/alice/key.jpg");
      expect(b?.media_object_key).toBeNull();
    });
  });
});
