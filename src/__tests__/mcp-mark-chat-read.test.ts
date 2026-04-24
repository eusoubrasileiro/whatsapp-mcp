import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../database.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../database.ts")>();
  return {
    ...actual,
    getLatestMessage: vi.fn(),
  };
});

vi.mock("../whatsapp.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../whatsapp.ts")>();
  return {
    ...actual,
    socketState: { socket: null as any },
  };
});

import { executeMarkChatRead } from "../mcp.ts";
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
});
