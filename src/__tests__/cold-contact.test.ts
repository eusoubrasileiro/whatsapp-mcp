import { describe, expect, it, vi } from "vitest";

import { assertNotColdContact, isColdContactGuardEnabled } from "../cold-contact.ts";

const COLD = "5511988887777@s.whatsapp.net";

describe("isColdContactGuardEnabled", () => {
  it("is on by default", () => {
    expect(isColdContactGuardEnabled({})).toBe(true);
  });

  it("can be switched off without a code change", () => {
    expect(isColdContactGuardEnabled({ SEND_COLD_CONTACT_GUARD: "false" })).toBe(false);
  });

  it("stays on for any value other than an explicit false", () => {
    expect(isColdContactGuardEnabled({ SEND_COLD_CONTACT_GUARD: "true" })).toBe(true);
  });
});

describe("assertNotColdContact", () => {
  it("throws when the contact has never messaged us", () => {
    expect(() => assertNotColdContact(COLD, { env: {}, hasInbound: () => false })).toThrow(
      /never messaged/i,
    );
  });

  it("explains the ban risk and names both ways out", () => {
    let message = "";
    try {
      assertNotColdContact(COLD, { env: {}, hasInbound: () => false });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toMatch(/nothing was sent/i);
    expect(message).toMatch(/restrict/i);
    expect(message).toMatch(/allow_cold_contact/);
    expect(message).toMatch(/SEND_COLD_CONTACT_GUARD/);
  });

  it("allows a send to a contact that has already messaged us", () => {
    expect(() => assertNotColdContact(COLD, { env: {}, hasInbound: () => true })).not.toThrow();
  });

  it("gates a LID exactly like a phone JID", () => {
    // A LID identifies one person, so a LID with no inbound history is just as
    // cold. Exempting it would gut the guard: `recipient.ts` opportunistically
    // upgrades a phone JID to its @lid before the send, so the very JID form the
    // send path produces would be the one that skips the check.
    expect(() =>
      assertNotColdContact("22233344455566@lid", { env: {}, hasInbound: () => false }),
    ).toThrow(/never messaged/i);
    expect(() =>
      assertNotColdContact("22233344455566@lid", { env: {}, hasInbound: () => true }),
    ).not.toThrow();
  });

  it.each([
    ["120363421815522729@g.us", "group"],
    ["abc@newsletter", "newsletter"],
    ["status@broadcast", "broadcast"],
  ])("exempts %s (%s) without touching the history read", (jid) => {
    const hasInbound = vi.fn(() => false);

    expect(() => assertNotColdContact(jid, { env: {}, hasInbound })).not.toThrow();
    expect(hasInbound).not.toHaveBeenCalled();
  });

  it("exempts the account's own self-chat", () => {
    // Talking to yourself is not a reach-out, and a self-chat holds only
    // is_from_me messages — so the history read calls it cold. Without this the
    // documented "message your own number to reach the agent" flow breaks.
    const hasInbound = vi.fn(() => false);

    expect(() =>
      assertNotColdContact("553191234567@s.whatsapp.net", {
        env: {},
        hasInbound,
        ownJids: ["553191234567:12@s.whatsapp.net"],
      }),
    ).not.toThrow();
    expect(hasInbound).not.toHaveBeenCalled();
  });

  it("still gates a stranger when the account's own JIDs are known", () => {
    expect(() =>
      assertNotColdContact(COLD, {
        env: {},
        hasInbound: () => false,
        ownJids: ["553191234567@s.whatsapp.net", "22233344455566@lid"],
      }),
    ).toThrow(/never messaged/i);
  });

  it("leaves an unknown address space alone rather than guessing", () => {
    const hasInbound = vi.fn(() => false);

    expect(() => assertNotColdContact("weird-jid", { env: {}, hasInbound })).not.toThrow();
    expect(hasInbound).not.toHaveBeenCalled();
  });

  it("lets a deliberate first contact through when allowCold is set", () => {
    expect(() =>
      assertNotColdContact(COLD, { env: {}, hasInbound: () => false, allowCold: true }),
    ).not.toThrow();
  });

  it("is inert when the guard is switched off", () => {
    const hasInbound = vi.fn(() => false);

    expect(() =>
      assertNotColdContact(COLD, { env: { SEND_COLD_CONTACT_GUARD: "false" }, hasInbound }),
    ).not.toThrow();
    expect(hasInbound).not.toHaveBeenCalled();
  });
});
