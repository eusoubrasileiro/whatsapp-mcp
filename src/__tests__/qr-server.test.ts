import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pino, { type Logger } from "pino";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { ConnectionState } from "@amiticia/baileys-client";
import { createQrServer } from "../qr-server.ts";
import type { TenantConnectionManager } from "../tenancy/manager.ts";
import type { TenantConnection } from "../tenancy/tenant-connection.ts";

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

function makeFakeTc(id: string, displayName: string, state: ConnectionState): TenantConnection {
  return {
    tenantId: id,
    displayName,
    connectionState: state,
    socket: null,
    getStatus: () => ({
      status: state.status,
      user: state.user,
      hasQr: state.status === "qr_pending" && !!state.qrCode,
      displayName,
      lastSeenAt: null,
    }),
  } as unknown as TenantConnection;
}

function makeFakeManager(tenants: TenantConnection[]): TenantConnectionManager {
  const map = new Map(tenants.map((tc) => [tc.tenantId, tc]));
  return {
    get: (id: string) => map.get(id),
    list: () => tenants,
    statusSnapshot: () =>
      tenants.map((tc) => ({
        id: tc.tenantId,
        ...tc.getStatus(),
      })),
    start: vi.fn(),
    stop: vi.fn(),
  } as unknown as TenantConnectionManager;
}

describe("createQrServer (multi-tenant)", () => {
  let server: Server;
  let baseUrl: string;
  let state1: ConnectionState;
  let state2: ConnectionState;

  beforeEach(async () => {
    state1 = baseState();
    state2 = baseState();
    const tc1 = makeFakeTc("t-alice", "Alice", state1);
    const tc2 = makeFakeTc("t-bob", "Bob", state2);
    const mgr = makeFakeManager([tc1, tc2]);

    server = createQrServer(makeSilentLogger(), mgr);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("GET /health returns JSON with connected count and tenant statuses", async () => {
    state1.status = "connected";
    state1.user = "5531@s.whatsapp.net";

    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.connected).toBe(1);
    expect(body.total).toBe(2);
    expect(body.tenants).toHaveLength(2);
  });

  it("GET /tenants returns JSON array of tenant statuses", async () => {
    const res = await fetch(`${baseUrl}/tenants`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
    expect(body[0]).toHaveProperty("id");
    expect(body[0]).toHaveProperty("displayName");
  });

  it("GET / returns HTML overview listing all tenants", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Alice");
    expect(body).toContain("Bob");
    expect(body).toContain("<meta http-equiv=\"refresh\"");
  });

  it("GET /t/:tenantId/ returns per-tenant HTML page", async () => {
    state1.status = "connected";
    state1.user = "5531@s.whatsapp.net";
    const res = await fetch(`${baseUrl}/t/t-alice/`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Alice");
    expect(body).toContain("Connected");
  });

  it("GET /t/:tenantId/qr.png returns 404 when no QR pending", async () => {
    const res = await fetch(`${baseUrl}/t/t-alice/qr.png`);
    expect(res.status).toBe(404);
  });

  it("GET /t/:tenantId/qr.png returns PNG when QR is pending", async () => {
    state1.status = "qr_pending";
    state1.qrCode = "2@abc123,def456,ghi789==,hex";
    const res = await fetch(`${baseUrl}/t/t-alice/qr.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 4).toString("hex")).toBe("89504e47");
  });

  it("GET /t/nonexistent/ returns 404", async () => {
    const res = await fetch(`${baseUrl}/t/nonexistent/`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for unknown routes", async () => {
    const res = await fetch(`${baseUrl}/unknown`);
    expect(res.status).toBe(404);
  });
});
