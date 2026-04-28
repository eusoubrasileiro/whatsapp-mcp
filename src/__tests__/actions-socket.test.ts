/**
 * Tests for socket-layer actions extracted from mcp.ts into actions.ts:
 *   executeLogout, executeGetGroupInfo, executeReactToMessage, executeDeleteMessage
 *
 * We avoid `importOriginal` on whatsapp.ts (which requires @amiticia/baileys-client)
 * by providing a minimal inline mock that only exposes the socketState we need.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Provide a self-contained stub — avoids importOriginal resolving baileys-client.
vi.mock("../whatsapp.ts", () => ({
  socketState: { socket: null as any },
  connectionState: {
    status: "disconnected",
    qrCode: null,
    qrAscii: null,
    user: null,
    syncProgress: { chats: 0, contacts: 0, messages: 0, lastBatchAt: null },
  },
  getConnectionState: () => ({
    status: "disconnected",
    qrCode: null,
    qrAscii: null,
    user: null,
    syncProgress: { chats: 0, contacts: 0, messages: 0, lastBatchAt: null },
  }),
  startWhatsAppConnection: vi.fn(),
  sendWhatsAppMessage: vi.fn(),
  sendWhatsAppMedia: vi.fn(),
  downloadMedia: vi.fn(),
}));

vi.mock("../database.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../database.ts")>();
  return {
    ...actual,
    getContactName: vi.fn().mockReturnValue(null),
  };
});

import {
  assertSocketActive,
  executeLogout,
  executeGetGroupInfo,
  executeReactToMessage,
  executeDeleteMessage,
} from "../actions.ts";
import { socketState } from "../whatsapp.ts";
import { getContactName } from "../database.ts";
import pino from "pino";

const logger = pino({ level: "silent" });

// ── assertSocketActive ─────────────────────────────────────────────

describe("assertSocketActive", () => {
  afterEach(() => {
    socketState.socket = null;
  });

  it("throws when socket is null", () => {
    socketState.socket = null;
    expect(() => assertSocketActive()).toThrow(/not active/i);
  });

  it("does not throw when socket is set", () => {
    socketState.socket = {} as any;
    expect(() => assertSocketActive()).not.toThrow();
  });
});

// ── executeLogout ──────────────────────────────────────────────────

describe("executeLogout", () => {
  let logoutFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logoutFn = vi.fn().mockResolvedValue(undefined);
    socketState.socket = { logout: logoutFn } as any;
  });

  afterEach(() => {
    socketState.socket = null;
    vi.clearAllMocks();
  });

  it("calls socket.logout() and returns confirmation message", async () => {
    const result = await executeLogout();
    expect(logoutFn).toHaveBeenCalledTimes(1);
    expect(result).toMatch(/logged out|reconnect|scan/i);
  });

  it("returns 'not connected' message when socket is null", async () => {
    socketState.socket = null;
    const result = await executeLogout();
    expect(logoutFn).not.toHaveBeenCalled();
    expect(result).toMatch(/not.*connected/i);
  });
});

// ── executeGetGroupInfo ────────────────────────────────────────────

describe("executeGetGroupInfo", () => {
  let groupMetadata: ReturnType<typeof vi.fn>;

  const fakeMetadata = {
    id: "abc@g.us",
    subject: "My Group",
    desc: "A group",
    owner: "5511@s.whatsapp.net",
    creation: 1700000000,
    participants: [
      { id: "5511@s.whatsapp.net", admin: "admin" },
      { id: "5522@s.whatsapp.net", admin: null },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    groupMetadata = vi.fn().mockResolvedValue(fakeMetadata);
    socketState.socket = { groupMetadata } as any;
  });

  afterEach(() => {
    socketState.socket = null;
    vi.clearAllMocks();
  });

  it("throws when socket is not connected", async () => {
    socketState.socket = null;
    await expect(
      executeGetGroupInfo({ group_jid: "abc@g.us" }),
    ).rejects.toThrow(/not active/i);
  });

  it("throws when JID does not end with @g.us", async () => {
    await expect(
      executeGetGroupInfo({ group_jid: "abc@s.whatsapp.net" }),
    ).rejects.toThrow(/@g\.us/);
  });

  it("returns group metadata JSON with participants", async () => {
    const result = await executeGetGroupInfo({ group_jid: "abc@g.us" });
    const parsed = JSON.parse(result);
    expect(parsed.jid).toBe("abc@g.us");
    expect(parsed.name).toBe("My Group");
    expect(parsed.description).toBe("A group");
    expect(parsed.participant_count).toBe(2);
    expect(parsed.participants).toHaveLength(2);
  });

  it("uses contact name for participant display name when available", async () => {
    vi.mocked(getContactName).mockImplementation((jid: string) =>
      jid === "5511@s.whatsapp.net" ? "Alice" : null,
    );
    const result = await executeGetGroupInfo({ group_jid: "abc@g.us" });
    const parsed = JSON.parse(result);
    const andre = parsed.participants.find((p: any) => p.jid === "5511@s.whatsapp.net");
    expect(andre.name).toBe("Alice");
  });

  it("falls back to phone segment when no contact name", async () => {
    vi.mocked(getContactName).mockReturnValue(null);
    const result = await executeGetGroupInfo({ group_jid: "abc@g.us" });
    const parsed = JSON.parse(result);
    const p = parsed.participants.find((p: any) => p.jid === "5522@s.whatsapp.net");
    expect(p.name).toBe("5522");
  });

  it("returns null description when metadata.desc is absent", async () => {
    const noDesc = { ...fakeMetadata, desc: undefined };
    groupMetadata.mockResolvedValue(noDesc);
    const parsed = JSON.parse(await executeGetGroupInfo({ group_jid: "abc@g.us" }));
    expect(parsed.description).toBeNull();
  });

  it("returns null owner when metadata.owner is absent", async () => {
    const noOwner = { ...fakeMetadata, owner: undefined };
    groupMetadata.mockResolvedValue(noOwner);
    const parsed = JSON.parse(await executeGetGroupInfo({ group_jid: "abc@g.us" }));
    expect(parsed.owner).toBeNull();
  });

  it("returns null creation_time when metadata.creation is absent", async () => {
    const noCreation = { ...fakeMetadata, creation: undefined };
    groupMetadata.mockResolvedValue(noCreation);
    const parsed = JSON.parse(await executeGetGroupInfo({ group_jid: "abc@g.us" }));
    expect(parsed.creation_time).toBeNull();
  });

  it("converts creation unix timestamp to ISO string", async () => {
    // metadata.creation = 1700000000 → 2023-11-14T22:13:20.000Z
    const parsed = JSON.parse(await executeGetGroupInfo({ group_jid: "abc@g.us" }));
    expect(parsed.creation_time).toBe(new Date(1700000000 * 1000).toISOString());
  });
});

// ── executeReactToMessage ──────────────────────────────────────────

describe("executeReactToMessage", () => {
  let sendMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    sendMessage = vi.fn().mockResolvedValue(undefined);
    socketState.socket = { sendMessage } as any;
  });

  afterEach(() => {
    socketState.socket = null;
    vi.clearAllMocks();
  });

  it("throws when socket is not connected", async () => {
    socketState.socket = null;
    await expect(
      executeReactToMessage({ chat_jid: "x@g.us", message_id: "m1", emoji: "👍", from_me: false }),
    ).rejects.toThrow(/not active/i);
  });

  it("sends a react message and returns confirmation with emoji", async () => {
    const result = await executeReactToMessage({
      chat_jid: "abc@g.us",
      message_id: "msg-123",
      emoji: "👍",
      from_me: false,
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [jid, payload] = sendMessage.mock.calls[0];
    expect(jid).toBe("abc@g.us");
    expect(payload.react.text).toBe("👍");
    expect(payload.react.key.id).toBe("msg-123");
    expect(payload.react.key.fromMe).toBe(false);
    expect(result).toMatch(/👍/);
  });

  it("empty emoji removes the reaction and returns removal message", async () => {
    const result = await executeReactToMessage({
      chat_jid: "abc@g.us",
      message_id: "msg-123",
      emoji: "",
      from_me: false,
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(result).toMatch(/removed|reaction/i);
    expect(result).not.toMatch(/Reacted/);
  });
});

// ── executeDeleteMessage ───────────────────────────────────────────

describe("executeDeleteMessage", () => {
  let sendMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    sendMessage = vi.fn().mockResolvedValue(undefined);
    socketState.socket = { sendMessage } as any;
  });

  afterEach(() => {
    socketState.socket = null;
    vi.clearAllMocks();
  });

  it("throws when socket is not connected", async () => {
    socketState.socket = null;
    await expect(
      executeDeleteMessage({ chat_jid: "x@g.us", message_id: "m1", from_me: true }),
    ).rejects.toThrow(/not active/i);
  });

  it("sends a delete message and returns confirmation", async () => {
    const result = await executeDeleteMessage({
      chat_jid: "abc@g.us",
      message_id: "msg-456",
      from_me: true,
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [jid, payload] = sendMessage.mock.calls[0];
    expect(jid).toBe("abc@g.us");
    expect(payload.delete.id).toBe("msg-456");
    expect(payload.delete.remoteJid).toBe("abc@g.us");
    expect(payload.delete.fromMe).toBe(true);
    expect(result).toMatch(/msg-456/);
  });
});
