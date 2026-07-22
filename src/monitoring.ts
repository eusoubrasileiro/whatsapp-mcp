/**
 * Reactive-monitoring core: the FastMCP-independent logic behind the
 * `get_new_messages` (delta) and `wait_for_messages` (long-poll) tools. Kept
 * out of the tool layer so it is testable without spinning up a server.
 *
 * Both read the same authoritative DB delta (`getMessagesSince`) and apply the
 * same two filters an agent monitoring receptionist replies wants:
 *  - loop guard: drop messages this MCP itself sent (the agent's own replies
 *    echo back as `is_from_me`) — reuses the webhook `sent-tracker`.
 *  - direction: drop your own messages unless `includeFromMe` is set.
 *
 * The long-poll blocks server-side at zero token cost while idle: tokens are
 * spent only on the request and the eventual response, never during the wait.
 * The agent loops it with the rolling `next_since` cursor to cover hour-scale
 * reply latency with a handful of cheap calls.
 */

import {
  getMessagesDelta,
  type Message,
  type MessagesDeltaCursor,
  resolveCanonicalJid,
} from "./database.ts";
import { type InboundBusMessage, waitForInbound } from "./inbound-bus.ts";
import { wasSentByUs } from "./webhooks/sent-tracker.ts";

export interface GetNewMessagesOpts {
  /** Chats to watch. Omit, empty, or `["*"]` = all chats. */
  chatJids?: string[] | null;
  /**
   * Opaque cursor from a previous call's `next_since` (`row:<n>` — exclusive,
   * monotonic). An ISO-8601 string is still accepted (back-compat / explicit
   * backfill: inclusive `gte`, at-least-once). Omitted → "from now".
   */
  since?: string | null;
  limit?: number;
  /** Include your own (`is_from_me`) messages. Default false. */
  includeFromMe?: boolean;
}

export interface NewMessagesResult {
  messages: Message[];
  /** Opaque exclusive cursor to pass back as `since` on the next call. */
  next_since: string;
}

const ROW_PREFIX = "row:";

/** Encode a rowid high-water mark as the opaque `next_since` cursor. */
export function encodeCursor(rowid: number): string {
  return `${ROW_PREFIX}${rowid}`;
}

/**
 * Decode a `since` value into a {@link MessagesDeltaCursor}. `row:<n>` → exclusive
 * rowid; a bare ISO string → inclusive backfill; anything empty → from-now.
 * A malformed `row:` token degrades safely to from-now rather than throwing.
 */
export function parseCursor(since?: string | null): MessagesDeltaCursor {
  if (since == null || since === "") return { fromNow: true };
  if (since.startsWith(ROW_PREFIX)) {
    const n = Number(since.slice(ROW_PREFIX.length));
    return Number.isFinite(n) ? { afterRowid: n } : { fromNow: true };
  }
  return { sinceIso: since };
}

/** `["*"]`, empty, or null → null (all chats); otherwise the list as given. */
function normalizeChatJids(chatJids?: string[] | null): string[] | null {
  if (!chatJids || chatJids.length === 0) return null;
  if (chatJids.includes("*")) return null;
  return chatJids;
}

/**
 * One delta read: messages since `since`, loop-guarded and direction-filtered.
 * `next_since` advances past every *fetched* row (even filtered-out ones) so the
 * cursor never stalls on a burst of your own messages, and is exclusive so a
 * rolling loop never re-delivers the boundary message.
 */
export function getNewMessagesCore(opts: GetNewMessagesOpts): NewMessagesResult {
  const limit = opts.limit ?? 50;
  const includeFromMe = opts.includeFromMe ?? false;
  const chatJids = normalizeChatJids(opts.chatJids);
  const cursor = parseCursor(opts.since);

  const delta = getMessagesDelta(chatJids, cursor, limit);

  const messages = delta.messages.filter((m) => {
    if (wasSentByUs(m.id)) return false; // our own send echoing back
    if (m.is_from_me && !includeFromMe) return false; // direction filter
    return true;
  });

  // Advance to the fetched high-water rowid; if there was nothing to advance to
  // (empty ISO backfill), hold the caller's original cursor.
  const next_since = delta.cursor != null ? encodeCursor(delta.cursor) : (opts.since ?? "");

  return { messages, next_since };
}

/**
 * Resolve a `since` value to a concrete cursor string. A "from now" cursor is
 * frozen to the current rowid high-water mark so repeated internal queries share
 * one stable boundary (see {@link waitForMessagesCore}).
 */
export function resolveStartCursor(since?: string | null): string {
  const parsed = parseCursor(since);
  if ("fromNow" in parsed) {
    const d = getMessagesDelta(null, { fromNow: true }, 1);
    return encodeCursor(d.cursor ?? 0);
  }
  return since as string;
}

export interface WaitForMessagesOpts extends GetNewMessagesOpts {
  /** Max time to block server-side before returning (possibly empty). */
  timeoutMs: number;
  heartbeatMs?: number;
  onHeartbeat?: () => void;
}

/**
 * Block until a matching live message arrives or `timeoutMs` elapses, then
 * return the delta. Returns immediately if one already landed since `since`.
 * The bus is only a wake-up; the returned data always comes from the DB delta.
 */
export async function waitForMessagesCore(opts: WaitForMessagesOpts): Promise<NewMessagesResult> {
  // Pin the start cursor to a concrete rowid ONCE. If `since` is "from now", a
  // fresh high-water mark on every internal query would drift forward and drop a
  // message that lands mid-wait — so resolve it a single time up front.
  const since = resolveStartCursor(opts.since);
  const base: GetNewMessagesOpts = { ...opts, since };

  // Fast path: something already arrived.
  const immediate = getNewMessagesCore(base);
  if (immediate.messages.length > 0) return immediate;

  const includeFromMe = opts.includeFromMe ?? false;
  const chatJids = normalizeChatJids(opts.chatJids);
  const canonicalAllowed = chatJids ? new Set(chatJids.map(resolveCanonicalJid)) : null;

  const predicate = (m: InboundBusMessage): boolean => {
    if (wasSentByUs(m.id)) return false;
    if (m.is_from_me && !includeFromMe) return false;
    if (canonicalAllowed && !canonicalAllowed.has(resolveCanonicalJid(m.chat_jid))) return false;
    return true;
  };

  // Register the waiter (listener attaches synchronously), then re-query once to
  // close the lost-wakeup gap between the immediate check and registration: a
  // message persisted in that window is caught here; one persisted afterwards
  // fires the listener. Either way, no missed message.
  const ac = new AbortController();
  const waited = waitForInbound(predicate, opts.timeoutMs, {
    signal: ac.signal,
    heartbeatMs: opts.heartbeatMs,
    onHeartbeat: opts.onHeartbeat,
  });

  const gapCheck = getNewMessagesCore(base);
  if (gapCheck.messages.length > 0) {
    ac.abort();
    await waited;
    return gapCheck;
  }

  await waited; // resolves on match or timeout
  return getNewMessagesCore(base);
}
