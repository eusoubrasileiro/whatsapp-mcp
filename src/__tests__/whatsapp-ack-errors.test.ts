import type { ConnectionState, SocketState } from "@amiticia/baileys-client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Integration counterpart to ack-errors.test.ts: that file covers the pure
// classifier, this one proves whatsapp.ts actually *registers* the hook.
// The regression being guarded is precisely a missing registration — the hook
// existed in baileys-client and was dispatched, but nothing consumed it, so
// every server-rejected send was silently discarded.

vi.mock("@amiticia/baileys-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@amiticia/baileys-client")>();
  return { ...actual, startConnection: vi.fn() };
});

vi.mock("../database.ts", () => ({
  storeMessage: vi.fn(),
  storeChat: vi.fn(),
  storeContact: vi.fn(),
}));

import { startConnection } from "@amiticia/baileys-client";
import { connectionState, socketState, startWhatsAppConnection } from "../whatsapp.ts";

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(() => mockLogger),
  level: "info",
} as any;

function mockStartConnectionResult(): {
  connectionState: ConnectionState;
  socketState: SocketState;
  socket: any;
} {
  return {
    socket: { ev: { process: vi.fn() } },
    connectionState: {
      status: "disconnected" as const,
      qrCode: null,
      qrAscii: null,
      user: null,
      syncProgress: { chats: 0, contacts: 0, messages: 0, lastBatchAt: null },
    },
    socketState: { socket: {} as any },
  };
}

/** Grab the hooks object whatsapp.ts handed to startConnection. */
async function captureHooks() {
  vi.mocked(startConnection).mockResolvedValue(mockStartConnectionResult() as never);
  await startWhatsAppConnection(mockLogger);
  return vi.mocked(startConnection).mock.calls[0][0].hooks;
}

describe("whatsapp.ts ack-error wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectionState.status = "disconnected";
    connectionState.user = null;
    socketState.socket = null;
  });

  it("registers an onMessagesUpdate hook", async () => {
    const hooks = await captureHooks();
    expect(typeof hooks?.onMessagesUpdate).toBe("function");
  });

  it("warns when a send is rejected with 463", async () => {
    const hooks = await captureHooks();

    await hooks?.onMessagesUpdate?.([
      {
        key: { id: "3EB0DE", remoteJid: "5531991234567@s.whatsapp.net", fromMe: true },
        update: { status: 0, messageStubParameters: ["463"] },
      },
    ] as never);

    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    const [bindings, msg] = mockLogger.warn.mock.calls[0];
    expect(bindings.code).toBe("463");
    expect(bindings.chat_jid).toBe("5531991234567@s.whatsapp.net");
    expect(msg).toMatch(/send rejected/i);
  });

  it("stays quiet on ordinary delivery acks", async () => {
    const hooks = await captureHooks();

    await hooks?.onMessagesUpdate?.([
      {
        key: { id: "3EB0DE", remoteJid: "5531991234567@s.whatsapp.net", fromMe: true },
        update: { status: 3 },
      },
    ] as never);

    expect(mockLogger.warn).not.toHaveBeenCalled();
  });
});
