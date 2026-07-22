import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getChats,
  getMessagesWithDateFilter,
  getMetaValue,
  initializeDatabase,
  type Message,
  mergeChatPair,
  recordJidMapping,
  resetDatabase,
  setMetaValue,
  storeMessage,
} from "../database.ts";

// Observed fragmentation case (BUG-lid-contact-fragmentation.md, 2026-05-18).
const PN = "555177776666@s.whatsapp.net";
const LID = "11122233344455@lid";

function makeMsg(id: string, chatJid: string, iso: string): Message {
  return {
    id,
    chat_jid: chatJid,
    content: `msg ${id}`,
    timestamp: new Date(iso),
    is_from_me: false,
    sender: chatJid,
  };
}

describe("Phase 2 — physical chat merge", () => {
  beforeEach(() => {
    initializeDatabase(":memory:");
  });
  afterEach(() => {
    resetDatabase();
  });

  describe("mergeChatPair (regression: Carol Example)", () => {
    it("relocates the stale chat's messages onto the canonical LID and drops the stale row", () => {
      // Pre-LID history under the phone-number JID.
      storeMessage(makeMsg("old1", PN, "2026-05-13T10:00:00Z"));
      storeMessage(makeMsg("old2", PN, "2026-05-14T14:01:00Z"));
      // Post-migration messages under the LID.
      storeMessage(makeMsg("new1", LID, "2026-05-18T09:00:00Z"));

      mergeChatPair(PN, LID);

      // One chat, the LID; the PN chat is gone.
      expect(getChats().map((c) => c.jid)).toEqual([LID]);
      // All three messages now live under the LID, none lost.
      const merged = getMessagesWithDateFilter(LID);
      expect(merged.map((m) => m.id).sort()).toEqual(["new1", "old1", "old2"]);
      expect(merged.every((m) => m.chat_jid === LID)).toBe(true);
    });

    it("preserves the chat's most recent timestamp", () => {
      storeMessage(makeMsg("old", PN, "2026-05-14T14:01:00Z"));
      storeMessage(makeMsg("new", LID, "2026-05-18T09:00:00Z"));

      mergeChatPair(PN, LID);

      const chat = getChats()[0];
      expect(chat.last_message_time?.toISOString()).toBe("2026-05-18T09:00:00.000Z");
    });
  });

  describe("duplicate message ids", () => {
    it("keeps the canonical copy when the same id exists under both JIDs", () => {
      storeMessage(makeMsg("dup", PN, "2026-05-14T10:00:00Z"));
      storeMessage(makeMsg("uniq", PN, "2026-05-14T11:00:00Z"));
      storeMessage(makeMsg("dup", LID, "2026-05-18T10:00:00Z"));

      mergeChatPair(PN, LID);

      const merged = getMessagesWithDateFilter(LID);
      expect(merged.map((m) => m.id).sort()).toEqual(["dup", "uniq"]);
      // The surviving "dup" is the canonical (LID) copy — note its timestamp.
      const dup = merged.find((m) => m.id === "dup");
      expect(dup?.timestamp.toISOString()).toBe("2026-05-18T10:00:00.000Z");
    });
  });

  describe("idempotency & safety", () => {
    it("is a no-op when the stale chat does not exist", () => {
      storeMessage(makeMsg("a", LID, "2026-05-18T09:00:00Z"));
      mergeChatPair(PN, LID); // PN never existed
      expect(getMessagesWithDateFilter(LID)).toHaveLength(1);
    });

    it("loses no messages when run twice", () => {
      storeMessage(makeMsg("old", PN, "2026-05-14T10:00:00Z"));
      storeMessage(makeMsg("new", LID, "2026-05-18T10:00:00Z"));

      mergeChatPair(PN, LID);
      mergeChatPair(PN, LID); // second run — stale row already gone

      expect(
        getMessagesWithDateFilter(LID)
          .map((m) => m.id)
          .sort(),
      ).toEqual(["new", "old"]);
      expect(getChats().map((c) => c.jid)).toEqual([LID]);
    });
  });

  describe("recordJidMapping triggers the merge", () => {
    it("merges both chats the moment a mapping is recorded", () => {
      storeMessage(makeMsg("old", PN, "2026-05-14T10:00:00Z"));
      storeMessage(makeMsg("new", LID, "2026-05-18T10:00:00Z"));

      recordJidMapping(PN, LID);

      expect(getChats().map((c) => c.jid)).toEqual([LID]);
      expect(
        getMessagesWithDateFilter(PN)
          .map((m) => m.id)
          .sort(),
      ).toEqual(["new", "old"]);
    });
  });

  describe("schema_meta", () => {
    it("round-trips a value and returns null for an unknown key", () => {
      expect(getMetaValue("lid_backlog_merged")).toBeNull();
      setMetaValue("lid_backlog_merged", "1");
      expect(getMetaValue("lid_backlog_merged")).toBe("1");
    });
  });
});
