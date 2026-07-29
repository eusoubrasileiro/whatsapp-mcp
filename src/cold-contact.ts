/**
 * Cold first-contact guard.
 *
 * Messaging someone who has never messaged you is a *reach-out*, and a burst of
 * reach-outs is the single most reliable way to get a WhatsApp account
 * restricted. That is not theoretical here: the linked number was restricted for
 * five days on 2026-07-28 — still able to reach saved contacts, unable to reach
 * strangers — after a run of sends to hand-built JIDs.
 *
 * So an outbound to a phone JID with no inbound history is refused by default.
 * The history read is injected (defaulting to the real one) so the policy is
 * unit-tested without a database.
 *
 * Two **operator** policies sit on top of that check, because the per-call escape
 * hatch alone is not trustworthy — any agent can pass `allow_cold_contact: true`,
 * which on the personal-number deployment — an account one strike from a
 * permanent ban — leaves the guard advisory.
 *
 *   - `SEND_COLD_OVERRIDE=deny` makes the escape hatch inert: the parameter is
 *     ignored and the refusal names the work instance, whose job outreach is.
 *   - `SEND_COLD_ALLOWED_JIDS` pre-approves specific recipients (numbers we own),
 *     which stay sendable under either policy — so testing needs no override.
 */

import { getAliasGroup } from "./database.ts";
import { hasInboundMessage } from "./db/inbound-history.ts";
import { readEnumValue, readList } from "./env-config.ts";
import { isSelfChatJid } from "./webhooks/delivery.ts";

type Env = Record<string, string | undefined>;

/**
 * Address spaces that identify one person, and are therefore reach-outs.
 *
 * `@lid` is included deliberately: `recipient.ts` opportunistically upgrades a
 * phone JID to its LID before sending, so exempting LIDs would let the guard be
 * skipped by the send path's own normal behaviour. `hasInboundMessage` resolves
 * the alias group, so either form reads the same history.
 *
 * Everything else — groups, newsletters, broadcasts, unknown address spaces — is
 * either not a reach-out or has no meaningful inbound history to consult.
 */
const PERSON_DOMAINS = ["@s.whatsapp.net", "@lid"];

/** Whether the per-call `allow_cold_contact` escape hatch is honoured at all. */
export type ColdOverridePolicy = "allow" | "deny";

const COLD_OVERRIDE_POLICIES = ["allow", "deny"] as const;

export type ColdContactOptions = {
  env?: Env;
  /** Deliberate, consented first contact — skips the check, unless policy denies it. */
  allowCold?: boolean;
  /** The connected account's own JIDs (`socket.user.id` / `.lid`), for self-chat detection. */
  ownJids?: string[];
  hasInbound?: (chatJid: string) => boolean;
  /**
   * Every JID form of one identity (defaults to the real alias-table helper).
   *
   * The allowlist is compared through it, so an entry written as a phone number
   * still matches after the send path has upgraded the target to its `@lid`.
   */
  aliasesOf?: (jid: string) => string[];
};

/** Whether cold first contacts are refused. On unless explicitly disabled. */
export function isColdContactGuardEnabled(env: Env = process.env): boolean {
  return env.SEND_COLD_CONTACT_GUARD !== "false";
}

/**
 * Whether `allow_cold_contact` is honoured on this instance.
 *
 * `allow` (the default) keeps the existing per-call behaviour. `deny` is for a
 * deployment where cold reach-outs are simply not this account's job.
 */
export function getColdOverridePolicy(env: Env = process.env): ColdOverridePolicy {
  return readEnumValue(env.SEND_COLD_OVERRIDE, COLD_OVERRIDE_POLICIES, "allow");
}

/**
 * Every comparable string form of one address: the bare user part, and
 * `user@domain` with any device suffix (`:12`) dropped.
 *
 * Applied to both sides of the allowlist comparison, so an operator can write
 * `553191234567`, `553191234567@s.whatsapp.net` or a LID and be understood.
 */
function addressForms(value: string): string[] {
  const trimmed = value.trim().toLowerCase();
  const at = trimmed.indexOf("@");
  const domain = at >= 0 ? trimmed.slice(at + 1) : "s.whatsapp.net";
  const user = (at >= 0 ? trimmed.slice(0, at) : trimmed).split(":")[0] ?? "";
  if (user === "" || domain === "") return [];
  return [user, `${user}@${domain}`];
}

/** The operator-approved recipients, expanded into every comparable form. */
function allowedForms(env: Env): Set<string> {
  return new Set(readList(env.SEND_COLD_ALLOWED_JIDS).flatMap(addressForms));
}

/**
 * The JID plus every alias of it.
 *
 * A failing alias lookup degrades to the JID alone rather than propagating: the
 * guard is fail-safe, so a database hiccup must never widen an exemption. An
 * entry naming this exact JID still matches — that exemption rests on the
 * operator's own configuration and needs no database.
 */
