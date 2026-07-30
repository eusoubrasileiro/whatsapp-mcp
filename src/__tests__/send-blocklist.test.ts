/**
 * The durable half of the anti-restriction guards.
 *
 * The in-session guards already refuse a cold contact and throw "DO NOT RETRY"
 * when the server refuses a send. What they cannot do is outlive the session:
 * 5531976543210 was refused with 463 and then re-attempted on 2026-07-24,
 * 07-25 and 07-28 by three *different* sessions, and the 07-28 attempt preceded
 * the second account restriction by 82 minutes. These tests pin the memory that
 * closes that hole.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emitAckError, resetAckBus } from "../ack-bus.ts";
import { logAckErrors } from "../ack-errors.ts";
import {
  getAliasGroup,
  initializeDatabase,
  recordJidMapping,
  resetDatabase,
  storeMessage,
} from "../database.ts";
import { findBlocklistEntry, upsertBlocklistEntry } from "../db/send-blocklist-store.ts";
import { assertNotBlocked, isSendBlocklistEnabled, recordSendRefusal } from "../send-blocklist.ts";
import { assertSendAccepted } from "../send-guard.ts";
import { resetSendPacer } from "../send-pacer.ts";
import { applySendPolicy } from "../send-policy.ts";
import { makeMessage } from "./helpers/make-message.ts";

const COLD = "5531976543210@s.whatsapp.net";
const WARM = "553191234567@s.whatsapp.net";

/** A refusal as it reaches either hook: the resolved jid plus the server code. */
function refusal(overrides: { jid?: string | null; code?: string | null; detail?: string } = {}) {
  return {
    jid: COLD,
    code: "463",
    detail: null,
    ...overrides,
  };
}

describe("isSendBlocklistEnabled", () => {
  it("is on by default", () => {
    expect(isSendBlocklistEnabled({})).toBe(true);
  });

  it("can be switched off without a code change", () => {
    expect(isSendBlocklistEnabled({ SEND_BLOCKLIST_ENABLED: "false" })).toBe(false);
  });

  it("stays on for any value other than an explicit false", () => {
    expect(isSendBlocklistEnabled({ SEND_BLOCKLIST_ENABLED: "true" })).toBe(true);
    expect(isSendBlocklistEnabled({ SEND_BLOCKLIST_ENABLED: "yes" })).toBe(true);
  });
});

describe("recordSendRefusal", () => {
  beforeEach(() => {
    initializeDatabase(":memory:");
  });

  afterEach(() => {
    resetDatabase();
  });

  it("remembers a 463 against a recipient that has never messaged this account", () => {
    recordSendRefusal(refusal(), { now: () => new Date("2026-07-24T15:04:05Z") });

    const entry = findBlocklistEntry([COLD]);
    expect(entry).not.toBeNull();
    expect(entry?.code).toBe("463");
    expect(entry?.refusalCount).toBe(1);
    expect(entry?.firstRefusedAt).toBe("2026-07-24T15:04:05.000Z");
    expect(entry?.lastRefusedAt).toBe("2026-07-24T15:04:05.000Z");
  });

  // 2026-07-28: while the account itself was restricted, a 463 also came back for
  // a contact of years' standing. Blocklisting her would have been a bug — the
  // refusal was collateral from the account-level block, not a dead recipient.
  it("does not blocklist an established contact whose 463 was collateral from an account-level restriction", () => {
    storeMessage(makeMessage({ id: "in1", chat_jid: WARM, content: "Oi!", is_from_me: false }));

    recordSendRefusal(refusal({ jid: WARM }));

    expect(findBlocklistEntry([WARM])).toBeNull();
  });

  it("ignores codes other than 463, which are not permanent for the recipient", () => {
    for (const code of ["479", "500", null]) {
      recordSendRefusal(refusal({ code }));
    }

    expect(findBlocklistEntry([COLD])).toBeNull();
  });

  it("ignores a group jid, which has no reach-out semantics", () => {
    recordSendRefusal(refusal({ jid: "12345-678@g.us" }));

    expect(findBlocklistEntry(["12345-678@g.us"])).toBeNull();
  });

  it("ignores a refusal that carries no chat jid at all", () => {
    expect(() => recordSendRefusal(refusal({ jid: null }))).not.toThrow();
  });

  it("counts repeat refusals and moves the last-seen date, keeping the first", () => {
    recordSendRefusal(refusal(), { now: () => new Date("2026-07-24T10:00:00Z") });
    recordSendRefusal(refusal(), { now: () => new Date("2026-07-25T11:00:00Z") });
    recordSendRefusal(refusal(), { now: () => new Date("2026-07-28T12:00:00Z") });

    const entry = findBlocklistEntry([COLD]);
    expect(entry?.refusalCount).toBe(3);
    expect(entry?.firstRefusedAt).toBe("2026-07-24T10:00:00.000Z");
    expect(entry?.lastRefusedAt).toBe("2026-07-28T12:00:00.000Z");
  });

  it("counts a contact refused under both its phone jid and its lid as one identity", () => {
    recordJidMapping(COLD, "111222333@lid");

    recordSendRefusal(refusal({ jid: COLD }));
    recordSendRefusal(refusal({ jid: "111222333@lid" }));

    // One row, two refusals — a second row would have counted 1. The row is
    // keyed canonically, so the read goes through the alias group like the
    // enforcement path does.
    expect(findBlocklistEntry(getAliasGroup(COLD))?.refusalCount).toBe(2);
  });

  it("writes nothing when the operator switched the blocklist off", () => {
    recordSendRefusal(refusal(), { env: { SEND_BLOCKLIST_ENABLED: "false" } });

    expect(findBlocklistEntry([COLD])).toBeNull();
  });
});

