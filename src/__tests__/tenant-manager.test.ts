import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import pino from "pino";

vi.mock("@amiticia/baileys-client", () => ({
  startConnection: vi.fn().mockResolvedValue({
    connectionState: {
      status: "connected",
      qrCode: null,
      qrAscii: null,
      user: null,
      syncProgress: { chats: 0, contacts: 0, messages: 0, lastBatchAt: null },
    },
    socketState: { socket: {} },
  }),
  parseMessage: vi.fn(),
}));

vi.mock("../db/queries.ts", () => ({
  storeChat: vi.fn(),
  storeMessage: vi.fn(),
  storeContact: vi.fn(),
}));

const mockFindMany = vi.fn();
const mockPrismaInstance = {
  tenant: { findMany: mockFindMany },
};
vi.mock("../db/client.ts", () => ({
  getPrisma: vi.fn(() => mockPrismaInstance),
}));

vi.mock("../connection-notifier.ts", () => ({
  createConnectionNotifier: vi.fn(() => ({
    onQrCode: vi.fn(),
    onConnecting: vi.fn(),
    onConnected: vi.fn(),
    onDisconnected: vi.fn(),
  })),
}));

vi.mock("../ntfy.ts", () => ({
  createNtfy: vi.fn(() => vi.fn()),
}));

import { TenantConnectionManager } from "../tenancy/manager.ts";
import { startConnection } from "@amiticia/baileys-client";

const logger = pino({ level: "silent" });

function makeTenantRow(id: string, displayName: string) {
  return {
    id,
    displayName,
    expectedWaNumber: "5531",
    ntfyTopicUrl: null,
    writeToolsEnabled: false,
    allowedWriteTools: [],
    conversionKeywords: [],
    status: "disconnected",
    lastSeenAt: null,
    createdAt: new Date(),
  };
}

describe("TenantConnectionManager", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mgr-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loadFromDb creates TenantConnection instances for each DB tenant", async () => {
    mockFindMany.mockResolvedValue([
      makeTenantRow("t-alice", "Alice"),
      makeTenantRow("t-bob", "Bob"),
    ]);

    const mgr = new TenantConnectionManager(tmpDir, logger);
    await mgr.loadFromDb();

    expect(mgr.list()).toHaveLength(2);
    expect(mgr.get("t-alice")).toBeDefined();
    expect(mgr.get("t-bob")).toBeDefined();
    expect(mgr.get("nonexistent")).toBeUndefined();
  });

  it("startAll starts all loaded connections with concurrency control", async () => {
    mockFindMany.mockResolvedValue([
      makeTenantRow("t-1", "T1"),
      makeTenantRow("t-2", "T2"),
      makeTenantRow("t-3", "T3"),
    ]);

    const mgr = new TenantConnectionManager(tmpDir, logger);
    await mgr.loadFromDb();
    await mgr.startAll();

    expect(startConnection).toHaveBeenCalledTimes(3);
  });

  it("start(id) starts a single tenant connection", async () => {
    mockFindMany.mockResolvedValue([
      makeTenantRow("t-alice", "Alice"),
    ]);

    const mgr = new TenantConnectionManager(tmpDir, logger);
    await mgr.loadFromDb();
    await mgr.start("t-alice");

    expect(startConnection).toHaveBeenCalledOnce();
  });

  it("start(id) throws for unknown tenant", async () => {
    mockFindMany.mockResolvedValue([]);

    const mgr = new TenantConnectionManager(tmpDir, logger);
    await mgr.loadFromDb();

    await expect(mgr.start("t-unknown")).rejects.toThrow("not found");
  });

  it("stop(id) stops a specific connection", async () => {
    mockFindMany.mockResolvedValue([
      makeTenantRow("t-alice", "Alice"),
    ]);

    const mgr = new TenantConnectionManager(tmpDir, logger);
    await mgr.loadFromDb();
    await mgr.start("t-alice");

    mgr.stop("t-alice");
    const status = mgr.get("t-alice")!.getStatus();
    expect(status.status).toBe("disconnected");
  });

  it("statusSnapshot returns status for all tenants", async () => {
    mockFindMany.mockResolvedValue([
      makeTenantRow("t-alice", "Alice"),
      makeTenantRow("t-bob", "Bob"),
    ]);

    const mgr = new TenantConnectionManager(tmpDir, logger);
    await mgr.loadFromDb();

    const snapshot = mgr.statusSnapshot();
    expect(snapshot).toHaveLength(2);
    expect(snapshot[0]).toMatchObject({
      id: "t-alice",
      displayName: "Alice",
      status: "disconnected",
      hasQr: false,
    });
  });

  it("stopAll stops all connections", async () => {
    mockFindMany.mockResolvedValue([
      makeTenantRow("t-1", "T1"),
      makeTenantRow("t-2", "T2"),
    ]);

    const mgr = new TenantConnectionManager(tmpDir, logger);
    await mgr.loadFromDb();
    await mgr.startAll();

    mgr.stopAll();

    const snapshot = mgr.statusSnapshot();
    expect(snapshot.every((s) => s.status === "disconnected")).toBe(true);
  });

  it("loadFromDb with empty tenant list produces empty manager", async () => {
    mockFindMany.mockResolvedValue([]);

    const mgr = new TenantConnectionManager(tmpDir, logger);
    await mgr.loadFromDb();

    expect(mgr.list()).toHaveLength(0);
    expect(mgr.statusSnapshot()).toEqual([]);
  });

  it("stop(id) is silent for nonexistent tenant", async () => {
    mockFindMany.mockResolvedValue([]);

    const mgr = new TenantConnectionManager(tmpDir, logger);
    await mgr.loadFromDb();

    expect(() => mgr.stop("nonexistent")).not.toThrow();
  });

  it("get returns undefined for unknown tenant", async () => {
    mockFindMany.mockResolvedValue([
      makeTenantRow("t-alice", "Alice"),
    ]);

    const mgr = new TenantConnectionManager(tmpDir, logger);
    await mgr.loadFromDb();

    expect(mgr.get("t-bob")).toBeUndefined();
  });

  it("startAll continues even when one tenant fails", async () => {
    mockFindMany.mockResolvedValue([
      makeTenantRow("t-1", "T1"),
      makeTenantRow("t-2", "T2"),
      makeTenantRow("t-3", "T3"),
    ]);

    let callCount = 0;
    vi.mocked(startConnection).mockImplementation(async () => {
      callCount++;
      if (callCount === 2) throw new Error("connection failed");
      return {
        connectionState: {
          status: "connected",
          qrCode: null,
          qrAscii: null,
          user: null,
          syncProgress: { chats: 0, contacts: 0, messages: 0, lastBatchAt: null },
        },
        socketState: { socket: {} },
      } as any;
    });

    const mgr = new TenantConnectionManager(tmpDir, logger);
    await mgr.loadFromDb();

    // Should not throw even though one tenant fails
    await expect(mgr.startAll()).resolves.toBeUndefined();
    expect(startConnection).toHaveBeenCalledTimes(3);
  });

  it("stopAll is safe when no tenants are loaded", async () => {
    mockFindMany.mockResolvedValue([]);

    const mgr = new TenantConnectionManager(tmpDir, logger);
    await mgr.loadFromDb();

    expect(() => mgr.stopAll()).not.toThrow();
  });
});
