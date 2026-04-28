import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../database.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../database.ts")>();
  return {
    ...actual,
    getLatestMessage: vi.fn(),
  };
});

// Inline stub avoids importOriginal resolving @amiticia/baileys-client (not present in CI).
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

import { executeMarkChatRead } from "../actions.ts";
import { getLatestMessage } from "../database.ts";
import { socketState } from "../whatsapp.ts";
import pino from "pino";

const logger = pino({ level: "silent" });

describe("executeMarkChatRead", () => {
  let chatModify: ReturnType<typeof vi.fn>;
  let readMessages: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    chatModify = vi.fn().mockResolvedValue(undefined);
    readMessages = vi.fn().mockResolvedValue(undefined);
    socketState.socket = { chatModify, readMessages } as any;
  });

  afterEach(() => {
    socketState.socket = null;
    vi.clearAllMocks();
  });

  it("calls chatModify with markRead:true and a real MinimalMessage from the latest DB row", async () => {
    vi.mocked(getLatestMessage).mockReturnValue({
      id: "WAMSG_LATEST_001",
      chat_jid: "5511@s.whatsapp.net",
      sender: "5511@s.whatsapp.net",
      content: "hi",
      timestamp: new Date("2025-06-01T12:00:00Z"),
      is_from_me: false,
    } as any);

    const result = await executeMarkChatRead(logger, { chat_jid: "5511@s.whatsapp.net" });

    expect(readMessages).not.toHaveBeenCalled();
    expect(chatModify).toHaveBeenCalledTimes(1);
    const [mod, jid] = chatModify.mock.calls[0];
    expect(jid).toBe("5511@s.whatsapp.net");
    expect(mod.markRead).toBe(true);
    expect(Array.isArray(mod.lastMessages)).toBe(true);
    expect(mod.lastMessages).toHaveLength(1);

    const last = mod.lastMessages[0];
    expect(last.key).toBeDefined();
    expect(last.key.id).toBe("WAMSG_LATEST_001");
    expect(last.key.remoteJid).toBe("5511@s.whatsapp.net");
    expect(last.key.fromMe).toBe(false);
    expect(typeof last.messageTimestamp).toBe("number");
    expect(last.messageTimestamp).toBeGreaterThan(0);
    expect(result).toContain("5511@s.whatsapp.net");
  });

  it("throws when there are no messages to mark", async () => {
    vi.mocked(getLatestMessage).mockReturnValue(null);
    await expect(
      executeMarkChatRead(logger, { chat_jid: "empty@s.whatsapp.net" }),
    ).rejects.toThrow(/no messages|empty/i);
    expect(chatModify).not.toHaveBeenCalled();
  });

  it("throws when socket is not connected", async () => {
    socketState.socket = null;
    await expect(
      executeMarkChatRead(logger, { chat_jid: "x@s.whatsapp.net" }),
    ).rejects.toThrow(/not active/i);
  });

  it("includes participant for group chats so receipt routes correctly", async () => {
    vi.mocked(getLatestMessage).mockReturnValue({
      id: "GRP_MSG_1",
      chat_jid: "abc@g.us",
      sender: "5511888@s.whatsapp.net",
      content: "hi",
      timestamp: new Date("2025-06-01T12:00:00Z"),
      is_from_me: false,
    } as any);

    await executeMarkChatRead(logger, { chat_jid: "abc@g.us" });
    const [mod] = chatModify.mock.calls[0];
    expect(mod.lastMessages[0].key.remoteJid).toBe("abc@g.us");
    expect(mod.lastMessages[0].key.participant).toBe("5511888@s.whatsapp.net");
  });

  it("omits participant when latest message is from me (null sender) in a group", async () => {
    vi.mocked(getLatestMessage).mockReturnValue({
      id: "GRP_OWN_1",
      chat_jid: "abc@g.us",
      sender: null,
      content: "my msg",
      timestamp: new Date("2025-06-01T13:00:00Z"),
      is_from_me: true,
    } as any);

    await executeMarkChatRead(logger, { chat_jid: "abc@g.us" });
    const [mod] = chatModify.mock.calls[0];
    expect(mod.lastMessages[0].key.fromMe).toBe(true);
    expect(mod.lastMessages[0].key.participant).toBeUndefined();
  });

  it("omits participant for 1:1 chats even when sender is set", async () => {
    vi.mocked(getLatestMessage).mockReturnValue({
      id: "DM_MSG_1",
      chat_jid: "5511@s.whatsapp.net",
      sender: "5511@s.whatsapp.net",
      content: "dm",
      timestamp: new Date("2025-06-01T14:00:00Z"),
      is_from_me: false,
    } as any);

    await executeMarkChatRead(logger, { chat_jid: "5511@s.whatsapp.net" });
    const [mod] = chatModify.mock.calls[0];
    expect(mod.lastMessages[0].key.participant).toBeUndefined();
  });
});
