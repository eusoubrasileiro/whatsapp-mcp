import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getChat,
  getChats,
  getDb,
  getMessages,
  initializeDatabase,
  resetDatabase,
  storeChat,
  storeContact,
  storeMessage,
} from "../database.ts";
import { makeMessage } from "./helpers/make-message.ts";

// WhatsApp sends no chat name for a 1:1 LID chat, so `chats.name` stays NULL
// while the address book lands in `contacts`. Every chat-facing read must show
// the person's name, not the bare LID (2026-11-18, the "empresa" line: 162 of
// 163 chats nameless while 434 contacts were named).

const LID = "147656714260715@lid";
const PN = "553199990000@s.whatsapp.net";

/** A contact row stored under a JID exactly as given, bypassing canonicalisation. */
function rawContact(jid: string, name: string) {
  getDb().run(sql`INSERT INTO contacts (jid, name) VALUES (${jid}, ${name})`);
}

/** An alias pair stored without the chat merge that recordJidMapping performs. */
function rawAlias(pnJid: string, lidJid: string) {
  for (const jid of [pnJid, lidJid]) {
    getDb().run(
      sql`INSERT INTO jid_aliases (jid, canonical_jid, pn_jid, lid_jid, updated_at)
          VALUES (${jid}, ${lidJid}, ${pnJid}, ${lidJid}, '2026-11-18')`,
    );
  }
}

describe("chat display name", () => {
  beforeEach(() => {
    initializeDatabase(":memory:");
  });

  afterEach(() => {
    resetDatabase();
  });

  it("lists a nameless LID chat under its contact's name", () => {
    storeChat({ jid: LID, last_message_time: new Date("2026-11-17T16:23:12Z") });
    storeContact({ jid: LID, name: "Maxwell BNI" });

    expect(getChats(10, 0, "last_active", null, false)[0]?.name).toBe("Maxwell BNI");
    expect(getChat(LID, false)?.name).toBe("Maxwell BNI");
  });

  it("finds the name when the contact sits on the phone-number twin", () => {
    rawAlias(PN, LID);
    storeChat({ jid: LID });
    rawContact(PN, "Regis");

    expect(getChat(LID, false)?.name).toBe("Regis");
  });

  it("falls back to the push name when the address book has none", () => {
    storeChat({ jid: LID });
    storeContact({ jid: LID, notify: "Leo InetVip" });

    expect(getChat(LID, false)?.name).toBe("Leo InetVip");
  });

  it("keeps a group's subject over any contact row on the same JID", () => {
    storeChat({ jid: "120363000000000000@g.us", name: "BNI Lagoa Santa" });
    rawContact("120363000000000000@g.us", "someone else");

    expect(getChat("120363000000000000@g.us", false)?.name).toBe("BNI Lagoa Santa");
  });

  it("searches and sorts chats by the resolved name", () => {
    storeChat({ jid: LID });
    storeContact({ jid: LID, name: "Maxwell BNI" });
    storeChat({ jid: "111@lid" });
    storeContact({ jid: "111@lid", name: "Ana" });

    expect(getChats(10, 0, "last_active", "maxw", false).map((c) => c.jid)).toEqual([LID]);
    expect(getChats(10, 0, "name", null, false).map((c) => c.name)).toEqual(["Ana", "Maxwell BNI"]);
  });

  it("puts the resolved name on messages read from the chat", () => {
    storeChat({ jid: LID });
    storeContact({ jid: LID, name: "Maxwell BNI" });
    storeMessage(makeMessage({ id: "m1", chat_jid: LID, content: "oi" }));

    expect(getMessages(LID)[0]?.chat_name).toBe("Maxwell BNI");
  });

  it("leaves a chat with no name and no contact nameless, as before", () => {
    storeChat({ jid: LID });

    expect(getChat(LID, false)?.name).toBeNull();
  });
});
