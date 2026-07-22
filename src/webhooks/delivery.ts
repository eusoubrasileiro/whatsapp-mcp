/**
 * Webhook delivery: sign + POST one event to one subscriber, and fan an inbound
 * message out to all matching subscribers. Modeled on the ntfy isolation
 * (src/ntfy.ts): a slow/down/erroring target NEVER throws and NEVER affects the
 * WhatsApp connection. The subscription secret never appears in any log object.
 */

import { createHmac } from "node:crypto";
import type { Logger } from "pino";

import { buildInboundEvent } from "./event.ts";
import { matchSubscriptions } from "./registry.ts";
import { wasSentByUs } from "./sent-tracker.ts";
import type { InboundMessageInput, Subscription } from "./types.ts";

/** HMAC-SHA256 hex of `payload` keyed by `secret`. */
export function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function isAudioMessage(msg: Pick<InboundMessageInput, "media_type" | "mimetype">): boolean {
  if (msg.media_type === "audio" || msg.media_type === "ptt") return true;
  return Boolean(msg.mimetype?.startsWith("audio/"));
}

/**
 * True when `chatJid` is the connected account's own self-chat (you ↔ you).
 * Compares the bare user part, ignoring @domain and :device suffixes, so
 * `5531…@s.whatsapp.net` matches a connected user reported as `5531…`.
 */
export function isSelfChatJid(chatJid: string, ownUser: string | null | undefined): boolean {
  if (!ownUser) return false;
  const user = (s: string) => s.split("@")[0].split(":")[0];
  return user(chatJid) === user(ownUser);
}

/**
 * Deliver one event to one subscriber. Never throws.
 *
 * Auth (when a secret is set):
 *  - `hmac` (default): `X-Webhook-Signature: sha256=<hmac(timestamp.body)>` plus
 *    `X-Webhook-Timestamp`. The secret is given once at registration and is never
 *    re-transmitted — the subscriber recomputes and compares.
 *  - `bearer`: `Authorization: Bearer <secret>` — for consumers that can't verify HMAC.
 */
export async function deliverEvent(
  sub: Subscription,
  msg: InboundMessageInput,
  transcript: string | null,
  logger: Logger,
): Promise<void> {
  try {
    const event = buildInboundEvent(sub, msg, transcript);
    const body = JSON.stringify(event);
    const headers: Record<string, string> = { "Content-Type": "application/json" };

    if (sub.secret) {
      if (sub.authMode === "bearer") {
        headers.Authorization = `Bearer ${sub.secret}`;
      } else {
        const timestamp = String(Math.floor(Date.now() / 1000));
        headers["X-Webhook-Timestamp"] = timestamp;
        headers["X-Webhook-Signature"] =
          `sha256=${signPayload(`${timestamp}.${body}`, sub.secret)}`;
      }
    }

    const res = await fetch(sub.targetUrl, { method: "POST", headers, body });
    if (!res.ok) {
      logger.warn({ status: res.status, subId: sub.id }, "webhook delivery returned non-2xx");
      return;
    }
    logger.debug({ subId: sub.id, message_id: msg.id }, "webhook delivered");
  } catch (err) {
    logger.warn({ err, subId: sub.id }, "webhook delivery failed");
  }
}

export interface DispatchDeps<T extends InboundMessageInput = InboundMessageInput> {
  logger: Logger;
  /**
   * Returns a transcript for an audio message, or null. Injected to avoid a
   * webhooks→whatsapp import cycle. Receives the full message type passed to
   * dispatchInbound (e.g. ParsedMessage), so it can reach media-fetch fields.
   */
  transcribe?: (msg: T) => Promise<string | null>;
  /**
   * The connected account's own JIDs (phone-number and LID, device suffix
   * stripped). Used to (a) detect the self-chat — a self-chat is all is_from_me,
   * so your messages there are always forwarded, zero config — and (b) let a
   * self-chat (which WhatsApp keys under your LID) also match a subscription that
   * allow-listed your number. Hermes's own replies are still suppressed (loop guard).
   */
  ownJids?: string[];
}

/**
 * Fan an inbound message out to every matching subscription. Transcribes at most
 * once per message (only when some matching subscription wants it). Never throws.
 */
export async function dispatchInbound<T extends InboundMessageInput>(
  msg: T,
  deps: DispatchDeps<T>,
): Promise<void> {
  try {
    // Loop guard: a message this MCP sent (e.g. an agent reply) echoes back via
    // messages.upsert as is_from_me — never forward it, or the agent talks to
    // itself forever. Applies to every subscription regardless of its settings.
    if (wasSentByUs(msg.id)) return;

    const ownJids = deps.ownJids ?? [];
    const isSelfChat = ownJids.some((j) => isSelfChatJid(msg.chat_jid, j));

    // A self-chat is keyed under your LID, but you'd naturally allow-list your
    // number — so also match subscriptions targeting any of your own JIDs.
    const matched = matchSubscriptions(msg.chat_jid);
    if (isSelfChat) {
      const seen = new Set(matched.map((s) => s.id));
      for (const j of ownJids) {
        for (const s of matchSubscriptions(j)) {
          if (!seen.has(s.id)) {
            seen.add(s.id);
            matched.push(s);
          }
        }
      }
    }

    // Direction filter: a genuine inbound (is_from_me=false) always qualifies. An
    // is_from_me message (you typing) qualifies when it's your self-chat (auto) OR
    // the subscription opted in via include_from_me (for a shared group/contact).
    const subs = matched.filter((s) => (msg.is_from_me ? isSelfChat || s.includeFromMe : true));
    if (subs.length === 0) return;

    let transcript: string | null = null;
    if (deps.transcribe && isAudioMessage(msg) && subs.some((s) => s.transcribe)) {
      try {
        transcript = await deps.transcribe(msg);
      } catch (err) {
        deps.logger.warn({ err, message_id: msg.id }, "inbound transcription failed");
      }
    }

    await Promise.all(
      subs.map((sub) => deliverEvent(sub, msg, sub.transcribe ? transcript : null, deps.logger)),
    );
  } catch (err) {
    deps.logger.warn({ err, chatId: msg.chat_jid }, "inbound webhook dispatch failed");
  }
}
