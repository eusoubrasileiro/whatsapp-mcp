import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import {
  initializeDatabase,
  resetDatabase,
  resolveDbPath,
  storeChat,
  storeMessage,
  storeContact,
  getMessages,
  getChats,
  getChat,
  getMessagesAround,
  getLatestMessage,
  getContactName,
  getContacts,
  getMessagesWithDateFilter,
  getMessagesSince,
  recordJidMapping,
  searchDbForContacts,
  searchMessages,
  getMessageById,
  updateMessageMediaObjectKey,
  type Message,
} from "../database.ts";

function makeMsg(overrides: Partial<Message> & { id: string; chat_jid: string; content: string }): Message {
  return {
    timestamp: new Date("2025-06-01T12:00:00Z"),
    is_from_me: false,
    sender: "5511999999999@s.whatsapp.net",
    ...overrides,
  };
}

describe("database", () => {
  beforeEach(() => {
    initializeDatabase(":memory:");
  });

  afterEach(() => {
    resetDatabase();
  });

  // ── storeChat / getChat ──────────────────────────────────────────

  describe("storeChat / getChat", () => {
    it("stores and retrieves a chat", () => {
      storeChat({ jid: "123@s.whatsapp.net", name: "Alice" });
      const chat = getChat("123@s.whatsapp.net", false);
      expect(chat).not.toBeNull();
      expect(chat!.jid).toBe("123@s.whatsapp.net");
      expect(chat!.name).toBe("Alice");
    });

    it("upsert preserves existing name when new name is null", () => {
      storeChat({ jid: "123@s.whatsapp.net", name: "Alice" });
      storeChat({ jid: "123@s.whatsapp.net" }); // name undefined
      const chat = getChat("123@s.whatsapp.net", false);
      expect(chat!.name).toBe("Alice");
    });

    it("returns null for nonexistent chat", () => {
      const chat = getChat("nonexistent@s.whatsapp.net", false);
      expect(chat).toBeNull();
    });
  });

  // ── storeMessage / getMessages ───────────────────────────────────

  describe("storeMessage / getMessages", () => {
    it("stores and retrieves messages", () => {
      storeMessage(makeMsg({ id: "msg1", chat_jid: "chat1@s.whatsapp.net", content: "Hello" }));
      storeMessage(makeMsg({ id: "msg2", chat_jid: "chat1@s.whatsapp.net", content: "World" }));

      const msgs = getMessages("chat1@s.whatsapp.net", 10, 0);
      expect(msgs).toHaveLength(2);
      expect(msgs.map((m) => m.content)).toContain("Hello");
      expect(msgs.map((m) => m.content)).toContain("World");
    });

    it("paginates correctly", () => {
      for (let i = 0; i < 5; i++) {
        storeMessage(makeMsg({
          id: `msg${i}`,
          chat_jid: "chat1@s.whatsapp.net",
          content: `Message ${i}`,
          timestamp: new Date(`2025-06-01T${String(i).padStart(2, "0")}:00:00Z`),
        }));
      }
      const page0 = getMessages("chat1@s.whatsapp.net", 2, 0);
      const page1 = getMessages("chat1@s.whatsapp.net", 2, 1);
      expect(page0).toHaveLength(2);
      expect(page1).toHaveLength(2);
      // Should be different messages (ordered by timestamp desc)
      expect(page0[0].id).not.toBe(page1[0].id);
    });

    it("returns empty array for nonexistent chat", () => {
      const msgs = getMessages("nonexistent@s.whatsapp.net", 10, 0);
      expect(msgs).toEqual([]);
    });

    it("upserts messages with same id+chat_jid", () => {
      storeMessage(makeMsg({ id: "msg1", chat_jid: "chat1@s.whatsapp.net", content: "Original" }));
      storeMessage(makeMsg({ id: "msg1", chat_jid: "chat1@s.whatsapp.net", content: "Updated" }));
      const msgs = getMessages("chat1@s.whatsapp.net", 10, 0);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].content).toBe("Updated");
    });
  });

  // ── getChats ─────────────────────────────────────────────────────

  describe("getChats", () => {
    it("lists chats sorted by last_active", () => {
      storeChat({ jid: "old@s.whatsapp.net", name: "Old", last_message_time: new Date("2025-01-01") });
      storeChat({ jid: "new@s.whatsapp.net", name: "New", last_message_time: new Date("2025-06-01") });

      const chats = getChats(10, 0, "last_active", null, false);
      expect(chats).toHaveLength(2);
      expect(chats[0].jid).toBe("new@s.whatsapp.net");
    });

    it("lists chats sorted by name", () => {
      storeChat({ jid: "b@s.whatsapp.net", name: "Bravo" });
      storeChat({ jid: "a@s.whatsapp.net", name: "Alpha" });

      const chats = getChats(10, 0, "name", null, false);
      expect(chats[0].name).toBe("Alpha");
      expect(chats[1].name).toBe("Bravo");
    });

    it("filters by query", () => {
      storeChat({ jid: "a@s.whatsapp.net", name: "Alice" });
      storeChat({ jid: "b@s.whatsapp.net", name: "Bob" });

      const chats = getChats(10, 0, "name", "alice", false);
      expect(chats).toHaveLength(1);
      expect(chats[0].name).toBe("Alice");
    });

    it("includes last message when requested", () => {
      storeMessage(makeMsg({
        id: "msg1",
        chat_jid: "chat1@s.whatsapp.net",
        content: "Last message content",
        is_from_me: true,
      }));

      const chats = getChats(10, 0, "last_active", null, true);
      expect(chats).toHaveLength(1);
      expect(chats[0].last_message).toBe("Last message content");
    });
  });

  // ── getMessagesAround ────────────────────────────────────────────

  describe("getMessagesAround", () => {
    it("returns context around a target message", () => {
      for (let i = 0; i < 10; i++) {
        storeMessage(makeMsg({
          id: `msg${i}`,
          chat_jid: "chat@s.whatsapp.net",
          content: `Message ${i}`,
          timestamp: new Date(`2025-06-01T${String(i).padStart(2, "0")}:00:00Z`),
        }));
      }

      const ctx = getMessagesAround("msg5", "chat@s.whatsapp.net", 2, 2);
      expect(ctx.target).not.toBeNull();
      expect(ctx.target!.content).toBe("Message 5");
      expect(ctx.before).toHaveLength(2);
      expect(ctx.after).toHaveLength(2);
    });

    it("returns empty for nonexistent message", () => {
      const ctx = getMessagesAround("nonexistent", "any@s.whatsapp.net", 2, 2);
      expect(ctx.target).toBeNull();
      expect(ctx.before).toEqual([]);
      expect(ctx.after).toEqual([]);
    });
  });

  // ── Contacts ─────────────────────────────────────────────────────

  describe("contacts", () => {
    it("stores and searches contacts", () => {
      storeContact({ jid: "123@s.whatsapp.net", name: "Alice Smith", notify: "Ali" });
      storeContact({ jid: "456@s.whatsapp.net", name: "Bob Jones", notify: "Bob" });

      const results = searchDbForContacts("alice", 10);
      expect(results).toHaveLength(1);
      expect(results[0].jid).toBe("123@s.whatsapp.net");
    });

    it("getContactName resolves display name", () => {
      storeContact({ jid: "123@s.whatsapp.net", name: "Alice" });
      expect(getContactName("123@s.whatsapp.net")).toBe("Alice");
    });

    it("getContactName falls back to notify", () => {
      storeContact({ jid: "123@s.whatsapp.net", notify: "Ali" });
      expect(getContactName("123@s.whatsapp.net")).toBe("Ali");
    });

    it("getContactName returns null for unknown jid", () => {
      expect(getContactName("unknown@s.whatsapp.net")).toBeNull();
    });

    it("getContacts lists all contacts", () => {
      storeContact({ jid: "a@s.whatsapp.net", name: "Alpha" });
      storeContact({ jid: "b@s.whatsapp.net", name: "Bravo" });

      const contacts = getContacts(undefined, 50);
      expect(contacts).toHaveLength(2);
    });

    it("getContacts filters by query", () => {
      storeContact({ jid: "a@s.whatsapp.net", name: "Alpha" });
      storeContact({ jid: "b@s.whatsapp.net", name: "Bravo" });

      const contacts = getContacts("alpha", 50);
      expect(contacts).toHaveLength(1);
      expect(contacts[0].name).toBe("Alpha");
    });

    it("upsert preserves existing name when new is null", () => {
      storeContact({ jid: "123@s.whatsapp.net", name: "Alice" });
      storeContact({ jid: "123@s.whatsapp.net", notify: "Ali2" });
      expect(getContactName("123@s.whatsapp.net")).toBe("Alice");
    });
  });

  // ── Date Filtering ───────────────────────────────────────────────

  describe("getMessagesWithDateFilter", () => {
    beforeEach(() => {
      storeMessage(makeMsg({
        id: "jan", chat_jid: "chat@s.whatsapp.net", content: "January",
        timestamp: new Date("2025-01-15T12:00:00Z"),
      }));
      storeMessage(makeMsg({
        id: "mar", chat_jid: "chat@s.whatsapp.net", content: "March",
        timestamp: new Date("2025-03-15T12:00:00Z"),
      }));
      storeMessage(makeMsg({
        id: "jun", chat_jid: "chat@s.whatsapp.net", content: "June",
        timestamp: new Date("2025-06-15T12:00:00Z"),
      }));
    });

    it("filters from a date", () => {
      const msgs = getMessagesWithDateFilter("chat@s.whatsapp.net", "2025-03-01T00:00:00Z", null, 10, 0);
      expect(msgs).toHaveLength(2);
      expect(msgs.map((m) => m.content)).toContain("March");
      expect(msgs.map((m) => m.content)).toContain("June");
    });

    it("filters up to a date", () => {
      const msgs = getMessagesWithDateFilter("chat@s.whatsapp.net", null, "2025-04-01T00:00:00Z", 10, 0);
      expect(msgs).toHaveLength(2);
      expect(msgs.map((m) => m.content)).toContain("January");
      expect(msgs.map((m) => m.content)).toContain("March");
    });

    it("filters date range", () => {
      const msgs = getMessagesWithDateFilter("chat@s.whatsapp.net", "2025-02-01T00:00:00Z", "2025-05-01T00:00:00Z", 10, 0);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].content).toBe("March");
    });

    it("returns all when no date filter", () => {
      const msgs = getMessagesWithDateFilter("chat@s.whatsapp.net", null, null, 10, 0);
      expect(msgs).toHaveLength(3);
    });

    it("filters across all chats when chatJid is null", () => {
      storeMessage(makeMsg({
        id: "other", chat_jid: "other@s.whatsapp.net", content: "Other",
        timestamp: new Date("2025-04-01T12:00:00Z"),
      }));
      const msgs = getMessagesWithDateFilter(null, "2025-03-01T00:00:00Z", "2025-05-01T00:00:00Z", 10, 0);
      expect(msgs).toHaveLength(2);
    });
  });

  // ── getMessagesSince (forward cursor) ────────────────────────────

  describe("getMessagesSince", () => {
    beforeEach(() => {
      storeMessage(makeMsg({
        id: "a", chat_jid: "c1@s.whatsapp.net", content: "A",
        timestamp: new Date("2025-06-01T10:00:00Z"),
      }));
      storeMessage(makeMsg({
        id: "b", chat_jid: "c1@s.whatsapp.net", content: "B",
        timestamp: new Date("2025-06-01T11:00:00Z"),
      }));
      storeMessage(makeMsg({
        id: "c", chat_jid: "c2@s.whatsapp.net", content: "C",
        timestamp: new Date("2025-06-01T12:00:00Z"),
      }));
    });

    it("returns only messages at or after the cursor (inclusive gte)", () => {
      const msgs = getMessagesSince(null, "2025-06-01T11:00:00.000Z");
      expect(msgs.map((m) => m.id)).toEqual(["b", "c"]);
    });

    it("orders results oldest-first (ascending)", () => {
      const msgs = getMessagesSince(null, "2025-06-01T00:00:00.000Z");
      expect(msgs.map((m) => m.id)).toEqual(["a", "b", "c"]);
    });

    it("filters to the given chats", () => {
      const msgs = getMessagesSince(["c1@s.whatsapp.net"], "2025-06-01T00:00:00.000Z");
      expect(msgs.map((m) => m.id)).toEqual(["a", "b"]);
    });

    it("honors the limit", () => {
      const msgs = getMessagesSince(null, "2025-06-01T00:00:00.000Z", 2);
      expect(msgs.map((m) => m.id)).toEqual(["a", "b"]);
    });

    it("returns empty when nothing is newer than the cursor", () => {
      const msgs = getMessagesSince(null, "2025-06-02T00:00:00.000Z");
      expect(msgs).toEqual([]);
    });

    it("matches via the LID/phone-number alias group", () => {
      const pn = "5511888888888@s.whatsapp.net";
      const lid = "111122223333@lid";
      recordJidMapping(pn, lid);
      storeChat({ jid: lid, name: "Aliased" });
      storeMessage(makeMsg({
        id: "x", chat_jid: lid, content: "via lid", sender: lid,
        timestamp: new Date("2025-06-01T13:00:00Z"),
      }));
      // Querying by the phone-number twin still finds the LID-keyed message.
      const msgs = getMessagesSince([pn], "2025-06-01T00:00:00.000Z");
      expect(msgs.map((m) => m.id)).toContain("x");
    });
  });

  // ── searchMessages ───────────────────────────────────────────────

  describe("searchMessages", () => {
    beforeEach(() => {
      storeMessage(makeMsg({ id: "m1", chat_jid: "c1@s.whatsapp.net", content: "Hello world" }));
      storeMessage(makeMsg({ id: "m2", chat_jid: "c1@s.whatsapp.net", content: "Goodbye world" }));
      storeMessage(makeMsg({ id: "m3", chat_jid: "c2@s.whatsapp.net", content: "Hello again" }));
    });

    it("searches across all chats", () => {
      const msgs = searchMessages("hello", null, null, null, 10, 0);
      expect(msgs).toHaveLength(2);
    });

    it("searches within a specific chat", () => {
      const msgs = searchMessages("hello", "c1@s.whatsapp.net", null, null, 10, 0);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].content).toBe("Hello world");
    });

    it("returns empty for no match", () => {
      const msgs = searchMessages("nonexistent", null, null, null, 10, 0);
      expect(msgs).toEqual([]);
    });

    it("supports date filtering in search", () => {
      storeMessage(makeMsg({
        id: "m4", chat_jid: "c1@s.whatsapp.net", content: "Hello old",
        timestamp: new Date("2024-01-01T12:00:00Z"),
      }));
      const msgs = searchMessages("hello", null, "2025-01-01T00:00:00Z", null, 10, 0);
      expect(msgs).toHaveLength(2); // m1 and m3, not m4
    });
  });

  // ── Media metadata storage ──────────────────────────────────────

  describe("media metadata", () => {
    it("stores and retrieves media metadata", () => {
      storeMessage(makeMsg({
        id: "media1",
        chat_jid: "chat@s.whatsapp.net",
        content: "[Image] Nice photo",
        media_type: "image",
        mimetype: "image/jpeg",
        media_key: "AQID",
        direct_path: "/v/t62.1234/image.enc",
        media_url: "https://mmg.whatsapp.net/image.enc",
        file_length: 54321,
        file_sha256: "ChQe",
        file_enc_sha256: "KDI8",
      }));

      const msgs = getMessages("chat@s.whatsapp.net", 10, 0);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].media_type).toBe("image");
      expect(msgs[0].mimetype).toBe("image/jpeg");
      expect(msgs[0].media_key).toBe("AQID");
      expect(msgs[0].direct_path).toBe("/v/t62.1234/image.enc");
      expect(msgs[0].file_length).toBe(54321);
    });

    it("preserves media metadata on upsert with COALESCE", () => {
      storeMessage(makeMsg({
        id: "media2",
        chat_jid: "chat@s.whatsapp.net",
        content: "[Image]",
        media_type: "image",
        media_key: "KEY123",
        direct_path: "/path/img.enc",
      }));

      // Re-store without media fields (simulating a text-only update)
      storeMessage(makeMsg({
        id: "media2",
        chat_jid: "chat@s.whatsapp.net",
        content: "[Image] Updated",
      }));

      const msgs = getMessages("chat@s.whatsapp.net", 10, 0);
      expect(msgs[0].media_key).toBe("KEY123");
      expect(msgs[0].direct_path).toBe("/path/img.enc");
      expect(msgs[0].content).toBe("[Image] Updated");
    });

    it("text messages have null media fields", () => {
      storeMessage(makeMsg({
        id: "text1",
        chat_jid: "chat@s.whatsapp.net",
        content: "Just text",
      }));

      const msgs = getMessages("chat@s.whatsapp.net", 10, 0);
      expect(msgs[0].media_type).toBeNull();
      expect(msgs[0].media_key).toBeNull();
      expect(msgs[0].media_object_key).toBeNull();
    });
  });

  // ── getMessageById ─────────────────────────────────────────────

  describe("getMessageById", () => {
    it("retrieves a specific message by id and chat_jid", () => {
      storeMessage(makeMsg({
        id: "specific1",
        chat_jid: "chat@s.whatsapp.net",
        content: "Find me",
        media_type: "image",
        media_key: "KEY",
      }));

      const msg = getMessageById("specific1", "chat@s.whatsapp.net");
      expect(msg).not.toBeNull();
      expect(msg!.content).toBe("Find me");
      expect(msg!.media_type).toBe("image");
    });

    it("returns null for nonexistent message", () => {
      const msg = getMessageById("nonexistent", "chat@s.whatsapp.net");
      expect(msg).toBeNull();
    });

    it("returns null when id matches but chat_jid differs", () => {
      storeMessage(makeMsg({
        id: "msg_in_chat_a",
        chat_jid: "chatA@s.whatsapp.net",
        content: "In chat A",
      }));

      const msg = getMessageById("msg_in_chat_a", "chatB@s.whatsapp.net");
      expect(msg).toBeNull();
    });
  });

  // ── getMessagesAround cross-chat disambiguation (Bug 2 regression) ─

  describe("getMessagesAround across chats", () => {
    it("returns the row from the requested chat when the same message id exists in two chats", () => {
      storeMessage(makeMsg({
        id: "shared_id",
        chat_jid: "chatA@s.whatsapp.net",
        content: "From A",
        timestamp: new Date("2025-06-01T10:00:00Z"),
      }));
      storeMessage(makeMsg({
        id: "shared_id",
        chat_jid: "chatB@s.whatsapp.net",
        content: "From B",
        timestamp: new Date("2025-06-01T11:00:00Z"),
      }));
      storeMessage(makeMsg({
        id: "ctx_a_before", chat_jid: "chatA@s.whatsapp.net", content: "ctx-A-before",
        timestamp: new Date("2025-06-01T09:00:00Z"),
      }));
      storeMessage(makeMsg({
        id: "ctx_a_after", chat_jid: "chatA@s.whatsapp.net", content: "ctx-A-after",
        timestamp: new Date("2025-06-01T10:30:00Z"),
      }));

      const ctxA = getMessagesAround("shared_id", "chatA@s.whatsapp.net", 5, 5);
      expect(ctxA.target).not.toBeNull();
      expect(ctxA.target!.content).toBe("From A");
      expect(ctxA.target!.chat_jid).toBe("chatA@s.whatsapp.net");
      expect(ctxA.before.map((m) => m.content)).toContain("ctx-A-before");
      expect(ctxA.after.map((m) => m.content)).toContain("ctx-A-after");
      expect(ctxA.before.every((m) => m.chat_jid === "chatA@s.whatsapp.net")).toBe(true);
      expect(ctxA.after.every((m) => m.chat_jid === "chatA@s.whatsapp.net")).toBe(true);

      const ctxB = getMessagesAround("shared_id", "chatB@s.whatsapp.net", 5, 5);
      expect(ctxB.target!.content).toBe("From B");
      expect(ctxB.target!.chat_jid).toBe("chatB@s.whatsapp.net");
    });

    it("returns null target when message id exists only in a different chat", () => {
      storeMessage(makeMsg({
        id: "only_in_a", chat_jid: "chatA@s.whatsapp.net", content: "x",
      }));
      const ctx = getMessagesAround("only_in_a", "chatB@s.whatsapp.net", 5, 5);
      expect(ctx.target).toBeNull();
    });
  });

  // ── getLatestMessage ─────────────────────────────────────────────

  describe("getLatestMessage", () => {
    it("returns the most recent message of a chat", () => {
      storeMessage(makeMsg({
        id: "old", chat_jid: "c@s.whatsapp.net", content: "old",
        timestamp: new Date("2025-06-01T08:00:00Z"),
      }));
      storeMessage(makeMsg({
        id: "newest", chat_jid: "c@s.whatsapp.net", content: "newest",
        timestamp: new Date("2025-06-01T12:00:00Z"),
      }));
      storeMessage(makeMsg({
        id: "mid", chat_jid: "c@s.whatsapp.net", content: "mid",
        timestamp: new Date("2025-06-01T10:00:00Z"),
      }));

      const latest = getLatestMessage("c@s.whatsapp.net");
      expect(latest).not.toBeNull();
      expect(latest!.id).toBe("newest");
    });

    it("returns null when chat has no messages", () => {
      expect(getLatestMessage("nobody@s.whatsapp.net")).toBeNull();
    });
  });

  // ── searchDbForContacts fallbacks ────────────────────────────────

  describe("searchDbForContacts fallbacks", () => {
    it("matches against notify when name is null", () => {
      storeContact({ jid: "x@s.whatsapp.net", notify: "Lalala" });
      const r = searchDbForContacts("lalala", 10);
      expect(r).toHaveLength(1);
      expect(r[0].name).toBe("Lalala");
    });

    it("matches against phone_number when name and notify are null", () => {
      storeContact({ jid: "x@s.whatsapp.net", phoneNumber: "+5531987654321" });
      const r = searchDbForContacts("31987", 10);
      expect(r).toHaveLength(1);
    });
  });

  // ── getContactName fallback chain ────────────────────────────────

  describe("getContactName fallback chain", () => {
    it("falls back to phone_number when name and notify are null", () => {
      storeContact({ jid: "x@s.whatsapp.net", phoneNumber: "+5531987" });
      expect(getContactName("x@s.whatsapp.net")).toBe("+5531987");
    });
  });

  // ── getChats last-message metadata ──────────────────────────────

  describe("getChats last-message metadata", () => {
    it("returns last_is_from_me for the most recent message", () => {
      storeMessage(makeMsg({
        id: "m1", chat_jid: "c@s.whatsapp.net", content: "older",
        timestamp: new Date("2025-06-01T10:00:00Z"),
        is_from_me: false, sender: "5511@s.whatsapp.net",
      }));
      storeMessage(makeMsg({
        id: "m2", chat_jid: "c@s.whatsapp.net", content: "newest",
        timestamp: new Date("2025-06-01T12:00:00Z"),
        is_from_me: true, sender: undefined,
      }));
      const chats = getChats(10, 0, "last_active", null, true);
      expect(chats).toHaveLength(1);
      expect(chats[0].last_message).toBe("newest");
      expect(chats[0].last_is_from_me).toBe(true);
    });
  });

  // ── getMessagesWithDateFilter pagination ─────────────────────────

  describe("getMessagesWithDateFilter pagination", () => {
    it("paginates results across two pages", () => {
      for (let i = 0; i < 5; i++) {
        storeMessage(makeMsg({
          id: `p${i}`, chat_jid: "c@s.whatsapp.net", content: `M${i}`,
          timestamp: new Date(`2025-06-01T${String(i).padStart(2, "0")}:00:00Z`),
        }));
      }
      const p0 = getMessagesWithDateFilter("c@s.whatsapp.net", null, null, 2, 0);
      const p1 = getMessagesWithDateFilter("c@s.whatsapp.net", null, null, 2, 1);
      expect(p0).toHaveLength(2);
      expect(p1).toHaveLength(2);
      expect(p0[0].id).not.toBe(p1[0].id);
    });
  });

});

