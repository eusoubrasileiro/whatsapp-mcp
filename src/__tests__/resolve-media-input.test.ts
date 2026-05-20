import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveMediaInput } from "../media-input.ts";

describe("resolveMediaInput", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("local filesystem path", () => {
    let tmpFile: string;

    beforeEach(() => {
      tmpFile = path.join(os.tmpdir(), `resolve-media-${Date.now()}-${Math.random()}.bin`);
      fs.writeFileSync(tmpFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    });

    afterEach(() => {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // ignore
      }
    });

    it("reads an absolute path into a buffer with basename as fileName", async () => {
      const result = await resolveMediaInput(tmpFile);
      expect(result.buffer).toBeInstanceOf(Buffer);
      expect(result.buffer.length).toBe(4);
      expect(result.buffer[0]).toBe(0x89);
      expect(result.fileName).toBe(path.basename(tmpFile));
    });

    it("throws when the local file does not exist", async () => {
      await expect(resolveMediaInput("/nonexistent/path/to/file.bin")).rejects.toThrow(
        /local file/i,
      );
    });
  });

  describe("http(s) URL", () => {
    it("fetches and returns the response buffer", async () => {
      const payload = Buffer.from("fake-jpeg-bytes");
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(payload, {
          status: 200,
          headers: { "content-type": "image/jpeg", "content-length": String(payload.length) },
        }),
      ) as unknown as typeof fetch;

      const result = await resolveMediaInput("https://example.com/path/photo.jpg");
      expect(result.buffer.equals(payload)).toBe(true);
      expect(result.fileName).toBe("photo.jpg");
    });

    it("rejects when Content-Length exceeds 16 MB", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response("", {
          status: 200,
          headers: { "content-length": String(17 * 1024 * 1024) },
        }),
      ) as unknown as typeof fetch;

      await expect(resolveMediaInput("https://example.com/big.bin")).rejects.toThrow(
        /16 ?MB|too large|size/i,
      );
    });

    it("rejects on non-2xx response with status in error", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response("Not Found", { status: 404 }),
      ) as unknown as typeof fetch;

      await expect(resolveMediaInput("https://example.com/missing.jpg")).rejects.toThrow(/404/);
    });

    it("rejects on fetch failure", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("ENOTFOUND")) as unknown as typeof fetch;

      await expect(resolveMediaInput("https://bad.example.com/x")).rejects.toThrow(
        /fetch|ENOTFOUND/i,
      );
    });

    it("aborts after the 15s timeout", async () => {
      globalThis.fetch = vi.fn((_url, init) => {
        return new Promise((_resolve, reject) => {
          const signal = (init as RequestInit | undefined)?.signal;
          if (signal) {
            signal.addEventListener("abort", () => {
              const err = new Error("aborted");
              (err as Error & { name: string }).name = "AbortError";
              reject(err);
            });
          }
        });
      }) as unknown as typeof fetch;

      vi.useFakeTimers();
      const promise = resolveMediaInput("https://slow.example.com/x");
      const assertion = expect(promise).rejects.toThrow(/timed out|timeout|abort/i);
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
    });
  });

  describe("data: URL", () => {
    it("decodes base64 PNG into a buffer", async () => {
      // 1x1 transparent PNG
      const b64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=";
      const result = await resolveMediaInput(`data:image/png;base64,${b64}`);
      expect(result.buffer.length).toBeGreaterThan(0);
      expect(result.buffer[0]).toBe(0x89);
      expect(result.buffer[1]).toBe(0x50);
      expect(result.fileName.endsWith(".png")).toBe(true);
    });

    it("decodes base64 JPEG with correct extension", async () => {
      // Minimal JPEG SOI marker
      const b64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64");
      const result = await resolveMediaInput(`data:image/jpeg;base64,${b64}`);
      expect(result.buffer[0]).toBe(0xff);
      expect(result.buffer[1]).toBe(0xd8);
      expect(result.fileName.endsWith(".jpg") || result.fileName.endsWith(".jpeg")).toBe(true);
    });

    it("rejects malformed data URL", async () => {
      await expect(resolveMediaInput("data:notvalid")).rejects.toThrow(/data url|malformed/i);
    });
  });

  describe("scheme rejection", () => {
    it("rejects file:// URLs", async () => {
      await expect(resolveMediaInput("file:///etc/passwd")).rejects.toThrow(/scheme|file:/i);
    });

    it("rejects ftp:// URLs", async () => {
      await expect(resolveMediaInput("ftp://example.com/x")).rejects.toThrow(/scheme|ftp:/i);
    });

    it("rejects relative paths", async () => {
      await expect(resolveMediaInput("relative/path.jpg")).rejects.toThrow(/scheme|absolute|path/i);
    });
  });
});
