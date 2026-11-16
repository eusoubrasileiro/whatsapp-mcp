import type { ConnectionStatus } from "@amiticia/baileys-client";
import type { Logger } from "pino";
import { CLOCK_RESETTING_STATUSES, LIVE_STATUSES } from "./connection-status.ts";
import { readNonNegativeNumber } from "./env-config.ts";
import type { NtfyMessage, SendNtfy } from "./ntfy.ts";
import type { WatchdogStore } from "./watchdog-store.ts";

/** How often the watchdog samples the connection status. */
const SAMPLE_INTERVAL_MS = 30_000;

/** Longest the watchdog waits on an ntfy push before exiting regardless. */
const NTFY_TIMEOUT_MS = 10_000;

/** Rolling window the restart cap is counted over (ban-risk guard: no reconnect storms). */
const RESTART_WINDOW_MS = 6 * 60 * 60 * 1000;

/** How often the "needs you" alert repeats while the watchdog may not (or cannot) restart. */
const REMINDER_INTERVAL_MS = 30 * 60 * 1000;

export type WatchdogEnv = {
  /** Seconds the socket may stay down before the process exits. `0` disables the watchdog. */
  restartAfterS: number;
  /** Self-restarts allowed per rolling 6 h window. `0` means alert only, never exit. */
  maxRestarts: number;
};

/**
 * Read the watchdog env vars. A malformed value reads as the default — never
 * as "disabled" — the same rule `env-config.ts` follows; only an explicit `0`
 * switches the watchdog off.
 */
export function readWatchdogEnv(
  env: Record<string, string | undefined> = process.env,
): WatchdogEnv {
  return {
    restartAfterS: readNonNegativeNumber(env.WATCHDOG_RESTART_AFTER_S, 600),
    maxRestarts: readNonNegativeNumber(env.WATCHDOG_MAX_RESTARTS, 3),
  };
}

type Timer = { cancel: () => void };

export type WatchdogConfig = WatchdogEnv & {
  /** Same accessor `qr-server.ts` uses — NOT the FSM, which saw no event in the 2026-11-13 wedge. */
  getState: () => { status: ConnectionStatus };
  sendNtfy: SendNtfy;
  publicQrUrl: string;
  /** Persists the restart history so the cap survives the restart it causes. */
  store: WatchdogStore;
  /** Called with 1 to end the process so `restart: unless-stopped` brings it back. Injected so tests never exit. */
  exit: (code: number) => void;
  /** Injectable clock in epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable for tests — default setTimeout (unref'd). */
  setTimer?: (cb: () => void, ms: number) => Timer;
};

function defaultTimer(cb: () => void, ms: number): Timer {
  const id = setTimeout(cb, ms);
  id.unref();
  return { cancel: () => clearTimeout(id) };
}

/**
 * In-process dead-man switch for a wedged WhatsApp socket.
 *
 * Why it exists: on 2026-11-13 the socket sat in `connecting` for 63 h. `/health`
 * correctly went 503, but plain Docker never restarts an unhealthy container and
 * Traefik stops routing to one, so the only effect was that the MCP and the QR
 * page vanished. Nothing outside the process can fix a wedge; only the process
 * exiting lets `restart: unless-stopped` do it.
 *
 * It samples on its own timer — it must not depend on anything polling `/health`
 * — and uses the same down/not-down classification as `/health`.
 */
export class ConnectionWatchdog {
  private readonly logger: Logger;
  private readonly config: WatchdogConfig;
  private readonly now: () => number;
  private readonly setTimer: (cb: () => void, ms: number) => Timer;

  private lastLiveAt: number;
  private lastAlertAt: number | null = null;
  /** An outage was announced (or a restart caused) and the all-clear is still owed. */
  private owesRecovery: boolean;
  private timer: Timer | null = null;
  private running = false;
  private exiting = false;

  constructor(logger: Logger, config: WatchdogConfig) {
    this.logger = logger;
    this.config = config;
    this.now = config.now ?? (() => Date.now());
    this.setTimer = config.setTimer ?? defaultTimer;
    this.lastLiveAt = this.now();
    this.owesRecovery = config.store.load().awaitingRecovery;
  }

  /** Arm the sampling timer. A no-op when `restartAfterS` is 0 (operator kill switch). */
  start(): void {
    if (this.config.restartAfterS <= 0) {
      this.logger.info("Connection watchdog disabled (WATCHDOG_RESTART_AFTER_S=0)");
      return;
    }
    this.lastLiveAt = this.now();
    this.running = true;
    this.logger.info({ restartAfterS: this.config.restartAfterS }, "Connection watchdog armed");
    this.schedule();
  }

  stop(): void {
    this.running = false;
    this.timer?.cancel();
    this.timer = null;
  }

  /** One sample. Public so tests (and nothing else) can drive it without timers. */
  async tick(): Promise<void> {
    if (this.exiting || this.config.restartAfterS <= 0) return;
    try {
      await this.sample();
    } catch (err) {
      // The watchdog must never die silently: log and keep sampling.
      this.logger.error({ err }, "Connection watchdog sample failed");
    }
  }

