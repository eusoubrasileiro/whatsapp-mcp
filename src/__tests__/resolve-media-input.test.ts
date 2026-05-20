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
      // Full PNG magic: 89 50 4E 47 0D 0A 1A 0A
      fs.writeFileSync(
        tmpFile,
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
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
      expect(result.buffer.length).toBe(8);
      expect(result.buffer[0]).toBe(0x89);
      expect(result.fileName).toBe(path.basename(tmpFile));
    });

    it("sniffs mimetype from magic bytes regardless of extension", async () => {
      const result = await resolveMediaInput(tmpFile);
      expect(result.mimetype).toBe("image/png");
    });

    it("throws when the local file does not exist", async () => {
      await expect(resolveMediaInput("/nonexistent/path/to/file.bin")).rejects.toThrow(
        /local file/i,
      );
    });
  });

  describe("http(s) URL", () => {
    it("fetches and returns the response buffer", async () => {
      // Real JPEG magic: FF D8 FF E0 ...
      const payload = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(payload, {
          status: 200,
          headers: { "content-type": "image/jpeg", "content-length": String(payload.length) },
        }),
      ) as unknown as typeof fetch;

      const result = await resolveMediaInput("https://example.com/path/photo.jpg");
      expect(result.buffer.equals(payload)).toBe(true);
      expect(result.fileName).toBe("photo.jpg");
      expect(result.mimetype).toBe("image/jpeg");
    });

    it("returns sniffed mimetype when Content-Type disagrees with bytes", async () => {
      // Server lies and says octet-stream, but bytes are JPEG.
      const payload = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(payload, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
      ) as unknown as typeof fetch;

      const result = await resolveMediaInput("https://example.com/x.bin");
      expect(result.mimetype).toBe("image/jpeg");
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
      expect(result.mimetype).toBe("image/png");
    });

    it("decodes base64 JPEG with correct extension", async () => {
      // Full JPEG SOI + APP0 marker (need ≥ 4 bytes for the sniffer)
      const b64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString("base64");
      const result = await resolveMediaInput(`data:image/jpeg;base64,${b64}`);
      expect(result.buffer[0]).toBe(0xff);
      expect(result.buffer[1]).toBe(0xd8);
      expect(result.fileName.endsWith(".jpg") || result.fileName.endsWith(".jpeg")).toBe(true);
      expect(result.mimetype).toBe("image/jpeg");
    });

    it("sniffs WebP magic bytes ignoring declared mediatype", async () => {
      // RIFF....WEBP — minimal WebP header
      const buf = Buffer.concat([
        Buffer.from("RIFF", "ascii"),
        Buffer.from([0x00, 0x00, 0x00, 0x00]),
        Buffer.from("WEBP", "ascii"),
      ]);
      const result = await resolveMediaInput(`data:image/png;base64,${buf.toString("base64")}`);
      // Declared image/png, but bytes are WebP — sniffer wins.
      expect(result.mimetype).toBe("image/webp");
    });

    it("sniffer overrides declared mediatype on mismatch (declared png, actual jpeg)", async () => {
      const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
      const result = await resolveMediaInput(
        `data:image/png;base64,${jpegBytes.toString("base64")}`,
      );
      expect(result.mimetype).toBe("image/jpeg");
    });

    it("falls back to declared mediatype when bytes are unrecognized", async () => {
      const unknownBytes = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);
      const result = await resolveMediaInput(
        `data:application/x-custom;base64,${unknownBytes.toString("base64")}`,
      );
      expect(result.mimetype).toBe("application/x-custom");
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
