/**
 * Harness: starts the real whatsapp-mcp servers in a child process (`serve.ts`) with a temp
 * data dir, a random Bearer token and ephemeral ports, and stops them again.
 *
 * The child gets a minimal, explicit environment, never a copy of ours, so nothing from the
 * developer's shell (deploy credentials, EXPECTED_WA_NUMBER, S3 keys) can reach it. It is
 * started with the no-egress guard preloaded: it cannot reach anything but loopback.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { EGRESS_BLOCKED_EXIT_CODE } from "./no-egress.ts";

const here = import.meta.dirname;
const SERVE = path.join(here, "serve.ts");
export const NO_EGRESS = path.join(here, "no-egress.ts");

const START_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 10_000;

const RUSTFS_HINT =
  "The upload spec needs the dev RustFS from docker-compose.dev.yaml on localhost:9000. " +
  "Start it with: pnpm test:e2e:deps";

/** The dev RustFS (docker-compose.dev.yaml, service `minio`) and the bucket the server ensures. */
const S3_ENV = {
  S3_ENABLED: "true",
  S3_ENDPOINT: "localhost",
  S3_PORT: "9000",
  S3_USE_SSL: "false",
  S3_ACCESS_KEY: "minioadmin",
  S3_SECRET_KEY: "minioadmin",
  S3_BUCKET: "amiticia-media",
  S3_REGION: "us-east-1",
  S3_SKIP_POLICY: "false",
  MEDIA_PUBLIC_BASE_URL: "http://localhost:9000/amiticia-media",
};

export interface E2eServer {
  /** The MCP endpoint, e.g. `http://127.0.0.1:41234/mcp`. */
  mcpUrl: string;
  /** Base URL of the QR page server. */
  qrUrl: string;
  /** Base URL of the upload server; `null` unless started with `s3: true`. */
  uploadUrl: string | null;
  /** The Bearer token the MCP endpoint and `/upload` require. */
  token: string;
  /** The server's `WHATSAPP_MCP_DATA_DIR` (SQLite file at `data/whatsapp.db`). */
  dataDir: string;
  /** Terminates the server and removes its data dir; throws if it tried to leave loopback. */
  stop(): Promise<void>;
}

/** A TCP port that was free a moment ago. FastMCP cannot report an ephemeral port back. */
async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function logTail(dataDir: string): string {
  try {
    return fs.readFileSync(path.join(dataDir, "mcp-logs.txt"), "utf8").slice(-2000);
  } catch {
    return "(no mcp-logs.txt)";
  }
}

interface Ready {
  mcp: number;
  qr: number;
  upload: number | null;
}

/** Resolves with the ports from the child's `{"e2e":"ready"}` line, or rejects with the evidence. */
function whenReady(child: ChildProcess, dataDir: string, stderr: () => string): Promise<Ready> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(
      () => fail(`did not become ready within ${START_TIMEOUT_MS / 1000}s`),
      START_TIMEOUT_MS,
    );
    const fail = (why: string) => {
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(
        new Error(
          `e2e server ${why}\n--- stderr ---\n${stderr()}\n--- mcp-logs.txt (tail) ---\n${logTail(dataDir)}`,
        ),
      );
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      for (const line of buffered.split("\n")) {
        if (!line.startsWith('{"e2e":"ready"')) continue;
        clearTimeout(timer);
        resolve(JSON.parse(line) as Ready);
        return;
      }
    });
    child.once("exit", (code, signal) =>
      fail(`exited before it was ready (code ${code}, signal ${signal})`),
    );
  });
}

/**
 * Boots one server. With `s3: true` it also needs the dev RustFS, and fails (never skips)
 * when that is not reachable.
 */
export async function startServer(options: { s3?: boolean } = {}): Promise<E2eServer> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-mcp-e2e-"));
  const token = randomBytes(16).toString("hex");
  const mcpPort = await freePort();

  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--no-warnings",
      "--import",
      pathToFileURL(NO_EGRESS).href,
      SERVE,
    ],
    {
      env: {
        PATH: process.env.PATH ?? "",
        WHATSAPP_MCP_DATA_DIR: dataDir,
        MCP_TRANSPORT: "httpstream",
        MCP_HOST: "127.0.0.1",
        MCP_PORT: String(mcpPort),
        MCP_AUTH_TOKEN: token,
        QR_SERVER_HOST: "127.0.0.1",
        QR_SERVER_PORT: "0",
        UPLOAD_SERVER_HOST: "127.0.0.1",
        UPLOAD_SERVER_PORT: "0",
        STREAM_SERVER_HOST: "127.0.0.1",
        STREAM_SERVER_PORT: "0",
        TENANT_ID: `e2e-${randomBytes(4).toString("hex")}`,
        ...(options.s3 ? S3_ENV : {}),
      },
      stdio: ["pipe", "pipe", "pipe"], // stdin stays open: see serve.ts
    },
  );

  let stderrText = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrText += chunk.toString("utf8");
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );

  let ready: Ready;
  try {
    ready = await whenReady(child, dataDir, () => stderrText);
  } catch (err) {
    fs.rmSync(dataDir, { recursive: true, force: true });
    throw options.s3 ? new Error(`${(err as Error).message}\n${RUSTFS_HINT}`) : err;
  }

  return {
    mcpUrl: `http://127.0.0.1:${ready.mcp}/mcp`,
    qrUrl: `http://127.0.0.1:${ready.qr}`,
    uploadUrl: ready.upload === null ? null : `http://127.0.0.1:${ready.upload}`,
    token,
    dataDir,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        const killer = setTimeout(() => child.kill("SIGKILL"), STOP_TIMEOUT_MS);
        await exited;
        clearTimeout(killer);
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
      if (
        stderrText.includes("E2E_EGRESS_BLOCKED") ||
        child.exitCode === EGRESS_BLOCKED_EXIT_CODE
      ) {
        throw new Error(`the server under test tried to leave loopback:\n${stderrText}`);
      }
    },
  };
}
