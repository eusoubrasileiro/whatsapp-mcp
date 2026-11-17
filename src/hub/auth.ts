import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SendNtfy } from "../ntfy.ts";
import { HubConfigError } from "./config.ts";

const MINUTE_MS = 60_000;
/** 5 wrong PINs from one address inside 15 minutes lock it for 15 minutes. */
const ADDRESS_LIMIT = { max: 5, windowMs: 15 * MINUTE_MS, lockMs: 15 * MINUTE_MS };
/** 20 wrong PINs from anywhere inside 60 minutes lock the form for everyone for 60 minutes. */
const GLOBAL_LIMIT = { max: 20, windowMs: 60 * MINUTE_MS, lockMs: 60 * MINUTE_MS };

const COOKIE_NAME = "wa_hub";
const COOKIE_VERSION = "v1";
const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;
const STATE_FILE = "pin-attempts.json";

type AttemptResult =
  | { outcome: "ok" }
  | { outcome: "wrong" }
  | { outcome: "locked"; retryAfterS: number };

export interface PinGate {
  /**
   * Checks one submitted PIN from one address. A locked address (or a locked form) is refused
   * without looking at the PIN and without counting the attempt.
   */
  attempt(address: string, submitted: string): AttemptResult;
  /** The `Set-Cookie` value that opens a 30-day session. */
  issueCookie(): string;
  /** Whether a `Cookie` request header carries a genuine, unexpired session. */
  hasSession(cookieHeader: string | undefined): boolean;
}

export interface PinGateOptions {
  pin: string;
  /** Signs the session cookie and keys the stored address hashes. */
  cookieKey: string;
  /** Holds `pin-attempts.json`. */
  stateDir: string;
  /** Epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /** Called once per lock for everyone. Defaults to doing nothing. */
  sendNtfy?: SendNtfy;
}

interface Bucket {
  /** Epoch ms of each wrong PIN still inside the window. */
  failures: number[];
  /** Epoch ms until which this bucket refuses everything; 0 when it is not locked. */
  lockedUntil: number;
}

interface Counters {
  global: Bucket;
  addresses: Record<string, Bucket>;
}

function isBucket(value: unknown): value is Bucket {
  if (typeof value !== "object" || value === null) return false;
  const { failures, lockedUntil } = value as Record<string, unknown>;
  return (
    Array.isArray(failures) &&
    failures.every((f) => typeof f === "number" && Number.isFinite(f)) &&
    typeof lockedUntil === "number" &&
    Number.isFinite(lockedUntil)
  );
}

function parseCounters(text: string): Counters | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const { global, addresses } = data as Record<string, unknown>;
  if (!isBucket(global) || typeof addresses !== "object" || addresses === null) return null;
  const table = addresses as Record<string, unknown>;
  if (!Object.values(table).every(isBucket)) return null;
  return { global, addresses: table as Record<string, Bucket> };
}

/** The counters on disk, empty when there is no file. A file that exists but is damaged stops the start. */
function loadCounters(file: string): Counters {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { global: { failures: [], lockedUntil: 0 }, addresses: {} };
    }
    throw new HubConfigError([`${STATE_FILE} exists but cannot be read`]);
  }
  const counters = parseCounters(text);
  if (counters === null) {
    throw new HubConfigError([
      `${STATE_FILE} exists but is not valid; fix or remove it (the hub never starts with empty PIN counters over a damaged file)`,
    ]);
  }
  return counters;
}

/** Records one wrong PIN in `bucket`. True when that wrong PIN started a lock. */
function recordFailure(
  bucket: Bucket,
  at: number,
  limit: { max: number; windowMs: number; lockMs: number },
): boolean {
  bucket.failures = bucket.failures.filter((failure) => at - failure < limit.windowMs);
  bucket.failures.push(at);
  if (bucket.failures.length < limit.max) return false;
  bucket.lockedUntil = at + limit.lockMs;
  bucket.failures = [];
  return true;
}

function sameSecret(a: string, b: string): boolean {
  const digest = (text: string) => createHash("sha256").update(text).digest();
  return timingSafeEqual(digest(a), digest(b));
}

function cookieValue(header: string | undefined): string | null {
  for (const pair of (header ?? "").split(";")) {
    const eq = pair.indexOf("=");
    if (eq !== -1 && pair.slice(0, eq).trim() === COOKIE_NAME) return pair.slice(eq + 1).trim();
  }
  return null;
}

export function createPinGate(options: PinGateOptions): PinGate {
  const { pin, cookieKey, stateDir } = options;
  const now = options.now ?? (() => Date.now());
  const sendNtfy = options.sendNtfy ?? (async () => {});
  const file = path.join(stateDir, STATE_FILE);
  const counters = loadCounters(file);

  const hmac = (text: string) => createHmac("sha256", cookieKey).update(text);

  /** Drops what no longer matters, then writes the file whole (temp file, then rename). */
  function persist(at: number): void {
    for (const [key, bucket] of Object.entries(counters.addresses)) {
      bucket.failures = bucket.failures.filter((f) => at - f < ADDRESS_LIMIT.windowMs);
      if (bucket.failures.length === 0 && bucket.lockedUntil <= at) delete counters.addresses[key];
    }
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(counters), { mode: 0o600 });
    fs.renameSync(temp, file);
  }

  function notifyLocked(): void {
    const minutes = GLOBAL_LIMIT.lockMs / MINUTE_MS;
    sendNtfy({
      title: "WhatsApp hub: PIN is being guessed",
      message: `${GLOBAL_LIMIT.max} wrong PINs in the last hour. The PIN form is locked for ${minutes} minutes.`,
      priority: 4,
    }).catch(() => {});
  }

  return {
    attempt(address, submitted) {
      const at = now();
      const key = hmac(`addr:${address}`).digest("hex");
      const bucket = counters.addresses[key] ?? { failures: [], lockedUntil: 0 };

      const lockedUntil = Math.max(counters.global.lockedUntil, bucket.lockedUntil);
      if (at < lockedUntil) {
        return { outcome: "locked", retryAfterS: Math.ceil((lockedUntil - at) / 1000) };
      }
      if (sameSecret(submitted, pin)) return { outcome: "ok" };

      counters.addresses[key] = bucket;
      recordFailure(bucket, at, ADDRESS_LIMIT);
      const lockedForEveryone = recordFailure(counters.global, at, GLOBAL_LIMIT);
      persist(at);
      if (lockedForEveryone) notifyLocked();
      return { outcome: "wrong" };
    },

    issueCookie() {
      const expires = Math.floor(now() / 1000) + COOKIE_MAX_AGE_S;
      const body = `${COOKIE_VERSION}.${expires}.${randomBytes(12).toString("hex")}`;
      const value = `${body}.${hmac(body).digest("base64url")}`;
      return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_S}`;
    },

    hasSession(cookieHeader) {
      const parts = cookieValue(cookieHeader)?.split(".") ?? [];
      if (parts.length !== 4) return false;
      const [version, expires, id, signature] = parts;
      if (version !== COOKIE_VERSION || !/^\d+$/.test(expires) || !/^[0-9a-f]{24}$/.test(id)) {
        return false;
      }
      const expected = hmac(`${version}.${expires}.${id}`).digest();
      const given = Buffer.from(signature, "base64url");
      const genuine =
        given.length === expected.length &&
        given.toString("base64url") === signature &&
        timingSafeEqual(given, expected);
      return genuine && Number(expires) > Math.floor(now() / 1000);
    },
  };
}
