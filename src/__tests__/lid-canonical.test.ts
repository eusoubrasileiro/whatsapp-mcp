import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getAliasGroup,
  getChats,
  getMessagesWithDateFilter,
  initializeDatabase,
  recordJidMapping,
  recordJidPair,
  resetDatabase,
  resolveCanonicalJid,
  searchDbForContacts,
  storeContact,
  storeMessage,
  type Message,
} from "../database.ts";

// Observed fragmentation case (BUG-lid-contact-fragmentation.md, 2026-05-18).
const PN = "555177776666@s.whatsapp.net";
const LID = "11122233344455@lid";

function makeMsg(overrides: Partial<Message> & { id: string; chat_jid: string }): Message {
  return {
    content: "msg",
    timestamp: new Date("2026-05-14T12:00:00Z"),
    is_from_me: false,
    sender: overrides.chat_jid,
    ...overrides,
  };
}

describe("LID/phone-number canonicalization", () => {
  beforeEach(() => {
    initializeDatabase(":memory:");
  });
  afterEach(() => {
    resetDatabase();
  });

  describe("resolveCanonicalJid", () => {
    it("returns the JID unchanged when no mapping exists", () => {
      expect(resolveCanonicalJid(PN)).toBe(PN);
    });

    it("passes group JIDs through untouched", () => {
      expect(resolveCanonicalJid("123456789@g.us")).toBe("123456789@g.us");
    });

    it("resolves both PN and LID to the LID once a mapping is recorded", () => {
      recordJidMapping(PN, LID);
      expect(resolveCanonicalJid(PN)).toBe(LID);
      expect(resolveCanonicalJid(LID)).toBe(LID);
    });
  });

  describe("recordJidPair", () => {
    it("records a PN/LID pair regardless of argument order", () => {
      recordJidPair(LID, PN);
      expect(resolveCanonicalJid(PN)).toBe(LID);
    });

    it("is a no-op when both JIDs are the same type", () => {
      recordJidPair(PN, "5511888888888@s.whatsapp.net");
      expect(resolveCanonicalJid(PN)).toBe(PN);
    });

    it("is a no-op when a twin is missing", () => {
      recordJidPair(PN, null);
      expect(resolveCanonicalJid(PN)).toBe(PN);
    });
  });

  describe("getAliasGroup", () => {
    it("returns just the JID itself when no mapping exists", () => {
      expect(getAliasGroup(PN)).toEqual([PN]);
    });

    it("returns both twin JIDs once mapped", () => {
      recordJidMapping(PN, LID);
      expect(getAliasGroup(PN).sort()).toEqual([LID, PN].sort());
      expect(getAliasGroup(LID).sort()).toEqual([LID, PN].sort());
    });
  });

  describe("ingest canonicalization", () => {
    it("writes a message under the canonical LID once the chat is mapped", () => {
      recordJidMapping(PN, LID);
      storeMessage(makeMsg({ id: "m1", chat_jid: PN }));

      // Stored under LID even though chat_jid was the PN JID.
      const underLid = getMessagesWithDateFilter(LID);
      expect(underLid).toHaveLength(1);
      expect(underLid[0].chat_jid).toBe(LID);
    });
  });

  describe("read-side dedup (regression: Carol Example)", () => {
    it("returns the LID twin's recent messages when querying the stale PN JID", () => {
      // Old history filed under the phone-number JID, before migration.
      storeMessage(
        makeMsg({ id: "old", chat_jid: PN, timestamp: new Date("2026-05-14T14:01:00Z") }),
      );
      // A migrated message arrives LID-addressed, carrying the PN as its twin.
      recordJidPair(LID, PN);
      storeMessage(
        makeMsg({ id: "new", chat_jid: LID, timestamp: new Date("2026-05-18T09:00:00Z") }),
      );

      // Querying the stale PN JID must surface BOTH messages, newest first.
      const messages = getMessagesWithDateFilter(PN);
      expect(messages.map((m) => m.id)).toEqual(["new", "old"]);
    });

    it("lists one chat per identity, not two", () => {
      storeMessage(makeMsg({ id: "old", chat_jid: PN }));
      recordJidPair(LID, PN);
      storeMessage(makeMsg({ id: "new", chat_jid: LID }));

      const chats = getChats();
      const jids = chats.map((c) => c.jid);
      expect(jids).toEqual([LID]);
    });

    it("returns one contact per identity from search_contacts", () => {
      storeContact({ jid: PN, name: "Carol Example" });
      recordJidMapping(PN, LID);

      const found = searchDbForContacts("Carol");
      expect(found).toHaveLength(1);
      // The name survives the merge even though it was recorded against the PN.
      expect(found[0].jid).toBe(LID);
      expect(found[0].name).toBe("Carol Example");
    });
  });
});
