import type { ConnectionState, SocketState } from "@amiticia/baileys-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────

vi.mock("@amiticia/baileys-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@amiticia/baileys-client")>();
  return {
    ...actual,
    startConnection: vi.fn(),
    downloadMedia: vi.fn(),
    mimetypeToExtension: { "image/jpeg": "jpg" },
  };
});

vi.mock("../database.ts", () => ({
  storeMessage: vi.fn(),
  storeChat: vi.fn(),
  storeContact: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      existsSync: vi.fn(() => false),
    },
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    existsSync: vi.fn(() => false),
  };
});

import { downloadMedia as baileysDownloadMedia, startConnection } from "@amiticia/baileys-client";
import {
  connectionState,
  downloadMedia,
  getConnectTimeoutMs,
  socketState,
  startWhatsAppConnection,
} from "../whatsapp.ts";

// ── Helpers ────────────────────────────────────────────────────────

function createDeferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

// ── Reconnect guard ────────────────────────────────────────────────

describe("startWhatsAppConnection guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset module-level state to "disconnected" / no socket
    connectionState.status = "disconnected";
    connectionState.qrCode = null;
    connectionState.qrAscii = null;
    connectionState.user = null;
    socketState.socket = null;
  });

  it("deduplicates concurrent calls — startConnection called once", async () => {
    const deferred = createDeferred<ReturnType<typeof mockStartConnectionResult>>();
    vi.mocked(startConnection).mockReturnValue(deferred.promise as any);

    const p1 = startWhatsAppConnection(mockLogger);
    const p2 = startWhatsAppConnection(mockLogger);

    deferred.resolve(mockStartConnectionResult());
    await Promise.all([p1, p2]);

    expect(startConnection).toHaveBeenCalledTimes(1);
  });

  it("skips when status is 'connected'", async () => {
    connectionState.status = "connected";
    await startWhatsAppConnection(mockLogger);
    expect(startConnection).not.toHaveBeenCalled();
  });

  it("skips when status is 'syncing'", async () => {
    connectionState.status = "syncing";
    await startWhatsAppConnection(mockLogger);
    expect(startConnection).not.toHaveBeenCalled();
  });

  it("skips when status is 'connecting'", async () => {
    connectionState.status = "connecting";
    await startWhatsAppConnection(mockLogger);
    expect(startConnection).not.toHaveBeenCalled();
  });

  it("skips when status is 'qr_pending'", async () => {
    connectionState.status = "qr_pending";
    await startWhatsAppConnection(mockLogger);
    expect(startConnection).not.toHaveBeenCalled();
  });

  it("skips when socket already exists even if status is 'disconnected'", async () => {
    connectionState.status = "disconnected";
    socketState.socket = { fake: true } as any;
    await startWhatsAppConnection(mockLogger);
    expect(startConnection).not.toHaveBeenCalled();
  });
});

type StartConnectionResult = Awaited<ReturnType<typeof startConnection>>;

// ── Connection-attempt timeout (anti-wedge) ────────────────────────

describe("getConnectTimeoutMs", () => {
  it("defaults to 60 seconds when unset", () => {
    expect(getConnectTimeoutMs({})).toBe(60_000);
  });

  it("reads an explicit value from ENGINE_CONNECT_TIMEOUT_MS", () => {
    expect(getConnectTimeoutMs({ ENGINE_CONNECT_TIMEOUT_MS: "5000" })).toBe(5000);
  });

  it("treats 0 as 'no cap'", () => {
    expect(getConnectTimeoutMs({ ENGINE_CONNECT_TIMEOUT_MS: "0" })).toBe(0);
  });

  it("falls back to the default for junk so a typo cannot disable the cap", () => {
    expect(getConnectTimeoutMs({ ENGINE_CONNECT_TIMEOUT_MS: "banana" })).toBe(60_000);
    expect(getConnectTimeoutMs({ ENGINE_CONNECT_TIMEOUT_MS: "-1" })).toBe(60_000);
  });
});

