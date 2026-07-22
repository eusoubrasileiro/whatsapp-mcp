/**
 * In-process bus for server-side rejections of our own sends.
 *
 * `socket.sendMessage()` resolves when the stanza is written; a rejection
 * arrives later on `messages.update` (see `ack-errors.ts`). Historically that
 * was logged and nothing more — so `send_message` reported success for a
 * message that never landed, and the agent had no way to find out. This bus
 * lets the send path block briefly and report the truth.
 *
 * **The ring buffer is not an optimisation — it is the correctness mechanism.**
 * A waiter can only register *after* `sendMessage()` returns the message id,
 * but the rejection lands ~40 ms behind the send (measured 2026-07-22:
 * 19:13:40.525 stored → 19:13:40.565 rejected, three for three). Listener-only
 * delivery would therefore lose the race about as often as it won it. Every
 * error is buffered first, and `waitForAckError` checks the buffer *before*
 * registering — the same lost-wakeup shape as `gapCheck` in `monitoring.ts`.
 */

import { EventEmitter } from "node:events";

import type { AckError } from "./ack-errors.ts";

const EVENT = "ack-error";
const emitter = new EventEmitter();
// Waiter lifecycle is managed here, not by the warning cap; concurrent sends
// must not emit MaxListenersExceededWarning.
emitter.setMaxListeners(0);

/**
 * Bounded recent-rejection buffer. Sized well above any plausible burst of
 * concurrent sends while staying trivially small in memory — this process is
 * long-lived, so an unbounded buffer would be a slow leak.
 */
const RECENT_LIMIT = 200;
const recent: AckError[] = [];

/** Record a rejection and wake any waiter for it. Never throws. */
export function emitAckError(error: AckError): void {
  recent.push(error);
  if (recent.length > RECENT_LIMIT) recent.shift();
  emitter.emit(EVENT, error);
}

/**
 * Remove and return a buffered rejection for `msgId`.
 *
 * Consuming (rather than peeking) keeps a single rejection from being reported
 * against two different waits.
 */
function takeBuffered(msgId: string): AckError | null {
  const index = recent.findIndex((e) => e.msgId === msgId);
  if (index === -1) return null;
  const [error] = recent.splice(index, 1);
  return error ?? null;
}

/** Number of active waiters — test/observability helper. */
export function ackListenerCount(): number {
  return emitter.listenerCount(EVENT);
}

/** Test helper: drop every waiter and clear the buffer. */
export function resetAckBus(): void {
  emitter.removeAllListeners(EVENT);
  recent.length = 0;
}

/**
 * Resolve with the rejection for `msgId`, or `null` if none arrives within
 * `timeoutMs`. A non-positive timeout checks the buffer without waiting.
 * Always removes its listener and clears its timer.
 */
export function waitForAckError(msgId: string, timeoutMs: number): Promise<AckError | null> {
  // Buffer first: the rejection may already have landed while sendMessage()
  // was still resolving.
  const buffered = takeBuffered(msgId);
  if (buffered) return Promise.resolve(buffered);
  if (timeoutMs <= 0) return Promise.resolve(null);

  return new Promise<AckError | null>((resolve) => {
    let settled = false;

    const finish = (error: AckError | null): void => {
      if (settled) return;
      settled = true;
      emitter.off(EVENT, listener);
      clearTimeout(timer);
      resolve(error);
    };

    const listener = (error: AckError): void => {
      if (error.msgId === msgId) {
        // Drop it from the buffer too — this wait is reporting it.
        takeBuffered(msgId);
        finish(error);
      }
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    emitter.on(EVENT, listener);
  });
}
