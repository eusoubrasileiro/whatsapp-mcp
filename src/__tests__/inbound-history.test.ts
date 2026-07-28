import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initializeDatabase, recordJidMapping, resetDatabase, storeMessage } from "../database.ts";
import { hasInboundMessage } from "../db/inbound-history.ts";
import { makeMessage } from "./helpers/make-message.ts";

describe("hasInboundMessage", () => {
  beforeEach(() => {
    initializeDatabase(":memory:");
  });

  afterEach(() => {
    resetDatabase();
  });

  it("returns false for a chat with no messages at all", () => {
    expect(hasInboundMessage("stranger@s.whatsapp.net")).toBe(false);
  });

  it("returns false when the chat only holds our own outbound messages", () => {
    storeMessage(
      makeMessage({
        id: "out1",
        chat_jid: "cold@s.whatsapp.net",
        content: "Olá",
        is_from_me: true,
      }),
    );
    expect(hasInboundMessage("cold@s.whatsapp.net")).toBe(false);
  });

  it("returns true once the contact has sent us anything", () => {
    storeMessage(
      makeMessage({
        id: "out1",
        chat_jid: "warm@s.whatsapp.net",
        content: "Olá",
        is_from_me: true,
      }),
    );
    storeMessage(
      makeMessage({
        id: "in1",
        chat_jid: "warm@s.whatsapp.net",
        content: "Oi!",
        is_from_me: false,
      }),
    );
    expect(hasInboundMessage("warm@s.whatsapp.net")).toBe(true);
  });

  it("counts inbound history recorded under the contact's other JID form", () => {
    // A contact known by both its phone JID and its LID must read as warm
    // through either address — otherwise a PN→LID upgrade turns an established
    // chat back into a "cold" first contact and the guard blocks a real reply.
    recordJidMapping("5531999999999@s.whatsapp.net", "111222333@lid");
    storeMessage(
      makeMessage({ id: "in1", chat_jid: "111222333@lid", content: "Oi!", is_from_me: false }),
    );
    expect(hasInboundMessage("5531999999999@s.whatsapp.net")).toBe(true);
  });

  it("returns false when the database is not initialized", () => {
    // Fail-safe: an unavailable DB must read as cold (refuse the send), never
    // as warm — an unverified reach-out is the failure this guard exists to stop.
    resetDatabase();
    expect(hasInboundMessage("anyone@s.whatsapp.net")).toBe(false);
  });
});
