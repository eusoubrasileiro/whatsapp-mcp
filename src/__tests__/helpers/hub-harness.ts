import fs from "node:fs";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { createPinGate, type PinGate } from "../../hub/auth.ts";
import { createPoller, type Poller } from "../../hub/poller.ts";
import { createHubListener } from "../../hub/server.ts";
import { type HubLang, stringsFor } from "../../hub/strings.ts";
import type { NtfyMessage } from "../../ntfy.ts";

export const TEST_PIN = "correct-test-pin";
export const TEST_COOKIE_KEY = "test-signing-key-0123456789abcdef-xyz";

/** A hub's HTTP side, listening on loopback, with a clock the test moves. */
export interface HubHarness {
  url: string;
  poller: Poller;
  gate: PinGate;
  stateDir: string;
  pushes: NtfyMessage[];
  /** The clock the gate and the poller read. */
  clock: { now: number };
  /** Logs in with the right PIN and returns the `Cookie` request header to send afterwards. */
  login(): Promise<string>;
  close(): Promise<void>;
}

export interface HubHarnessOptions {
  instances: { label: string; baseUrl: string }[];
  /** Replaces the real poller, e.g. with one that throws. */
  poller?: Poller;
  pollerTimeoutMs?: number;
  /** The language of every page. Defaults to English. */
  lang?: HubLang;
}

export async function startHubHarness(options: HubHarnessOptions): Promise<HubHarness> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-harness-"));
  const clock = { now: 1_800_000_000_000 };
  const pushes: NtfyMessage[] = [];
  const poller =
    options.poller ??
    createPoller({
      instances: options.instances,
      now: () => clock.now,
      timeoutMs: options.pollerTimeoutMs ?? 500,
    });
  const gate = createPinGate({
    pin: TEST_PIN,
    cookieKey: TEST_COOKIE_KEY,
    stateDir,
    now: () => clock.now,
    sendNtfy: async (message) => {
      pushes.push(message);
    },
  });
  const server: Server = http.createServer(
    createHubListener({
      poller,
      gate,
      logger: pino({ level: "silent" }),
      t: stringsFor(options.lang ?? "en"),
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    poller,
    gate,
    stateDir,
    pushes,
    clock,
    async login() {
      const res = await fetch(`${url}/_hub/login`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ pin: TEST_PIN }),
      });
      return (res.headers.get("set-cookie") ?? "").split(";")[0];
    },
    close: () =>
      new Promise<void>((resolve) => {
        poller.stop();
        server.close(() => {
          fs.rmSync(stateDir, { recursive: true, force: true });
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}

export interface HubResponse {
  status: number;
  headers: Headers;
  body: string;
  bytes: Buffer;
}

/** One request to the hub, never following redirects. */
export async function request(
  base: string,
  pathname: string,
  init: { method?: string; cookie?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HubResponse> {
  const headers: Record<string, string> = { ...init.headers };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.body !== undefined) headers["content-type"] = "application/x-www-form-urlencoded";
  const res = await fetch(`${base}${pathname}`, {
    method: init.method ?? "GET",
    redirect: "manual",
    headers,
    body: init.body,
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, body: bytes.toString("utf8"), bytes };
}

/** A login attempt: the form a browser would post. */
export function loginForm(pin: string, next?: string): string {
  const form = new URLSearchParams({ pin });
  if (next !== undefined) form.set("next", next);
  return form.toString();
}

/** The same page with the per-response nonce blanked, so two responses can be compared. */
export function withoutNonce(text: string): string {
  return text.replace(/nonce[-=]["']?[A-Za-z0-9+/=]{20,}/g, "nonce-N");
}
