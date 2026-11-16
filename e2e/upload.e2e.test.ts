import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type E2eServer, startServer } from "./support/server.ts";

/**
 * POST /upload against the REAL dev RustFS (docker-compose.dev.yaml, service `minio`, on
 * localhost:9000). If RustFS or Docker is down, beforeAll fails and so does the suite: there
 * is deliberately no skip. Start it with `pnpm test:e2e:deps`.
 */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let server: E2eServer;
let upload: string;

beforeAll(async () => {
  server = await startServer({ s3: true });
  upload = `${server.uploadUrl}/upload`;
});

afterAll(async () => {
  await server?.stop();
});

describe("POST /upload", () => {
  it("rejects a request with no Bearer token with 401", async () => {
    const res = await fetch(upload, { method: "POST", body: PNG_MAGIC });

    expect(res.status).toBe(401);
  });

  it("rejects a wrong Bearer token with 401", async () => {
    const res = await fetch(upload, {
      method: "POST",
      body: PNG_MAGIC,
      headers: { authorization: "Bearer wrong" },
    });

    expect(res.status).toBe(401);
  });

  it("stores the bytes in RustFS and returns a URL that serves them back unchanged", async () => {
    const bytes = Buffer.concat([PNG_MAGIC, randomBytes(2048)]);

    const res = await fetch(upload, {
      method: "POST",
      body: bytes,
      headers: { authorization: `Bearer ${server.token}` },
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ mimetype: "image/png", size: bytes.length });
    expect(body.key).toMatch(/^t\/e2e-[0-9a-f]{8}\/uploads\/[0-9a-f-]{36}\.png$/);

    const fetched = await fetch(body.url);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await fetched.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it("rejects bytes that are not recognisable media with 415", async () => {
    const res = await fetch(upload, {
      method: "POST",
      body: "just some text",
      headers: { authorization: `Bearer ${server.token}` },
    });

    expect(res.status).toBe(415);
  });

  it("rejects an empty body with 400", async () => {
    const res = await fetch(upload, {
      method: "POST",
      headers: { authorization: `Bearer ${server.token}` },
    });

    expect(res.status).toBe(400);
  });

  it("answers GET /health without credentials", async () => {
    const res = await fetch(`${server.uploadUrl}/health`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
