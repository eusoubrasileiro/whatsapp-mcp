/**
 * In-memory subscription registry, backed by SQLite.
 *
 * Hydrated once at boot (`loadRegistry`) and kept in sync on register/deregister,
 * so the hot path — matching an inbound message against subscriptions on every
 * `onMessageUpsert` — is a synchronous array scan with no per-message DB query
 * or JSON parse. The DB is the source of truth across restarts; this cache is a
 * read-through projection of it.
 */

import { randomUUID } from "node:crypto";

import {
  deleteSubscriptionRow,
  getAllSubscriptionRows,
  insertSubscriptionRow,
  resolveCanonicalJid,
  type SubscriptionRow,
} from "../database.ts";
import type { AuthMode, Subscription } from "./types.ts";

let cache: Subscription[] = [];

function rowToSubscription(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    tenantId: row.tenantId,
    targetUrl: row.targetUrl,
    secret: row.secret,
    authMode: row.authMode === "bearer" ? "bearer" : "hmac",
    allowedJids: JSON.parse(row.allowedJids) as string[],
    transcribe: row.transcribe,
    includeFromMe: row.includeFromMe,
    label: row.label,
    active: row.active,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Hydrate the in-memory cache from the DB. Call once at boot. */
export function loadRegistry(): void {
  cache = getAllSubscriptionRows().map(rowToSubscription);
}

/** Clear the in-memory cache (tests; does not touch the DB). */
export function resetRegistry(): void {
  cache = [];
}

export interface NewSubscriptionInput {
  tenantId: string;
  targetUrl: string;
  secret?: string | null;
  authMode?: AuthMode;
  allowedJids: string[];
  transcribe?: boolean;
  includeFromMe?: boolean;
  label?: string | null;
}

/** Persist a new subscription and add it to the cache. Returns the stored subscription. */
export function addSubscription(input: NewSubscriptionInput): Subscription {
  const now = new Date().toISOString();
  // Store the allow-list JIDs as given (raw). Canonicalization happens at match
  // time, not here — otherwise a PN↔LID alias learned AFTER registration would
  // leave a frozen canonical form that silently stops matching.
  const allowedJids = [...input.allowedJids];
  const sub: Subscription = {
    id: randomUUID(),
    tenantId: input.tenantId,
    targetUrl: input.targetUrl,
    secret: input.secret ?? null,
    authMode: input.authMode ?? "hmac",
    allowedJids,
    transcribe: input.transcribe ?? true,
    includeFromMe: input.includeFromMe ?? false,
    label: input.label ?? null,
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  insertSubscriptionRow({ ...sub, allowedJids: JSON.stringify(sub.allowedJids) });
  cache.push(sub);
  return sub;
}

/** Remove a subscription (scoped to its tenant). Returns true if one was removed. */
export function removeSubscription(id: string, tenantId: string): boolean {
  const removed = deleteSubscriptionRow(id, tenantId);
  if (removed) {
    cache = cache.filter((s) => !(s.id === id && s.tenantId === tenantId));
  }
  return removed;
}

/** All subscriptions for a tenant (active and inactive), for management/listing. */
export function listSubscriptions(tenantId: string): Subscription[] {
  return cache.filter((s) => s.tenantId === tenantId);
}

/**
 * Active subscriptions whose allow-list matches this chat. Tenant-agnostic today
 * (one WhatsApp account); a future multi-account build would pass the connection's
 * tenant to scope this.
 */
export function matchSubscriptions(chatJid: string): Subscription[] {
  const canonical = resolveCanonicalJid(chatJid);
  return cache.filter(
    (s) =>
      s.active &&
      (s.allowedJids.includes("*") ||
        s.allowedJids.some((j) => resolveCanonicalJid(j) === canonical)),
  );
}
