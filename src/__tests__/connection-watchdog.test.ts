import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConnectionStatus } from "@amiticia/baileys-client";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionWatchdog, readWatchdogEnv } from "../connection-watchdog.ts";
import type { NtfyMessage } from "../ntfy.ts";
import { createFileWatchdogStore, type WatchdogStore } from "../watchdog-store.ts";

const T0 = 1_700_000_000_000;
const SAMPLE_MS = 30_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

function memoryStore(restarts: number[] = []): WatchdogStore {
  let current = { restarts, awaitingRecovery: false };
  return {
    load: () => ({ ...current, restarts: [...current.restarts] }),
    save: (state) => {
      current = { ...state, restarts: [...state.restarts] };
    },
  };
}

type FakeTimer = { cb: () => void; ms: number; cancelled: boolean };

/**
 * Drives a ConnectionWatchdog with a manual clock, a manual timer list and a
 * recorded ntfy/exit, so no test sleeps or exits the runner.
 */
function makeHarness(
  options: {
    status?: ConnectionStatus;
    restartAfterS?: number;
    maxRestarts?: number;
    store?: WatchdogStore;
    /** Epoch ms the "process" boots at. Defaults to T0. */
    bootAt?: number;
    sendNtfy?: (msg: NtfyMessage) => Promise<void>;
  } = {},
) {
  let clock = options.bootAt ?? T0;
  let status: ConnectionStatus = options.status ?? "connecting";
  let failNextRead = false;
  const events: string[] = [];
  const pushes: NtfyMessage[] = [];
  const timers: FakeTimer[] = [];
  const exit = vi.fn((code: number) => {
    events.push(`exit(${code})`);
  });
  const sendNtfy =
    options.sendNtfy ??
    (async (msg: NtfyMessage) => {
      events.push("ntfy");
      pushes.push(msg);
    });

  const watchdog = new ConnectionWatchdog(pino({ level: "silent" }), {
    getState: () => {
      if (failNextRead) {
        failNextRead = false;
        throw new Error("state read failed");
      }
      return { status };
    },
    sendNtfy,
    publicQrUrl: "https://wa.example.com/",
    exit,
    restartAfterS: options.restartAfterS ?? 600,
    maxRestarts: options.maxRestarts ?? 3,
    store: options.store ?? memoryStore(),
    now: () => clock,
    setTimer: (cb, ms) => {
      const timer: FakeTimer = { cb, ms, cancelled: false };
      timers.push(timer);
      return {
        cancel: () => {
          timer.cancelled = true;
        },
      };
    },
  });

  return {
    watchdog,
    exit,
    events,
    pushes,
    timers,
    setStatus: (s: ConnectionStatus) => {
      status = s;
    },
    failNextStateRead: () => {
      failNextRead = true;
    },
    clock: () => clock,
    /** Advance the clock in 30 s samples, ticking at each step like the real interval. */
    async runFor(ms: number): Promise<void> {
      for (let elapsed = 0; elapsed < ms; elapsed += SAMPLE_MS) {
        clock += SAMPLE_MS;
        await watchdog.tick();
      }
    },
  };
}

