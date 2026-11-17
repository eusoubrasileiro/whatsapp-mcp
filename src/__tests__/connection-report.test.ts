import type { ConnectionState } from "@amiticia/baileys-client";
import { describe, expect, it } from "vitest";
import { buildConnectionReport, isQrReady, QR_PNG_PATH } from "../connection-report.ts";

const NOW = 1_700_000_000_000;

function state(overrides: Partial<ConnectionState> = {}): ConnectionState {
  return {
    status: "disconnected",
    qrCode: null,
    qrAscii: null,
    user: null,
    syncProgress: { chats: 0, contacts: 0, messages: 0, lastBatchAt: null },
    ...overrides,
  };
}

const NO_IDENTITY = { identity: null, now: NOW };
const EMPRESA = { label: "empresa", description: "the company line" };
const PAIRED = "5500000000000:7@s.whatsapp.net";

const QR_MESSAGE =
  "QR code saved (and opened if a desktop session is available). Scan with WhatsApp mobile (Settings > Linked Devices), or open the QR web page. Call this tool again after scanning.";

describe("isQrReady", () => {
  it("is true only for qr_pending with a QR code", () => {
    expect(isQrReady(state({ status: "qr_pending", qrCode: "2@abc" }))).toBe(true);
    expect(isQrReady(state({ status: "qr_pending", qrCode: null }))).toBe(false);
    expect(isQrReady(state({ status: "connecting", qrCode: "2@abc" }))).toBe(false);
  });
});

describe("buildConnectionReport without an identity (today's objects, byte for byte)", () => {
  it("connected, with the display name", () => {
    const report = buildConnectionReport(state({ status: "connected", user: "Alice" }), {
      ...NO_IDENTITY,
      pairedId: PAIRED,
    });
    expect(JSON.stringify(report.body)).toBe(
      '{"status":"connected","user":"Alice","message":"WhatsApp is connected and ready"}',
    );
    expect(report.reconnect).toBe(false);
  });

  it("connected, before the display name is known", () => {
    const report = buildConnectionReport(state({ status: "connected" }), NO_IDENTITY);
    expect(JSON.stringify(report.body)).toBe(
      '{"status":"connected","message":"WhatsApp is connected and ready"}',
    );
    expect(report.reconnect).toBe(false);
  });

  it("syncing, with the seconds since the last batch", () => {
    const report = buildConnectionReport(
      state({
        status: "syncing",
        user: "Alice",
        syncProgress: {
          chats: 3,
          contacts: 4,
          messages: 5,
          lastBatchAt: new Date(NOW - 12_400),
        },
      }),
      NO_IDENTITY,
    );
    expect(JSON.stringify(report.body)).toBe(
      '{"status":"syncing","user":"Alice","message":"WhatsApp is connected but syncing history. Some operations may fail.","sync_progress":{"chats":3,"contacts":4,"messages":5,"last_batch_ago_seconds":12}}',
    );
    expect(report.reconnect).toBe(false);
  });

  it("syncing, before any batch arrived", () => {
    const report = buildConnectionReport(state({ status: "syncing" }), NO_IDENTITY);
    expect(JSON.stringify(report.body)).toBe(
      '{"status":"syncing","message":"WhatsApp is connected but syncing history. Some operations may fail.","sync_progress":{"chats":0,"contacts":0,"messages":0,"last_batch_ago_seconds":null}}',
    );
  });

  it("connecting", () => {
    const report = buildConnectionReport(state({ status: "connecting" }), NO_IDENTITY);
    expect(JSON.stringify(report.body)).toBe(
      '{"status":"connecting","message":"Connecting to WhatsApp..."}',
    );
    expect(report.reconnect).toBe(false);
  });

  it("disconnected, which asks the caller to reconnect", () => {
    const report = buildConnectionReport(state({ status: "disconnected" }), NO_IDENTITY);
    expect(JSON.stringify(report.body)).toBe(
      '{"status":"disconnected","message":"WhatsApp is disconnected. Attempting to reconnect..."}',
    );
    expect(report.reconnect).toBe(true);
  });

  it("qr_pending without a QR code behaves like disconnected, as it always did", () => {
    const report = buildConnectionReport(state({ status: "qr_pending" }), NO_IDENTITY);
    expect(JSON.stringify(report.body)).toBe(
      '{"status":"qr_pending","message":"WhatsApp is disconnected. Attempting to reconnect..."}',
    );
    expect(report.reconnect).toBe(true);
  });

  it("qr_pending with a QR code points at the saved PNG", () => {
    const report = buildConnectionReport(
      state({ status: "qr_pending", qrCode: "2@abc", user: "ignored" }),
      NO_IDENTITY,
    );
    expect(JSON.stringify(report.body)).toBe(
      `{"status":"qr_pending","qr_code_path":"/tmp/whatsapp-mcp-qr.png","message":${JSON.stringify(QR_MESSAGE)}}`,
    );
    expect(report.reconnect).toBe(false);
  });

  it("never adds instance or phone_number keys, even when a phone is paired", () => {
    const keys = Object.keys(
      buildConnectionReport(state({ status: "connected" }), {
        ...NO_IDENTITY,
        pairedId: PAIRED,
      }).body,
    );
    expect(keys).toEqual(["status", "message"]);
  });

  it("saves the QR PNG where it always did", () => {
    expect(QR_PNG_PATH).toBe("/tmp/whatsapp-mcp-qr.png");
  });
});