describe("startWhatsAppConnection timeout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectionState.status = "disconnected";
    connectionState.qrCode = null;
    connectionState.qrAscii = null;
    connectionState.user = null;
    socketState.socket = null;
    process.env.ENGINE_CONNECT_TIMEOUT_MS = "20";
  });

  afterEach(() => {
    delete process.env.ENGINE_CONNECT_TIMEOUT_MS;
  });

  /** A result whose socket is identity-checkable, so a test can tell which
   *  attempt installed the live socket. */
  function taggedResult(tag: string) {
    const socket = { tag, end: vi.fn() };
    const result = {
      ...mockStartConnectionResult(),
      socketState: { socket },
    } as unknown as StartConnectionResult;
    return { result, socket };
  }

  /** Identity assertion without widening the socket type. */
  function expectLiveSocket(socket: object) {
    expect<unknown>(socketState.socket).toBe(socket);
  }

  it("rejects with the env var named when the connection attempt hangs", async () => {
    const hung = createDeferred<StartConnectionResult>();
    vi.mocked(startConnection).mockReturnValue(hung.promise);

    await expect(startWhatsAppConnection(mockLogger)).rejects.toThrow(/ENGINE_CONNECT_TIMEOUT_MS/);
  });

  it("starts a fresh attempt after a hang instead of awaiting the dead promise", async () => {
    const hung = createDeferred<StartConnectionResult>();
    vi.mocked(startConnection).mockReturnValueOnce(hung.promise);

    await expect(startWhatsAppConnection(mockLogger)).rejects.toThrow(/did not connect/i);
    expect(startConnection).toHaveBeenCalledTimes(1);

    // The wedge: before the fix, connectionPromise stayed set forever and this
    // call resolved off the dead promise without ever reconnecting.
    const second = taggedResult("second");
    vi.mocked(startConnection).mockResolvedValueOnce(second.result);
    await startWhatsAppConnection(mockLogger);

    expect(startConnection).toHaveBeenCalledTimes(2);
    expectLiveSocket(second.socket);
  });

  it("discards a superseded attempt that settles late, keeping the live socket", async () => {
    const hung = createDeferred<StartConnectionResult>();
    vi.mocked(startConnection).mockReturnValueOnce(hung.promise);
    await expect(startWhatsAppConnection(mockLogger)).rejects.toThrow(/did not connect/i);

    const second = taggedResult("second");
    vi.mocked(startConnection).mockResolvedValueOnce(second.result);
    await startWhatsAppConnection(mockLogger);

    // The hung attempt finally comes back — it must not clobber the live socket,
    // and its orphan socket is closed so two sockets can't share the creds.
    const late = taggedResult("late");
    hung.resolve(late.result);
    await vi.waitFor(() => expect(late.socket.end).toHaveBeenCalled());

    expectLiveSocket(second.socket);
  });

  it("never times out when ENGINE_CONNECT_TIMEOUT_MS is 0", async () => {
    process.env.ENGINE_CONNECT_TIMEOUT_MS = "0";
    const hung = createDeferred<StartConnectionResult>();
    vi.mocked(startConnection).mockReturnValue(hung.promise);

    let settled = false;
    const call = startWhatsAppConnection(mockLogger).then(() => {
      settled = true;
    });

    await new Promise((r) => setTimeout(r, 80));
    expect(settled).toBe(false);

    const uncapped = taggedResult("uncapped");
    hung.resolve(uncapped.result);
    await call;
    expectLiveSocket(uncapped.socket);
  });

  it("leaves a connection that completes inside the window unaffected", async () => {
    const fast = taggedResult("fast");
    vi.mocked(startConnection).mockResolvedValue(fast.result);

    await startWhatsAppConnection(mockLogger);

    expect(startConnection).toHaveBeenCalledTimes(1);
    expectLiveSocket(fast.socket);
  });
});

// ── Download concurrency limiter ───────────────────────────────────

describe("downloadMedia concurrency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    socketState.socket = { fake: true } as any;
  });

  function makeDownloadParams(messageId: string) {
    return {
      logger: mockLogger,
      mediaKey: "key",
      directPath: "/path",
      mediaUrl: null,
      mediaType: "image" as const,
      mimetype: "image/jpeg",
      chatJid: "123@s.whatsapp.net",
      messageId,
      fromMe: false,
    };
  }

  it("limits concurrent downloads to 2", async () => {
    let peakConcurrent = 0;
    let currentConcurrent = 0;
    const deferreds = Array.from({ length: 5 }, () => createDeferred<Buffer>());

    vi.mocked(baileysDownloadMedia).mockImplementation(async (_sock, params) => {
      currentConcurrent++;
      peakConcurrent = Math.max(peakConcurrent, currentConcurrent);
      const idx = parseInt((params as any).messageId.replace("msg", ""), 10);
      const buf = await deferreds[idx].promise;
      currentConcurrent--;
      return buf;
    });

    const promises = deferreds.map((_, i) => downloadMedia(makeDownloadParams(`msg${i}`)));

    // Let the first 2 start, resolve them, then the next batch
    await vi.waitFor(() => expect(currentConcurrent).toBe(2));
    for (const d of deferreds) d.resolve(Buffer.from("data"));
    await Promise.all(promises);

    expect(peakConcurrent).toBe(2);
  });

  it("frees slot when download fails", async () => {
    const failDeferred = createDeferred<Buffer>();
    const successDeferred = createDeferred<Buffer>();
    let callCount = 0;

    vi.mocked(baileysDownloadMedia).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return failDeferred.promise;
      return successDeferred.promise;
    });

    const p1 = downloadMedia(makeDownloadParams("fail1")).catch(() => "failed");
    const p2 = downloadMedia(makeDownloadParams("ok1"));
    const p3 = downloadMedia(makeDownloadParams("ok2"));

    // First two start (limit=2), third waits
    await vi.waitFor(() => expect(callCount).toBe(2));

    // Fail the first — should free a slot for the third
    failDeferred.reject(new Error("download failed"));
    await vi.waitFor(() => expect(callCount).toBe(3));

    successDeferred.resolve(Buffer.from("data"));
    const [r1] = await Promise.all([p1, p2, p3]);
    expect(r1).toBe("failed");
  });

  it("throws when socket is null", async () => {
    socketState.socket = null;
    await expect(downloadMedia(makeDownloadParams("msg1"))).rejects.toThrow(
      "Cannot download media: WhatsApp socket not connected.",
    );
  });
});