describe("resolveDbPath", () => {
  const originalEnv = process.env.WHATSAPP_MCP_DATA_DIR;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.WHATSAPP_MCP_DATA_DIR = originalEnv;
    } else {
      delete process.env.WHATSAPP_MCP_DATA_DIR;
    }
  });

  it("uses WHATSAPP_MCP_DATA_DIR/data/whatsapp.db when env var is set", () => {
    process.env.WHATSAPP_MCP_DATA_DIR = "/tmp/wa-resolve-test";
    expect(resolveDbPath()).toBe("/tmp/wa-resolve-test/data/whatsapp.db");
  });

  it("falls back to repo-root/data/whatsapp.db when env var is unset", () => {
    delete process.env.WHATSAPP_MCP_DATA_DIR;
    const result = resolveDbPath();
    // src/database.ts → parent is src/ → one level up is repo root → data/whatsapp.db
    expect(result.endsWith(path.join("data", "whatsapp.db"))).toBe(true);
    // Must NOT resolve inside src/ (the previous buggy path included /src/../data which normalizes away)
    expect(path.basename(path.dirname(path.dirname(result)))).not.toBe("src");
  });

  it("explicit override wins over env var", () => {
    process.env.WHATSAPP_MCP_DATA_DIR = "/tmp/wa-resolve-test";
    expect(resolveDbPath("/custom/explicit.db")).toBe("/custom/explicit.db");
  });

  it(":memory: is passed through as-is", () => {
    process.env.WHATSAPP_MCP_DATA_DIR = "/tmp/wa-resolve-test";
    expect(resolveDbPath(":memory:")).toBe(":memory:");
  });
});

