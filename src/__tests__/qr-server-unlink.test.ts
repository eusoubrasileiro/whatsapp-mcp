import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQrServer, type QrServerOptions } from "../qr-server.ts";
import { stateOf } from "./helpers/connection-state.ts";
import { recordingLogger } from "./helpers/recording-logger.ts";

const SECRET = "hub-secret-0123456789abcdef-0123456789";
const open: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((close) => close()));
});

/** A QR server on loopback, with the unlink use case replaced by `run`. */
async function startQr(run: () => Promise<boolean>, options: QrServerOptions = {}) {
  const { logger, lines } = recordingLogger();
  const server = createQrServer(logger, () => stateOf({ status: "connected" }), {
    unlink: { secret: SECRET, run },
    ...options,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  open.push(() => new Promise((resolve) => server.close(() => resolve())));
  const call = (method: string, authorization?: string) =>
    fetch(`${url}/internal/unlink`, {
      method,
      redirect: "manual",
      headers: authorization === undefined ? {} : { authorization },
    });
  return { url, lines, call };
}

describe("POST /internal/unlink", () => {
  it("does not exist without a secret: 404 on every method, and the use case is never called", async () => {
    const run = vi.fn(async () => true);
    const qr = await startQr(run, { unlink: null });
    const noOption = await startQr(run, { unlink: undefined });

    for (const server of [qr, noOption]) {
      for (const method of ["POST", "GET", "PUT", "DELETE"]) {
        const res = await server.call(method, `Bearer ${SECRET}`);
        expect(res.status, method).toBe(404);
        expect(await res.text()).toBe("not found");
      }
    }
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ["no Authorization header", undefined],
    ["an empty one", ""],
    ["a wrong bearer", "Bearer not-the-secret"],
    ["a bearer that is the start of the secret", `Bearer ${SECRET.slice(0, -1)}`],
    ["the secret without its scheme", SECRET],
    ["another scheme", `Basic ${SECRET}`],
  ])(
    "answers 401 with an empty body for %s, and does not call the use case",
    async (_name, header) => {
      const run = vi.fn(async () => true);
      const qr = await startQr(run);

      const res = await qr.call("POST", header);

      expect(res.status).toBe(401);
      expect(await res.text()).toBe("");
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("runs the use case exactly once for the right bearer and says the number was unlinked", async () => {
    const run = vi.fn(async () => true);
    const qr = await startQr(run);

    const res = await qr.call("POST", `Bearer ${SECRET}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await res.json()).toEqual({ unlinked: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("says the number was not connected when the use case reports nothing to log out", async () => {
    const qr = await startQr(async () => false);

    const res = await qr.call("POST", `Bearer ${SECRET}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ unlinked: false });
  });

  it("answers 502 and logs the error, without the secret, when the use case throws", async () => {
    const qr = await startQr(async () => {
      throw new Error("socket exploded");
    });

    const res = await qr.call("POST", `Bearer ${SECRET}`);

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ unlinked: false });
    expect(qr.lines).toHaveLength(1);
    expect(JSON.parse(qr.lines[0])).toMatchObject({ level: 50 });
    expect(qr.lines[0]).toContain("socket exploded");
    expect(qr.lines[0]).not.toContain(SECRET);
  });

  it.each(["GET", "PUT", "DELETE", "PATCH"])(
    "never runs the use case for %s, with or without the right bearer",
    async (method) => {
      const run = vi.fn(async () => true);
      const qr = await startQr(run);

      for (const header of [undefined, `Bearer ${SECRET}`]) {
        const res = await qr.call(method, header);
        expect([404, 405], `${method} ${header}`).toContain(res.status);
      }
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("leaves /health, /live and /qr.png as they were", async () => {
    const qr = await startQr(async () => true);
    const bare = await startQr(async () => true, { unlink: null });

    for (const path of ["/health", "/live", "/qr.png"]) {
      const withRoute = await fetch(`${qr.url}${path}`);
      const without = await fetch(`${bare.url}${path}`);
      expect(withRoute.status, path).toBe(without.status);
      expect(await withRoute.text(), path).toBe(await without.text());
    }
  });
});
