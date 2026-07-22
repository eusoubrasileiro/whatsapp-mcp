import type { ConnectionState, SocketState } from "@amiticia/baileys-client";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