// ── updateMessageMediaObjectKey / getMessageById ────────────────────

describe("updateMessageMediaObjectKey", () => {
  beforeEach(() => initializeDatabase(":memory:"));
  afterEach(() => resetDatabase());

  it("persists media_object_key and getMessageById returns it", () => {
    storeMessage(makeMsg({
      id: "mok1",
      chat_jid: "chat@s.whatsapp.net",
      content: "photo",
      media_type: "image",
    }));

    updateMessageMediaObjectKey("mok1", "chat@s.whatsapp.net", "t/default/jid/mok1.jpg");

    const msg = getMessageById("mok1", "chat@s.whatsapp.net");
    expect(msg).not.toBeNull();
    expect(msg!.media_object_key).toBe("t/default/jid/mok1.jpg");
  });

  it("does not overwrite an unrelated message", () => {
    storeMessage(makeMsg({ id: "mok1", chat_jid: "chat@s.whatsapp.net", content: "a" }));
    storeMessage(makeMsg({ id: "mok2", chat_jid: "chat@s.whatsapp.net", content: "b" }));

    updateMessageMediaObjectKey("mok1", "chat@s.whatsapp.net", "t/default/jid/mok1.jpg");

    const other = getMessageById("mok2", "chat@s.whatsapp.net");
    expect(other!.media_object_key).toBeNull();
  });
});

// ── Boot-time ALTER TABLE idempotency for media_object_key ──────────

describe("initializeDatabase media_object_key migration idempotency", () => {
  afterEach(() => resetDatabase());

  it("runs twice without throwing (column already exists on second run)", () => {
    expect(() => initializeDatabase(":memory:")).not.toThrow();
    // Re-initialize same in-memory (different instance) — simulates server restart
    resetDatabase();
    expect(() => initializeDatabase(":memory:")).not.toThrow();
  });
});
