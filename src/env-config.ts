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

/**
 * Parse one of a fixed set of words, falling back on anything unrecognised.
 *
 * Case- and whitespace-insensitive, because these values are typed by hand into
 * a compose file. A typo reads as the documented default rather than as some
 * other policy — the same rule `readNonNegativeNumber` follows.
 */
export function readEnumValue<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  const parsed = raw?.trim().toLowerCase();
  if (!parsed) return fallback;
  return allowed.find((value) => value === parsed) ?? fallback;
}

/** Split a comma-separated env list, trimming entries and dropping blanks. */
export function readList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}