describe("recordSendRefusal (never breaks the caller)", () => {
  it("swallows a database failure rather than throwing into the send path", () => {
    // No database at all — the send path and the ack logger must not care.
    resetDatabase();

    expect(() => recordSendRefusal(refusal())).not.toThrow();
  });

  it("swallows a failing store rather than throwing into the ack logger", () => {
    initializeDatabase(":memory:");
    try {
      expect(() =>
        recordSendRefusal(refusal(), {
          hasInbound: () => false,
          store: {
            find: () => null,
            upsert: () => {
              throw new Error("disk I/O error");
            },
          },
        }),
      ).not.toThrow();
    } finally {
      resetDatabase();
    }
  });
});

describe("assertNotBlocked", () => {
  beforeEach(() => {
    initializeDatabase(":memory:");
  });

  afterEach(() => {
    resetDatabase();
  });

  function block(jid: string, overrides: Record<string, unknown> = {}) {
    upsertBlocklistEntry({
      jid,
      tenantId: "default",
      code: "463",
      firstRefusedAt: "2026-07-24T10:00:00.000Z",
      lastRefusedAt: "2026-07-28T12:00:00.000Z",
      refusalCount: 3,
      detail: null,
      ...overrides,
    });
  }

  it("allows a recipient that WhatsApp has never refused", () => {
    expect(() => assertNotBlocked(WARM)).not.toThrow();
  });

  it("refuses a recorded recipient, naming the code, the date and the attempt count", () => {
    block(COLD);

    let message = "";
    try {
      assertNotBlocked(COLD);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toMatch(/Send REFUSED locally/);
    expect(message).toMatch(/nothing was sent/i);
    expect(message).toContain("463");
    expect(message).toContain("2026-07-28");
    expect(message).toContain("3");
  });

  it("tells the agent a retry can never succeed and risks the account", () => {
    block(COLD);

    expect(() => assertNotBlocked(COLD)).toThrow(/never succeed/i);
    expect(() => assertNotBlocked(COLD)).toThrow(/restrict/i);
  });

  // Deliberately no tool and no env var to clear an entry: an agent that can
  // clear its own memory of a refusal has no memory of a refusal.
  it("points removal at a manual operator DELETE, offering no tool to clear it", () => {
    block(COLD);

    expect(() => assertNotBlocked(COLD)).toThrow(/DELETE FROM send_blocklist/);
  });

  it("still refuses when the send is addressed by the contact's other jid form", () => {
    // The 07-2x re-attempts came from fresh sessions that had resolved the
    // contact differently. A PN/LID mismatch must not read as a new recipient.
    recordJidMapping(COLD, "111222333@lid");
    block(COLD);

    expect(() => assertNotBlocked("111222333@lid")).toThrow(/Send REFUSED locally/);
  });

  it("exempts an operator-approved recipient, so a stale entry cannot lock it out", () => {
    block(COLD);

    expect(() =>
      assertNotBlocked(COLD, {
        env: { SEND_COLD_ALLOWED_JIDS: "5531976543210" },
      }),
    ).not.toThrow();
  });

  it("is inert when the operator switched the blocklist off", () => {
    block(COLD);

    expect(() =>
      assertNotBlocked(COLD, { env: { SEND_BLOCKLIST_ENABLED: "false" } }),
    ).not.toThrow();
  });

  it("allows the send when the blocklist cannot be read at all", () => {
    // Fail-open here on purpose: the cold-contact guard still protects the
    // account, and a database hiccup must not make every send impossible.
    resetDatabase();

    expect(() => assertNotBlocked(COLD)).not.toThrow();
  });

  it("keeps a recorded refusal across a restart of the process", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-blocklist-"));
    const dbPath = path.join(dir, "whatsapp.db");
    try {
      initializeDatabase(dbPath);
      recordSendRefusal(refusal(), { now: () => new Date("2026-07-24T10:00:00Z") });
      resetDatabase();

      // A brand-new session, same volume — this is exactly the boundary the
      // in-session "DO NOT RETRY" could not cross.
      initializeDatabase(dbPath);
      expect(() => assertNotBlocked(COLD)).toThrow(/Send REFUSED locally/);
    } finally {
      resetDatabase();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("applySendPolicy with a recorded refusal", () => {
  beforeEach(() => {
    resetSendPacer();
    initializeDatabase(":memory:");
  });

  afterEach(() => {
    resetDatabase();
  });

  it("refuses a recorded recipient before any other guard runs", async () => {
    upsertBlocklistEntry({
      jid: COLD,
      tenantId: "default",
      code: "463",
      firstRefusedAt: "2026-07-24T10:00:00.000Z",
      lastRefusedAt: "2026-07-28T12:00:00.000Z",
      refusalCount: 3,
      detail: null,
    });

    const events: string[] = [];
    await expect(
      applySendPolicy({
        socket: {
          sendPresenceUpdate: async (state: string) => {
            events.push(`presence:${state}`);
          },
        },
        jid: COLD,
        logger: pino({ level: "silent" }),
        isText: true,
        text: "oi",
        env: {},
        // Passing allowCold proves the blocklist is not a cold-contact refusal:
        // the per-call escape hatch has no effect on it.
        allowCold: true,
        hasInbound: () => {
          events.push("hasInbound");
          return true;
        },
        sleep: async (ms: number) => {
          events.push(`sleep:${ms}`);
        },
        random: () => 0,
      }),
    ).rejects.toThrow(/DELETE FROM send_blocklist/);

    expect(events).toEqual([]);
  });
});

describe("logAckErrors (records late refusals too)", () => {
  beforeEach(() => {
    resetAckBus();
    initializeDatabase(":memory:");
  });

  afterEach(() => {
    resetDatabase();
  });

  it("records a refusal that arrived after the send path stopped waiting", () => {
    // The ack funnel is the second call site on purpose: a refusal landing later
    // than SEND_ACK_WAIT_MS is invisible to assertSendAccepted, and that late
    // refusal is still a recipient no future session should try again.
    logAckErrors(
      [
        {
          key: { id: "late1", remoteJid: COLD, fromMe: true },
          update: { status: 0, messageStubParameters: ["463"] },
        } as never,
      ],
      pino({ level: "silent" }),
    );

    expect(findBlocklistEntry([COLD])?.code).toBe("463");
  });
});

describe("assertSendAccepted (records what it refuses)", () => {
  beforeEach(() => {
    resetAckBus();
    initializeDatabase(":memory:");
  });

  afterEach(() => {
    resetDatabase();
  });

  it("records the refusal so the next session cannot repeat the send", async () => {
    emitAckError({ msgId: "m1", chatJid: COLD, code: "463", reason: "r", detail: null });

    await expect(assertSendAccepted("m1", COLD, 3000)).rejects.toThrow(/did NOT arrive/);

    expect(findBlocklistEntry([COLD])?.code).toBe("463");
  });

  it("reports the server refusal even when the recording fails", async () => {
    resetDatabase();
    emitAckError({ msgId: "m2", chatJid: COLD, code: "463", reason: "r", detail: null });

    // The agent must still be told the truth about its send; a storage problem
    // is not allowed to become the error the caller sees.
    await expect(assertSendAccepted("m2", COLD, 3000)).rejects.toThrow(/DO NOT RETRY/);
  });
});