describe("buildConnectionReport with an identity", () => {
  const withEmpresa = { identity: EMPRESA, now: NOW };

  it("adds instance and the paired phone digits right after status", () => {
    const report = buildConnectionReport(state({ status: "connected", user: "Alice" }), {
      ...withEmpresa,
      pairedId: PAIRED,
    });
    expect(report.body).toStrictEqual({
      status: "connected",
      instance: { label: "empresa", description: "the company line" },
      phone_number: "5500000000000",
      user: "Alice",
      message: "WhatsApp is connected and ready",
    });
    expect(Object.keys(report.body)).toEqual([
      "status",
      "instance",
      "phone_number",
      "user",
      "message",
    ]);
  });

  it("leaves out phone_number when nothing is paired", () => {
    const report = buildConnectionReport(state({ status: "disconnected" }), {
      ...withEmpresa,
      pairedId: undefined,
    });
    expect(Object.keys(report.body)).toEqual(["status", "instance", "message"]);
  });

  it("leaves out phone_number when the socket id is not a phone-number JID", () => {
    const report = buildConnectionReport(state({ status: "connected" }), {
      ...withEmpresa,
      pairedId: "10000000000005:3@lid",
    });
    expect(report.body).not.toHaveProperty("phone_number");
  });

  it("carries only the label when the identity has no description", () => {
    const report = buildConnectionReport(state({ status: "connected" }), {
      identity: { label: "empresa" },
      now: NOW,
    });
    expect(report.body.instance).toStrictEqual({ label: "empresa" });
  });

  it("names the line in the qr_pending branch too, so the agent knows which phone must scan", () => {
    const report = buildConnectionReport(state({ status: "qr_pending", qrCode: "2@abc" }), {
      ...withEmpresa,
      pairedId: undefined,
    });
    expect(report.body).toStrictEqual({
      status: "qr_pending",
      instance: { label: "empresa", description: "the company line" },
      qr_code_path: "/tmp/whatsapp-mcp-qr.png",
      message: QR_MESSAGE,
    });
    expect(report.reconnect).toBe(false);
  });

  it.each([
    ["connected", false],
    ["syncing", false],
    ["connecting", false],
    ["disconnected", true],
    ["qr_pending", true],
  ] as const)("names the line while %s, and reconnect stays %s", (status, reconnect) => {
    const report = buildConnectionReport(state({ status }), withEmpresa);
    expect(report.body.instance).toStrictEqual(EMPRESA);
    expect(report.reconnect).toBe(reconnect);
  });

  it("keeps every other key exactly as without an identity", () => {
    const syncing = state({
      status: "syncing",
      user: "Alice",
      syncProgress: { chats: 1, contacts: 2, messages: 3, lastBatchAt: new Date(NOW - 5_000) },
    });
    const plain = buildConnectionReport(syncing, NO_IDENTITY).body;
    const named = buildConnectionReport(syncing, { ...withEmpresa, pairedId: PAIRED }).body;
    const { instance: _i, phone_number: _p, ...rest } = named;
    expect(rest).toStrictEqual(plain);
  });

  it("does not hand out the identity object itself", () => {
    const report = buildConnectionReport(state({ status: "connected" }), withEmpresa);
    expect(report.body.instance).not.toBe(EMPRESA);
  });
});
