/**
 * Application-layer actions for webhook subscriptions. Decoupled from the
 * WhatsApp socket (depends only on the registry) so these are testable without
 * `@amiticia/baileys-client`. MCP tools delegate here.
 */

import {
  addSubscription,
  listSubscriptions,
  removeSubscription,
} from "./registry.ts";
import type { AuthMode, Subscription } from "./types.ts";

/**
 * Resolve the tenant for the current call. Single `default` tenant today; the
 * seam where a future SaaS maps the MCP Bearer token to a tenant.
 */
export function resolveTenantId(): string {
  return process.env.TENANT_ID ?? "default";
}

export interface RegisterWebhookInput {
  target_url: string;
  allowed_jids: string[];
  secret?: string;
  auth_mode?: AuthMode;
  transcribe?: boolean;
  label?: string;
}

/** Public (secret-redacted) view of a subscription for `list_webhooks`. */
export interface PublicSubscription {
  id: string;
  target_url: string;
  allowed_jids: string[];
  transcribe: boolean;
  auth_mode: AuthMode;
  label: string | null;
  active: boolean;
  created_at: string;
  has_secret: boolean;
}

function validateTargetUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid target_url: "${url}" is not a valid URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`target_url must use http(s), got "${parsed.protocol}".`);
  }
}

export function executeRegisterWebhook(input: RegisterWebhookInput): { id: string } {
  validateTargetUrl(input.target_url);
  if (!input.allowed_jids || input.allowed_jids.length === 0) {
    throw new Error('allowed_jids must contain at least one chat JID (or "*" for all chats).');
  }
  const sub = addSubscription({
    tenantId: resolveTenantId(),
    targetUrl: input.target_url,
    secret: input.secret,
    authMode: input.auth_mode,
    allowedJids: input.allowed_jids,
    transcribe: input.transcribe,
    label: input.label,
  });
  return { id: sub.id };
}

export function executeDeregisterWebhook(id: string): { removed: boolean } {
  return { removed: removeSubscription(id, resolveTenantId()) };
}

export function executeListWebhooks(): PublicSubscription[] {
  return listSubscriptions(resolveTenantId()).map(toPublic);
}

function toPublic(s: Subscription): PublicSubscription {
  return {
    id: s.id,
    target_url: s.targetUrl,
    allowed_jids: s.allowedJids,
    transcribe: s.transcribe,
    auth_mode: s.authMode,
    label: s.label,
    active: s.active,
    created_at: s.createdAt,
    has_secret: Boolean(s.secret),
  };
}
