/**
 * Durable memory of recipients WhatsApp has permanently refused.
 *
 * Every other send guard is in-session. `assertSendAccepted` throws
 * "DO NOT RETRY" at the agent that made the send, and that works — for that
 * agent. It does not survive the process, and the failure it was built for is
 * precisely a *cross-session* one: 5531976543210 was refused with code 463 and
 * then re-attempted on 2026-07-24, 07-25 and 07-28 by three different sessions,
 * each of which had never seen the refusal. The 07-28 attempt preceded the
 * second account restriction by 82 minutes.
 *
 * So a 463 against a cold recipient is written to SQLite, and every later send
 * to that identity is refused locally — no reach-out spent, no matter who is
 * asking or how long ago it was refused.
 *
 * Two deliberate asymmetries:
 *
 *   - **Recording fails closed but silently.** It never throws: a blocklist that
 *     can break the send path or the ack logger is worse than none. A refusal it
 *     fails to record is simply not recorded.
 *   - **Enforcement fails open.** An unreadable database allows the send, because
 *     the cold-contact guard still stands behind it and a database hiccup must
 *     not make every send impossible.
 *
 * Sibling of `send-guard.ts`: policy lives here, not in the FastMCP tool bodies.
 */

import { isOperatorAllowlisted, isPersonJid } from "./cold-contact.ts";
import { getAliasGroup, resolveCanonicalJid } from "./database.ts";
import { hasInboundMessage } from "./db/inbound-history.ts";
import {
  type BlocklistEntry,
  type BlocklistStore,
  blocklistStore,
} from "./db/send-blocklist-store.ts";

type Env = Record<string, string | undefined>;

/**
 * The only refusal code treated as permanent for a recipient.
 *
 * 463 means there is no trusted-contact token for the chat, and this server
 * cannot mint one — the state does not decay, so a retry is pure cost. 479
 * (stale device session) and unknown codes are transient or unclassified, and a
 * permanent record for them would wrongly retire a reachable contact.
 */
const PERMANENT_REFUSAL_CODE = "463";

/** Whether refused recipients are remembered and enforced. On unless explicitly disabled. */
export function isSendBlocklistEnabled(env: Env = process.env): boolean {
  return env.SEND_BLOCKLIST_ENABLED !== "false";
}

/** A server refusal as it reaches either call site. */
export type SendRefusal = {
  /** The chat the refusal is about; `null` when the ack carried no jid. */
  jid: string | null;
  code: string | null;
  detail?: string | null;
};

export type RecordRefusalOptions = {
  env?: Env;
  now?: () => Date;
  hasInbound?: (chatJid: string) => boolean;
  aliasesOf?: (jid: string) => string[];
  store?: BlocklistStore;
};

export type BlocklistCheckOptions = {
  env?: Env;
  aliasesOf?: (jid: string) => string[];
  store?: BlocklistStore;
};

/**
 * The jid plus every alias of it, degrading to the jid alone on a lookup error.
 *
 * Both directions matter: a refusal recorded against a phone jid must be found
 * when a later session addresses the same person by `@lid`, and vice versa.
 */
function aliasGroupOf(jid: string, aliasesOf: (jid: string) => string[]): string[] {
  try {
    return [...new Set([jid, ...aliasesOf(jid)])];
  } catch {
    return [jid];
  }
}

/**
 * Record a permanent refusal. Never throws.
 *
 * Called from the send path (`assertSendAccepted`) and from the ack funnel
 * (`logAckErrors`) — the second catches refusals that land after the send path
 * stopped waiting, which are exactly as permanent and just as invisible.
 */
export function recordSendRefusal(refusal: SendRefusal, options: RecordRefusalOptions = {}): void {
  try {
    persistRefusal(refusal, options);
  } catch {
    // Swallowed on purpose. This is a safety net bolted onto two hot paths; a
    // net that can throw would take down the thing it protects.
  }
}

