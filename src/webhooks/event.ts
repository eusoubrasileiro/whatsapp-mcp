/**
 * Pure builder: turn an inbound WhatsApp message + its subscription into the
 * JSON event we deliver. No I/O, no DB — trivially unit-testable. Field
 * conventions mirror `formatDbMessageForJson` (src/formatters.ts).
 */

import type {
  InboundMessageEvent,
  InboundMessageInput,
  Subscription,
} from "./types.ts";

export function buildInboundEvent(
  sub: Pick<Subscription, "id" | "tenantId">,
  msg: InboundMessageInput,
  transcript: string | null = null,
): InboundMessageEvent {
  return {
    event: "inbound_message",
    tenant_id: sub.tenantId,
    subscription_id: sub.id,
    message_id: msg.id,
    chat_jid: msg.chat_jid,
    sender_jid: msg.sender ?? null,
    timestamp: msg.timestamp.toISOString(),
    is_from_me: false,
    content: msg.content,
    transcript,
    media: msg.media_type
      ? {
          type: msg.media_type,
          mimetype: msg.mimetype,
          file_size: msg.file_length,
        }
      : null,
  };
}
