import { describe, it, expect, beforeEach, vi } from "vitest";

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

import { downloadMedia as baileysDownloadMedia } from "@amiticia/baileys-client";
import { downloadMedia } from "../whatsapp.ts";
import type { TenantConnectionManager } from "../tenancy/manager.ts";
import type { TenantConnection } from "../tenancy/tenant-connection.ts";

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

function makeFakeManager(socket: any): TenantConnectionManager {
  return {
    get: vi.fn(() => ({
      tenantId: "default",
      socket,
    } as unknown as TenantConnection)),
  } as unknown as TenantConnectionManager;
}

// ── Download concurrency limiter ───────────────────────────────────

describe("downloadMedia concurrency", () => {
  let fakeSocket: any;
  let manager: TenantConnectionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    fakeSocket = { fake: true };
    manager = makeFakeManager(fakeSocket);
  });

  function makeDownloadParams(messageId: string) {
    return {
      logger: mockLogger,
      manager,
      tenantId: "default",
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
      const idx = parseInt((params as any).messageId.replace("msg", ""));
      const buf = await deferreds[idx].promise;
      currentConcurrent--;
      return buf;
    });

    const promises = deferreds.map((_, i) =>
      downloadMedia(makeDownloadParams(`msg${i}`)),
    );

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

    await vi.waitFor(() => expect(callCount).toBe(2));

    failDeferred.reject(new Error("download failed"));
    await vi.waitFor(() => expect(callCount).toBe(3));

    successDeferred.resolve(Buffer.from("data"));
    const [r1] = await Promise.all([p1, p2, p3]);
    expect(r1).toBe("failed");
  });

  it("throws when socket is null", async () => {
    const nullManager = makeFakeManager(null);
    await expect(
      downloadMedia({
        ...makeDownloadParams("msg1"),
        manager: nullManager,
      }),
    ).rejects.toThrow("Cannot download media: WhatsApp socket not connected.");
  });

  it("throws when tenant is not found", async () => {
    const emptyManager = {
      get: vi.fn(() => undefined),
    } as unknown as TenantConnectionManager;
    await expect(
      downloadMedia({
        ...makeDownloadParams("msg1"),
        manager: emptyManager,
      }),
    ).rejects.toThrow("Tenant default not found.");
  });
});
