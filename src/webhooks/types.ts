/**
 * Shared types for the outbound webhook subscription platform.
 *
 * A subscription lets an external agent (Hermes, or any future product/tenant)
 * receive inbound WhatsApp messages from a curated allow-list of chats in real
 * time. Nothing here is Hermes-specific — the push is a reusable asset.
 */

export type AuthMode = "hmac" | "bearer";

/** A persisted webhook subscription (one delivery target). */
export interface Subscription {
  id: string;
  tenantId: string;
  targetUrl: string;
  /** Shared secret: HMAC signing key, or the Bearer token. Null = unauthenticated. */
  secret: string | null;
  authMode: AuthMode;
  /** Canonical chat JIDs allowed to wake this subscription, or `["*"]` for all. */
  allowedJids: string[];
  /** When true, forwarded voice notes are transcribed before delivery. */
  transcribe: boolean;
  /**
   * When true, the user's OWN messages (is_from_me) in allow-listed chats are
   * forwarded — the talk-to-yourself pattern (you message Hermes in a self-chat).
   * Hermes's own replies are always suppressed regardless (loop guard). Default
   * false, so a customer-facing bot only sees genuine inbound.
   */
  includeFromMe: boolean;
  label: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Structural subset of `ParsedMessage` the webhook layer needs. Kept local so
 * the pure builder/delivery modules don't depend on `@amiticia/baileys-client`
 * and stay trivially testable. `ParsedMessage` is a structural superset.
 */
export interface InboundMessageInput {
  id: string;
  chat_jid: string;
  sender: string | null;
  content: string;
  timestamp: Date;
  is_from_me: boolean;
  media_type: string | null;
  mimetype: string | null;
  file_length: number | null;
}

/** The JSON event delivered to a subscriber. */
export interface InboundMessageEvent {
  event: "inbound_message";
  tenant_id: string;
  subscription_id: string;
  message_id: string;
  chat_jid: string;
  sender_jid: string | null;
  timestamp: string; // ISO 8601
  is_from_me: boolean;
  content: string;
  transcript: string | null;
  media: {
    type: string;
    mimetype: string | null;
    file_size: number | null;
  } | null;
}
