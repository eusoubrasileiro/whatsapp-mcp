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

import { getMessagesSince, resolveCanonicalJid, type Message } from "./database.ts";
import { wasSentByUs } from "./webhooks/sent-tracker.ts";
import { waitForInbound, type InboundBusMessage } from "./inbound-bus.ts";

export interface GetNewMessagesOpts {
  /** Chats to watch. Omit, empty, or `["*"]` = all chats. */
  chatJids?: string[] | null;
  /** ISO cursor; inclusive `gte`. Omitted → "from now" (fresh high-water mark). */
  since?: string | null;
  limit?: number;
  /** Include your own (`is_from_me`) messages. Default false. */
  includeFromMe?: boolean;
}

export interface NewMessagesResult {
  messages: Message[];
  /** Cursor for the next call: newest fetched timestamp, or `since` if none. */
  next_since: string;
}

/** `["*"]`, empty, or null → null (all chats); otherwise the list as given. */
function normalizeChatJids(chatJids?: string[] | null): string[] | null {
  if (!chatJids || chatJids.length === 0) return null;
  if (chatJids.includes("*")) return null;
  return chatJids;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * One delta read: messages since `since`, loop-guarded and direction-filtered.
 * `next_since` advances past every *fetched* row (even filtered-out ones) so the
 * cursor never stalls on a burst of your own messages.
 */
export function getNewMessagesCore(opts: GetNewMessagesOpts): NewMessagesResult {
  const since = opts.since ?? nowIso();
  const limit = opts.limit ?? 50;
  const includeFromMe = opts.includeFromMe ?? false;
  const chatJids = normalizeChatJids(opts.chatJids);

  const raw = getMessagesSince(chatJids, since, limit);

  const messages = raw.filter((m) => {
    if (wasSentByUs(m.id)) return false; // our own send echoing back
    if (m.is_from_me && !includeFromMe) return false; // direction filter
    return true;
  });

  const next_since = raw.length
    ? raw[raw.length - 1].timestamp.toISOString()
    : since;

  return { messages, next_since };
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
  const since = opts.since ?? nowIso();
  const base: GetNewMessagesOpts = { ...opts, since };

  // Fast path: something already arrived.
  const immediate = getNewMessagesCore(base);
  if (immediate.messages.length > 0) return immediate;

  const includeFromMe = opts.includeFromMe ?? false;
  const chatJids = normalizeChatJids(opts.chatJids);
  const canonicalAllowed = chatJids
    ? new Set(chatJids.map(resolveCanonicalJid))
    : null;

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
