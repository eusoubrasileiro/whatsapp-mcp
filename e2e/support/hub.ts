/**
 * Harness: starts the real hub (`src/hub/main.ts`) in a child process, pointed at real
 * whatsapp-mcp servers started with `startServer`.
 *
 * Like the server harness, the child gets a minimal, explicit environment (never a copy of
 * ours) and the no-egress guard preloaded: it cannot reach anything but loopback.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { EGRESS_BLOCKED_EXIT_CODE } from "./no-egress.ts";
import { NO_EGRESS } from "./server.ts";

const MAIN = path.resolve(import.meta.dirname, "../../src/hub/main.ts");
const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;

const HUB_COOKIE_KEY = "e2e-hub-cookie-key-0123456789abcdef";

export interface E2eHub {
  /** `http://127.0.0.1:<port>` */
  url: string;
  /** The PIN the hub was started with. */
  pin: string;
  /** Everything the hub has written to stderr so far. */
  stderr(): string;
  /** Terminates the hub and removes its state dir; throws if it tried to leave loopback. */
  stop(): Promise<void>;
}

export interface HubOptions {
  /** One entry per number: the label, and where its instance answers. */
  instances: { label: string; url: string }[];
  pin?: string;
  /** Merged last into the child's environment. */
  env?: Record<string, string>;
  /** `runHubExpectingExit` only: leave an unreadable attempts file in the state dir first. */
  damagedCounters?: boolean;
}

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function spawnHub(env: Record<string, string>): ChildProcess {
  return spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--no-warnings",
      "--import",
      pathToFileURL(NO_EGRESS).href,
      MAIN,
    ],
    { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"] },
  );
}

function hubEnvironment(options: HubOptions, stateDir: string, port: number) {
  return {
    HUB_PIN: options.pin ?? randomBytes(8).toString("hex"),
    HUB_COOKIE_KEY,
    HUB_INSTANCES: options.instances.map((i) => `${i.label}=${i.url}`).join(","),
    HUB_PUBLIC_URL: `http://127.0.0.1:${port}`,
    HUB_STATE_DIR: stateDir,
    HUB_HOST: "127.0.0.1",
    HUB_PORT: String(port),
    ...options.env,
  };
}

/** Boots the hub and resolves once `/live` answers; rejects with the evidence otherwise. */
export async function startHub(options: HubOptions): Promise<E2eHub> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-hub-e2e-"));
  const port = await freePort();
  const env = hubEnvironment(options, stateDir, port);
  const child = spawnHub(env);

  let stderrText = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrText += chunk.toString("utf8");
  });
  child.stdout?.resume();
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );
  const cleanUp = () => fs.rmSync(stateDir, { recursive: true, force: true });

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    if (child.exitCode !== null) {
      cleanUp();
      throw new Error(`the hub exited before it was ready (code ${child.exitCode})\n${stderrText}`);
    }
    try {
      if ((await fetch(`${url}/live`)).status === 200) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      cleanUp();
      throw new Error(
        `the hub did not answer /live within ${START_TIMEOUT_MS / 1000}s\n${stderrText}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return {
    url,
    pin: env.HUB_PIN,
    stderr: () => stderrText,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        const killer = setTimeout(() => child.kill("SIGKILL"), STOP_TIMEOUT_MS);
        await exited;
        clearTimeout(killer);
      }
      cleanUp();
      if (
        stderrText.includes("E2E_EGRESS_BLOCKED") ||
        child.exitCode === EGRESS_BLOCKED_EXIT_CODE
      ) {
        throw new Error(`the hub tried to leave loopback:\n${stderrText}`);
      }
    },
  };
}

export interface HubRun {
  code: number | null;
  stderr: string;
  stdout: string;
}

/** Runs the hub with settings that should make it refuse to start, and waits for it to exit. */
export async function runHubExpectingExit(options: HubOptions): Promise<HubRun> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-hub-e2e-"));
  try {
    if (options.damagedCounters) {
      fs.writeFileSync(path.join(stateDir, "pin-attempts.json"), "{ this is not json");
    }
    const child = spawnHub(hubEnvironment(options, stateDir, await freePort()));
    let stderr = "";
    let stdout = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    const killer = setTimeout(() => child.kill("SIGKILL"), START_TIMEOUT_MS);
    const code = await new Promise<number | null>((resolve) =>
      child.once("exit", (exitCode) => resolve(exitCode)),
    );
    clearTimeout(killer);
    return { code, stderr, stdout };
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}
