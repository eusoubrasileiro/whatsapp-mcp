import type { AddressInfo } from "node:net";
import type { ConnectionState } from "@amiticia/baileys-client";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQrServer, type QrServerOptions } from "../qr-server.ts";
import { stateOf } from "./helpers/connection-state.ts";

/** A fake number with a recognisable tail; the fixture every "no leak" assertion slices up. */
const NUMBER = "5500000001234";
const PAIRED_ID = `${NUMBER}:7@s.whatsapp.net`;
const EMPRESA = { label: "empresa", description: "the company line" };
const NOW = 1_700_000_000_000;

const STATUSES = ["connected", "syncing", "connecting", "disconnected", "qr_pending"] as const;

const open: Array<{ close: () => Promise<void> }> = [];

/** The ONE place this file builds a QR server. */
async function startQr(state: ConnectionState, options: QrServerOptions = {}) {
  const server = createQrServer(pino({ level: "silent" }), () => state, {
    now: () => NOW,
    disconnectedGraceS: 300,
    ...options,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  open.push({ close: () => new Promise((resolve) => server.close(() => resolve())) });
  return {
    url,
    async health(): Promise<{ code: number; text: string; body: Record<string, unknown> }> {
      const res = await fetch(`${url}/health`);
      const text = await res.text();
      return { code: res.status, text, body: JSON.parse(text) };
    },
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(open.splice(0).map((s) => s.close()));
});

/** `GET /health` exactly as `main` returned it, fixed clock, grace 300. */
const TODAYS_HEALTH: Record<(typeof STATUSES)[number], string> = {
  connected:
    '{"status":"connected","health":"ok","user":"Alice","syncProgress":{"chats":0,"contacts":0,"messages":0,"lastBatchAt":null},"disconnected_for_s":0,"grace_s":300}',
  syncing:
    '{"status":"syncing","health":"ok","user":null,"syncProgress":{"chats":0,"contacts":0,"messages":0,"lastBatchAt":null},"disconnected_for_s":0,"grace_s":300}',
  connecting:
    '{"status":"connecting","health":"degraded","user":null,"syncProgress":{"chats":0,"contacts":0,"messages":0,"lastBatchAt":null},"disconnected_for_s":0,"grace_s":300}',
  disconnected:
    '{"status":"disconnected","health":"degraded","user":null,"syncProgress":{"chats":0,"contacts":0,"messages":0,"lastBatchAt":null},"disconnected_for_s":0,"grace_s":300}',
  qr_pending:
    '{"status":"qr_pending","health":"degraded","user":null,"syncProgress":{"chats":0,"contacts":0,"messages":0,"lastBatchAt":null},"disconnected_for_s":0,"grace_s":300}',
};

function healthState(status: (typeof STATUSES)[number]): ConnectionState {
  return stateOf({ status, user: status === "connected" ? "Alice" : null });
}

describe("the QR server's root", () => {
  it.each(STATUSES)("is 404 with an identity, and without one, while %s", async (status) => {
    const labelled = await startQr(healthState(status), { identity: EMPRESA });
    const bare = await startQr(healthState(status));

    for (const qr of [labelled, bare]) {
      for (const path of ["/", "/index.html"]) {
        const res = await fetch(`${qr.url}${path}`);
        expect(res.status).toBe(404);
        expect(await res.text()).toBe("not found");
      }
    }
  });
});

describe("GET /health without an identity", () => {
  it.each(STATUSES)("is exactly what main returned while %s", async (status) => {
    const qr = await startQr(healthState(status), { pairedUserId: () => PAIRED_ID });
    vi.stubEnv("EXPECTED_WA_NUMBER", NUMBER);

    const { code, text } = await qr.health();

    expect(code).toBe(200);
    expect(text).toBe(TODAYS_HEALTH[status]);
  });
});

describe("GET /health with an identity", () => {
  it("names the line and the last four digits of the paired number", async () => {
    const qr = await startQr(healthState("connected"), {
      identity: EMPRESA,
      pairedUserId: () => PAIRED_ID,
    });

    const { code, text, body } = await qr.health();

    expect(code).toBe(200);
    expect(body.instance).toStrictEqual({ label: "empresa", description: "the company line" });
    expect(body.phone_last4).toBe("1234");
    expect(typeof body.phone_last4).toBe("string");
    expect(text).toBe(
      `${TODAYS_HEALTH.connected.slice(0, -1)},"instance":{"label":"empresa","description":"the company line"},"phone_last4":"1234"}`,
    );
  });

  it("falls back to the last four digits of EXPECTED_WA_NUMBER while nothing is paired", async () => {
    vi.stubEnv("EXPECTED_WA_NUMBER", NUMBER);
    const qr = await startQr(healthState("qr_pending"), {
      identity: { label: "empresa" },
      pairedUserId: () => undefined,
    });

    const { body } = await qr.health();

    expect(body.instance).toStrictEqual({ label: "empresa" });
    expect(body.phone_last4).toBe("1234");
  });

  it("falls back to EXPECTED_WA_NUMBER when the server has no way to read the paired id", async () => {
    vi.stubEnv("EXPECTED_WA_NUMBER", NUMBER);
    const qr = await startQr(healthState("disconnected"), { identity: EMPRESA });

    const { body } = await qr.health();

    expect(body.phone_last4).toBe("1234");
  });

  it("has no phone_last4 when nothing is paired and EXPECTED_WA_NUMBER is short or unset", async () => {
    const qr = await startQr(healthState("disconnected"), { identity: EMPRESA });
    expect((await qr.health()).body).not.toHaveProperty("phone_last4");

    vi.stubEnv("EXPECTED_WA_NUMBER", "123456789");
    expect((await qr.health()).body).not.toHaveProperty("phone_last4");
  });

  it("keeps every existing key untouched", async () => {
    const qr = await startQr(healthState("syncing"), {
      identity: EMPRESA,
      pairedUserId: () => PAIRED_ID,
    });

    const { instance: _i, phone_last4: _p, ...rest } = (await qr.health()).body;

    expect(JSON.stringify(rest)).toBe(TODAYS_HEALTH.syncing);
    expect(Object.keys(rest)).toEqual([
      "status",
      "health",
      "user",
      "syncProgress",
      "disconnected_for_s",
      "grace_s",
    ]);
  });

  it("never carries more than four consecutive digits of the number", async () => {
    vi.stubEnv("EXPECTED_WA_NUMBER", NUMBER);
    const paired = await startQr(healthState("connected"), {
      identity: EMPRESA,
      pairedUserId: () => PAIRED_ID,
    });
    const unpaired = await startQr(healthState("disconnected"), { identity: EMPRESA });

    for (const { text } of [await paired.health(), await unpaired.health()]) {
      for (let at = 0; at + 5 <= NUMBER.length; at++) {
        expect(text).not.toContain(NUMBER.slice(at, at + 5));
      }
      expect(text).toContain("1234");
    }
  });

  it("does not turn a LID into a phone_last4", async () => {
    const qr = await startQr(healthState("connected"), {
      identity: EMPRESA,
      pairedUserId: () => "10000000009876:3@lid",
    });

    expect((await qr.health()).body).not.toHaveProperty("phone_last4");
  });

  it("keeps the status codes: 200 while live, 503 once wedged", async () => {
    let clock = NOW;
    const state = healthState("connected");
    const qr = await startQr(state, { identity: EMPRESA, now: () => clock });
    expect((await qr.health()).code).toBe(200);

    state.status = "disconnected";
    clock += 301_000;

    const wedged = await qr.health();
    expect(wedged.code).toBe(503);
    expect(wedged.body.instance).toStrictEqual(EMPRESA);
  });
});
