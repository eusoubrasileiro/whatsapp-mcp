/**
 * Outbound send pacing: a minimum jittered gap plus rolling volume caps.
 *
 * Motivating incident (2026-07-28): the linked account was restricted for five
 * days — it could still reach saved contacts but not strangers, the signature of
 * a *reach-out* restriction. Nothing in this server paced its sends, so a burst
 * of tool calls left WhatsApp's anti-abuse system looking at a machine-regular
 * stream of outbound messages. A restriction on the live customer number is a
 * revenue outage that cannot be appealed, so the pacing is on by default.
 *
 * Two windows, deliberately different in kind:
 *   - the rolling minute **waits** — a slot frees within seconds;
 *   - the rolling hour **throws** — an agent cannot usefully block for an hour,
 *     and pretending otherwise just hides the cap from whoever must decide.
 *
 * The decision is pure (`decidePacing`) and the clock, sleep and jitter source
 * are injected, so the policy is tested with no real timers and no `Math.random`.
 */

import { readNonNegativeNumber } from "./env-config.ts";

type Env = Record<string, string | undefined>;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** OpenWA's shipped bulk-send defaults; conservative on purpose. */
const DEFAULTS = { minIntervalMs: 3000, jitterMs: 2000, perMinute: 10, perHour: 120 };

export type SendRateLimitConfig = {
  minIntervalMs: number;
  jitterMs: number;
  perMinute: number;
  perHour: number;
};

export type PacingDecision =
  | { action: "proceed"; waitMs: number }
  | { action: "refuse"; reason: string };

export type PacerDeps = {
  env?: Env;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source in [0, 1). Injected so tests are not at the mercy of chance. */
  random?: () => number;
};

/** Whether outbound sends are paced at all. On unless explicitly disabled. */
export function isSendRateLimitEnabled(env: Env = process.env): boolean {
  return env.SEND_RATE_LIMIT_ENABLED !== "false";
}

export function getSendRateLimitConfig(env: Env = process.env): SendRateLimitConfig {
  return {
    minIntervalMs: readNonNegativeNumber(
      env.SEND_RATE_LIMIT_MIN_INTERVAL_MS,
      DEFAULTS.minIntervalMs,
    ),
    jitterMs: readNonNegativeNumber(env.SEND_RATE_LIMIT_JITTER_MS, DEFAULTS.jitterMs),
    perMinute: readNonNegativeNumber(env.SEND_RATE_LIMIT_PER_MINUTE, DEFAULTS.perMinute),
    perHour: readNonNegativeNumber(env.SEND_RATE_LIMIT_PER_HOUR, DEFAULTS.perHour),
  };
}

function hourlyCapMessage(sent: number, cap: number): string {
  return [
    `Send REFUSED locally: ${sent} messages already went out in the last hour (cap ${cap}).`,
    "Nothing was sent — this refusal is from this server, not from WhatsApp.",
    "",
    "The cap exists because a high outbound volume is what gets a WhatsApp account",
    "restricted, and this account has been restricted once already (2026-07-28). A",
    "restriction is not appealable and takes the number offline for days.",
    "",
    "DO NOT retry in a loop: the window is an hour wide, so a retry now fails",
    "identically and every attempt is counted. Stop sending, report the cap to",
    "whoever asked for the run, and resume later.",
    "",
    "An operator can raise or disable the cap with SEND_RATE_LIMIT_PER_HOUR /",
    "SEND_RATE_LIMIT_ENABLED, but that is a deliberate risk decision, not a workaround.",
  ].join("\n");
}

function countWithin(history: readonly number[], windowStart: number): number {
  let count = 0;
  for (const at of history) {
    if (at > windowStart) count++;
  }
  return count;
}

/**
 * How long this send must wait — or whether it must be refused outright.
 *
 * `history` is the ascending list of previous send times; `jitterMs` is the
 * already-resolved random component, passed in so this stays pure.
 */
export function decidePacing(
  history: readonly number[],
  now: number,
  config: SendRateLimitConfig,
  jitterMs: number,
): PacingDecision {
  const sentThisHour = countWithin(history, now - HOUR_MS);
  if (config.perHour > 0 && sentThisHour >= config.perHour) {
    return { action: "refuse", reason: hourlyCapMessage(sentThisHour, config.perHour) };
  }

  let waitMs = 0;

  const last = history[history.length - 1];
  if (last !== undefined) {
    waitMs = Math.max(waitMs, last + config.minIntervalMs + jitterMs - now);
  }

  if (config.perMinute > 0) {
    const recent = history.filter((at) => at > now - MINUTE_MS);
    if (recent.length >= config.perMinute) {
      // Wait for the oldest send still occupying a slot to age out of the window.
      const blocking = recent[recent.length - config.perMinute] as number;
      waitMs = Math.max(waitMs, blocking + MINUTE_MS - now);
    }
  }

  return { action: "proceed", waitMs };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Process-wide send history. Global rather than per-recipient on purpose: the
 * account is what gets restricted, so the account is what gets paced.
 */
let history: number[] = [];

/** Test helper: forget every recorded send. */
export function resetSendPacer(): void {
  history = [];
}

/**
 * Pace this send, returning the milliseconds waited.
 *
 * The slot is **reserved before sleeping**, so two concurrent sends queue behind
 * each other instead of both reading an empty gap and firing together.
 */
export async function applySendPacing(deps: PacerDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  if (!isSendRateLimitEnabled(env)) return 0;

  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const config = getSendRateLimitConfig(env);

  const at = now();
  history = history.filter((sentAt) => sentAt > at - HOUR_MS);

  const decision = decidePacing(history, at, config, random() * config.jitterMs);
  if (decision.action === "refuse") throw new Error(decision.reason);

  history.push(at + decision.waitMs);
  if (decision.waitMs > 0) await (deps.sleep ?? defaultSleep)(decision.waitMs);
  return decision.waitMs;
}
