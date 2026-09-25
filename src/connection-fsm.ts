import type { Logger } from "pino";
import type { SendNtfy } from "./ntfy.ts";

export type Phase = "idle" | "qr_pending" | "connecting" | "connected" | "disconnected";

export type FSMConfig = {
  sendNtfy: SendNtfy;
  publicQrUrl: string;
  /** If set, connect with a different number triggers logout + purge. e.g. "5531" */
  expectedWaNumber: string | null;
  /** Milliseconds between QR reminders. Default 120_000 (2 min). */
  reminderIntervalMs?: number;
  /** Milliseconds to wait before sending disconnect notification. Default 120_000 (2 min).
   *  If reconnection happens within this window, both notifications are suppressed. */
  disconnectGraceMs?: number;
  /** Called when number mismatch — should logout socket and purge auth_info. */
  onBadPairing?: () => void | Promise<void>;
  /** Injectable for tests — default setTimeout. */
  setTimer?: (cb: () => void, ms: number) => { cancel: () => void };
};

export type ConnectionEvent =
  | { type: "qrCode" }
  | { type: "connecting" }
  | { type: "connected"; user: { id: string; name?: string } }
  | { type: "disconnected" };

function defaultTimer(cb: () => void, ms: number) {
  const id = setTimeout(cb, ms);
  return { cancel: () => clearTimeout(id) };
}

/**
 * Explicit connection state machine.
 *
 * States: idle → qr_pending → connecting → connected → disconnected (cycle)
 *
 * All side effects (ntfy pushes, timer arming/cancellation) live inside `handle`.
 * External callers only see the public `phase` field and `handle(event)`.
 */
export class ConnectionFSM {
  phase: Phase = "idle";

  private readonly logger: Logger;
  private readonly config: FSMConfig;
  private readonly interval: number;
  private readonly graceMs: number;
  private readonly setTimer: (cb: () => void, ms: number) => { cancel: () => void };

  private reminder: { cancel: () => void } | null = null;
  private graceTimer: { cancel: () => void } | null = null;
  private wasDisconnected = false;

  constructor(logger: Logger, config: FSMConfig) {
    this.logger = logger;
    this.config = config;
    this.interval = config.reminderIntervalMs ?? 120_000;
    this.graceMs = config.disconnectGraceMs ?? 120_000;
    this.setTimer = config.setTimer ?? defaultTimer;
  }

  async handle(event: ConnectionEvent): Promise<void> {
    switch (event.type) {
      case "qrCode":
        await this.onQrCode();
        return;
      case "connecting":
        this.onConnecting();
        return;
      case "connected":
        await this.onConnected(event.user);
        return;
      case "disconnected":
        await this.onDisconnected();
        return;
    }
  }

  private cancelReminder(): void {
    if (this.reminder) {
      this.reminder.cancel();
      this.reminder = null;
    }
  }

  private cancelGrace(): void {
    if (this.graceTimer) {
      this.graceTimer.cancel();
      this.graceTimer = null;
    }
  }

  private async flushDisconnect(): Promise<void> {
    this.cancelGrace();
    await this.config.sendNtfy({
      title: "WhatsApp - desconectado",
      message: "Conexão caiu. Aguardando reconexão automática.",
      priority: 4,
      tags: ["warning"],
      click: this.config.publicQrUrl,
    });
  }

  private armReminder(): void {
    this.cancelReminder();
    this.reminder = this.setTimer(() => {
      if (this.phase !== "qr_pending") return;
      void this.config.sendNtfy({
        title: "WhatsApp - QR ainda aguardando",
        message: `Escaneie o QR em ${this.config.publicQrUrl} para concluir o pareamento.`,
        priority: 4,
        tags: ["hourglass_flowing_sand"],
        click: this.config.publicQrUrl,
      });
      this.armReminder();
    }, this.interval);
  }

  private async onQrCode(): Promise<void> {
    const wasPending = this.phase === "qr_pending";
    this.phase = "qr_pending";
    if (wasPending) return;

    if (this.graceTimer) await this.flushDisconnect();

    this.logger.info("ConnectionFSM: qrCode → first QR, pushing ntfy + arming reminder");
    await this.config.sendNtfy({
      title: "WhatsApp - Escaneie QR",
      message: `Abra ${this.config.publicQrUrl} e escaneie com seu WhatsApp.`,
      priority: 4,
      tags: ["qrcode", "warning"],
      click: this.config.publicQrUrl,
    });
    this.armReminder();
  }

  private onConnecting(): void {
    this.phase = "connecting";
    this.cancelReminder();
  }

  private async onConnected(user: { id: string; name?: string }): Promise<void> {
    this.cancelReminder();

    const hadPendingGrace = this.graceTimer !== null;
    this.cancelGrace();

    if (this.config.expectedWaNumber && !user.id.startsWith(this.config.expectedWaNumber)) {
      this.logger.error(
        { userId: user.id, expected: this.config.expectedWaNumber },
        "Unexpected WhatsApp number paired — triggering bad-pairing cleanup",
      );
      await this.config.sendNtfy({
        title: "WhatsApp - Pareamento indevido",
        message: `Número inesperado (${user.id}). Sessão descartada. Acesse ${this.config.publicQrUrl} e escaneie novamente.`,
        priority: 5,
        tags: ["rotating_light", "no_entry"],
        click: this.config.publicQrUrl,
      });
      if (this.config.onBadPairing) {
        try {
          await this.config.onBadPairing();
        } catch (err) {
          this.logger.error({ err }, "onBadPairing handler failed");
        }
      }
      this.phase = "disconnected";
      this.wasDisconnected = true;
      return;
    }

    if (hadPendingGrace) {
      this.phase = "connected";
      this.wasDisconnected = false;
      return;
    }

    const wasReconnect = this.wasDisconnected;
    this.phase = "connected";
    this.wasDisconnected = false;

    if (wasReconnect) {
      await this.config.sendNtfy({
        title: "WhatsApp - reconectado",
        message: `Conexão restabelecida como ${user.name ?? user.id}.`,
        priority: 2,
        tags: ["white_check_mark"],
      });
    }
  }

  private async onDisconnected(): Promise<void> {
    this.cancelReminder();
    this.cancelGrace();
    this.phase = "disconnected";
    this.wasDisconnected = true;
    this.graceTimer = this.setTimer(() => {
      this.graceTimer = null;
      void this.flushDisconnect();
    }, this.graceMs);
  }
}
