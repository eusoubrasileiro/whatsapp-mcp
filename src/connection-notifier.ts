import type { Logger } from "pino";
import type { SendNtfy } from "./ntfy.ts";

export type NotifierConfig = {
  sendNtfy: SendNtfy;
  publicQrUrl: string;
  /** If set, connect with a different number triggers logout + purge. e.g. "5531" */
  expectedWaNumber: string | null;
  /** Milliseconds between QR reminders. Default 120_000 (2 min). */
  reminderIntervalMs?: number;
  /** Called when number mismatch — should logout socket and purge auth_info. */
  onBadPairing?: () => void | Promise<void>;
  /** Injectable for tests — default setTimeout. */
  setTimer?: (cb: () => void, ms: number) => { cancel: () => void };
};

export type NotifierHandlers = {
  onQrCode: (qr: string, ascii: string) => Promise<void>;
  onConnecting: () => void;
  onConnected: (user: { id: string; name?: string }) => Promise<void>;
  onDisconnected: () => Promise<void>;
};

type Phase = "idle" | "qr_pending" | "connecting" | "connected" | "disconnected";

function defaultTimer(cb: () => void, ms: number) {
  const id = setTimeout(cb, ms);
  return { cancel: () => clearTimeout(id) };
}

export function createConnectionNotifier(
  logger: Logger,
  config: NotifierConfig,
): NotifierHandlers {
  const interval = config.reminderIntervalMs ?? 120_000;
  const setTimer = config.setTimer ?? defaultTimer;

  let phase: Phase = "idle";
  let reminder: { cancel: () => void } | null = null;
  let wasDisconnected = false;

  function cancelReminder() {
    if (reminder) {
      reminder.cancel();
      reminder = null;
    }
  }

  function armReminder() {
    cancelReminder();
    reminder = setTimer(() => {
      if (phase !== "qr_pending") return;
      void config.sendNtfy({
        title: "WhatsApp - QR ainda aguardando",
        message: "Escaneie o QR em wa.amiticia.cc para concluir o pareamento.",
        priority: 4,
        tags: ["hourglass_flowing_sand"],
        click: config.publicQrUrl,
      });
      armReminder();
    }, interval);
  }

  return {
    onQrCode: async () => {
      const wasPending = phase === "qr_pending";
      phase = "qr_pending";
      if (wasPending) return;

      logger.info("onQrCode → first QR, pushing ntfy + arming reminder");
      await config.sendNtfy({
        title: "WhatsApp - Escaneie QR",
        message: `Abra ${config.publicQrUrl} e escaneie com seu WhatsApp.`,
        priority: 4,
        tags: ["qrcode", "warning"],
        click: config.publicQrUrl,
      });
      armReminder();
    },

    onConnecting: () => {
      phase = "connecting";
      cancelReminder();
    },

    onConnected: async (user) => {
      cancelReminder();

      if (config.expectedWaNumber && !user.id.startsWith(config.expectedWaNumber)) {
        logger.error(
          { userId: user.id, expected: config.expectedWaNumber },
          "Unexpected WhatsApp number paired — triggering bad-pairing cleanup",
        );
        await config.sendNtfy({
          title: "WhatsApp - Pareamento indevido",
          message: `Número inesperado (${user.id}). Sessão descartada. Acesse ${config.publicQrUrl} e escaneie novamente.`,
          priority: 5,
          tags: ["rotating_light", "no_entry"],
          click: config.publicQrUrl,
        });
        if (config.onBadPairing) {
          try {
            await config.onBadPairing();
          } catch (err) {
            logger.error({ err }, "onBadPairing handler failed");
          }
        }
        phase = "disconnected";
        wasDisconnected = true;
        return;
      }

      const wasReconnect = wasDisconnected;
      phase = "connected";
      wasDisconnected = false;

      if (wasReconnect) {
        await config.sendNtfy({
          title: "WhatsApp - reconectado",
          message: `Conexão restabelecida como ${user.name ?? user.id}.`,
          priority: 2,
          tags: ["white_check_mark"],
        });
      }
    },

    onDisconnected: async () => {
      cancelReminder();
      phase = "disconnected";
      wasDisconnected = true;
      await config.sendNtfy({
        title: "WhatsApp - desconectado",
        message: "Conexão caiu. Aguardando reconexão automática.",
        priority: 4,
        tags: ["warning"],
        click: config.publicQrUrl,
      });
    },
  };
}
