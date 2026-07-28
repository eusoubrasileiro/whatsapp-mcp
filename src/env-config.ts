/**
 * Env parsing shared by the send-path guards.
 *
 * The rule these guards live by: a malformed value must never silently disable
 * a protection. `SEND_RATE_LIMIT_PER_HOUR=banana` has to read as "the default",
 * not as "no cap" — the same convention `getSendAckWaitMs` established in
 * `send-guard.ts`.
 */

/** Parse a non-negative number, falling back on anything unusable. */
export function readNonNegativeNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}