function resolveAliases(jid: string, aliasesOf: (jid: string) => string[]): string[] {
  try {
    return [jid, ...aliasesOf(jid)];
  } catch {
    return [jid];
  }
}

/** Whether the operator has pre-approved this recipient, in any of its JID forms. */
function isAllowlisted(jid: string, options: ColdContactOptions, env: Env): boolean {
  const allowed = allowedForms(env);
  // Nothing listed is the default, so the alias lookup is never even attempted.
  if (allowed.size === 0) return false;

  const aliases = resolveAliases(jid, options.aliasesOf ?? getAliasGroup);
  return aliases.some((alias) => addressForms(alias).some((form) => allowed.has(form)));
}

const SHARED_NEXT_STEPS = [
  "What to do instead, in order:",
  "",
  "  1. CHECK THE RECIPIENT. If you expected an existing chat, the JID is probably",
  '     wrong. Resolve it: search_contacts("<name>") -> use the @lid it returns.',
  "",
  "  2. HAVE THEM MESSAGE FIRST. An inbound message (or a chat started from the",
  "     linked phone) makes this contact warm and the send goes through.",
  "",
];

/** Tail of the refusal when the per-call override is still available. */
const OVERRIDE_ALLOWED_TAIL = [
  "Cold reach-outs are what WhatsApp's anti-abuse system restricts accounts for.",
  "This number was already restricted once (2026-07-28) and a restriction cannot",
  "be appealed — it takes the account offline for days.",
  "",
  ...SHARED_NEXT_STEPS,
  "  3. ONLY IF THE CONTACT ASKED TO BE REACHED — someone who gave you the number",
  "     and is expecting the message — re-send with allow_cold_contact: true. Do",
  "     not use it to work around this refusal in bulk; that is exactly the",
  "     pattern that caused the restriction.",
  "",
  "An operator can disable the guard entirely with SEND_COLD_CONTACT_GUARD=false.",
];

/**
 * Tail of the refusal when the override is switched off.
 *
 * Deliberately never suggests `allow_cold_contact`: an agent that reads a way out
 * takes it, and every retry here is another reach-out against an account that
 * cannot afford one.
 */
const OVERRIDE_DENIED_TAIL = [
  "Cold-contact override is DISABLED on this instance by policy",
  "(SEND_COLD_OVERRIDE=deny), so allow_cold_contact was IGNORED. Sending it again",
  "changes nothing — on this instance that is not a per-call decision.",
  "",
  "This number has already been restricted for cold reach-outs, and a restriction",
  "cannot be appealed — it takes the account offline for days. Outreach and",
  "first-contact sends belong on the work instance: use the whatsapp-work MCP for",
  "them.",
  "",
  ...SHARED_NEXT_STEPS,
  "  3. SEND IT FROM THE WORK INSTANCE. First contact is that account's job — the",
  "     whatsapp-work MCP exposes the same send tools against a number that is",
  "     meant to reach strangers.",
  "",
  "Only an operator can change this: an approved recipient goes in",
  "SEND_COLD_ALLOWED_JIDS, and the override itself returns with SEND_COLD_OVERRIDE=allow.",
];

function coldContactMessage(jid: string, policy: ColdOverridePolicy): string {
  return [
    `Send REFUSED locally: ${jid} has never messaged this account, so this would be`,
    "a cold first contact. Nothing was sent — this refusal is from this server, not",
    "from WhatsApp.",
    "",
    ...(policy === "deny" ? OVERRIDE_DENIED_TAIL : OVERRIDE_ALLOWED_TAIL),
  ].join("\n");
}

/**
 * Throw if this send would be a cold first contact.
 *
 * Nothing is sent on the throwing path — the reach-out is never spent.
 *
 * Exemptions are checked most-authoritative first: the operator's allowlist, then
 * the account's own self-chat, then the caller's per-call override — which only
 * counts when the instance policy still honours it.
 */
export function assertNotColdContact(jid: string, options: ColdContactOptions = {}): void {
  const env = options.env ?? process.env;
  if (!isColdContactGuardEnabled(env)) return;

  // An operator-approved recipient is exempt under every policy: it is the
  // supported way to keep testing working once the override is denied.
  if (isAllowlisted(jid, options, env)) return;

  // Talking to yourself is not a reach-out. It also reads as cold no matter how
  // long it has been used: a self-chat holds only is_from_me messages, so the
  // history read finds nothing inbound. Without this, an agent could no longer
  // answer the user's own messages — the documented talk-to-yourself flow.
  if (options.ownJids?.some((own) => isSelfChatJid(jid, own))) return;

  const policy = getColdOverridePolicy(env);
  if (options.allowCold && policy === "allow") return;

  if (!PERSON_DOMAINS.some((domain) => jid.endsWith(domain))) return;

  const hasInbound = options.hasInbound ?? hasInboundMessage;
  if (hasInbound(jid)) return;

  throw new Error(coldContactMessage(jid, policy));
}
