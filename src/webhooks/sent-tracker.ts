/**
 * Loop guard for the talk-to-yourself pattern.
 *
 * When a subscription has `include_from_me`, we forward the user's own messages
 * (so the agent sees what you type in a self-chat). But the agent's *replies* — sent
 * through this MCP — are also `is_from_me` and echo back via messages.upsert. If
 * we forwarded those, the agent would react to its own reply forever. So every
 * message this MCP sends is recorded here, and dispatch skips any upsert whose
 * id we recognise as our own send.
 *
 * Bounded ring (no timers): once an id has echoed back through onMessageUpsert
 * it's never needed again, and the cap keeps memory flat under load.
 */

const MAX_TRACKED = 1000;
const sent = new Set<string>();
const order: string[] = [];

/** Record a message id this MCP just sent, so its echo is never forwarded. */
export function markSentByUs(id: string | null | undefined): void {
  if (!id) return;
  if (sent.has(id)) return;
  sent.add(id);
  order.push(id);
  if (order.length > MAX_TRACKED) {
    const evicted = order.shift();
    if (evicted !== undefined) sent.delete(evicted);
  }
}

/** True if `id` was sent by this MCP (i.e. an agent reply echoing back). */
export function wasSentByUs(id: string | null | undefined): boolean {
  return id ? sent.has(id) : false;
}

/** Test helper: clear the tracker. */
export function resetSentTracker(): void {
  sent.clear();
  order.length = 0;
}
