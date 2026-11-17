import { createHash } from "node:crypto";
import type { HubInstance } from "./config.ts";

/** How often each instance is asked, and how long one question may take. */
export const POLL_INTERVAL_MS = 2000;
export const REQUEST_TIMEOUT_MS = 1000;

type HubState = "connected" | "waiting_qr" | "starting" | "disconnected" | "down" | "mismatch";

/** Everything the hub knows, and is willing to say, about one number. Nothing else leaves. */
export interface InstanceView {
  label: string;
  description: string | null;
  phone_last4: string | null;
  state: HubState;
  down_for_s: number | null;
  qr_rev: string | null;
}

export interface Poller {
  /** Starts one independent polling loop per instance. */
  start(): void;
  stop(): void;
  /** Asks every instance once, concurrently. Resolves when the slowest has answered or timed out. */
  pollOnce(): Promise<void>;
  /** The cached picture, in the order the instances were configured. Never touches the network. */
  views(): InstanceView[];
  /** The QR image currently pending for `label`, or `null`. */
  qrPng(label: string): Buffer | null;
}

export interface PollerOptions {
  instances: HubInstance[];
  /** Epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  intervalMs?: number;
  timeoutMs?: number;
}

interface Reading {
  state: Exclude<HubState, "down">;
  description: string | null;
  last4: string | null;
  qr: Buffer | null;
}

interface Entry {
  instance: HubInstance;
  state: HubState;
  description: string | null;
  last4: string | null;
  qr: { png: Buffer; rev: string } | null;
  answered: boolean;
  downSince: number | null;
}

const STATUS_STATES = new Map<string, Exclude<HubState, "down" | "mismatch" | "waiting_qr">>([
  ["connected", "connected"],
  ["disconnected", "disconnected"],
  ["connecting", "starting"],
  ["syncing", "starting"],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** The last four digits, and only if it really is four digits: never a longer number. */
function asLast4(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}$/.test(value) ? value : null;
}

async function getWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
}

/** `/health` parses whatever the HTTP status is: a wedged instance answers 503 with valid JSON. */
async function readHealth(baseUrl: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const res = await getWithTimeout(`${baseUrl}/health`, timeoutMs);
  const body: unknown = JSON.parse(await res.text());
  if (!isRecord(body)) throw new Error("health is not an object");
  return body;
}

async function readQr(baseUrl: string, timeoutMs: number): Promise<Buffer | null> {
  try {
    const res = await getWithTimeout(`${baseUrl}/qr.png`, timeoutMs);
    return res.status === 200 ? Buffer.from(await res.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

/** One question to one instance: `null` when it did not give a usable answer. */
async function readInstance(instance: HubInstance, timeoutMs: number): Promise<Reading | null> {
  let health: Record<string, unknown>;
  try {
    health = await readHealth(instance.baseUrl, timeoutMs);
  } catch {
    return null;
  }

  const identity = isRecord(health.instance) ? health.instance : {};
  if (typeof identity.label === "string" && identity.label !== instance.label) {
    return { state: "mismatch", description: null, last4: null, qr: null };
  }

  const description = asString(identity.description);
  const last4 = asLast4(health.phone_last4);
  if (health.status === "qr_pending") {
    const qr = await readQr(instance.baseUrl, timeoutMs);
    return { state: qr ? "waiting_qr" : "starting", description, last4, qr };
  }
  // A Map answers `undefined` for a key that is not in it, whatever the key's type.
  const state = STATUS_STATES.get(health.status as string);
  return state ? { state, description, last4, qr: null } : null;
}

export function createPoller(options: PollerOptions): Poller {
  const now = options.now ?? (() => Date.now());
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const startedAt = now();

  const entries: Entry[] = options.instances.map((instance) => ({
    instance,
    state: "starting",
    description: null,
    last4: null,
    qr: null,
    answered: false,
    downSince: null,
  }));

  async function pollInstance(entry: Entry): Promise<void> {
    const reading = await readInstance(entry.instance, timeoutMs);
    if (reading === null) {
      // Counted from the first failure, or from hub start for an instance never heard from.
      if (entry.downSince === null) entry.downSince = entry.answered ? now() : startedAt;
      entry.state = "down";
      entry.qr = null;
      return;
    }
    entry.answered = true;
    entry.downSince = null;
    entry.state = reading.state;
    entry.description = reading.description;
    entry.last4 = reading.last4;
    entry.qr = reading.qr
      ? { png: reading.qr, rev: createHash("sha256").update(reading.qr).digest("hex").slice(0, 12) }
      : null;
  }

  let running = false;
  const timers = new Set<NodeJS.Timeout>();

  function schedule(entry: Entry, delayMs: number): void {
    const timer = setTimeout(async () => {
      timers.delete(timer);
      await pollInstance(entry);
      if (running) schedule(entry, intervalMs);
    }, delayMs);
    timers.add(timer);
  }

  return {
    start() {
      if (running) return;
      running = true;
      for (const entry of entries) schedule(entry, 0);
    },
    stop() {
      running = false;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
    async pollOnce() {
      await Promise.all(entries.map(pollInstance));
    },
    views() {
      return entries.map((entry) => ({
        label: entry.instance.label,
        description: entry.description,
        phone_last4: entry.last4,
        state: entry.state,
        down_for_s: entry.downSince === null ? null : Math.floor((now() - entry.downSince) / 1000),
        qr_rev: entry.qr?.rev ?? null,
      }));
    },
    qrPng(label) {
      return entries.find((entry) => entry.instance.label === label)?.qr?.png ?? null;
    },
  };
}
