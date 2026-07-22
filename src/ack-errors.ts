import type { WAMessageUpdate } from "@amiticia/baileys-client";
import type { Logger } from "pino";

/**
 * Server-side rejections of messages we sent.
 *
 * `socket.sendMessage()` resolves as soon as the stanza is written, so a
 * rejection cannot surface as a thrown error — it arrives later in an ack and
 * Baileys re-emits it on `messages.update` as `status: ERROR` plus the numeric
 * code in `messageStubParameters[0]`. Without a consumer for that event a
 * failed send is indistinguishable from a successful one.
 */

/** `WAMessageStatus.ERROR`. Deliberately named: the value is 0, i.e. falsy. */
const STATUS_ERROR = 0;

export type AckError = {
  msgId: string | null;
  chatJid: string | null;
  /** Numeric server code as a string, or null when the server sent none. */
  code: string | null;
  reason: string;
  /** Extra human-readable text the server attached, when present. */
  detail: string | null;
};

const REASONS: Record<string, string> = {
  // Not rate limiting. WhatsApp gates 1:1 messages behind a TC (Trusted
  // Contact) privacy token; a send without one is refused. Established chats
  // already carry a token, which is why this shows up on new reach-outs.
  // Baileys issues the token and retries on its own — we must not re-send, as
  // each attempt counts as another reach-out and worsens the restriction.
  "463": "account restricted or missing privacy token (tctoken) for this contact — do not retry",
  "479": "stanza rejected (smax-invalid) — likely a stale device session",
};

export function classifyAckError(entry: WAMessageUpdate): AckError | null {
  const update = entry.update;
  // Compare explicitly: ERROR is 0, so a truthiness check would skip every
  // failure and report only successes.
  if (update?.status !== STATUS_ERROR) return null;

  const [code = null, detail = null] = update.messageStubParameters ?? [];

  return {
    msgId: entry.key?.id ?? null,
    chatJid: entry.key?.remoteJid ?? null,
    code,
    reason: (code && REASONS[code]) || "server rejected the message",
    detail,
  };
}

/**
 * Log every server-rejected send in a `messages.update` batch.
 *
 * Operator-facing only: nothing is persisted and the agent still sees
 * `send_message` as fire-and-forget. Deliberate — the fix for the 463 that
 * prompted this is the Baileys upgrade itself; this is the safety net that
 * makes a recurrence visible instead of silent.
 */
export function logAckErrors(updates: WAMessageUpdate[], logger: Logger): void {
  for (const entry of updates) {
    const ackError = classifyAckError(entry);
    if (!ackError) continue;

    logger.warn(
      {
        msgId: ackError.msgId,
        chat_jid: ackError.chatJid,
        code: ackError.code,
        detail: ackError.detail,
      },
      `send rejected by server: ${ackError.reason}`,
    );
  }
}
