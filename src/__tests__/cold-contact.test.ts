import { describe, expect, it, vi } from "vitest";

import {
  assertNotColdContact,
  getColdOverridePolicy,
  isColdContactGuardEnabled,
} from "../cold-contact.ts";

const COLD = "5511988887777@s.whatsapp.net";
/** The owned test number, in both of the forms one identity is addressed by. */
const OWNED_PN = "553191234567@s.whatsapp.net";
const OWNED_LID = "22233344455566@lid";

/** Stand-in for the DB alias helper: the two forms above are one person. */
function aliasesOf(jid: string): string[] {
  const group = [OWNED_PN, OWNED_LID];
  return group.includes(jid) ? group : [jid];
}

function refusalFor(jid: string, options: Parameters<typeof assertNotColdContact>[1]): string {
  try {
    assertNotColdContact(jid, options);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return "";
}

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
    const message = refusalFor(COLD, { env: {}, hasInbound: () => false });

    expect(message).toMatch(/nothing was sent/i);
    expect(message).toMatch(/restrict/i);
    expect(message).toMatch(/allow_cold_contact/);
    expect(message).toMatch(/SEND_COLD_CONTACT_GUARD/);
  });

  it("states the risk generically, not one deployment's restriction history", () => {
    // The text ships to every instance of this server; a dated claim that "this
    // number was already restricted" is only true of one of them.
    const message = refusalFor(COLD, { env: {}, hasInbound: () => false });

    expect(message).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
    expect(message).not.toMatch(/already restricted/i);
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

describe("getColdOverridePolicy", () => {
  it("allows the per-call override by default, so existing deployments are unchanged", () => {
    expect(getColdOverridePolicy({})).toBe("allow");
  });

  it("reads deny when the operator locks the override down", () => {
    expect(getColdOverridePolicy({ SEND_COLD_OVERRIDE: "deny" })).toBe("deny");
  });

  it("accepts the value with surrounding whitespace and any casing", () => {
    expect(getColdOverridePolicy({ SEND_COLD_OVERRIDE: "  DENY " })).toBe("deny");
  });

  it("falls back to allow on an unrecognised value rather than guessing deny", () => {
    // A typo must not silently change how the send path behaves. Falling back to
    // the documented default is the same convention `readNonNegativeNumber` uses.
    expect(getColdOverridePolicy({ SEND_COLD_OVERRIDE: "banana" })).toBe("allow");
    expect(getColdOverridePolicy({ SEND_COLD_OVERRIDE: "" })).toBe("allow");
    expect(getColdOverridePolicy({ SEND_COLD_OVERRIDE: "DENIED" })).toBe("allow");
  });
});

/**
 * Why the per-call escape hatch is not enough — any agent can pass
 * `allow_cold_contact: true`, so on a number that cannot afford another
 * restriction the guard was advisory. Under `deny` the parameter is ignored
 * outright.
 */
describe("assertNotColdContact under SEND_COLD_OVERRIDE=deny", () => {
  const DENY = { SEND_COLD_OVERRIDE: "deny" };

  it("refuses a cold contact even when the caller passes allowCold", () => {
    expect(() =>
      assertNotColdContact(COLD, { env: DENY, hasInbound: () => false, allowCold: true }),
    ).toThrow(/never messaged/i);
  });

  it("says the override is disabled by policy and points at a separate outreach instance", () => {
    const message = refusalFor(COLD, { env: DENY, hasInbound: () => false, allowCold: true });

    expect(message).toMatch(/disabled on this instance by policy/i);
    expect(message).toMatch(/SEND_COLD_OVERRIDE/);
    expect(message).toMatch(/first[- ]contact sends belong on a separate instance/i);
  });

  it("never names a specific deployment or restriction history", () => {
    // An agent told to "use the whatsapp-work MCP" goes looking for a server that
    // may not exist on this operator's setup — and the named instance was one
    // deployment's, not a property of this code.
    const message = refusalFor(COLD, { env: DENY, hasInbound: () => false, allowCold: true });

    expect(message).not.toMatch(/whatsapp-work/i);
    expect(message).not.toMatch(/already been restricted/i);
  });

  it("does not tell the agent to retry with allow_cold_contact", () => {
    // The refusal must not advertise a way out that cannot work — an agent that
    // reads one retries, and every retry is another reach-out.
    const message = refusalFor(COLD, { env: DENY, hasInbound: () => false, allowCold: true });

    expect(message).toMatch(/REFUSED/);
    expect(message).not.toMatch(/re-send with allow_cold_contact/i);
  });

  it("still sends to a contact that has already messaged us", () => {
    // deny narrows the escape hatch only: a warm chat is untouched.
    expect(() =>
      assertNotColdContact(COLD, { env: DENY, hasInbound: () => true, allowCold: false }),
    ).not.toThrow();
  });

  it("still replies into the account's own self-chat", () => {
    expect(() =>
      assertNotColdContact(OWNED_PN, {
        env: DENY,
        hasInbound: () => false,
        ownJids: ["553191234567:12@s.whatsapp.net"],
      }),
    ).not.toThrow();
  });
});

/**
 * The operator allowlist: numbers we own and may always message, so testing
 * against them never needs the override that `deny` removes.
 */
describe("assertNotColdContact with SEND_COLD_ALLOWED_JIDS", () => {
  it("exempts a listed JID without reading the history", () => {
    const hasInbound = vi.fn(() => false);

    expect(() =>
      assertNotColdContact(OWNED_PN, {
        env: { SEND_COLD_ALLOWED_JIDS: OWNED_PN },
        hasInbound,
        aliasesOf,
      }),
    ).not.toThrow();
    expect(hasInbound).not.toHaveBeenCalled();
  });

  it("accepts a bare phone number as an entry", () => {
    expect(() =>
      assertNotColdContact(OWNED_PN, {
        env: { SEND_COLD_ALLOWED_JIDS: "553191234567" },
        hasInbound: () => false,
        aliasesOf,
      }),
    ).not.toThrow();
  });

  it("matches a phone-form entry against the LID the send resolved to", () => {
    // The send path upgrades a phone JID to its @lid before sending, so an
    // allowlist that only understood the phone form would never match in
    // practice. The alias group makes both forms one identity.
    expect(() =>
      assertNotColdContact(OWNED_LID, {
        env: { SEND_COLD_ALLOWED_JIDS: "553191234567" },
        hasInbound: () => false,
        aliasesOf,
      }),
    ).not.toThrow();
  });

  it("matches a LID entry against the phone JID", () => {
    expect(() =>
      assertNotColdContact(OWNED_PN, {
        env: { SEND_COLD_ALLOWED_JIDS: OWNED_LID },
        hasInbound: () => false,
        aliasesOf,
      }),
    ).not.toThrow();
  });

  it("tolerates blank and padded entries in the list", () => {
    expect(() =>
      assertNotColdContact(OWNED_LID, {
        env: { SEND_COLD_ALLOWED_JIDS: " , 553191234567 ,, " },
        hasInbound: () => false,
        aliasesOf,
      }),
    ).not.toThrow();
  });

  it("exempts a listed recipient even under SEND_COLD_OVERRIDE=deny", () => {
    expect(() =>
      assertNotColdContact(OWNED_LID, {
        env: { SEND_COLD_OVERRIDE: "deny", SEND_COLD_ALLOWED_JIDS: "553191234567" },
        hasInbound: () => false,
        aliasesOf,
      }),
    ).not.toThrow();
  });

  it("still refuses a recipient that is not on the list", () => {
    expect(() =>
      assertNotColdContact(COLD, {
        env: { SEND_COLD_ALLOWED_JIDS: "553191234567" },
        hasInbound: () => false,
        aliasesOf,
      }),
    ).toThrow(/never messaged/i);
  });

  it("never consults the alias helper when the list is empty", () => {
    const failIfCalled = vi.fn(() => {
      throw new Error("alias lookup must not run for an empty allowlist");
    });

    expect(() =>
      assertNotColdContact(COLD, { env: {}, hasInbound: () => true, aliasesOf: failIfCalled }),
    ).not.toThrow();
    expect(failIfCalled).not.toHaveBeenCalled();
  });

  it("does not exempt an aliased form when the alias lookup fails", () => {
    // Fail-safe: a DB error must never widen an exemption. The LID only matches a
    // phone-form entry through the alias group, so a broken lookup means refused.
    expect(() =>
      assertNotColdContact(OWNED_LID, {
        env: { SEND_COLD_ALLOWED_JIDS: "553191234567" },
        hasInbound: () => false,
        aliasesOf: () => {
          throw new Error("db down");
        },
      }),
    ).toThrow(/never messaged/i);
  });

  it("still exempts an exactly-listed JID when the alias lookup fails", () => {
    // The entry names this very JID, so the exemption rests on the operator's own
    // configuration and needs no database at all.
    expect(() =>
      assertNotColdContact(OWNED_LID, {
        env: { SEND_COLD_ALLOWED_JIDS: OWNED_LID },
        hasInbound: () => false,
        aliasesOf: () => {
          throw new Error("db down");
        },
      }),
    ).not.toThrow();
  });
});
