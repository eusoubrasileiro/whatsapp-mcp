import { createHash } from "node:crypto";
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
  const server = createQrServer(pino({ level: "silent" }), () => state, undefined, {
    now: () => NOW,
    disconnectedGraceS: 300,
    ...options,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  open.push({ close: () => new Promise((resolve) => server.close(() => resolve())) });
  return {
    async page(): Promise<string> {
      return (await fetch(`${url}/`)).text();
    },
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

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * SHA-256 of `GET /` exactly as `main` (bf0aa24) rendered it before instance identities
 * existed. Computed once by running that revision's `createQrServer` over these states and
 * hashing the response text. With no identity the page must stay byte-identical.
 */
const TODAYS_PAGE_SHA256: Record<string, { state: Partial<ConnectionState>; sha256: string }> = {
  connected: {
    state: { status: "connected", user: "5500000000000@s.whatsapp.net" },
    sha256: "addab0ddcd502781ae248de79d5e1340c1bd0478b81157084b07f783f298bf4b",
  },
  "connected, user not known yet": {
    state: { status: "connected" },
    sha256: "478c370ec7824cfbd0180c719c946db45a960939d4959b8e12545be82152ec24",
  },
  "qr_pending with a QR code": {
    state: { status: "qr_pending", qrCode: "2@abc123,def456,ghi789==,hex" },
    sha256: "982ab81ae29e00b242d02eb1f3f02a74d3c481e64d6804f984640da0f97fa296",
  },
  "qr_pending without a QR code": {
    state: { status: "qr_pending" },
    sha256: "d2eda64d7acd4065f1eec04bb44b46d5697cdce271ba09036db23eacacee0916",
  },
  connecting: {
    state: { status: "connecting" },
    sha256: "dbcb766eeddf36ed5b1142ac84d4221ad6326d5647e22dac63cc44adf7a3ba6a",
  },
  syncing: {
    state: { status: "syncing" },
    sha256: "8128d7b717d3619e0dafc433da77d7fdb1800cfe23d5ae2ea7606bf81c5daddd",
  },
  disconnected: {
    state: { status: "disconnected" },
    sha256: "ca00117fde1b75a64770dab4cbe57ca6c7f3192756dd79bfd46a74527df8d0f6",
  },
};

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

describe("QR page without an identity", () => {
  it.each(Object.entries(TODAYS_PAGE_SHA256))("is byte-identical to main: %s", async (_name, c) => {
    const qr = await startQr(stateOf(c.state));

    expect(sha256(await qr.page())).toBe(c.sha256);
  });

  it("is still byte-identical when the identity is null", async () => {
    const qr = await startQr(stateOf({ status: "connecting" }), { identity: null });

    expect(sha256(await qr.page())).toBe(TODAYS_PAGE_SHA256.connecting?.sha256);
  });
});

describe("QR page with an identity", () => {
  it.each(STATUSES)("shows the label in the title and the body while %s", async (status) => {
    const qr = await startQr(
      stateOf({ status, qrCode: status === "qr_pending" ? "2@abc" : null }),
      {
        identity: EMPRESA,
      },
    );

    const html = await qr.page();

    expect(html).toContain(`<title>WhatsApp MCP [empresa] — ${status}</title>`);
    const body = html.slice(html.indexOf("<body>"));
    expect(body).toContain("WhatsApp line: empresa");
    expect(body).toContain("the company line");
  });

  it("shows no description line when there is none", async () => {
    const qr = await startQr(stateOf(), { identity: { label: "empresa" } });

    const html = await qr.page();

    expect(html).toContain("WhatsApp line: empresa");
    expect(html).not.toContain("<small>the company line");
    expect(html).not.toContain("undefined");
  });

  it("only adds to the page: today's markup is still there, in order", async () => {
    const withLine = await (
      await startQr(stateOf({ status: "connecting" }), { identity: EMPRESA })
    ).page();

    expect(withLine).toContain("<h1>connecting...</h1><p>Please wait.</p>");
    expect(withLine.indexOf("WhatsApp line: empresa")).toBeLessThan(
      withLine.indexOf("<h1>connecting...</h1>"),
    );
    expect(withLine).toContain('<meta http-equiv="refresh" content="3" />');
  });

  it("escapes a label and a description that carry markup", async () => {
    const qr = await startQr(stateOf(), {
      identity: { label: '<b>x</b>"', description: '"><script>alert(1)</script> & <img src=x>' },
    });

    const html = await qr.page();

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x>");
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;&quot;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;img src=x&gt;");
    expect(html).toMatch(/<title>WhatsApp MCP \[&lt;b&gt;x&lt;\/b&gt;&quot;\] /);
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
