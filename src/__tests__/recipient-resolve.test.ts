import { describe, it, expect, beforeEach, vi } from "vitest";

import { resolveRecipient, resetRecipientCache } from "../recipient.ts";

// Root cause of the 2026-07-22 "MCP isn't delivering" incident: agents built a
// phone JID by hand. The real test number is 551100000011 (12 digits); BR
// mobiles are usually 13 (55 DD 9XXXX-XXXX), so an inserted "9" produces
// 5511900000012 — a different number, not on WhatsApp, which can never mint a
// trusted-contact token and therefore 463s forever.

function makeLogger() {
  return { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function socketWith(onWhatsApp: ReturnType<typeof vi.fn>) {
  return { onWhatsApp } as never;
}

describe("resolveRecipient", () => {
  beforeEach(() => {
    resetRecipientCache();
  });

  it("rewrites a phone JID to the canonical LID the server returns", async () => {
    const onWhatsApp = vi.fn().mockResolvedValue([
      { jid: "551100000011@s.whatsapp.net", exists: true, lid: "10000000000005@lid" },
    ]);

    const result = await resolveRecipient(
      socketWith(onWhatsApp),
      "551100000011@s.whatsapp.net",
      makeLogger() as never,
    );

    expect(result).toBe("10000000000005@lid");
  });

  it("keeps the phone JID when the contact exists but has no LID", async () => {
    const onWhatsApp = vi.fn().mockResolvedValue([
      { jid: "551100000011@s.whatsapp.net", exists: true },
    ]);

    const result = await resolveRecipient(
      socketWith(onWhatsApp),
      "551100000011@s.whatsapp.net",
      makeLogger() as never,
    );

    expect(result).toBe("551100000011@s.whatsapp.net");
  });

  it("throws for a number that is not on WhatsApp, before anything is sent", async () => {
    const onWhatsApp = vi.fn().mockResolvedValue([
      { jid: "5511900000012@s.whatsapp.net", exists: false },
    ]);

    await expect(
      resolveRecipient(
        socketWith(onWhatsApp),
        "5511900000012@s.whatsapp.net",
        makeLogger() as never,
      ),
    ).rejects.toThrow(/not.*whatsapp/i);
  });

  it("treats an empty lookup result as 'not on WhatsApp'", async () => {
    // Baileys omits non-existent numbers from the response rather than
    // returning exists:false for them.
    const onWhatsApp = vi.fn().mockResolvedValue([]);

    await expect(
      resolveRecipient(
        socketWith(onWhatsApp),
        "5511900000011@s.whatsapp.net",
        makeLogger() as never,
      ),
    ).rejects.toThrow(/not.*whatsapp/i);
  });

  it("names the offending JID in the error so the agent can self-correct", async () => {
    const onWhatsApp = vi.fn().mockResolvedValue([{ exists: false }]);

    await expect(
      resolveRecipient(
        socketWith(onWhatsApp),
        "5511900000012@s.whatsapp.net",
        makeLogger() as never,
      ),
    ).rejects.toThrow(/5511900000012/);
  });

  it("passes group JIDs through untouched without a lookup", async () => {
    const onWhatsApp = vi.fn();

    const result = await resolveRecipient(
      socketWith(onWhatsApp),
      "120363000000000001@g.us",
      makeLogger() as never,
    );

    expect(result).toBe("120363000000000001@g.us");
    expect(onWhatsApp).not.toHaveBeenCalled();
  });

  it("passes LID JIDs through untouched without a lookup", async () => {
    const onWhatsApp = vi.fn();

    const result = await resolveRecipient(
      socketWith(onWhatsApp),
      "10000000000005@lid",
      makeLogger() as never,
    );

    expect(result).toBe("10000000000005@lid");
    expect(onWhatsApp).not.toHaveBeenCalled();
  });

  it("passes newsletter JIDs through untouched", async () => {
    const onWhatsApp = vi.fn();

    const result = await resolveRecipient(
      socketWith(onWhatsApp),
      "120363000000000901@newsletter",
      makeLogger() as never,
    );

    expect(result).toBe("120363000000000901@newsletter");
    expect(onWhatsApp).not.toHaveBeenCalled();
  });

  // Availability beats strictness: a flaky lookup must not block a legitimate send.
  it("falls back to the original JID and warns when the lookup itself fails", async () => {
    const onWhatsApp = vi.fn().mockRejectedValue(new Error("timed out"));
    const logger = makeLogger();

    const result = await resolveRecipient(
      socketWith(onWhatsApp),
      "551100000011@s.whatsapp.net",
      logger as never,
    );

    expect(result).toBe("551100000011@s.whatsapp.net");
    expect(logger.warn).toHaveBeenCalled();
  });

  it("reuses a cached positive lookup instead of querying twice", async () => {
    const onWhatsApp = vi.fn().mockResolvedValue([
      { jid: "551100000011@s.whatsapp.net", exists: true, lid: "10000000000005@lid" },
    ]);
    const socket = socketWith(onWhatsApp);

    await resolveRecipient(socket, "551100000011@s.whatsapp.net", makeLogger() as never);
    const second = await resolveRecipient(
      socket,
      "551100000011@s.whatsapp.net",
      makeLogger() as never,
    );

    expect(second).toBe("10000000000005@lid");
    expect(onWhatsApp).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed lookup, so a transient error self-heals", async () => {
    const onWhatsApp = vi
      .fn()
      .mockRejectedValueOnce(new Error("timed out"))
      .mockResolvedValue([
        { jid: "551100000011@s.whatsapp.net", exists: true, lid: "10000000000005@lid" },
      ]);
    const socket = socketWith(onWhatsApp);

    await resolveRecipient(socket, "551100000011@s.whatsapp.net", makeLogger() as never);
    const second = await resolveRecipient(
      socket,
      "551100000011@s.whatsapp.net",
      makeLogger() as never,
    );

    expect(second).toBe("10000000000005@lid");
    expect(onWhatsApp).toHaveBeenCalledTimes(2);
  });
});
