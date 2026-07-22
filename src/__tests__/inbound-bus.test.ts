import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  emitInbound,
  type InboundBusMessage,
  listenerCount,
  resetInboundBus,
  waitForInbound,
} from "../inbound-bus.ts";

function msg(overrides: Partial<InboundBusMessage> = {}): InboundBusMessage {
  return { id: "m1", chat_jid: "chat@s.whatsapp.net", is_from_me: false, ...overrides };
}

describe("inbound-bus", () => {
  beforeEach(() => {
    resetInboundBus();
  });

  it("resolves true when a matching message is emitted", async () => {
    const p = waitForInbound(() => true, 1000);
    emitInbound(msg());
    await expect(p).resolves.toBe(true);
  });

  it("resolves false on timeout when nothing matches", async () => {
    vi.useFakeTimers();
    try {
      const p = waitForInbound(() => true, 5000);
      await vi.advanceTimersByTimeAsync(5000);
      await expect(p).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores messages the predicate rejects", async () => {
    vi.useFakeTimers();
    try {
      const p = waitForInbound((m) => m.chat_jid === "wanted@s.whatsapp.net", 5000);
      emitInbound(msg({ chat_jid: "other@s.whatsapp.net" }));
      await vi.advanceTimersByTimeAsync(5000);
      await expect(p).resolves.toBe(false); // never matched → timed out
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes its listener after a match (no leak)", async () => {
    const p = waitForInbound(() => true, 1000);
    expect(listenerCount()).toBe(1);
    emitInbound(msg());
    await p;
    expect(listenerCount()).toBe(0);
  });

  it("removes its listener after a timeout (no leak)", async () => {
    vi.useFakeTimers();
    try {
      const p = waitForInbound(() => true, 5000);
      expect(listenerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(5000);
      await p;
      expect(listenerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves false and cleans up when aborted", async () => {
    const ac = new AbortController();
    const p = waitForInbound(() => true, 10_000, { signal: ac.signal });
    expect(listenerCount()).toBe(1);
    ac.abort();
    await expect(p).resolves.toBe(false);
    expect(listenerCount()).toBe(0);
  });

  it("only the first matching waiter resolves per emit; others keep waiting", async () => {
    const first = waitForInbound((m) => m.id === "target", 1000);
    const second = waitForInbound((m) => m.id === "never", 1000);
    emitInbound(msg({ id: "target" }));
    await expect(first).resolves.toBe(true);
    expect(listenerCount()).toBe(1); // second is still registered
    resetInboundBus();
    await expect(second).resolves.toBe(false);
  });

  it("invokes the heartbeat while waiting", async () => {
    vi.useFakeTimers();
    try {
      const onHeartbeat = vi.fn();
      const p = waitForInbound(() => true, 5000, { heartbeatMs: 1000, onHeartbeat });
      await vi.advanceTimersByTimeAsync(3500);
      expect(onHeartbeat).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1500);
      await p;
    } finally {
      vi.useRealTimers();
    }
  });
});