function persistRefusal(refusal: SendRefusal, options: RecordRefusalOptions): void {
  const env = options.env ?? process.env;
  if (!isSendBlocklistEnabled(env)) return;

  const jid = refusal.jid;
  if (!jid || refusal.code !== PERMANENT_REFUSAL_CODE) return;
  // Groups, newsletters and broadcasts are not reach-outs and have no token gate.
  if (!isPersonJid(jid)) return;

  // An established contact must never be retired by a 463. On 2026-07-28, while
  // the account itself was restricted, a contact of years' standing also came
  // back 463 — collateral from the account-level block, not a dead recipient.
  // Blocklisting her would have been the bug, so inbound history wins here.
  const hasInbound = options.hasInbound ?? hasInboundMessage;
  if (hasInbound(jid)) return;

  const store = options.store ?? blocklistStore;
  const aliasesOf = options.aliasesOf ?? getAliasGroup;
  const at = (options.now?.() ?? new Date()).toISOString();
  const detail = refusal.detail ?? null;

  const existing = store.find(aliasGroupOf(jid, aliasesOf));
  if (existing) {
    store.upsert({
      ...existing,
      code: refusal.code,
      lastRefusedAt: at,
      refusalCount: existing.refusalCount + 1,
      detail: detail ?? existing.detail,
    });
    return;
  }

  store.upsert({
    // Canonical form, so the row is keyed by identity rather than by whichever
    // address form this particular session happened to send to.
    jid: canonicalJid(jid),
    tenantId: env.TENANT_ID ?? "default",
    code: refusal.code,
    firstRefusedAt: at,
    lastRefusedAt: at,
    refusalCount: 1,
    detail,
  });
}

/** Canonical jid, degrading to the jid as given when the alias table is unreadable. */
function canonicalJid(jid: string): string {
  try {
    return resolveCanonicalJid(jid);
  } catch {
    return jid;
  }
}

function blockedMessage(jid: string, entry: BlocklistEntry): string {
  const code = entry.code ?? PERMANENT_REFUSAL_CODE;
  const day = (iso: string): string => iso.slice(0, 10);

  return [
    `Send REFUSED locally: WhatsApp has already refused a send to ${jid}, and this`,
    "server remembers it. Nothing was sent — this refusal is from this server, not",
    "from WhatsApp.",
    "",
    `  refused with code ${code} on ${day(entry.lastRefusedAt)}, after ${entry.refusalCount} attempt(s)`,
    `  first refused on ${day(entry.firstRefusedAt)}, recorded as ${entry.jid}`,
    "",
    `A ${code} is not transient: there is no trusted-contact token for this chat and`,
    "this server cannot mint one. Retrying will NEVER succeed, and each attempt is",
    "another cold reach-out against a number WhatsApp has already restricted twice",
    "(July 2026) for exactly this pattern — the second restriction landed 82 minutes",
    "after a fresh session re-attempted a recipient that had been refused days",
    "earlier. This record exists so no later session can repeat that.",
    "",
    "To reach this person, they have to message this account first, or the chat has",
    "to be started from the linked phone: an inbound message is what mints the token",
    "this send is missing.",
    "",
    "There is deliberately NO tool and NO environment variable to clear this entry —",
    "removing it is a manual operator action against the database:",
    "",
    `  DELETE FROM send_blocklist WHERE jid = '${entry.jid}';`,
  ].join("\n");
}

/** The recorded refusal for this recipient, or `null` — including on any read error. */
function lookupEntry(jid: string, options: BlocklistCheckOptions): BlocklistEntry | null {
  const store = options.store ?? blocklistStore;
  try {
    return store.find(aliasGroupOf(jid, options.aliasesOf ?? getAliasGroup));
  } catch {
    return null;
  }
}

/**
 * Throw if WhatsApp has already refused this recipient permanently.
 *
 * Nothing is sent on the throwing path. Runs before the cold-contact check: a
 * recorded refusal is the stronger fact, and unlike a cold contact it cannot be
 * waved through with `allow_cold_contact`.
 */
export function assertNotBlocked(jid: string, options: BlocklistCheckOptions = {}): void {
  const env = options.env ?? process.env;
  if (!isSendBlocklistEnabled(env)) return;

  // An operator-approved recipient is exempt: numbers we own are used for
  // testing, and a stale entry must not retire one of them permanently.
  if (isOperatorAllowlisted(jid, { env, aliasesOf: options.aliasesOf })) return;

  const entry = lookupEntry(jid, options);
  if (!entry) return;

  throw new Error(blockedMessage(jid, entry));
}
