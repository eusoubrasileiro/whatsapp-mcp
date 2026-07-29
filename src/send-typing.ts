/**
 * Humanised text sends: a length-scaled "typing…" pause before the message.
 *
 * A stream of messages that appear with zero composing time is one of the
 * cheapest signals an automated sender leaves. Faking the pause is common
 * practice across community WhatsApp automation tools; the delay maths below is
 * our own. Text only — media has no plausible typing indicator, so it is left
 * alone.
 *
 * The delay maths is pure so it is unit-tested without a socket, and a presence
 * failure is swallowed: the presence update is cosmetic, and a cosmetic failure
 * must never block a legitimate message (same principle as the `onWhatsApp`
 * fallback in `recipient.ts`).
 */

import type { Logger } from "pino";

import { readNonNegativeNumber } from "./env-config.ts";

type Env = Record<string, string | undefined>;

/** Even a two-character reply gets a beat, or the cadence is obviously robotic. */
const MIN_DELAY_MS = 500;
/** Roughly 22 words per minute of "typing" — unhurried, human-plausible. */
const MS_PER_CHAR = 45;
/** The jitter widens the pause by up to 40%, so two identical texts differ. */
const JITTER_RATIO = 0.4;

/**
 * Structural subset of the Baileys socket used here — a stub in tests needs
 * nothing else.
 */
export interface PresenceSocket {
  sendPresenceUpdate(state: "composing" | "paused", jid: string): Promise<void>;
}

export type TypingDeps = {
  env?: Env;
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source in [0, 1). Injected so tests are deterministic. */
  random?: () => number;
};

/** Whether to show a typing indicator before a text send. On unless disabled. */
export function isTypingSimulationEnabled(env: Env = process.env): boolean {
  return env.SEND_SIMULATE_TYPING !== "false";
}

export function getTypingMaxMs(env: Env = process.env): number {
  return readNonNegativeNumber(env.SEND_TYPING_MAX_MS, 5000);
}

/** How long to "type" a message of this length. `jitter` is a factor in [0, 1). */
export function computeTypingDelayMs(textLength: number, maxMs: number, jitter: number): number {
  const length = Number.isFinite(textLength) && textLength > 0 ? textLength : 0;
  const spread = Number.isFinite(jitter) ? Math.min(Math.max(jitter, 0), 1) : 0;

  const base = Math.max(MIN_DELAY_MS, length * MS_PER_CHAR);
  return Math.round(Math.min(base * (1 + JITTER_RATIO * spread), maxMs));
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function emitPresence(
  socket: PresenceSocket,
  jid: string,
  state: "composing" | "paused",
  logger: Logger,
): Promise<void> {
  try {
    await socket.sendPresenceUpdate(state, jid);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ jid, state, reason }, "presence update failed — sending anyway");
  }
}

/**
 * Show "typing…", pause for a plausible interval, then clear it.
 *
 * Returns the milliseconds paused (0 when the simulation is switched off).
 */
export async function simulateTyping(
  socket: PresenceSocket,
  jid: string,
  text: string,
  logger: Logger,
  deps: TypingDeps = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  if (!isTypingSimulationEnabled(env)) return 0;

  const random = deps.random ?? Math.random;
  const delayMs = computeTypingDelayMs(text.length, getTypingMaxMs(env), random());

  await emitPresence(socket, jid, "composing", logger);
  await (deps.sleep ?? defaultSleep)(delayMs);
  await emitPresence(socket, jid, "paused", logger);

  return delayMs;
}
