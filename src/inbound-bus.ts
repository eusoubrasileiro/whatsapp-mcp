/**
 * In-process inbound-message event bus.
 *
 * The MCP is otherwise poll-only. This bus lets a long-poll tool
 * (`wait_for_messages`) block until a live inbound message arrives, instead of
 * the agent re-scanning on a timer. `emitInbound` is fired once per live
 * message from `whatsapp.ts` (the `type === "notify"` branch, right after the
 * row is persisted — so a woken waiter that re-queries the DB always sees it).
 *
 * The payload is intentionally minimal: just enough for a waiter's predicate to
 * decide "is this for me?". The authoritative read is the DB delta the waiter
 * runs after waking — the bus is only a wake-up signal, never the source of
 * truth.
 *
 * Cleanup is owned here, not by `EventEmitter`'s warning cap: every waiter
 * removes its listener and clears its timer on resolve, timeout, or abort, so a
 * flood of concurrent or abandoned waiters never leaks.
 */

import { EventEmitter } from "node:events";

export interface InboundBusMessage {
  id: string;
  chat_jid: string;
  is_from_me: boolean;
}

const EVENT = "inbound";
const emitter = new EventEmitter();
// We manage listener lifecycle ourselves; disable the 10-listener warning cap
// so many concurrent waiters don't emit spurious MaxListenersExceededWarning.
emitter.setMaxListeners(0);

/** Fire a live inbound message at all registered waiters. Never throws. */
export function emitInbound(msg: InboundBusMessage): void {
  emitter.emit(EVENT, msg);
}

/**
 * Register a long-lived listener fired on every live inbound message. Unlike
 * {@link waitForInbound} (one-shot), this stays attached until the returned
 * unsubscribe is called — the `follow_chat` stream keeps one per open socket.
 * The listener must never throw; it is called inside `emit`.
 */
export function subscribeInbound(listener: (msg: InboundBusMessage) => void): () => void {
  emitter.on(EVENT, listener);
  return () => emitter.off(EVENT, listener);
}

/** Number of active waiters — test/observability helper. */
export function listenerCount(): number {
  return emitter.listenerCount(EVENT);
}

/** Test helper: drop every waiter. */
export function resetInboundBus(): void {
  emitter.removeAllListeners(EVENT);
}

export interface WaitForInboundOpts {
  /** Abort the wait early (resolves `false`); used to close lost-wakeup races. */
  signal?: AbortSignal;
  /** Invoke `onHeartbeat` every `heartbeatMs` while waiting. */
  heartbeatMs?: number;
  onHeartbeat?: () => void;
}

/**
 * Resolve `true` when a message satisfying `predicate` is emitted, or `false`
 * when `timeoutMs` elapses (or the optional signal aborts). Always removes its
 * listener and clears its timers — no leaks regardless of outcome.
 */
export function waitForInbound(
  predicate: (msg: InboundBusMessage) => boolean,
  timeoutMs: number,
  opts: WaitForInboundOpts = {},
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    const finish = (matched: boolean): void => {
      if (settled) return;
      settled = true;
      emitter.off(EVENT, listener);
      clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      resolve(matched);
    };

    const listener = (msg: InboundBusMessage): void => {
      try {
        if (predicate(msg)) finish(true);
      } catch {
        // A faulty predicate must never break the bus for other waiters.
      }
    };

    const onAbort = (): void => finish(false);

    const timer = setTimeout(() => finish(false), timeoutMs);
    emitter.on(EVENT, listener);

    if (opts.signal) {
      if (opts.signal.aborted) return finish(false);
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    if (opts.heartbeatMs && opts.onHeartbeat) {
      heartbeat = setInterval(() => {
        try {
          opts.onHeartbeat!();
        } catch {
          // ignore heartbeat sink errors
        }
      }, opts.heartbeatMs);
    }
  });
}
