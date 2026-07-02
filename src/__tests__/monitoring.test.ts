import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  initializeDatabase,
  resetDatabase,
  storeChat,
  storeMessage,
  type Message,
} from "../database.ts";
import { getNewMessagesCore, waitForMessagesCore } from "../monitoring.ts";
import { emitInbound, resetInboundBus } from "../inbound-bus.ts";
import { markSentByUs, resetSentTracker } from "../webhooks/sent-tracker.ts";

function makeMsg(o: Partial<Message> & { id: string; chat_jid: string; content: string }): Message {
  return {
    timestamp: new Date("2025-06-01T12:00:00Z"),
    is_from_me: false,
    sender: "5511999999999@s.whatsapp.net",
    ...o,
  };
}

describe("monitoring core", () => {
  beforeEach(() => {
    initializeDatabase(":memory:");
    resetInboundBus();
    resetSentTracker();
    storeChat({ jid: "c1@s.whatsapp.net", name: "Clinic 1" });
    storeChat({ jid: "c2@s.whatsapp.net", name: "Clinic 2" });
  });

  afterEach(() => {
    resetDatabase();
    resetInboundBus();
    resetSentTracker();
  });

  describe("getNewMessagesCore", () => {
    it("returns only messages at/after the cursor, ascending, with next_since", () => {
      storeMessage(makeMsg({ id: "a", chat_jid: "c1@s.whatsapp.net", content: "A", timestamp: new Date("2025-06-01T10:00:00Z") }));
      storeMessage(makeMsg({ id: "b", chat_jid: "c1@s.whatsapp.net", content: "B", timestamp: new Date("2025-06-01T11:00:00Z") }));

      const res = getNewMessagesCore({ since: "2025-06-01T10:30:00.000Z" });
      expect(res.messages.map((m) => m.id)).toEqual(["b"]);
      // next_since is now an opaque, monotonic rowid cursor (row:<n>), not an
      // ISO timestamp — its defining property is that looping with it never
      // re-delivers a message it already returned.
      expect(res.next_since).toMatch(/^row:\d+$/);
      expect(getNewMessagesCore({ since: res.next_since }).messages).toEqual([]);
    });

    it("does NOT re-deliver the boundary message when looping with next_since", () => {
      // Regression for the observed duplicate: the old inclusive `gte` cursor
      // re-delivered the last message ("Amei." arrived twice). The rowid cursor
      // is exclusive, so a rolling loop sees each message exactly once.
      storeMessage(makeMsg({ id: "amei", chat_jid: "c1@s.whatsapp.net", content: "Amei.", timestamp: new Date("2025-06-01T11:00:00Z") }));

      const first = getNewMessagesCore({ since: "2025-06-01T00:00:00.000Z" });
      expect(first.messages.map((m) => m.id)).toEqual(["amei"]);

      const second = getNewMessagesCore({ since: first.next_since });
      expect(second.messages).toEqual([]);
    });

    it("does not lose a same-second message across the cursor boundary", () => {
      // Two messages at the SAME 1-second-resolution timestamp: a naive
      // exclusive `gt timestamp` cursor would drop the second. The rowid cursor
      // keeps them distinct.
      const t = new Date("2025-06-01T11:00:00Z");
      storeMessage(makeMsg({ id: "m1", chat_jid: "c1@s.whatsapp.net", content: "one", timestamp: t }));

      const first = getNewMessagesCore({ since: "2025-06-01T00:00:00.000Z" });
      expect(first.messages.map((m) => m.id)).toEqual(["m1"]);

      storeMessage(makeMsg({ id: "m2", chat_jid: "c1@s.whatsapp.net", content: "two", timestamp: t }));
      const second = getNewMessagesCore({ since: first.next_since });
      expect(second.messages.map((m) => m.id)).toEqual(["m2"]);
    });

    it("with no `since`, starts from now: no backfill, then sees the next message", () => {
      storeMessage(makeMsg({ id: "old", chat_jid: "c1@s.whatsapp.net", content: "old", timestamp: new Date("2025-06-01T09:00:00Z") }));

      const boot = getNewMessagesCore({});
      expect(boot.messages).toEqual([]); // established a high-water mark, no history
      expect(boot.next_since).toMatch(/^row:\d+$/);

      storeMessage(makeMsg({ id: "new", chat_jid: "c1@s.whatsapp.net", content: "new" }));
      const after = getNewMessagesCore({ since: boot.next_since });
      expect(after.messages.map((m) => m.id)).toEqual(["new"]);
    });

    it("filters to the given chats", () => {
      storeMessage(makeMsg({ id: "a", chat_jid: "c1@s.whatsapp.net", content: "A" }));
      storeMessage(makeMsg({ id: "b", chat_jid: "c2@s.whatsapp.net", content: "B" }));
      const res = getNewMessagesCore({ chatJids: ["c1@s.whatsapp.net"], since: "2025-06-01T00:00:00.000Z" });
      expect(res.messages.map((m) => m.id)).toEqual(["a"]);
    });

    it('treats ["*"] as all chats', () => {
      storeMessage(makeMsg({ id: "a", chat_jid: "c1@s.whatsapp.net", content: "A" }));
      storeMessage(makeMsg({ id: "b", chat_jid: "c2@s.whatsapp.net", content: "B" }));
      const res = getNewMessagesCore({ chatJids: ["*"], since: "2025-06-01T00:00:00.000Z" });
      expect(res.messages).toHaveLength(2);
    });

    it("excludes the agent's own sends (loop guard)", () => {
      storeMessage(makeMsg({ id: "mine", chat_jid: "c1@s.whatsapp.net", content: "agent reply", is_from_me: true }));
      markSentByUs("mine");
      const res = getNewMessagesCore({ since: "2025-06-01T00:00:00.000Z", includeFromMe: true });
      expect(res.messages).toHaveLength(0);
      // ...but the cursor still advances past it (rowid of the filtered row) so
      // we never re-scan it.
      expect(res.next_since).toMatch(/^row:\d+$/);
      expect(getNewMessagesCore({ since: res.next_since, includeFromMe: true }).messages).toEqual([]);
    });

    it("excludes is_from_me by default and includes it when asked", () => {
      storeMessage(makeMsg({ id: "me", chat_jid: "c1@s.whatsapp.net", content: "me typing", is_from_me: true }));
      expect(getNewMessagesCore({ since: "2025-06-01T00:00:00.000Z" }).messages).toHaveLength(0);
      expect(getNewMessagesCore({ since: "2025-06-01T00:00:00.000Z", includeFromMe: true }).messages).toHaveLength(1);
    });

    it("echoes the cursor when there is nothing new", () => {
      const res = getNewMessagesCore({ since: "2025-06-01T00:00:00.000Z" });
      expect(res.messages).toEqual([]);
      expect(res.next_since).toBe("2025-06-01T00:00:00.000Z");
    });
  });

  describe("waitForMessagesCore", () => {
    it("returns immediately when a message already arrived since the cursor", async () => {
      storeMessage(makeMsg({ id: "a", chat_jid: "c1@s.whatsapp.net", content: "A" }));
      const res = await waitForMessagesCore({ since: "2025-06-01T00:00:00.000Z", timeoutMs: 5000 });
      expect(res.messages.map((m) => m.id)).toEqual(["a"]);
    });

    it("blocks then returns the new message when one is emitted", async () => {
      const since = "2025-06-01T00:00:00.000Z";
      const p = waitForMessagesCore({ chatJids: ["c1@s.whatsapp.net"], since, timeoutMs: 5000 });
      // Persist, then wake — mirrors whatsapp.ts (store before emit).
      storeMessage(makeMsg({ id: "reply", chat_jid: "c1@s.whatsapp.net", content: "we have an opening" }));
      emitInbound({ id: "reply", chat_jid: "c1@s.whatsapp.net", is_from_me: false });
      const res = await p;
      expect(res.messages.map((m) => m.id)).toEqual(["reply"]);
      expect(res.next_since).toMatch(/^row:\d+$/);
    });

    it("returns empty on timeout", async () => {
      const res = await waitForMessagesCore({ since: "2025-06-01T00:00:00.000Z", timeoutMs: 20 });
      expect(res.messages).toEqual([]);
    });

    it("does not wake on a non-allow-listed chat", async () => {
      const res = await waitForMessagesCore({
        chatJids: ["c1@s.whatsapp.net"],
        since: "2025-06-01T00:00:00.000Z",
        timeoutMs: 40,
        onHeartbeat: () => {
          // emit an unrelated chat mid-wait; predicate must reject it
          emitInbound({ id: "x", chat_jid: "c2@s.whatsapp.net", is_from_me: false });
        },
        heartbeatMs: 5,
      });
      expect(res.messages).toEqual([]);
    });

    it("does not wake on the agent's own send echoing back", async () => {
      markSentByUs("echo");
      const res = await waitForMessagesCore({
        chatJids: ["c1@s.whatsapp.net"],
        since: "2025-06-01T00:00:00.000Z",
        timeoutMs: 40,
        heartbeatMs: 5,
        onHeartbeat: () => emitInbound({ id: "echo", chat_jid: "c1@s.whatsapp.net", is_from_me: true }),
      });
      expect(res.messages).toEqual([]);
    });
  });
});
