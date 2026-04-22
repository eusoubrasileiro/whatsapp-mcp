import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@amiticia/baileys-client", () => ({
  startConnection: vi.fn(),
  parseMessage: vi.fn(),
}));

vi.mock("../db/queries.ts", () => ({
  storeChat: vi.fn(),
  storeMessage: vi.fn(),
  storeContact: vi.fn(),
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

import { TenantConnection } from "../tenancy/tenant-connection.ts";
import { startConnection, parseMessage } from "@amiticia/baileys-client";
import { storeChat, storeMessage, storeContact } from "../db/queries.ts";
import pino from "pino";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const logger = pino({ level: "silent" });

describe("TenantConnection", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeTenant(overrides: Record<string, unknown> = {}) {
    return {
      id: "t-alice",
      displayName: "Alice",
      expectedWaNumber: "5531",
      ntfyTopicUrl: null as string | null,
      writeToolsEnabled: false,
      allowedWriteTools: [] as string[],
      conversionKeywords: [] as string[],
      status: "disconnected",
      lastSeenAt: null as Date | null,
      createdAt: new Date(),
      ...overrides,
    };
  }

  it("creates auth directory under baseDir/auth_info/{tenantId}", () => {
    const tc = new TenantConnection(makeTenant(), tmpDir, logger);
    const expectedAuthDir = path.join(tmpDir, "auth_info", "t-alice");
    expect(tc.authDir).toBe(expectedAuthDir);
    expect(fs.existsSync(expectedAuthDir)).toBe(true);
  });

  it("getStatus returns disconnected before start", () => {
    const tc = new TenantConnection(makeTenant(), tmpDir, logger);
    expect(tc.getStatus().status).toBe("disconnected");
  });

  it("start() calls startConnection with correct authDir", async () => {
    const fakeConnectionState = {
      status: "connecting",
      qrCode: null,
      qrAscii: null,
      user: null,
      syncProgress: { chats: 0, contacts: 0, messages: 0, lastBatchAt: null },
    };
    const fakeSocketState = { socket: null };

    vi.mocked(startConnection).mockResolvedValue({
      connectionState: fakeConnectionState,
      socketState: fakeSocketState,
    } as any);

    const tc = new TenantConnection(makeTenant(), tmpDir, logger);
    await tc.start();

    expect(startConnection).toHaveBeenCalledOnce();
    const callArgs = vi.mocked(startConnection).mock.calls[0][0];
    expect(callArgs.authDir).toBe(path.join(tmpDir, "auth_info", "t-alice"));
    expect(tc.getStatus().status).toBe("connecting");
  });

  it("stop() resets state to disconnected", async () => {
    const fakeSocket = { end: vi.fn(), logout: vi.fn() };
    const fakeConnectionState = {
      status: "connected",
      qrCode: null,
      qrAscii: null,
      user: "5531@s.whatsapp.net",
      syncProgress: { chats: 0, contacts: 0, messages: 0, lastBatchAt: null },
    };
    const fakeSocketState = { socket: fakeSocket };

    vi.mocked(startConnection).mockResolvedValue({
      connectionState: fakeConnectionState,
      socketState: fakeSocketState,
    } as any);

    const tc = new TenantConnection(makeTenant(), tmpDir, logger);
    await tc.start();
    tc.stop();

    expect(tc.getStatus().status).toBe("disconnected");
    expect(tc.socket).toBeNull();
    expect(fakeSocket.end).toHaveBeenCalled();
  });

  it("onMessageUpsert stores messages with correct tenantId", async () => {
    let capturedHooks: any;
    vi.mocked(startConnection).mockImplementation(async (config: any) => {
      capturedHooks = config.hooks;
      return {
        connectionState: {
          status: "connected",
          qrCode: null,
          qrAscii: null,
          user: "5531@s.whatsapp.net",
          syncProgress: { chats: 0, contacts: 0, messages: 0, lastBatchAt: null },
        },
        socketState: { socket: {} },
      } as any;
    });

    vi.mocked(parseMessage).mockReturnValue({
      id: "m1",
      chat_jid: "c1@s.whatsapp.net",
      sender: "5531@s.whatsapp.net",
      content: "Hello",
      timestamp: new Date("2026-04-01T12:00:00Z"),
      is_from_me: false,
      media_type: null,
      mimetype: null,
      media_key: null,
      direct_path: null,
      media_url: null,
      file_length: null,
      file_sha256: null,
      file_enc_sha256: null,
    });

    const tc = new TenantConnection(makeTenant(), tmpDir, logger);
    await tc.start();

    await capturedHooks.onMessageUpsert([{ key: { id: "m1" } }], "notify");

    expect(storeMessage).toHaveBeenCalledWith(
      "t-alice",
      expect.objectContaining({ id: "m1", chat_jid: "c1@s.whatsapp.net" }),
    );
  });

  it("onGroupsSync stores chats with correct tenantId", async () => {
    let capturedHooks: any;
    vi.mocked(startConnection).mockImplementation(async (config: any) => {
      capturedHooks = config.hooks;
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

    const tc = new TenantConnection(makeTenant(), tmpDir, logger);
    await tc.start();

    await capturedHooks.onGroupsSync({
      "group1@g.us": { subject: "Team Chat" },
    });

    expect(storeChat).toHaveBeenCalledWith("t-alice", { jid: "group1@g.us", name: "Team Chat" });
  });

  it("onContactsUpsert stores contacts with correct tenantId", async () => {
    let capturedHooks: any;
    vi.mocked(startConnection).mockImplementation(async (config: any) => {
      capturedHooks = config.hooks;
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

    const tc = new TenantConnection(makeTenant(), tmpDir, logger);
    await tc.start();

    await capturedHooks.onContactsUpsert([
      { id: "5531@s.whatsapp.net", name: "Carlos", notify: "Carlinhos" },
    ]);

    expect(storeContact).toHaveBeenCalledWith("t-alice", {
      jid: "5531@s.whatsapp.net",
      name: "Carlos",
      notify: "Carlinhos",
    });
  });

  it("prevents concurrent start() calls", async () => {
    vi.mocked(startConnection).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50));
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

    const tc = new TenantConnection(makeTenant(), tmpDir, logger);
    const p1 = tc.start();
    const p2 = tc.start();

    await Promise.all([p1, p2]);

    expect(startConnection).toHaveBeenCalledOnce();
  });

  it("skips start when already connected", async () => {
    vi.mocked(startConnection).mockResolvedValue({
      connectionState: {
        status: "connected",
        qrCode: null,
        qrAscii: null,
        user: "5531@s.whatsapp.net",
        syncProgress: { chats: 0, contacts: 0, messages: 0, lastBatchAt: null },
      },
      socketState: { socket: { end: vi.fn() } },
    } as any);

    const tc = new TenantConnection(makeTenant(), tmpDir, logger);
    await tc.start();
    vi.mocked(startConnection).mockClear();
    await tc.start();

    expect(startConnection).not.toHaveBeenCalled();
  });

  it("getQrPng returns null when not in qr_pending state", async () => {
    const tc = new TenantConnection(makeTenant(), tmpDir, logger);
    const png = await tc.getQrPng();
    expect(png).toBeNull();
  });

  it("onHistorySync stores contacts, chats, and messages with correct tenantId", async () => {
    let capturedHooks: any;
    vi.mocked(startConnection).mockImplementation(async (config: any) => {
      capturedHooks = config.hooks;
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

    vi.mocked(parseMessage).mockReturnValue({
      id: "hist-m1",
      chat_jid: "c@s.whatsapp.net",
      sender: "5531@s.whatsapp.net",
      content: "History msg",
      timestamp: new Date("2026-01-01T00:00:00Z"),
      is_from_me: false,
      media_type: null,
      mimetype: null,
      media_key: null,
      direct_path: null,
      media_url: null,
      file_length: null,
      file_sha256: null,
      file_enc_sha256: null,
    });

    const tc = new TenantConnection(makeTenant(), tmpDir, logger);
    await tc.start();

    await capturedHooks.onHistorySync({
      contacts: [{ id: "5531@s.whatsapp.net", name: "Carlos" }],
      chats: [{ id: "c@s.whatsapp.net", name: "Chat", conversationTimestamp: 1704067200 }],
      messages: [{ key: { id: "hist-m1" } }],
    });

    expect(storeContact).toHaveBeenCalledWith("t-alice", expect.objectContaining({
      jid: "5531@s.whatsapp.net",
      name: "Carlos",
    }));
    expect(storeChat).toHaveBeenCalledWith("t-alice", expect.objectContaining({
      jid: "c@s.whatsapp.net",
    }));
    expect(storeMessage).toHaveBeenCalledWith("t-alice", expect.objectContaining({
      id: "hist-m1",
    }));
  });

  it("onChatsUpdate stores chats with correct tenantId", async () => {
    let capturedHooks: any;
    vi.mocked(startConnection).mockImplementation(async (config: any) => {
      capturedHooks = config.hooks;
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

    const tc = new TenantConnection(makeTenant(), tmpDir, logger);
    await tc.start();

    await capturedHooks.onChatsUpdate([
      { id: "c@s.whatsapp.net", name: "Updated Chat" },
    ]);

    expect(storeChat).toHaveBeenCalledWith("t-alice", expect.objectContaining({
      jid: "c@s.whatsapp.net",
      name: "Updated Chat",
    }));
  });

  it("onContactsUpdate stores contacts with correct tenantId", async () => {
    let capturedHooks: any;
    vi.mocked(startConnection).mockImplementation(async (config: any) => {
      capturedHooks = config.hooks;
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

    const tc = new TenantConnection(makeTenant(), tmpDir, logger);
    await tc.start();

    await capturedHooks.onContactsUpdate([
      { id: "5531@s.whatsapp.net", name: "Updated Carlos", notify: null },
    ]);

    expect(storeContact).toHaveBeenCalledWith("t-alice", expect.objectContaining({
      jid: "5531@s.whatsapp.net",
      name: "Updated Carlos",
    }));
  });

  it("stop() is safe to call when not started", () => {
    const tc = new TenantConnection(makeTenant(), tmpDir, logger);
    expect(() => tc.stop()).not.toThrow();
    expect(tc.getStatus().status).toBe("disconnected");
  });
});
