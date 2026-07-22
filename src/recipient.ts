/**
 * Pre-send recipient resolution.
 *
 * Motivating incident (2026-07-22): the MCP appeared to stop delivering. It
 * hadn't — agents were hand-building phone JIDs. The AmiticIA 2 test number is
 * `553191234567` (12 digits), but Brazilian mobiles are normally 13
 * (`55 DD 9XXXX-XXXX`), so an inserted `9` yields `5531912344567` — a different
 * number that isn't on WhatsApp. A number that isn't on WhatsApp can never mint
 * a trusted-contact token, so every send to it is refused with 463 while the
 * same account keeps delivering everywhere else. Hours were spent suspecting an
 * account restriction and a deactivated carrier line.
 *
 * So: ask the server before sending. A bad number fails *before* a reach-out is
 * spent, and a good one is upgraded to its canonical `@lid` — the addressing
 * every successful send in that incident used.
 */

import type { WhatsAppSocket } from "@amiticia/baileys-client";
import type { Logger } from "pino";

/** Address spaces where an existence check is meaningless. */
const PASSTHROUGH_DOMAINS = ["@g.us", "@lid", "@newsletter", "@broadcast"];
const PHONE_DOMAIN = "@s.whatsapp.net";

type CacheEntry = { jid: string; expiresAt: number };

const cache = new Map<string, CacheEntry>();

/**
 * A confirmed contact is stable, so cache it for a long while. Nothing is
 * cached for a *failed* lookup — see `resolveRecipient`.
 */
const POSITIVE_TTL_MS = 6 * 60 * 60 * 1000;

/** Test helper: forget every cached lookup. */
export function resetRecipientCache(): void {
  cache.clear();
}

/**
 * Resolve the JID a message should actually be addressed to.
 *
 * - Groups / LIDs / newsletters pass through untouched (no lookup).
 * - A phone JID is verified with `onWhatsApp`; when the contact exists and the
 *   server reports a LID, that LID is returned.
 * - A number that is not on WhatsApp **throws** — nothing is sent.
 * - A lookup that itself fails logs a warning and falls back to the original
 *   JID: a flaky lookup must never block a legitimate send.
 */
export async function resolveRecipient(
  socket: WhatsAppSocket,
  jid: string,
  logger: Logger,
): Promise<string> {
  if (PASSTHROUGH_DOMAINS.some((domain) => jid.endsWith(domain))) return jid;
  // Unknown address space: leave it alone rather than guess.
  if (!jid.endsWith(PHONE_DOMAIN)) return jid;

  const cached = cache.get(jid);
  if (cached && cached.expiresAt > Date.now()) return cached.jid;

  let results: Array<{ jid?: string; exists?: boolean; lid?: string }> | undefined;
  try {
    results = (await socket.onWhatsApp(jid)) as typeof results;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(
      { jid, reason },
      "recipient existence check failed — sending to the JID as given",
    );
    return jid;
  }

  // Baileys omits non-existent numbers from the response entirely, so an empty
  // result means "not on WhatsApp" just as much as an explicit exists:false.
  const match = results?.[0];
  if (!match || match.exists === false) {
    throw new Error(
      `Recipient "${jid}" is not on WhatsApp — nothing was sent.\n\n` +
        `Do not retype the number: resolve it instead.\n` +
        `  search_contacts("<name>") -> send to the @lid it returns.\n\n` +
        `Common cause: a Brazilian mobile written with an extra "9". ` +
        `55 31 9123-4567 is 553191234567 (12 digits), NOT 5531912344567.`,
    );
  }

  const resolved = match.lid ?? jid;
  if (resolved !== jid) {
    logger.info({ from: jid, to: resolved }, "recipient upgraded to canonical LID");
  }
  cache.set(jid, { jid: resolved, expiresAt: Date.now() + POSITIVE_TTL_MS });
  return resolved;
}
