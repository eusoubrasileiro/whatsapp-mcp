import pino from "pino";
import { beforeEach, describe, expect, it } from "vitest";

import { resetSendPacer } from "../send-pacer.ts";
import { applySendPolicy } from "../send-policy.ts";

const logger = pino({ level: "silent" });
const WARM = "553191234567@s.whatsapp.net";

describe("applySendPolicy", () => {
  let clock = 0;
  let events: string[] = [];

  const socket = {
    sendPresenceUpdate: async (state: string) => {
      events.push(`presence:${state}`);
    },
  };

  function input(overrides: Partial<Parameters<typeof applySendPolicy>[0]> = {}) {
    return {
      socket,
      jid: WARM,
      logger,
      isText: true,
      text: "oi",
      env: {},
      hasInbound: (jid: string) => {
        events.push(`hasInbound:${jid}`);
        return true;
      },
      now: () => clock,
      sleep: async (ms: number) => {
        events.push(`sleep:${ms}`);
        clock += ms;
      },
      random: () => 0,
      ...overrides,
    };
  }

  beforeEach(() => {
    resetSendPacer();
    clock = 0;
    events = [];
  });

  it("checks the contact, paces, then simulates typing — in that order", async () => {
    await applySendPolicy(input());
    events = [];
    // The second send is the interesting one: the first had nothing to wait behind.
    await applySendPolicy(input());

    expect(events).toEqual([
      `hasInbound:${WARM}`,
      "sleep:2500",
      "presence:composing",
      "sleep:500",
      "presence:paused",
    ]);
  });

  it("refuses a cold contact before spending a pacing slot or a typing pause", async () => {
    await expect(applySendPolicy(input({ hasInbound: () => false }))).rejects.toThrow(
      /never messaged/i,
    );

    expect(events).toEqual([]);
  });

  it("leaves the pacing history untouched when a cold contact is refused", async () => {
    await applySendPolicy(input({ hasInbound: () => false })).catch(() => {});
    events = [];

    // A rejected send must not have burned the rolling-window slot: the next
    // legitimate send still goes out with no pacing wait.
    await applySendPolicy(input());
    expect(events).not.toContain("sleep:3000");
  });

  it("skips the typing simulation for a media send", async () => {
    await applySendPolicy(input({ isText: false, text: undefined }));

    expect(events).toEqual([`hasInbound:${WARM}`]);
  });

  it("still paces a media send", async () => {
    await applySendPolicy(input({ isText: false }));
    events = [];
    await applySendPolicy(input({ isText: false }));

    expect(events).toEqual([`hasInbound:${WARM}`, "sleep:3000"]);
  });

  it("lets a deliberate cold first contact through", async () => {
    await expect(
      applySendPolicy(input({ hasInbound: () => false, allowCold: true })),
    ).resolves.toBeUndefined();
  });

  it("ignores allowCold when the instance policy denies the override", async () => {
    await expect(
      applySendPolicy(
        input({
          hasInbound: () => false,
          allowCold: true,
          env: { SEND_COLD_OVERRIDE: "deny" },
        }),
      ),
    ).rejects.toThrow(/disabled on this instance by policy/i);

    expect(events).toEqual([]);
  });

  it("sends to an operator-allowlisted recipient with no inbound history", async () => {
    await expect(
      applySendPolicy(
        input({
          hasInbound: () => false,
          env: { SEND_COLD_OVERRIDE: "deny", SEND_COLD_ALLOWED_JIDS: "553191234567" },
          aliasesOf: () => [WARM],
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("is fully inert when every guard is switched off", async () => {
    const off = {
      SEND_COLD_CONTACT_GUARD: "false",
      SEND_RATE_LIMIT_ENABLED: "false",
      SEND_SIMULATE_TYPING: "false",
    };

    await applySendPolicy(input({ env: off, hasInbound: () => false }));
    await applySendPolicy(input({ env: off, hasInbound: () => false }));

    expect(events).toEqual([]);
  });
});
