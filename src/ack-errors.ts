import type { WAMessageUpdate } from "@amiticia/baileys-client";
import type { Logger } from "pino";

import { emitAckError } from "./ack-bus.ts";

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
  // Not rate limiting, and — despite the server's "account restricted" text —
  // usually not an account problem at all. WhatsApp gates 1:1 messages behind a
  // TC (Trusted Contact) privacy token. Two distinct causes, both observed on
  // 2026-07-22: a mistyped number that isn't on WhatsApp can never mint a token
  // (5531912344567), and a real number you have never chatted with does not have
  // one yet (5531991234567 — it passed the existence check and was still
  // refused). Never re-send: each attempt is another reach-out.
  "463":
    "wrong recipient JID/LID, or no trusted-contact token (tctoken) yet for this chat (first contact) — verify the JID, do not retry",
  "479": "stanza rejected (smax-invalid) — likely a stale device session",
};

/**
 * Agent-facing explanation of a rejected send.
 *
 * Pure and separate from the log line: operators read `wa-logs.txt`, but the
 * agent that called `send_message` needs to be told, in its own tool result,
 * that the message is gone and what to do instead.
 */
export function formatAckErrorForAgent(ackError: AckError, recipient: string): string {
  const code = ackError.code ?? "unspecified";
  const lines = [
    `Message to ${recipient} was REJECTED by WhatsApp (code ${code}) and did NOT arrive.`,
    "",
  ];

  if (ackError.code === "463") {
    lines.push(
      "463 = no trusted-contact token for this chat. Two causes are common —",
      "check them in this order:",
      "",
      "  1. WRONG RECIPIENT JID. The number may not be on WhatsApp at all, or the",
      "     contact is addressed by @lid rather than by phone. Verify it:",
      '       search_contacts("<name>") -> use the @lid it returns.',
      "     Do not retype the number from memory or from a doc.",
      "",
      "  2. FIRST CONTACT with a real number. WhatsApp gates 1:1 sends behind a",
      "     token that a chat you have never exchanged messages with does not yet",
      "     have. Nothing is wrong with the number, the account, or this server.",
      "     This cannot be forced from here — the contact must message first, or",
      "     the chat must be established from the linked phone / WhatsApp Web.",
      "",
      "DO NOT RETRY this send. A wrong number fails identically every time, and a",
      "retry to a real number is just another reach-out against the same gate.",
    );
  } else if (ackError.code === "479") {
    lines.push(
      "Cause: a stale device session for this contact (479).",
      "",
      "DO NOT RETRY immediately — Baileys re-establishes the session on its own.",
      "Verify the recipient JID, then try again later.",
    );
  } else {
    lines.push(
      `Server reason: ${ackError.reason}`,
      "",
      "DO NOT RETRY blindly. Verify the recipient JID first:",
      '  search_contacts("<name>") -> use the @lid it returns.',
    );
  }

  if (ackError.detail) lines.push("", `Server detail: ${ackError.detail}`);

  return lines.join("\n");
}

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
 * Log every server-rejected send in a `messages.update` batch, and publish it
 * on the ack bus.
 *
 * This used to be operator-facing only, leaving `send_message` fire-and-forget.
 * That is precisely what made the 2026-07-22 incident so expensive: the tool
 * reported success for four messages the server had refused, the evidence sat
 * only in `wa-logs.txt`, and the agent concluded the MCP was broken. The bus
 * lets the send path block briefly and tell the caller the truth.
 */
export function logAckErrors(updates: WAMessageUpdate[], logger: Logger): void {
  for (const entry of updates) {
    const ackError = classifyAckError(entry);
    if (!ackError) continue;

    emitAckError(ackError);

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
