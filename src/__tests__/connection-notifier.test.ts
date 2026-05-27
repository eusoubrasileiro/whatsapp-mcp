import { beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { createConnectionNotifier } from "../connection-notifier.ts";
import { ConnectionFSM } from "../connection-fsm.ts";
import type { NtfyMessage, SendNtfy } from "../ntfy.ts";

function makeFakeTimer() {
  type Handle = { cb: () => void; ms: number; cancelled: boolean };
  const handles: Handle[] = [];

  const setTimer = vi.fn((cb: () => void, ms: number) => {
    const h: Handle = { cb, ms, cancelled: false };
    handles.push(h);
    return { cancel: () => { h.cancelled = true; } };
  });

  return {
    setTimer,
    handles,
    fire: (index?: number) => {
      const h = index !== undefined ? handles[index] : handles[handles.length - 1];
      if (h && !h.cancelled) h.cb();
    },
    isCancelled: (index?: number) => {
      const h = index !== undefined ? handles[index] : handles[handles.length - 1];
      return h?.cancelled ?? true;
    },
  };
}

describe("createConnectionNotifier", () => {
  let sent: NtfyMessage[];
  let sendNtfy: SendNtfy;

  beforeEach(() => {
    sent = [];
    sendNtfy = async (msg) => {
      sent.push(msg);
    };
  });

  it("pushes on first QR and arms a reminder timer", async () => {
    const t = makeFakeTimer();
    const n = createConnectionNotifier(pino({ level: "silent" }), {
      sendNtfy,
      publicQrUrl: "https://wa.example/",
      expectedWaNumber: null,
      setTimer: t.setTimer,
    });

    await n.onQrCode("qr", "ascii");
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toContain("Escaneie");
    expect(sent[0].click).toBe("https://wa.example/");
    expect(t.setTimer).toHaveBeenCalledTimes(1);
  });

  it("does not re-push on subsequent QR re-emissions (same phase)", async () => {
    const t = makeFakeTimer();
    const n = createConnectionNotifier(pino({ level: "silent" }), {
      sendNtfy,
      publicQrUrl: "https://wa.example/",
      expectedWaNumber: null,
      setTimer: t.setTimer,
    });
    await n.onQrCode("qr1", "a");
    await n.onQrCode("qr2", "a");
    await n.onQrCode("qr3", "a");
    expect(sent).toHaveLength(1);
  });

  it("reminder timer firing pushes a reminder and re-arms", async () => {
    const t = makeFakeTimer();
    const n = createConnectionNotifier(pino({ level: "silent" }), {
      sendNtfy,
      publicQrUrl: "https://wa.example/",
      expectedWaNumber: null,
      setTimer: t.setTimer,
    });
    await n.onQrCode("qr", "a");
    t.fire();
    // Allow microtasks to settle so the async sendNtfy completes
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(2);
    expect(sent[1].title).toContain("aguardando");
    expect(t.setTimer).toHaveBeenCalledTimes(2);
  });

  it("cancels reminder on connecting", async () => {
    const t = makeFakeTimer();
    const n = createConnectionNotifier(pino({ level: "silent" }), {
      sendNtfy,
      publicQrUrl: "https://wa.example/",
      expectedWaNumber: null,
      setTimer: t.setTimer,
    });
    await n.onQrCode("qr", "a");
    n.onConnecting();
    expect(t.isCancelled()).toBe(true);
    t.fire();
    expect(sent).toHaveLength(1);
  });

  it("no reconnect notification on first-ever connect (no prior disconnect)", async () => {
    const n = createConnectionNotifier(pino({ level: "silent" }), {
      sendNtfy,
      publicQrUrl: "https://wa.example/",
      expectedWaNumber: null,
    });
    await n.onConnected({ id: "5531@s", name: "Alice" });
    expect(sent).toHaveLength(0);
  });

  it("pushes reconnect notification after grace expires and reconnect", async () => {
    const t = makeFakeTimer();
    const n = createConnectionNotifier(pino({ level: "silent" }), {
      sendNtfy,
      publicQrUrl: "https://wa.example/",
      expectedWaNumber: null,
      setTimer: t.setTimer,
    });
    await n.onDisconnected();
    expect(sent).toHaveLength(0);
    t.fire();
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toContain("desconectado");
    await n.onConnected({ id: "5531@s", name: "Alice" });
    expect(sent).toHaveLength(2);
    expect(sent[1].title).toContain("reconectado");
  });

  it("rejects pairing when expectedWaNumber mismatches, pushes alert, calls onBadPairing", async () => {
    const onBadPairing = vi.fn(async () => {});
    const n = createConnectionNotifier(pino({ level: "silent" }), {
      sendNtfy,
      publicQrUrl: "https://wa.example/",
      expectedWaNumber: "5531",
      onBadPairing,
    });
    await n.onConnected({ id: "5599@s", name: "Stranger" });
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toContain("indevido");
    expect(sent[0].priority).toBe(5);
    expect(onBadPairing).toHaveBeenCalledOnce();
  });

  it("accepts pairing when expectedWaNumber matches", async () => {
    const onBadPairing = vi.fn();
    const n = createConnectionNotifier(pino({ level: "silent" }), {
      sendNtfy,
      publicQrUrl: "https://wa.example/",
      expectedWaNumber: "5531",
      onBadPairing,
    });
    await n.onConnected({ id: "5531999@s", name: "Alice" });
    expect(sent).toHaveLength(0);
    expect(onBadPairing).not.toHaveBeenCalled();
  });

  it("disconnected → QR within grace flushes disconnect, then QR, then reconnect", async () => {
    const t = makeFakeTimer();
    const n = createConnectionNotifier(pino({ level: "silent" }), {
      sendNtfy,
      publicQrUrl: "https://wa.example/",
      expectedWaNumber: null,
      setTimer: t.setTimer,
    });
    await n.onDisconnected();
    expect(sent).toHaveLength(0);
    await n.onQrCode("qr", "a");
    expect(sent.map((m) => m.title)).toEqual([
      expect.stringContaining("desconectado"),
      expect.stringContaining("Escaneie"),
    ]);
    await n.onConnected({ id: "5531@s", name: "Alice" });
    expect(sent[2].title).toContain("reconectado");
  });

  describe("disconnect grace period", () => {
    it("suppresses both notifications on quick reconnect within grace", async () => {
      const t = makeFakeTimer();
      const n = createConnectionNotifier(pino({ level: "silent" }), {
        sendNtfy,
        publicQrUrl: "https://wa.example/",
        expectedWaNumber: null,
        setTimer: t.setTimer,
      });
      await n.onDisconnected();
      expect(sent).toHaveLength(0);
      await n.onConnected({ id: "5531@s", name: "Alice" });
      expect(sent).toHaveLength(0);
    });

    it("fires disconnect notification only after grace expires", async () => {
      const t = makeFakeTimer();
      const n = createConnectionNotifier(pino({ level: "silent" }), {
        sendNtfy,
        publicQrUrl: "https://wa.example/",
        expectedWaNumber: null,
        setTimer: t.setTimer,
      });
      await n.onDisconnected();
      expect(sent).toHaveLength(0);
      t.fire();
      await new Promise((r) => setImmediate(r));
      expect(sent).toHaveLength(1);
      expect(sent[0].title).toContain("desconectado");
    });

    it("uses default 120s grace period", async () => {
      const t = makeFakeTimer();
      const n = createConnectionNotifier(pino({ level: "silent" }), {
        sendNtfy,
        publicQrUrl: "https://wa.example/",
        expectedWaNumber: null,
        setTimer: t.setTimer,
      });
      await n.onDisconnected();
      expect(t.setTimer).toHaveBeenLastCalledWith(expect.any(Function), 120_000);
    });

    it("respects custom disconnectGraceMs", async () => {
      const t = makeFakeTimer();
      const n = createConnectionNotifier(pino({ level: "silent" }), {
        sendNtfy,
        publicQrUrl: "https://wa.example/",
        expectedWaNumber: null,
        disconnectGraceMs: 30_000,
        setTimer: t.setTimer,
      });
      await n.onDisconnected();
      expect(t.setTimer).toHaveBeenLastCalledWith(expect.any(Function), 30_000);
    });

    it("resets grace timer on multiple disconnects", async () => {
      const t = makeFakeTimer();
      const n = createConnectionNotifier(pino({ level: "silent" }), {
        sendNtfy,
        publicQrUrl: "https://wa.example/",
        expectedWaNumber: null,
        setTimer: t.setTimer,
      });
      await n.onDisconnected();
      const firstGraceIdx = t.handles.length - 1;
      await n.onDisconnected();
      expect(t.isCancelled(firstGraceIdx)).toBe(true);
      expect(t.isCancelled()).toBe(false);
    });

    it("still fires bad-pairing alert on quick reconnect with wrong number", async () => {
      const t = makeFakeTimer();
      const onBadPairing = vi.fn(async () => {});
      const n = createConnectionNotifier(pino({ level: "silent" }), {
        sendNtfy,
        publicQrUrl: "https://wa.example/",
        expectedWaNumber: "5531",
        onBadPairing,
        setTimer: t.setTimer,
      });
      await n.onDisconnected();
      await n.onConnected({ id: "5599@s", name: "Stranger" });
      expect(sent).toHaveLength(1);
      expect(sent[0].title).toContain("indevido");
      expect(onBadPairing).toHaveBeenCalledOnce();
    });
  });
});

describe("ConnectionFSM (explicit state machine)", () => {
  let sent: NtfyMessage[];
  let sendNtfy: SendNtfy;

  beforeEach(() => {
    sent = [];
    sendNtfy = async (msg) => {
      sent.push(msg);
    };
  });

  it("starts in idle phase", () => {
    const t = makeFakeTimer();
    const fsm = new ConnectionFSM(pino({ level: "silent" }), {
      sendNtfy,
      publicQrUrl: "https://wa.example/",
      expectedWaNumber: null,
      setTimer: t.setTimer,
    });
    expect(fsm.phase).toBe("idle");
  });

  it("transitions idle → qr_pending on qrCode event", async () => {
    const t = makeFakeTimer();
    const fsm = new ConnectionFSM(pino({ level: "silent" }), {
      sendNtfy,
      publicQrUrl: "https://wa.example/",
      expectedWaNumber: null,
      setTimer: t.setTimer,
    });
    await fsm.handle({ type: "qrCode" });
    expect(fsm.phase).toBe("qr_pending");
  });

  it("transitions qr_pending → connecting on connecting event", async () => {
    const t = makeFakeTimer();
    const fsm = new ConnectionFSM(pino({ level: "silent" }), {
      sendNtfy,
      publicQrUrl: "https://wa.example/",
      expectedWaNumber: null,
      setTimer: t.setTimer,
    });
    await fsm.handle({ type: "qrCode" });
    await fsm.handle({ type: "connecting" });
    expect(fsm.phase).toBe("connecting");
  });

  it("transitions to connected on connected event", async () => {
    const t = makeFakeTimer();
    const fsm = new ConnectionFSM(pino({ level: "silent" }), {
      sendNtfy,
      publicQrUrl: "https://wa.example/",
      expectedWaNumber: null,
      setTimer: t.setTimer,
    });
    await fsm.handle({ type: "connected", user: { id: "5531@s", name: "Alice" } });
    expect(fsm.phase).toBe("connected");
  });

  it("transitions to disconnected on disconnected event", async () => {
    const t = makeFakeTimer();
    const fsm = new ConnectionFSM(pino({ level: "silent" }), {
      sendNtfy,
      publicQrUrl: "https://wa.example/",
      expectedWaNumber: null,
      setTimer: t.setTimer,
    });
    await fsm.handle({ type: "disconnected" });
    expect(fsm.phase).toBe("disconnected");
  });

  it("idle → connected fires no notification (first-ever connect)", async () => {
    const t = makeFakeTimer();
    const fsm = new ConnectionFSM(pino({ level: "silent" }), {
      sendNtfy,
      publicQrUrl: "https://wa.example/",
      expectedWaNumber: null,
      setTimer: t.setTimer,
    });
    await fsm.handle({ type: "connected", user: { id: "5531@s", name: "Alice" } });
    expect(sent).toHaveLength(0);
  });

  it("qr_pending → connected fires no reconnect notification (initial pairing)", async () => {
    const t = makeFakeTimer();
    const fsm = new ConnectionFSM(pino({ level: "silent" }), {
      sendNtfy,
      publicQrUrl: "https://wa.example/",
      expectedWaNumber: null,
      setTimer: t.setTimer,
    });
    await fsm.handle({ type: "qrCode" });
    expect(sent).toHaveLength(1); // QR push
    await fsm.handle({ type: "connected", user: { id: "5531@s", name: "Alice" } });
    expect(sent).toHaveLength(1); // no reconnect, just QR
  });

  it("disconnected (grace fires) → connected fires reconnected notification", async () => {
    const t = makeFakeTimer();
    const fsm = new ConnectionFSM(pino({ level: "silent" }), {
      sendNtfy,
      publicQrUrl: "https://wa.example/",
      expectedWaNumber: null,
      setTimer: t.setTimer,
    });
    await fsm.handle({ type: "disconnected" });
    t.fire();
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(1);
    await fsm.handle({ type: "connected", user: { id: "5531@s", name: "Alice" } });
    expect(sent).toHaveLength(2);
    expect(sent[1].title).toContain("reconectado");
    expect(fsm.phase).toBe("connected");
  });

  it("disconnected → connected within grace stays silent (both suppressed)", async () => {
    const t = makeFakeTimer();
    const fsm = new ConnectionFSM(pino({ level: "silent" }), {
      sendNtfy,
      publicQrUrl: "https://wa.example/",
      expectedWaNumber: null,
      setTimer: t.setTimer,
    });
    await fsm.handle({ type: "disconnected" });
    await fsm.handle({ type: "connected", user: { id: "5531@s", name: "Alice" } });
    expect(sent).toHaveLength(0);
    expect(fsm.phase).toBe("connected");
  });

  it("re-fires qrCode in qr_pending phase is idempotent (no extra ntfy, no new timer)", async () => {
    const t = makeFakeTimer();
    const fsm = new ConnectionFSM(pino({ level: "silent" }), {
      sendNtfy,
      publicQrUrl: "https://wa.example/",
      expectedWaNumber: null,
      setTimer: t.setTimer,
    });
    await fsm.handle({ type: "qrCode" });
    await fsm.handle({ type: "qrCode" });
    await fsm.handle({ type: "qrCode" });
    expect(sent).toHaveLength(1);
    expect(t.setTimer).toHaveBeenCalledTimes(1);
    expect(fsm.phase).toBe("qr_pending");
  });

  it("bad pairing transitions to disconnected and fires alert", async () => {
    const t = makeFakeTimer();
    const onBadPairing = vi.fn(async () => {});
    const fsm = new ConnectionFSM(pino({ level: "silent" }), {
      sendNtfy,
      publicQrUrl: "https://wa.example/",
      expectedWaNumber: "5531",
      onBadPairing,
      setTimer: t.setTimer,
    });
    await fsm.handle({ type: "connected", user: { id: "5599@s", name: "Stranger" } });
    expect(fsm.phase).toBe("disconnected");
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toContain("indevido");
    expect(onBadPairing).toHaveBeenCalledOnce();
  });

  it("connecting event in qr_pending phase cancels reminder", async () => {
    const t = makeFakeTimer();
    const fsm = new ConnectionFSM(pino({ level: "silent" }), {
      sendNtfy,
      publicQrUrl: "https://wa.example/",
      expectedWaNumber: null,
      setTimer: t.setTimer,
    });
    await fsm.handle({ type: "qrCode" });
    expect(t.isCancelled()).toBe(false);
    await fsm.handle({ type: "connecting" });
    expect(t.isCancelled()).toBe(true);
    expect(fsm.phase).toBe("connecting");
  });

  it("qrCode arriving in disconnected phase (within grace) flushes disconnect first", async () => {
    const t = makeFakeTimer();
    const fsm = new ConnectionFSM(pino({ level: "silent" }), {
      sendNtfy,
      publicQrUrl: "https://wa.example/",
      expectedWaNumber: null,
      setTimer: t.setTimer,
    });
    await fsm.handle({ type: "disconnected" });
    await fsm.handle({ type: "qrCode" });
    expect(sent.map((m) => m.title)).toEqual([
      expect.stringContaining("desconectado"),
      expect.stringContaining("Escaneie"),
    ]);
    expect(fsm.phase).toBe("qr_pending");
  });
});
