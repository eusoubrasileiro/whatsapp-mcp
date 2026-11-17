import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type E2eServer, startServer } from "./support/server.ts";

const SECRET = "e2e-qr-instance-secret-0123456789abcdef";

let server: E2eServer;
let unlinkable: E2eServer; // started with the secret a hub would share with it

beforeAll(async () => {
  [server, unlinkable] = await Promise.all([
    startServer(),
    startServer({ env: { HUB_INSTANCE_SECRET: SECRET } }),
  ]);
});

afterAll(async () => {
  await Promise.all([server?.stop(), unlinkable?.stop()]);
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

describe("POST /internal/unlink", () => {
  const post = (target: E2eServer, authorization?: string) =>
    fetch(`${target.qrUrl}/internal/unlink`, {
      method: "POST",
      headers: authorization ? { authorization } : {},
    });

  it("does not exist on a server started without HUB_INSTANCE_SECRET, whatever it is sent", async () => {
    const res = await post(server, `Bearer ${SECRET}`);

    expect(res.status).toBe(404);
  });

  it.each([
    ["no Authorization header", undefined],
    ["a wrong secret", "Bearer not-the-secret"],
    ["the secret without the Bearer word", SECRET],
  ])("refuses %s with 401 and an empty body", async (_what, authorization) => {
    const res = await post(unlinkable, authorization);

    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
  });

  it("answers the right secret with unlinked:false, as nothing is connected, and touches no pairing", async () => {
    const res = await post(unlinkable, `Bearer ${SECRET}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ unlinked: false });
    expect(fs.existsSync(path.join(unlinkable.dataDir, "auth_info"))).toBe(false);
  });

  it("is a POST route only", async () => {
    const res = await fetch(`${unlinkable.qrUrl}/internal/unlink`, {
      headers: { authorization: `Bearer ${SECRET}` },
    });

    expect(res.status).toBe(405);
  });
});
