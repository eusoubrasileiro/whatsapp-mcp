import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type E2eServer, startServer } from "./support/server.ts";

let server: E2eServer;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server?.stop();
});

describe("QR server", () => {
  it("has no page: / and /index.html are 404 on the status port", async () => {
    for (const path of ["/", "/index.html"]) {
      const res = await fetch(`${server.qrUrl}${path}`);

      expect(res.status, path).toBe(404);
      expect(await res.text()).toBe("not found");
    }
  });

  it("answers /live with 200 whatever the WhatsApp socket is doing (Docker healthcheck)", async () => {
    const res = await fetch(`${server.qrUrl}/live`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ live: true });
  });

  it("reports the disconnected state, degraded but not yet wedged, on /health", async () => {
    const res = await fetch(`${server.qrUrl}/health`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ status: "disconnected", health: "degraded", user: null });
  });

  it("has no QR image to serve while nothing is connecting", async () => {
    const res = await fetch(`${server.qrUrl}/qr.png`);

    expect(res.status).toBe(404);
  });

  it("answers an unknown path with 404", async () => {
    expect((await fetch(`${server.qrUrl}/nope`)).status).toBe(404);
  });

  it("has no repair route: POST /repair answers 404", async () => {
    const res = await fetch(`${server.qrUrl}/repair`, { method: "POST", redirect: "manual" });

    expect(res.status).toBe(404);
  });
});

describe("no WhatsApp connection", () => {
  it("never starts one: no auth state on disk and still disconnected after boot", async () => {
    // A connection attempt creates auth_info/ at once; give a stray async one time to show up.
    await new Promise((resolve) => setTimeout(resolve, 1000));

    expect(fs.existsSync(path.join(server.dataDir, "auth_info"))).toBe(false);
    const health = await (await fetch(`${server.qrUrl}/health`)).json();
    expect(health.status).toBe("disconnected");
  });
});
