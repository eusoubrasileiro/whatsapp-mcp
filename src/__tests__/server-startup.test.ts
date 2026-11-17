import fs from "node:fs";
import type { Server } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import pino, { type Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Collaborators that would touch a real database, S3 or WhatsApp are replaced; the three
// HTTP servers (QR, upload, follow_chat stream) are the real ones and really listen.
const h = vi.hoisted(() => ({
  calls: [] as string[],
  startWhatsAppConnection: vi.fn(),
  initializeDatabase: vi.fn(),
  ensureBucketReady: vi.fn(),
  startMcpServer: vi.fn(),
  socketState: { socket: null as { user?: { id: string } } | null },
}));

vi.mock("../database.ts", () => ({
  initializeDatabase: h.initializeDatabase,
  setDatabaseLogger: vi.fn(() => h.calls.push("setDatabaseLogger")),
}));
vi.mock("../webhooks/registry.ts", () => ({
  loadRegistry: vi.fn(() => h.calls.push("loadRegistry")),
}));
vi.mock("../storage.ts", () => ({
  ensureBucketReady: h.ensureBucketReady,
  putUpload: vi.fn(),
}));
vi.mock("../mcp.ts", () => ({ startMcpServer: h.startMcpServer }));
vi.mock("../whatsapp.ts", () => ({
  startWhatsAppConnection: h.startWhatsAppConnection,
  getConnectionState: () => ({
    status: "disconnected",
    qrCode: null,
    qrAscii: null,
    user: null,
    syncProgress: { chats: 0, contacts: 0, messages: 0, lastBatchAt: null },
  }),
  socketState: h.socketState,
  triggerRepair: vi.fn(),
  transcribeMediaMessage: vi.fn(),
}));

import { createAppLoggers, type RunningServers, startServers } from "../server-startup.ts";

const silent = (): Logger => pino({ level: "silent" });

function portOf(server: Server | net.Server): number {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("server is not listening on a TCP port");
  return addr.port;
}

/** A port nothing listens on right now (bind to 0, read it, release it). */
async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = portOf(probe);
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** True when something accepts a TCP connection on `port`. */
function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function closeAll(running: RunningServers): Promise<void> {
  for (const s of [running.qr, running.upload, running.stream]) {
    if (s?.listening) await new Promise<void>((resolve) => s.close(() => resolve()));
  }
}

describe("startServers", () => {
  let running: RunningServers | undefined;

  beforeEach(() => {
    h.calls.length = 0;
    h.initializeDatabase.mockReset().mockImplementation(() => h.calls.push("initializeDatabase"));
    h.ensureBucketReady.mockReset().mockImplementation(async () => {
      h.calls.push("ensureBucketReady");
    });
    h.startMcpServer.mockReset().mockImplementation(async () => {
      h.calls.push("startMcpServer");
    });
    h.startWhatsAppConnection.mockReset();
    vi.stubEnv("QR_SERVER_PORT", "0");
    vi.stubEnv("UPLOAD_SERVER_PORT", "0");
    vi.stubEnv("STREAM_SERVER_PORT", "0");
    vi.stubEnv("S3_ENABLED", undefined);
    vi.stubEnv("MCP_AUTH_TOKEN", undefined);
    vi.stubEnv("INSTANCE_LABEL", undefined);
    vi.stubEnv("INSTANCE_DESCRIPTION", undefined);
    vi.stubEnv("EXPECTED_WA_NUMBER", undefined);
    h.socketState.socket = null;
  });

  afterEach(async () => {
    if (running) await closeAll(running);
    running = undefined;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("initialises the database and the webhook registry before the MCP server starts", async () => {
    running = await startServers({ mcpLogger: silent(), waLogger: silent() });

    expect(h.calls).toEqual([
      "setDatabaseLogger",
      "initializeDatabase",
      "loadRegistry",
      "startMcpServer",
    ]);
  });

  it("starts the MCP server before any side server accepts a connection", async () => {
    const qrPort = await freePort();
    vi.stubEnv("QR_SERVER_PORT", String(qrPort));
    let qrAcceptedDuringMcpStart: boolean | undefined;
    h.startMcpServer.mockImplementation(async () => {
      qrAcceptedDuringMcpStart = await accepts(qrPort);
    });

    running = await startServers({ mcpLogger: silent(), waLogger: silent() });

    expect(qrAcceptedDuringMcpStart).toBe(false);
    expect(await accepts(qrPort)).toBe(true);
  });

  it("serves the QR liveness route on the QR server it returns", async () => {
    running = await startServers({ mcpLogger: silent(), waLogger: silent() });

    const res = await fetch(`http://127.0.0.1:${portOf(running.qr)}/live`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ live: true });
  });

  it("reports the disconnected state on /health without ever connecting to WhatsApp", async () => {
    running = await startServers({ mcpLogger: silent(), waLogger: silent() });

    const res = await fetch(`http://127.0.0.1:${portOf(running.qr)}/health`);

    expect((await res.json()).status).toBe("disconnected");
    expect(h.startWhatsAppConnection).not.toHaveBeenCalled();
  });

  describe("instance identity", () => {
    const qrUrl = (r: RunningServers, route: string) => `http://127.0.0.1:${portOf(r.qr)}${route}`;

    it("passes no identity on, and leaves the QR page and /health unlabelled, without INSTANCE_LABEL", async () => {
      vi.stubEnv("INSTANCE_DESCRIPTION", "orphan description");

      running = await startServers({ mcpLogger: silent(), waLogger: silent() });

      expect(h.startMcpServer).toHaveBeenCalledWith(expect.anything(), expect.anything(), null);
      expect(await (await fetch(qrUrl(running, "/"))).text()).toContain(
        "<title>WhatsApp MCP \u2014 disconnected</title>",
      );
      expect(await (await fetch(qrUrl(running, "/health"))).json()).not.toHaveProperty("instance");
    });

    it("reads the identity once and hands it to the MCP server, the QR page and /health", async () => {
      vi.stubEnv("INSTANCE_LABEL", " Empresa ");
      vi.stubEnv("INSTANCE_DESCRIPTION", "the company line");

      running = await startServers({ mcpLogger: silent(), waLogger: silent() });

      const identity = { label: "empresa", description: "the company line" };
      expect(h.startMcpServer).toHaveBeenCalledWith(expect.anything(), expect.anything(), identity);
      expect(await (await fetch(qrUrl(running, "/"))).text()).toContain(
        "<title>WhatsApp MCP [empresa] \u2014 disconnected</title>",
      );
      expect((await (await fetch(qrUrl(running, "/health"))).json()).instance).toEqual(identity);
    });

    it("reports the last four digits of the socket's paired number on /health, live", async () => {
      vi.stubEnv("INSTANCE_LABEL", "empresa");
      running = await startServers({ mcpLogger: silent(), waLogger: silent() });
      const health = async () => (await fetch(qrUrl(running as RunningServers, "/health"))).json();

      expect(await health()).not.toHaveProperty("phone_last4");

      h.socketState.socket = { user: { id: "5500000001234:7@s.whatsapp.net" } };
      expect((await health()).phone_last4).toBe("1234");

      h.socketState.socket = null;
      expect(await health()).not.toHaveProperty("phone_last4");
    });
  });

  it("answers the follow_chat stream port with 426 (upgrade required)", async () => {
    running = await startServers({ mcpLogger: silent(), waLogger: silent() });

    const res = await fetch(`http://127.0.0.1:${portOf(running.stream)}/`);

    expect(res.status).toBe(426);
  });

  it("starts neither the S3 bucket check nor the upload server when S3 is disabled", async () => {
    running = await startServers({ mcpLogger: silent(), waLogger: silent() });

    expect(h.ensureBucketReady).not.toHaveBeenCalled();
    expect(running.upload).toBeNull();
  });

  it("does not treat S3_ENABLED=false (or any non-'true' value) as enabled", async () => {
    vi.stubEnv("S3_ENABLED", "false");

    running = await startServers({ mcpLogger: silent(), waLogger: silent() });

    expect(h.ensureBucketReady).not.toHaveBeenCalled();
    expect(running.upload).toBeNull();
  });

  describe("with S3_ENABLED=true", () => {
    beforeEach(() => {
      vi.stubEnv("S3_ENABLED", "true");
    });

    it("ensures the bucket after the registry and before the MCP server starts", async () => {
      running = await startServers({ mcpLogger: silent(), waLogger: silent() });

      expect(h.calls).toEqual([
        "setDatabaseLogger",
        "initializeDatabase",
        "loadRegistry",
        "ensureBucketReady",
        "startMcpServer",
      ]);
    });

    it("returns a listening upload server whose /upload is gated by MCP_AUTH_TOKEN", async () => {
      vi.stubEnv("MCP_AUTH_TOKEN", "s3cret");

      running = await startServers({ mcpLogger: silent(), waLogger: silent() });
      const url = `http://127.0.0.1:${portOf(running.upload as Server)}/upload`;

      const anonymous = await fetch(url, { method: "POST", body: "x" });
      const wrong = await fetch(url, {
        method: "POST",
        body: "x",
        headers: { authorization: "Bearer nope" },
      });
      const authed = await fetch(url, {
        method: "POST",
        body: "not an image",
        headers: { authorization: "Bearer s3cret" },
      });

      expect(anonymous.status).toBe(401);
      expect(wrong.status).toBe(401);
      expect(authed.status).toBe(415); // past auth, rejected by the MIME sniff
    });

    it("leaves /upload open when MCP_AUTH_TOKEN is unset (local-dev behaviour)", async () => {
      running = await startServers({ mcpLogger: silent(), waLogger: silent() });

      const res = await fetch(`http://127.0.0.1:${portOf(running.upload as Server)}/upload`, {
        method: "POST",
        body: "not an image",
      });

      expect(res.status).toBe(415);
    });

    it("rejects and never starts the MCP server when the bucket cannot be prepared", async () => {
      h.ensureBucketReady.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:9000"));

      await expect(startServers({ mcpLogger: silent(), waLogger: silent() })).rejects.toThrow(
        /ECONNREFUSED/,
      );

      expect(h.startMcpServer).not.toHaveBeenCalled();
    });
  });

  it("rejects, and opens no side server, when the MCP server fails to start", async () => {
    const qrPort = await freePort();
    vi.stubEnv("QR_SERVER_PORT", String(qrPort));
    h.startMcpServer.mockRejectedValue(new Error("port in use"));

    await expect(startServers({ mcpLogger: silent(), waLogger: silent() })).rejects.toThrow(
      "port in use",
    );

    expect(await accepts(qrPort)).toBe(false);
  });

  it("rejects when the database cannot be initialised and goes no further", async () => {
    h.initializeDatabase.mockImplementation(() => {
      throw new Error("SQLITE_CANTOPEN");
    });

    await expect(startServers({ mcpLogger: silent(), waLogger: silent() })).rejects.toThrow(
      "SQLITE_CANTOPEN",
    );

    expect(h.calls).not.toContain("loadRegistry");
    expect(h.startMcpServer).not.toHaveBeenCalled();
  });

  it("binds the documented default ports on loopback when no port env is set", async () => {
    vi.stubEnv("QR_SERVER_PORT", undefined);
    vi.stubEnv("UPLOAD_SERVER_PORT", undefined);
    vi.stubEnv("STREAM_SERVER_PORT", undefined);
    vi.stubEnv("QR_SERVER_HOST", undefined);
    vi.stubEnv("UPLOAD_SERVER_HOST", undefined);
    vi.stubEnv("STREAM_SERVER_HOST", undefined);
    vi.stubEnv("S3_ENABLED", "true");
    const listens: unknown[][] = [];
    vi.spyOn(net.Server.prototype, "listen").mockImplementation(function (
      this: net.Server,
      ...args: unknown[]
    ) {
      listens.push(args.slice(0, 2));
      queueMicrotask(() => this.emit("listening"));
      return this;
    } as never);

    await startServers({ mcpLogger: silent(), waLogger: silent() });

    expect(listens).toEqual([
      [39002, "127.0.0.1"],
      [39003, "127.0.0.1"],
      [39004, "127.0.0.1"],
    ]);
  });

  it("honours QR_SERVER_HOST / UPLOAD_SERVER_HOST / STREAM_SERVER_HOST", async () => {
    vi.stubEnv("S3_ENABLED", "true");
    vi.stubEnv("QR_SERVER_HOST", "0.0.0.0");
    vi.stubEnv("UPLOAD_SERVER_HOST", "127.0.0.2");
    vi.stubEnv("STREAM_SERVER_HOST", "127.0.0.3");

    running = await startServers({ mcpLogger: silent(), waLogger: silent() });

    expect((running.qr.address() as net.AddressInfo).address).toBe("0.0.0.0");
    expect(((running.upload as Server).address() as net.AddressInfo).address).toBe("127.0.0.2");
    expect((running.stream.address() as net.AddressInfo).address).toBe("127.0.0.3");
  });

  it("keeps going, logging the error, when a side server cannot bind its port", async () => {
    const taken = net.createServer();
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    vi.stubEnv("QR_SERVER_PORT", String(portOf(taken)));
    const mcpLogger = silent();
    const errorLog = vi.spyOn(mcpLogger, "error");

    try {
      running = await startServers({ mcpLogger, waLogger: silent() });

      expect(running.qr.listening).toBe(false);
      expect(running.stream.listening).toBe(true);
      expect(errorLog).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve) => taken.close(() => resolve()));
    }
  });
});

