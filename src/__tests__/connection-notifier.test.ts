import { beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { createConnectionNotifier } from "../connection-notifier.ts";
import type { NtfyMessage, SendNtfy } from "../ntfy.ts";

function makeFakeTimer() {
  let callback: (() => void) | null = null;
  let cancelled = false;
  const timer = {
    cancel: () => {
      cancelled = true;
      callback = null;
    },
  };
  const setTimer = vi.fn((cb: () => void, _ms: number) => {
    callback = cb;
    cancelled = false;
    return timer;
  });
  const fire = () => {
    if (!cancelled && callback) callback();
  };
  return { setTimer, fire, isCancelled: () => cancelled };
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

  it("pushes reconnect notification after a prior disconnect", async () => {
    const n = createConnectionNotifier(pino({ level: "silent" }), {
      sendNtfy,
      publicQrUrl: "https://wa.example/",
      expectedWaNumber: null,
    });
    await n.onDisconnected();
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

  it("disconnected → QR → connected cycle pushes: down, scan, reconnect", async () => {
    const t = makeFakeTimer();
    const n = createConnectionNotifier(pino({ level: "silent" }), {
      sendNtfy,
      publicQrUrl: "https://wa.example/",
      expectedWaNumber: null,
      setTimer: t.setTimer,
    });
    await n.onDisconnected();
    await n.onQrCode("qr", "a");
    await n.onConnected({ id: "5531@s", name: "Alice" });
    expect(sent.map((m) => m.title)).toEqual([
      expect.stringContaining("desconectado"),
      expect.stringContaining("Escaneie"),
      expect.stringContaining("reconectado"),
    ]);
  });
});
