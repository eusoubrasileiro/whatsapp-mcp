import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pino, { type Logger } from "pino";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { ConnectionState } from "@amiticia/baileys-client";
import { createQrServer } from "../qr-server.ts";

function makeSilentLogger(): Logger {
  return pino({ level: "silent" });
}

function baseState(): ConnectionState {
  return {
    status: "disconnected",
    qrCode: null,
    qrAscii: null,
    user: null,
    syncProgress: { chats: 0, contacts: 0, messages: 0, lastBatchAt: null },
  };
}

describe("createQrServer", () => {
  let server: Server;
  let baseUrl: string;
  let state: ConnectionState;

  beforeEach(async () => {
    state = baseState();
    server = createQrServer(makeSilentLogger(), () => state);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("GET /health returns JSON with status and user", async () => {
    state.status = "connected";
    state.user = "5531999999999@s.whatsapp.net";

    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.status).toBe("connected");
    expect(body.user).toBe("5531999999999@s.whatsapp.net");
  });

  it("GET / returns HTML with auto-refresh meta", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("<meta http-equiv=\"refresh\"");
    expect(body).toContain("disconnected");
  });

  it("GET / shows connected message when connected", async () => {
    state.status = "connected";
    state.user = "5531999999999@s.whatsapp.net";
    const res = await fetch(`${baseUrl}/`);
    const body = await res.text();
    expect(body).toContain("5531999999999");
  });

  it("GET /qr.png returns 404 when no QR is pending", async () => {
    const res = await fetch(`${baseUrl}/qr.png`);
    expect(res.status).toBe(404);
  });

  it("GET /qr.png returns PNG when QR is pending", async () => {
    state.status = "qr_pending";
    state.qrCode = "2@abc123,def456,ghi789==,hex";
    const res = await fetch(`${baseUrl}/qr.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const buf = Buffer.from(await res.arrayBuffer());
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    expect(buf.subarray(0, 4).toString("hex")).toBe("89504e47");
  });

  it("returns 404 for unknown routes", async () => {
    const res = await fetch(`${baseUrl}/unknown`);
    expect(res.status).toBe(404);
  });
});
