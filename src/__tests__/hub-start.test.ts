import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { HubConfigError } from "../hub/config.ts";
import { type RunningHub, reportStartupFailure, startHub } from "../hub/start.ts";
import { type FakeInstance, startFakeInstance } from "./helpers/fake-instance.ts";

const silent = pino({ level: "silent" });
const PIN = "start-test-pin-9f3";
const COOKIE_KEY = "start-test-cookie-key-0123456789abcdef";

let running: RunningHub | undefined;
let fake: FakeInstance | undefined;
let stateDir: string | undefined;

afterEach(async () => {
  await running?.stop();
  await fake?.close();
  if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
  running = undefined;
  fake = undefined;
  stateDir = undefined;
});

async function freePort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function environment(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  fake = await startFakeInstance({
    status: "connected",
    instance: { label: "personal", description: "Personal" },
    phone_last4: "5678",
  });
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-start-"));
  return {
    HUB_PIN: PIN,
    HUB_COOKIE_KEY: COOKIE_KEY,
    HUB_INSTANCES: `personal=${fake.url}`,
    HUB_PUBLIC_URL: "https://hub.example.com",
    HUB_STATE_DIR: stateDir,
    HUB_HOST: "127.0.0.1",
    HUB_PORT: String(await freePort()),
    ...extra,
  };
}

describe("startHub", () => {
  it("listens on the configured host and port, answers /live, and polls its instances", async () => {
    const env = await environment();

    running = await startHub(env, { logger: silent });

    const address = running.server.address() as AddressInfo;
    expect(address.address).toBe("127.0.0.1");
    expect(address.port).toBe(Number(env.HUB_PORT));
    const live = await fetch(`http://127.0.0.1:${env.HUB_PORT}/live`);
    expect(live.status).toBe(200);
    await expect.poll(() => fake?.hits.health ?? 0, { timeout: 3000 }).toBeGreaterThan(0);
  });

  it("asks for the PIN on every other address", async () => {
    const env = await environment();
    running = await startHub(env, { logger: silent });

    const res = await fetch(`http://127.0.0.1:${env.HUB_PORT}/`);

    expect(res.status).toBe(401);
    expect(await res.text()).toContain("Enter the PIN");
  });

  it("answers in Brazilian Portuguese when HUB_LANG says pt-BR", async () => {
    const env = await environment({ HUB_LANG: "pt-BR" });
    running = await startHub(env, { logger: silent });

    const res = await fetch(`http://127.0.0.1:${env.HUB_PORT}/`);

    const body = await res.text();
    expect(body).toContain('<html lang="pt-BR">');
    expect(body).toContain("Digite o PIN");
  });

  it("refuses a language it does not have before it binds anything", async () => {
    const env = await environment({ HUB_LANG: "xx" });

    await expect(startHub(env, { logger: silent })).rejects.toThrow(/HUB_LANG/);

    await expect(fetch(`http://127.0.0.1:${env.HUB_PORT}/live`)).rejects.toThrow();
  });

  it("refuses unusable settings before it binds anything", async () => {
    const env = await environment({ HUB_PIN: "123" });

    await expect(startHub(env, { logger: silent })).rejects.toBeInstanceOf(HubConfigError);

    await expect(fetch(`http://127.0.0.1:${env.HUB_PORT}/live`)).rejects.toThrow();
  });

  it("stops polling and closes the listener on stop()", async () => {
    const env = await environment();
    running = await startHub(env, { logger: silent });
    await fetch(`http://127.0.0.1:${env.HUB_PORT}/live`);

    await running.stop();
    running = undefined;
    await new Promise((resolve) => setTimeout(resolve, 200)); // a request already on its way lands
    const before = fake?.hits.health ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 2500));

    await expect(fetch(`http://127.0.0.1:${env.HUB_PORT}/live`)).rejects.toThrow();
    expect(fake?.hits.health).toBe(before);
  });

  it("fails when the port is already taken", async () => {
    const env = await environment();
    const taken = http.createServer();
    await new Promise<void>((resolve) => taken.listen(Number(env.HUB_PORT), "127.0.0.1", resolve));

    try {
      await expect(startHub(env, { logger: silent })).rejects.toThrow(/EADDRINUSE/);
    } finally {
      await new Promise<void>((resolve) => taken.close(() => resolve()));
    }
  });
});

describe("reportStartupFailure", () => {
  function io() {
    const written: string[] = [];
    return {
      written,
      write: (text: string) => {
        written.push(text);
      },
      exit: (code: number): never => {
        throw new Error(`exit ${code}`);
      },
    };
  }

  it("prints a configuration problem as written and exits 1", () => {
    const fake = io();

    expect(() =>
      reportStartupFailure(new HubConfigError(["HUB_PIN must be at least 4 characters."]), fake),
    ).toThrow("exit 1");

    expect(fake.written.join("")).toBe(
      `${new HubConfigError(["HUB_PIN must be at least 4 characters."]).message}\n`,
    );
  });

  it("prints any other failure after a fixed sentence and exits 1", () => {
    const fake = io();

    expect(() =>
      reportStartupFailure(new Error("listen EADDRINUSE: address already in use"), fake),
    ).toThrow("exit 1");

    expect(fake.written.join("")).toBe(
      "The hub cannot start: Error: listen EADDRINUSE: address already in use\n",
    );
  });

  it("never echoes a value that was in the environment", async () => {
    const env = await environment({
      HUB_PIN: "pin-secret-VALUE",
      HUB_COOKIE_KEY: "short-key-secret",
    });
    const fake = io();
    const err = await startHub(env, { logger: silent }).catch((e: unknown) => e);

    expect(() => reportStartupFailure(err, fake)).toThrow("exit 1");

    const text = fake.written.join("");
    expect(text).toContain("HUB_COOKIE_KEY");
    expect(text).not.toContain("pin-secret-VALUE");
    expect(text).not.toContain("short-key-secret");
  });

  it("writes to stderr and exits through the process by default", () => {
    const writes: string[] = [];
    const exits: unknown[] = [];
    const realWrite = process.stderr.write;
    const realExit = process.exit;
    process.stderr.write = ((text: string) => {
      writes.push(text);
      return true;
    }) as typeof process.stderr.write;
    process.exit = ((code?: number) => {
      exits.push(code);
      return undefined as never;
    }) as typeof process.exit;
    try {
      reportStartupFailure(new HubConfigError(["HUB_PORT is not a port."]));
    } finally {
      process.stderr.write = realWrite;
      process.exit = realExit;
    }

    expect(writes.join("")).toContain("HUB_PORT is not a port.");
    expect(exits).toEqual([1]);
  });
});
