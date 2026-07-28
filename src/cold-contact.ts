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
 */

import { hasInboundMessage } from "./db/inbound-history.ts";
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

export type ColdContactOptions = {
  env?: Env;
  /** Deliberate, consented first contact — skips the check. */
  allowCold?: boolean;
  /** The connected account's own JIDs (`socket.user.id` / `.lid`), for self-chat detection. */
  ownJids?: string[];
  hasInbound?: (chatJid: string) => boolean;
};

/** Whether cold first contacts are refused. On unless explicitly disabled. */
export function isColdContactGuardEnabled(env: Env = process.env): boolean {
  return env.SEND_COLD_CONTACT_GUARD !== "false";
}

function coldContactMessage(jid: string): string {
  return [
    `Send REFUSED locally: ${jid} has never messaged this account, so this would be`,
    "a cold first contact. Nothing was sent — this refusal is from this server, not",
    "from WhatsApp.",
    "",
    "Cold reach-outs are what WhatsApp's anti-abuse system restricts accounts for.",
    "This number was already restricted once (2026-07-28) and a restriction cannot",
    "be appealed — it takes the account offline for days.",
    "",
    "What to do instead, in order:",
    "",
    "  1. CHECK THE RECIPIENT. If you expected an existing chat, the JID is probably",
    '     wrong. Resolve it: search_contacts("<name>") -> use the @lid it returns.',
    "",
    "  2. HAVE THEM MESSAGE FIRST. An inbound message (or a chat started from the",
    "     linked phone) makes this contact warm and the send goes through.",
    "",
    "  3. ONLY IF THE CONTACT ASKED TO BE REACHED — someone who gave you the number",
    "     and is expecting the message — re-send with allow_cold_contact: true. Do",
    "     not use it to work around this refusal in bulk; that is exactly the",
    "     pattern that caused the restriction.",
    "",
    "An operator can disable the guard entirely with SEND_COLD_CONTACT_GUARD=false.",
  ].join("\n");
}

/**
 * Throw if this send would be a cold first contact.
 *
 * Nothing is sent on the throwing path — the reach-out is never spent.
 */
export function assertNotColdContact(jid: string, options: ColdContactOptions = {}): void {
  if (!isColdContactGuardEnabled(options.env ?? process.env)) return;
  if (options.allowCold) return;
  if (!PERSON_DOMAINS.some((domain) => jid.endsWith(domain))) return;

  // Talking to yourself is not a reach-out. It also reads as cold no matter how
  // long it has been used: a self-chat holds only is_from_me messages, so the
  // history read finds nothing inbound. Without this, an agent could no longer
  // answer the user's own messages — the documented talk-to-yourself flow.
  if (options.ownJids?.some((own) => isSelfChatJid(jid, own))) return;

  const hasInbound = options.hasInbound ?? hasInboundMessage;
  if (hasInbound(jid)) return;

  throw new Error(coldContactMessage(jid));
}