  private schedule(): void {
    if (!this.running || this.exiting) return;
    this.timer = this.setTimer(() => {
      void this.tick().finally(() => this.schedule());
    }, SAMPLE_INTERVAL_MS);
  }

  private async sample(): Promise<void> {
    const status = this.config.getState().status;
    const t = this.now();

    if (CLOCK_RESETTING_STATUSES.has(status)) {
      this.lastLiveAt = t;
      this.lastAlertAt = null;
      if (LIVE_STATUSES.has(status)) await this.announceRecovery();
      return;
    }

    const downMs = t - this.lastLiveAt;
    if (downMs < this.config.restartAfterS * 1000) return;

    const recent = this.config.store.load().restarts.filter((ts) => t - ts < RESTART_WINDOW_MS);
    const capReached = recent.length >= this.config.maxRestarts;
    if (!capReached && this.recordRestart(recent, t)) {
      await this.restart(downMs, recent.length + 1);
      return;
    }
    await this.remind(downMs, capReached);
  }

  /**
   * Persist the restart BEFORE exiting, or the cap cannot survive it. Returns
   * false when the history cannot be written: without a durable count the cap
   * cannot hold, so the caller must fail closed (alert, don't exit).
   */
  private recordRestart(recent: number[], t: number): boolean {
    try {
      this.config.store.save({ restarts: [...recent, t], awaitingRecovery: true });
      return true;
    } catch (err) {
      this.logger.error({ err }, "Watchdog cannot persist its restart count — refusing to exit");
      return false;
    }
  }

  private async restart(downMs: number, nth: number): Promise<void> {
    this.exiting = true;
    this.timer?.cancel();
    this.timer = null;

    const downMin = Math.floor(downMs / 60_000);
    try {
      await this.sendBounded({
        title: "WhatsApp - fora do ar",
        message: `WhatsApp fora do ar há ${downMin} min — reiniciando (${nth}/${this.config.maxRestarts} nas últimas 6 h).`,
        priority: 5,
        tags: ["rotating_light"],
        click: this.config.publicQrUrl,
      });
    } finally {
      this.logger.error(
        { downMin, nth },
        "WhatsApp socket down past WATCHDOG_RESTART_AFTER_S — exiting so the container restarts",
      );
      this.config.exit(1);
    }
  }

  /**
   * Tell Andre the socket is back when the watchdog has been telling him it was
   * down. After a self-restart this is the only "reconectado": the new process's
   * FSM never saw the disconnect, so its own reconnect push stays silent.
   */
  private async announceRecovery(): Promise<void> {
    if (!this.owesRecovery) return;
    this.owesRecovery = false;
    try {
      const state = this.config.store.load();
      if (state.awaitingRecovery) this.config.store.save({ ...state, awaitingRecovery: false });
    } catch (err) {
      this.logger.warn({ err }, "Watchdog could not clear its recovery flag");
    }
    await this.sendBounded({
      title: "WhatsApp - reconectado",
      message: "Conexão restabelecida depois da queda longa.",
      priority: 2,
      tags: ["white_check_mark"],
    });
  }

  /** The watchdog may not restart: tell Andre, then keep telling him every 30 min. */
  private async remind(downMs: number, capReached: boolean): Promise<void> {
    const t = this.now();
    if (this.lastAlertAt !== null && t - this.lastAlertAt < REMINDER_INTERVAL_MS) return;
    this.lastAlertAt = t;
    this.owesRecovery = true;

    const downMin = Math.floor(downMs / 60_000);
    let why: string;
    if (this.config.maxRestarts <= 0)
      why = "Reinício automático desligado (WATCHDOG_MAX_RESTARTS=0).";
    else if (capReached)
      why = `Limite de ${this.config.maxRestarts} reinícios automáticos em 6 h atingido.`;
    else why = "Não consegui gravar o contador de reinícios, então não reinicio sozinho.";
    this.logger.error(
      { downMin, capReached },
      "WhatsApp socket down and the watchdog may not restart",
    );
    await this.sendBounded({
      title: "WhatsApp - precisa de você",
      message: `WhatsApp fora do ar há ${downMin} min. ${why} Veja ${this.config.publicQrUrl}`,
      priority: 5,
      tags: ["sos"],
      click: this.config.publicQrUrl,
    });
  }

  /** Send a push but never wait on it longer than {@link NTFY_TIMEOUT_MS}; never throws. */
  private sendBounded(msg: NtfyMessage): Promise<void> {
    return new Promise<void>((resolve) => {
      const guard = this.setTimer(() => {
        this.logger.warn({ title: msg.title }, "Watchdog ntfy push timed out — not waiting");
        resolve();
      }, NTFY_TIMEOUT_MS);
      void (async () => this.config.sendNtfy(msg))()
        .catch((err) => this.logger.warn({ err }, "Watchdog ntfy push failed"))
        .finally(() => {
          guard.cancel();
          resolve();
        });
    });
  }
}
