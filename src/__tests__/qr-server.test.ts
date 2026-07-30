import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ConnectionState } from "@amiticia/baileys-client";
import pino, { type Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQrServer } from "../qr-server.ts";

function makeSilentLogger(): Logger {
  return pino({ level: "silent" });
}

type HealthBody = {
  health: "ok" | "degraded";
  status: string;
  user: string | null;
  disconnected_for_s: number;
  grace_s: number;
};

function baseState(): ConnectionState {
  return {
    status: "disconnected",
    qrCode: null,
    qrAscii: null,
    user: null,
    syncProgress: { chats: 0, contacts: 0, messages: 0, lastBatchAt: null },
  };
}

describe("createQrServer", () => {
  let server: Server;
  let baseUrl: string;
  let state: ConnectionState;

  beforeEach(async () => {
    state = baseState();
    server = createQrServer(makeSilentLogger(), () => state);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("GET /health returns JSON with status and user", async () => {
    state.status = "connected";
    state.user = "5531999999999@s.whatsapp.net";

    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.status).toBe("connected");
    expect(body.user).toBe("5531999999999@s.whatsapp.net");
  });

  describe("GET /health socket observation", () => {
    const T0 = 1_700_000_000_000;
    let clock: number;

    /** Recreate the server with an injected clock so no test waits on real time. */
    async function restart(options: {
      now?: () => number;
      disconnectedGraceS?: number;
    }): Promise<void> {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      server = createQrServer(makeSilentLogger(), () => state, undefined, options);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }

    async function health(): Promise<{ code: number; body: HealthBody }> {
      const res = await fetch(`${baseUrl}/health`);
      return { code: res.status, body: (await res.json()) as HealthBody };
    }

    beforeEach(async () => {
      clock = T0;
      state.status = "connected";
      state.user = "5531999999999@s.whatsapp.net";
      await restart({ now: () => clock, disconnectedGraceS: 300 });
    });

    it("reports ok with a zero downtime counter while connected", async () => {
      clock += 60_000;
      const { code, body } = await health();
      expect(code).toBe(200);
      expect(body.health).toBe("ok");
      expect(body.status).toBe("connected");
      expect(body.disconnected_for_s).toBe(0);
      expect(body.grace_s).toBe(300);
    });

    it("reports degraded but still 200 while disconnected inside the grace window", async () => {
      await health(); // observe the connected baseline
      state.status = "disconnected";
      clock += 100_000;

      const { code, body } = await health();
      expect(code).toBe(200);
      expect(body.health).toBe("degraded");
      expect(body.status).toBe("disconnected");
      expect(body.disconnected_for_s).toBe(100);
    });

    it("returns 503 once the socket has been down longer than the grace window", async () => {
      await health();
      state.status = "disconnected";
      clock += 301_000;

      const { code, body } = await health();
      expect(code).toBe(503);
      expect(body.health).toBe("degraded");
      expect(body.disconnected_for_s).toBe(301);
    });

    it("counts a reconnect loop stuck on connecting toward the grace window", async () => {
      // The 21h outage flapped; if "connecting" reset the clock, a wedged
      // reconnect loop would keep reporting healthy forever.
      await health();
      state.status = "connecting";
      clock += 400_000;

      const { code } = await health();
      expect(code).toBe(503);
    });

    it("keeps 200 while syncing, which resets the downtime counter", async () => {
      await health();
      state.status = "disconnected";
      clock += 200_000;
      expect((await health()).code).toBe(200);

      state.status = "syncing";
      clock += 10_000;
      const { code, body } = await health();
      expect(code).toBe(200);
      expect(body.health).toBe("ok");
      expect(body.disconnected_for_s).toBe(0);
    });

    it("restarts the downtime counter after a successful reconnect", async () => {
      await health();
      state.status = "disconnected";
      clock += 200_000;
      await health();

      state.status = "connected";
      clock += 10_000;
      await health();

      state.status = "disconnected";
      clock += 200_000;
      const { code, body } = await health();
      expect(code).toBe(200);
      expect(body.disconnected_for_s).toBe(200);
    });

    it("never 503s while a QR scan is pending, however long it waits", async () => {
      state.status = "qr_pending";
      state.user = null;
      clock += 86_400_000;

      const { code, body } = await health();
      expect(code).toBe(200);
      expect(body.health).toBe("degraded");
      expect(body.status).toBe("qr_pending");
      expect(body.disconnected_for_s).toBe(0);
    });

    it("does not carry a long QR wait into the grace window once pairing proceeds", async () => {
      state.status = "qr_pending";
      clock += 86_400_000;
      await health();

      state.status = "connecting";
      clock += 10_000;
      const { code } = await health();
      expect(code).toBe(200);
    });

    it("always returns 200 when HEALTH_DISCONNECTED_GRACE_S is 0", async () => {
      const previous = process.env.HEALTH_DISCONNECTED_GRACE_S;
      process.env.HEALTH_DISCONNECTED_GRACE_S = "0";
      try {
        await restart({ now: () => clock });
        state.status = "disconnected";
        clock += 21 * 3600 * 1000;

        const { code, body } = await health();
        expect(code).toBe(200);
        expect(body.health).toBe("degraded");
        expect(body.grace_s).toBe(0);
        expect(body.disconnected_for_s).toBe(21 * 3600);
      } finally {
        if (previous === undefined) delete process.env.HEALTH_DISCONNECTED_GRACE_S;
        else process.env.HEALTH_DISCONNECTED_GRACE_S = previous;
      }
    });

    it("falls back to the 300s default when the grace env var is unparsable", async () => {
      const previous = process.env.HEALTH_DISCONNECTED_GRACE_S;
      process.env.HEALTH_DISCONNECTED_GRACE_S = "banana";
      try {
        await restart({ now: () => clock });
        const { body } = await health();
        expect(body.grace_s).toBe(300);
      } finally {
        if (previous === undefined) delete process.env.HEALTH_DISCONNECTED_GRACE_S;
        else process.env.HEALTH_DISCONNECTED_GRACE_S = previous;
      }
    });
  });

  it("GET / returns HTML with auto-refresh meta", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain('<meta http-equiv="refresh"');
    expect(body).toContain("disconnected");
  });

  it("GET / shows connected message when connected", async () => {
    state.status = "connected";
    state.user = "5531999999999@s.whatsapp.net";
    const res = await fetch(`${baseUrl}/`);
    const body = await res.text();
    expect(body).toContain("5531999999999");
  });

  it("GET /qr.png returns 404 when no QR is pending", async () => {
    const res = await fetch(`${baseUrl}/qr.png`);
    expect(res.status).toBe(404);
  });

  it("GET /qr.png returns PNG when QR is pending", async () => {
    state.status = "qr_pending";
    state.qrCode = "2@abc123,def456,ghi789==,hex";
    const res = await fetch(`${baseUrl}/qr.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const buf = Buffer.from(await res.arrayBuffer());
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    expect(buf.subarray(0, 4).toString("hex")).toBe("89504e47");
  });

  it("returns 404 for unknown routes", async () => {
    const res = await fetch(`${baseUrl}/unknown`);
    expect(res.status).toBe(404);
  });

  it("POST /repair calls onRepair and redirects to /", async () => {
    let repaired = false;
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    server = createQrServer(
      makeSilentLogger(),
      () => state,
      async () => {
        repaired = true;
      },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const res = await fetch(`${baseUrl}/repair`, { method: "POST", redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(repaired).toBe(true);
  });

  it("POST /repair without onRepair callback returns 204", async () => {
    const res = await fetch(`${baseUrl}/repair`, { method: "POST", redirect: "manual" });
    expect(res.status).toBe(204);
  });

  it("GET / shows Re-pair button when connected", async () => {
    state.status = "connected";
    state.user = "5531999999999@s.whatsapp.net";
    const res = await fetch(`${baseUrl}/`);
    const body = await res.text();
    expect(body).toContain('action="/repair"');
    expect(body).toContain("Re-pair device");
  });
});