describe("main.ts startup order", () => {
  it("starts the servers (MCP handshake first) before it connects to WhatsApp", () => {
    const main = fs.readFileSync(path.join(import.meta.dirname, "..", "main.ts"), "utf8");

    const servers = main.indexOf("await startServers(");
    const connect = main.indexOf("startWhatsAppConnection(waLogger)");

    expect(servers).toBeGreaterThan(-1);
    expect(connect).toBeGreaterThan(servers);
  });
});

describe("createAppLoggers", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-mcp-loggers-"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // pino.destination(path) opens and writes asynchronously, so assertions poll the file.
  const logText = (d: string, file: string): string => {
    try {
      return fs.readFileSync(path.join(d, file), "utf8");
    } catch {
      return "";
    }
  };

  it("creates the data dir (including parents) and writes each logger to its own file", async () => {
    const nested = path.join(dir, "a", "b");

    const { waLogger, mcpLogger } = createAppLoggers(nested);
    waLogger.info("hello-wa");
    mcpLogger.info("hello-mcp");

    await vi.waitFor(() => {
      expect(logText(nested, "wa-logs.txt")).toContain("hello-wa");
      expect(logText(nested, "mcp-logs.txt")).toContain("hello-mcp");
    });
    expect(logText(nested, "wa-logs.txt")).not.toContain("hello-mcp");
    expect(logText(nested, "mcp-logs.txt")).not.toContain("hello-wa");
  });

  it("writes ISO timestamps", async () => {
    const { waLogger, mcpLogger } = createAppLoggers(dir);
    waLogger.info("stamped");
    mcpLogger.info("stamped");

    await vi.waitFor(() => expect(logText(dir, "wa-logs.txt")).toContain("stamped"));
    await vi.waitFor(() => expect(logText(dir, "mcp-logs.txt")).toContain("stamped"));
    const line = JSON.parse(logText(dir, "wa-logs.txt").trim());
    expect(line.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("honours LOG_LEVEL", async () => {
    vi.stubEnv("LOG_LEVEL", "warn");
    const { waLogger, mcpLogger } = createAppLoggers(dir);

    waLogger.info("quiet-info");
    waLogger.warn("loud-warn");
    mcpLogger.warn("loud-warn");

    await vi.waitFor(() => expect(logText(dir, "wa-logs.txt")).toContain("loud-warn"));
    await vi.waitFor(() => expect(logText(dir, "mcp-logs.txt")).toContain("loud-warn"));
    expect(logText(dir, "wa-logs.txt")).not.toContain("quiet-info");
  });

  it("defaults to the info level when LOG_LEVEL is unset", async () => {
    vi.stubEnv("LOG_LEVEL", undefined);
    const { waLogger, mcpLogger } = createAppLoggers(dir);

    waLogger.info("default-info");
    waLogger.debug("default-debug");
    mcpLogger.info("default-info");

    await vi.waitFor(() => expect(logText(dir, "wa-logs.txt")).toContain("default-info"));
    await vi.waitFor(() => expect(logText(dir, "mcp-logs.txt")).toContain("default-info"));
    expect(logText(dir, "wa-logs.txt")).not.toContain("default-debug");
  });
});
