import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import pino, { type Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUploadServer, type UploadServerOptions } from "../upload-server.ts";

type PutUploadFn = UploadServerOptions["putUpload"];

function makeSilentLogger(): Logger {
  return pino({ level: "silent" });
}

// PNG magic header — minimal sniffable image payload.
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// MP4 "ftyp" box — bytes 4..8 = "ftyp", brand at 8..12 = "isom".
const MP4_HEAD = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from("ftyp", "ascii"),
  Buffer.from("isom", "ascii"),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
]);

async function start(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

async function stop(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

describe("createUploadServer", () => {
  let server: Server;
  let baseUrl: string;
  let putUpload: ReturnType<typeof vi.fn<PutUploadFn>>;

  beforeEach(async () => {
    putUpload = vi.fn<PutUploadFn>(async ({ ext }) => ({
      key: `t/default/uploads/test-uuid.${ext}`,
      url: `http://localhost:9000/amiticia-media/t/default/uploads/test-uuid.${ext}`,
    }));
    server = createUploadServer(makeSilentLogger(), { putUpload });
    baseUrl = await start(server);
  });

  afterEach(async () => {
    await stop(server);
  });

  it("POST /upload accepts a PNG body and returns url/key/mimetype/size", async () => {
    const body = Buffer.concat([PNG_HEAD, Buffer.alloc(64, 0x41)]);
    const res = await fetch(`${baseUrl}/upload`, {
      method: "POST",
      body,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const json = await res.json();
    expect(json.mimetype).toBe("image/png");
    expect(json.size).toBe(body.length);
    expect(json.key).toContain(".png");
    expect(json.url).toContain("/uploads/");

    expect(putUpload).toHaveBeenCalledOnce();
    const call = putUpload.mock.calls[0][0];
    expect(call.mimetype).toBe("image/png");
    expect(call.ext).toBe("png");
    expect(Buffer.isBuffer(call.buffer)).toBe(true);
    expect(call.buffer.length).toBe(body.length);
  });

  it("POST /upload accepts an MP4 body and routes ext=mp4", async () => {
    const res = await fetch(`${baseUrl}/upload`, {
      method: "POST",
      body: MP4_HEAD,
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.mimetype).toBe("video/mp4");
    expect(json.key.endsWith(".mp4")).toBe(true);
  });

  it("POST /upload with empty body returns 400", async () => {
    const res = await fetch(`${baseUrl}/upload`, { method: "POST", body: "" });
    expect(res.status).toBe(400);
    expect(putUpload).not.toHaveBeenCalled();
  });

  it("POST /upload rejects body with un-sniffable bytes (no MIME match) as 415", async () => {
    const res = await fetch(`${baseUrl}/upload`, {
      method: "POST",
      body: Buffer.from("hello world this is plain text"),
    });
    expect(res.status).toBe(415);
    expect(putUpload).not.toHaveBeenCalled();
  });

  it("POST /upload over 16 MB returns 413 and never calls putUpload", async () => {
    const oversize = Buffer.concat([PNG_HEAD, Buffer.alloc(16 * 1024 * 1024 + 1)]);
    const res = await fetch(`${baseUrl}/upload`, { method: "POST", body: oversize });
    expect(res.status).toBe(413);
    expect(putUpload).not.toHaveBeenCalled();
  });

  it("GET /health returns 200 JSON", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ok");
  });

  it("GET /upload returns 405", async () => {
    const res = await fetch(`${baseUrl}/upload`);
    expect(res.status).toBe(405);
  });

  it("unknown routes return 404", async () => {
    const res = await fetch(`${baseUrl}/whatever`);
    expect(res.status).toBe(404);
  });

  it("propagates putUpload errors as 500", async () => {
    putUpload.mockRejectedValueOnce(new Error("S3 down"));
    const body = Buffer.concat([PNG_HEAD, Buffer.alloc(32)]);
    const res = await fetch(`${baseUrl}/upload`, { method: "POST", body });
    expect(res.status).toBe(500);
  });

  describe("when authToken is set", () => {
    let authServer: Server;
    let authBaseUrl: string;

    beforeEach(async () => {
      authServer = createUploadServer(makeSilentLogger(), {
        putUpload,
        authToken: "secret-token",
      });
      authBaseUrl = await start(authServer);
    });

    afterEach(async () => {
      await stop(authServer);
    });

    it("POST /upload without Authorization header returns 401", async () => {
      const res = await fetch(`${authBaseUrl}/upload`, {
        method: "POST",
        body: PNG_HEAD,
      });
      expect(res.status).toBe(401);
      expect(putUpload).not.toHaveBeenCalled();
    });

    it("POST /upload with wrong bearer returns 401", async () => {
      const res = await fetch(`${authBaseUrl}/upload`, {
        method: "POST",
        headers: { Authorization: "Bearer wrong" },
        body: PNG_HEAD,
      });
      expect(res.status).toBe(401);
      expect(putUpload).not.toHaveBeenCalled();
    });

    it("POST /upload with correct bearer returns 200", async () => {
      const body = Buffer.concat([PNG_HEAD, Buffer.alloc(8)]);
      const res = await fetch(`${authBaseUrl}/upload`, {
        method: "POST",
        headers: { Authorization: "Bearer secret-token" },
        body,
      });
      expect(res.status).toBe(200);
      expect(putUpload).toHaveBeenCalledOnce();
    });

    it("GET /health is unauthenticated", async () => {
      const res = await fetch(`${authBaseUrl}/health`);
      expect(res.status).toBe(200);
    });
  });
});
