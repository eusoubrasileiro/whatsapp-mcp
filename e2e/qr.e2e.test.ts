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

describe("QR page", () => {
  it("serves the page and says the instance is not paired", async () => {
    const res = await fetch(`${server.qrUrl}/`);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("<h1>disconnected</h1>");
    expect(html).toContain("status: disconnected");
    expect(html).not.toContain("/qr.png"); // no QR to scan: nothing has connected
  });

  it("serves the same page at /index.html", async () => {
    const res = await fetch(`${server.qrUrl}/index.html`);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<h1>disconnected</h1>");
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
