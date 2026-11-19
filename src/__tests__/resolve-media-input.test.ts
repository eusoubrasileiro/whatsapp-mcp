import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LocalSendConfig, readLocalSendConfig } from "../local-send-dir.ts";
import { resolveMediaInput } from "../media-input.ts";

describe("resolveMediaInput", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("local filesystem path", () => {
    // Full PNG magic: 89 50 4E 47 0D 0A 1A 0A
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    let base: string;
    let root: string;
    let local: LocalSendConfig;
    let tmpFile: string;

    beforeEach(() => {
      base = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-media-"));
      root = path.join(base, "outbox");
      fs.mkdirSync(root);
      fs.mkdirSync(path.join(base, "auth_info"));
      fs.writeFileSync(path.join(base, "auth_info", "creds.json"), '{"noiseKey":"secret"}');
      local = { root, protectedDirs: [path.join(base, "auth_info")] };
      tmpFile = path.join(root, "photo.bin");
      fs.writeFileSync(tmpFile, PNG);
    });

    afterEach(() => {
      fs.rmSync(base, { recursive: true, force: true });
    });

    it("reads a file inside the send directory with basename as fileName", async () => {
      const result = await resolveMediaInput(tmpFile, local);
      expect(result.buffer.equals(PNG)).toBe(true);
      expect(result.fileName).toBe("photo.bin");
    });

    it("sniffs mimetype from magic bytes regardless of extension", async () => {
      const result = await resolveMediaInput(tmpFile, local);
      expect(result.mimetype).toBe("image/png");
    });

    it("falls back to the extension's mimetype when the bytes are not recognised", async () => {
      const pdfLike = path.join(root, "notes.pdf");
      fs.writeFileSync(pdfLike, "not really a pdf");
      const result = await resolveMediaInput(pdfLike, local);
      expect(result.mimetype).toBe("application/pdf");
    });

    it("throws when the local file does not exist", async () => {
      await expect(resolveMediaInput(path.join(root, "missing.bin"), local)).rejects.toThrow(
        /^send_file: cannot read local file .*missing\.bin/,
      );
    });

    it("refuses an existing file outside the send directory, naming the directory", async () => {
      const outside = path.join(base, "elsewhere.png");
      fs.writeFileSync(outside, PNG);
      await expect(resolveMediaInput(outside, local)).rejects.toThrow(
        `send_file: ${outside} is outside ${root}, the only directory this server sends local files from`,
      );
    });

    it("refuses the pairing credentials", async () => {
      await expect(
        resolveMediaInput(path.join(base, "auth_info", "creds.json"), local),
      ).rejects.toThrow(/outside/);
    });

    it("refuses a `..` path that climbs out of the send directory", async () => {
      fs.writeFileSync(path.join(base, "secret.png"), PNG);
      await expect(
        resolveMediaInput(`${root}${path.sep}..${path.sep}secret.png`, local),
      ).rejects.toThrow(/outside/);
    });

    it("refuses a symlink inside the send directory that points out of it", async () => {
      const link = path.join(root, "innocent.png");
      fs.symlinkSync(path.join(base, "auth_info", "creds.json"), link);
      await expect(resolveMediaInput(link, local)).rejects.toThrow(/outside/);
    });

    it("refuses a sibling directory whose name only starts like the send directory", async () => {
      const sibling = `${root}-other`;
      fs.mkdirSync(sibling);
      fs.writeFileSync(path.join(sibling, "x.png"), PNG);
      await expect(resolveMediaInput(path.join(sibling, "x.png"), local)).rejects.toThrow(
        /outside/,
      );
    });

    it("reads a file whose name begins with two dots", async () => {
      const dotted = path.join(root, "..photo.png");
      fs.writeFileSync(dotted, PNG);
      const result = await resolveMediaInput(dotted, local);
      expect(result.fileName).toBe("..photo.png");
    });

    it("follows a send directory that is itself a symlink", async () => {
      const linkedRoot = path.join(base, "linked-outbox");
      fs.symlinkSync(root, linkedRoot);
      const result = await resolveMediaInput(path.join(linkedRoot, "photo.bin"), {
        ...local,
        root: linkedRoot,
      });
      expect(result.buffer.equals(PNG)).toBe(true);
    });

    const ownFiles = (sendDir: string, dir: string) =>
      `send_file: local files are not sent from ${sendDir}, because it holds this server's own files (${dir}). Point SEND_FILE_LOCAL_DIR at a directory of its own.`;

    it("sends nothing from a send directory that holds the credentials directory", async () => {
      const settings = { ...local, root: base };
      const authInfo = path.join(base, "auth_info");
      await expect(resolveMediaInput(tmpFile, settings)).rejects.toThrow(ownFiles(base, authInfo));
      await expect(resolveMediaInput(path.join(authInfo, "creds.json"), settings)).rejects.toThrow(
        ownFiles(base, authInfo),
      );
    });

    it("sends nothing from a send directory that is the credentials directory", async () => {
      const authInfo = path.join(base, "auth_info");
      await expect(
        resolveMediaInput(path.join(authInfo, "creds.json"), { ...local, root: authInfo }),
      ).rejects.toThrow(ownFiles(authInfo, authInfo));
    });

    it("sends nothing from a send directory inside the credentials directory", async () => {
      const inside = path.join(base, "auth_info", "sub");
      fs.mkdirSync(inside);
      fs.writeFileSync(path.join(inside, "photo.png"), PNG);
      await expect(
        resolveMediaInput(path.join(inside, "photo.png"), { ...local, root: inside }),
      ).rejects.toThrow(ownFiles(inside, path.join(base, "auth_info")));
    });

    it("judges a protected directory that does not exist yet by its path", async () => {
      const notYet = path.join(base, "data");
      await expect(
        resolveMediaInput(tmpFile, { root: base, protectedDirs: [notYet] }),
      ).rejects.toThrow(ownFiles(base, notYet));
    });

    it("sends from a send directory beside the protected ones", async () => {
      const result = await resolveMediaInput(tmpFile, local);
      expect(result.buffer.equals(PNG)).toBe(true);
    });

    it("refuses a directory", async () => {
      fs.mkdirSync(path.join(root, "folder"));
      await expect(resolveMediaInput(path.join(root, "folder"), local)).rejects.toThrow(
        `send_file: ${path.join(root, "folder")} is not a regular file`,
      );
    });

    it("refuses a file over 16 MB without reading it", async () => {
      const big = path.join(root, "big.bin");
      fs.writeFileSync(big, "");
      fs.truncateSync(big, 16 * 1024 * 1024 + 1);
      await expect(resolveMediaInput(big, local)).rejects.toThrow(
        `send_file: local file ${big} is 16777217 bytes, exceeds 16 MB limit`,
      );
    });

    it("reads a file of exactly 16 MB", async () => {
      const edge = path.join(root, "edge.bin");
      fs.writeFileSync(edge, "");
      fs.truncateSync(edge, 16 * 1024 * 1024);
      const result = await resolveMediaInput(edge, local);
      expect(result.buffer.length).toBe(16 * 1024 * 1024);
    });

    it("refuses every local path when the send directory does not exist", async () => {
      const gone = path.join(base, "no-such-dir");
      await expect(resolveMediaInput(tmpFile, { ...local, root: gone })).rejects.toThrow(
        `send_file: local files are only sent from ${gone}, which does not exist on this server`,
      );
    });

    it("tells the caller to upload the file or pass a URL instead", async () => {
      await expect(resolveMediaInput("/etc/hostname", local)).rejects.toThrow(
        /POST it to \/upload and pass the returned URL, or pass an http\(s\) or data: URL/,
      );
    });

    it("reads the send directory from the environment by default", async () => {
      vi.stubEnv("SEND_FILE_LOCAL_DIR", root);
      vi.stubEnv("WHATSAPP_MCP_DATA_DIR", base);
      try {
        expect((await resolveMediaInput(tmpFile)).buffer.equals(PNG)).toBe(true);
        await expect(resolveMediaInput(path.join(base, "auth_info", "creds.json"))).rejects.toThrow(
          /outside/,
        );
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  describe("readLocalSendConfig", () => {
    const repoRoot = path.resolve(import.meta.dirname, "..", "..");

    it("defaults to <data dir>/outbox and protects auth_info and data", () => {
      expect(readLocalSendConfig({ WHATSAPP_MCP_DATA_DIR: "/data" })).toEqual({
        root: "/data/outbox",
        protectedDirs: ["/data/auth_info", "/data/data"],
      });
    });

    it("uses the repository root as the data dir when none is set, like the pairing store", () => {
      expect(readLocalSendConfig({})).toEqual({
        root: path.join(repoRoot, "outbox"),
        protectedDirs: [path.join(repoRoot, "auth_info"), path.join(repoRoot, "data")],
      });
    });

    it("takes an absolute SEND_FILE_LOCAL_DIR, trimmed", () => {
      expect(
        readLocalSendConfig({ WHATSAPP_MCP_DATA_DIR: "/data", SEND_FILE_LOCAL_DIR: " /srv/out \n" })
          .root,
      ).toBe("/srv/out");
    });

    it.each([
      ["relative", "outbox"],
      ["empty", ""],
      ["blank", "   "],
    ])("ignores a %s SEND_FILE_LOCAL_DIR and keeps the default", (_kind, value) => {
      expect(
        readLocalSendConfig({ WHATSAPP_MCP_DATA_DIR: "/data", SEND_FILE_LOCAL_DIR: value }).root,
      ).toBe("/data/outbox");
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
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(new Response("Not Found", { status: 404 })) as unknown as typeof fetch;

      await expect(resolveMediaInput("https://example.com/missing.jpg")).rejects.toThrow(/404/);
    });

    it("rejects on fetch failure", async () => {
      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(new Error("ENOTFOUND")) as unknown as typeof fetch;

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
