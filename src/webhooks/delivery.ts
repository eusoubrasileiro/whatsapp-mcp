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
        headers["X-Webhook-Signature"] = `sha256=${signPayload(`${timestamp}.${body}`, sub.secret)}`;
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
    const subs = matchSubscriptions(msg.chat_jid);
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
      subs.map((sub) =>
        deliverEvent(sub, msg, sub.transcribe ? transcript : null, deps.logger),
      ),
    );
  } catch (err) {
    deps.logger.warn({ err, chatId: msg.chat_jid }, "inbound webhook dispatch failed");
  }
}