describe("ConnectionWatchdog restart", () => {
  it("does nothing while the socket stays connected", async () => {
    const h = makeHarness({ status: "connected" });
    await h.runFor(24 * 3600 * 1000);
    expect(h.exit).not.toHaveBeenCalled();
    expect(h.pushes).toHaveLength(0);
  });

  it("sends one priority-5 ntfy and then exit(1) after 600 s in connecting", async () => {
    const h = makeHarness({ status: "connecting" });

    await h.runFor(570_000);
    expect(h.exit).not.toHaveBeenCalled();
    expect(h.pushes).toHaveLength(0);

    await h.runFor(SAMPLE_MS);
    expect(h.pushes).toHaveLength(1);
    expect(h.pushes[0].priority).toBe(5);
    expect(h.pushes[0].message).toContain("10 min");
    expect(h.pushes[0].message).toContain("reiniciando");
    expect(h.exit).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledWith(1);
    // the alert goes out BEFORE the process dies
    expect(h.events).toEqual(["ntfy", "exit(1)"]);
  });

  it("does not exit or push twice if ticks keep arriving after the exit", async () => {
    const h = makeHarness({ status: "connecting" });
    await h.runFor(1800_000);
    expect(h.exit).toHaveBeenCalledTimes(1);
    expect(h.pushes).toHaveLength(1);
  });

  it("restarts from a disconnected socket too, not only connecting", async () => {
    const h = makeHarness({ status: "disconnected" });
    await h.runFor(600_000);
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it("never exits and never pushes while a QR scan is pending, however long", async () => {
    // A restart would destroy the QR code the operator is looking at.
    const h = makeHarness({ status: "qr_pending" });
    await h.runFor(48 * 3600 * 1000);
    expect(h.exit).not.toHaveBeenCalled();
    expect(h.pushes).toHaveLength(0);
  });

  it("starts the clock only after pairing moves on from qr_pending", async () => {
    const h = makeHarness({ status: "qr_pending" });
    await h.runFor(12 * 3600 * 1000);

    h.setStatus("connecting");
    await h.runFor(570_000);
    expect(h.exit).not.toHaveBeenCalled();
    await h.runFor(SAMPLE_MS);
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it("accumulates downtime across a connecting/disconnected flapping loop", async () => {
    // The 2026-07-28 outage flapped; if "connecting" reset the clock the wedge
    // would never reach the threshold.
    const h = makeHarness({ status: "connecting" });
    for (let i = 0; i < 9; i++) {
      h.setStatus(i % 2 === 0 ? "disconnected" : "connecting");
      await h.runFor(60_000);
    }
    expect(h.exit).not.toHaveBeenCalled();
    h.setStatus("connecting");
    await h.runFor(60_000);
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it("resets the downtime clock whenever the socket is live or syncing", async () => {
    const h = makeHarness({ status: "connecting" });
    await h.runFor(540_000);

    h.setStatus("syncing");
    await h.runFor(SAMPLE_MS);
    h.setStatus("connected");
    await h.runFor(SAMPLE_MS);

    h.setStatus("connecting");
    await h.runFor(540_000);
    expect(h.exit).not.toHaveBeenCalled();
  });

  it("waits for the ntfy push to finish before exiting", async () => {
    let pushStarted = false;
    let finishPush: () => void = () => {};
    const h = makeHarness({
      status: "connecting",
      sendNtfy: () =>
        new Promise<void>((resolve) => {
          pushStarted = true;
          finishPush = resolve;
        }),
    });
    await h.runFor(570_000);

    const ticking = h.runFor(SAMPLE_MS);
    await vi.waitFor(() => expect(pushStarted).toBe(true));
    expect(h.exit).not.toHaveBeenCalled();

    finishPush();
    await ticking;
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it("exits anyway when the ntfy push hangs past its short timeout", async () => {
    const h = makeHarness({
      status: "connecting",
      sendNtfy: () => new Promise<void>(() => {}),
    });
    await h.runFor(570_000);

    const ticking = h.runFor(SAMPLE_MS);
    await vi.waitFor(() =>
      expect(
        h.timers.some((t) => t.ms <= 30_000 && !t.cancelled),
        "a bounded wait on the ntfy push",
      ).toBe(true),
    );
    expect(h.exit).not.toHaveBeenCalled();

    h.timers.find((t) => t.ms <= 30_000 && !t.cancelled)?.cb();
    await ticking;
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it("exits even when the ntfy sender rejects", async () => {
    const h = makeHarness({
      status: "connecting",
      sendNtfy: async () => {
        throw new Error("ntfy down");
      },
    });
    await h.runFor(600_000);
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it("survives a failing state read and keeps sampling afterwards", async () => {
    const h = makeHarness({ status: "connecting" });
    h.failNextStateRead();

    await expect(h.watchdog.tick()).resolves.toBeUndefined();

    await h.runFor(600_000);
    expect(h.exit).toHaveBeenCalledWith(1);
  });
});

describe("ConnectionWatchdog scheduling", () => {
  it("samples on its own 30 s timer, independent of /health being polled", async () => {
    const h = makeHarness({ status: "connecting" });
    h.watchdog.start();

    expect(h.timers).toHaveLength(1);
    expect(h.timers[0].ms).toBe(30_000);

    // firing the timer runs one sample and re-arms the next
    h.timers[0].cb();
    await vi.waitFor(() => expect(h.timers).toHaveLength(2));
    expect(h.timers[1].ms).toBe(30_000);
  });

  it("stop() cancels the pending sample", () => {
    const h = makeHarness({ status: "connecting" });
    h.watchdog.start();
    h.watchdog.stop();
    expect(h.timers[0].cancelled).toBe(true);
  });

  it("is disabled by restartAfterS=0: arms no timer, never exits or pushes", async () => {
    const h = makeHarness({ status: "connecting", restartAfterS: 0 });
    h.watchdog.start();
    expect(h.timers).toHaveLength(0);

    await h.runFor(7 * 24 * 3600 * 1000);
    expect(h.exit).not.toHaveBeenCalled();
    expect(h.pushes).toHaveLength(0);
  });
});

describe("readWatchdogEnv", () => {
  it("defaults to restarting after 600 s and at most 3 restarts", () => {
    expect(readWatchdogEnv({})).toEqual({ restartAfterS: 600, maxRestarts: 3 });
  });

  it("reads explicit values, including 0 as the restart kill switch", () => {
    expect(readWatchdogEnv({ WATCHDOG_RESTART_AFTER_S: "0", WATCHDOG_MAX_RESTARTS: "5" })).toEqual({
      restartAfterS: 0,
      maxRestarts: 5,
    });
    expect(readWatchdogEnv({ WATCHDOG_RESTART_AFTER_S: "900" })).toMatchObject({
      restartAfterS: 900,
    });
  });

  it("reads a malformed value as the default, never as disabled", () => {
    expect(
      readWatchdogEnv({ WATCHDOG_RESTART_AFTER_S: "banana", WATCHDOG_MAX_RESTARTS: "-2" }),
    ).toEqual({ restartAfterS: 600, maxRestarts: 3 });
    expect(readWatchdogEnv({ WATCHDOG_RESTART_AFTER_S: "-5" })).toMatchObject({
      restartAfterS: 600,
    });
    expect(readWatchdogEnv({ WATCHDOG_RESTART_AFTER_S: "" })).toMatchObject({
      restartAfterS: 600,
    });
  });
});

describe("ConnectionWatchdog restart cap", () => {
  let dir: string;
  let file: string;
  const logger = pino({ level: "silent" });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-cap-"));
    file = path.join(dir, "watchdog-state.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A fresh "process": new watchdog, new store instance reading the same file. */
  function boot(bootAt: number, extra: { maxRestarts?: number } = {}) {
    return makeHarness({
      status: "connecting",
      bootAt,
      store: createFileWatchdogStore(file, logger),
      ...extra,
    });
  }

  it("records each self-restart in the persisted state before exiting", async () => {
    const h = boot(T0);
    await h.runFor(600_000);
    expect(h.exit).toHaveBeenCalledWith(1);

    const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as { restarts: number[] };
    expect(onDisk.restarts).toEqual([h.clock()]);
  });

  it("allows 3 restarts per 6 h across process restarts, then stops exiting", async () => {
    let bootAt = T0;
    for (let i = 1; i <= 3; i++) {
      const h = boot(bootAt);
      await h.runFor(600_000);
      expect(h.exit, `restart #${i}`).toHaveBeenCalledWith(1);
      bootAt = h.clock() + 60_000; // the container comes back about a minute later
    }

    const capped = boot(bootAt);
    await capped.runFor(2 * HOUR);
    expect(capped.exit).not.toHaveBeenCalled();
    expect(capped.pushes.length).toBeGreaterThan(0);
    for (const push of capped.pushes) {
      expect(push.priority).toBe(5);
      expect(push.title).toContain("precisa de você");
    }
  });

  it("re-pushes the needs-you alert every 30 min while capped and still down", async () => {
    fs.writeFileSync(file, JSON.stringify({ restarts: [T0 - 3 * HOUR, T0 - 2 * HOUR, T0 - HOUR] }));
    const h = boot(T0);

    await h.runFor(10 * MIN);
    expect(h.pushes).toHaveLength(1);

    await h.runFor(29 * MIN);
    expect(h.pushes).toHaveLength(1);

    // pushes land at 10, 40, 70, 100 and 130 min of downtime
    await h.runFor(91 * MIN);
    expect(h.pushes).toHaveLength(5);
    expect(h.exit).not.toHaveBeenCalled();
  });

  it("does not count restarts older than the 6 h window", async () => {
    fs.writeFileSync(
      file,
      JSON.stringify({ restarts: [T0 - 7 * HOUR, T0 - 8 * HOUR, T0 - 9 * HOUR] }),
    );
    const h = boot(T0);
    await h.runFor(600_000);
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it("restarts again as soon as the oldest restart ages out of the window", async () => {
    fs.writeFileSync(file, JSON.stringify({ restarts: [T0 - 5 * HOUR, T0 - HOUR, T0 - 30 * MIN] }));
    const h = boot(T0);

    await h.runFor(55 * MIN);
    expect(h.exit).not.toHaveBeenCalled();

    await h.runFor(10 * MIN);
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it("never exits when WATCHDOG_MAX_RESTARTS is 0, only alerts", async () => {
    const h = boot(T0, { maxRestarts: 0 });
    await h.runFor(HOUR);
    expect(h.exit).not.toHaveBeenCalled();
    expect(h.pushes[0].title).toContain("precisa de você");
    expect(h.pushes[0].message).toContain("WATCHDOG_MAX_RESTARTS=0");
  });

  it("refuses to exit when it cannot persist the restart count, and alerts instead", async () => {
    // Without a durable count the cap cannot hold, which risks a reconnect storm.
    const h = makeHarness({
      status: "connecting",
      store: {
        load: () => ({ restarts: [], awaitingRecovery: false }),
        save: () => {
          throw new Error("read-only file system");
        },
      },
    });
    await h.runFor(HOUR);
    expect(h.exit).not.toHaveBeenCalled();
    expect(h.pushes[0].priority).toBe(5);
    expect(h.pushes[0].title).toContain("precisa de você");
  });
});

describe("ConnectionWatchdog recovery", () => {
  let dir: string;
  let file: string;
  const logger = pino({ level: "silent" });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-recovery-"));
    file = path.join(dir, "watchdog-state.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function boot(status: ConnectionStatus, bootAt = T0) {
    return makeHarness({ status, bootAt, store: createFileWatchdogStore(file, logger) });
  }

  it("stops the reminders once the socket is live and starts a fresh clock for the next outage", async () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        restarts: [T0 - 90 * MIN, T0 - 60 * MIN, T0 - 30 * MIN],
        awaitingRecovery: false,
      }),
    );
    const needsYou = () => h.pushes.filter((p) => p.title.includes("precisa de você"));
    const h = boot("connecting");
    await h.runFor(HOUR); // alerts at 10 and 40 min
    expect(needsYou()).toHaveLength(2);

    h.setStatus("connected");
    await h.runFor(3 * HOUR);
    expect(needsYou()).toHaveLength(2);
    expect(h.pushes.filter((p) => p.title.includes("reconectado"))).toHaveLength(1);

    // the next outage is a new one: nothing for 10 min, then a fresh alert
    h.setStatus("connecting");
    await h.runFor(9 * MIN);
    expect(needsYou()).toHaveLength(2);
    await h.runFor(MIN);
    expect(needsYou()).toHaveLength(3);
  });

  it("announces the reconnect once after a watchdog restart, since the new process has no FSM memory of the outage", async () => {
    const down = boot("connecting");
    await down.runFor(10 * MIN);
    expect(down.exit).toHaveBeenCalledWith(1);

    const up = boot("connecting", down.clock() + MIN);
    await up.runFor(2 * MIN);
    expect(up.pushes).toHaveLength(0);

    up.setStatus("connected");
    await up.runFor(SAMPLE_MS);
    expect(up.pushes).toHaveLength(1);
    expect(up.pushes[0].title).toContain("reconectado");
    expect(up.pushes[0].priority).toBe(2);

    await up.runFor(HOUR);
    expect(up.pushes).toHaveLength(1);

    // a later, unrelated boot must not repeat the announcement
    const later = boot("connected", up.clock() + HOUR);
    await later.runFor(HOUR);
    expect(later.pushes).toHaveLength(0);
  });

  it("announces the recovery after capped reminders without any restart", async () => {
    const h = makeHarness({ status: "connecting", maxRestarts: 0 });
    await h.runFor(HOUR);
    const before = h.pushes.length;
    expect(before).toBeGreaterThan(0);

    h.setStatus("syncing");
    await h.runFor(SAMPLE_MS);
    expect(h.pushes).toHaveLength(before + 1);
    expect(h.pushes[before].title).toContain("reconectado");
  });

  it("stays silent on a clean boot that connects normally", async () => {
    const h = boot("connecting");
    await h.runFor(2 * MIN);
    h.setStatus("connected");
    await h.runFor(HOUR);
    expect(h.pushes).toHaveLength(0);
  });

  it("does not announce a reconnect while only a QR scan is pending", async () => {
    const down = boot("connecting");
    await down.runFor(10 * MIN);

    const up = boot("qr_pending", down.clock() + MIN);
    await up.runFor(HOUR);
    expect(up.pushes).toHaveLength(0);
  });
});
