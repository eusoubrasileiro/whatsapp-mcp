import type { Logger } from "pino";
import type { FSMConfig } from "./connection-fsm.ts";
import { ConnectionFSM } from "./connection-fsm.ts";

export type NotifierConfig = FSMConfig;

export type NotifierHandlers = {
  onQrCode: (qr: string, ascii: string) => Promise<void>;
  onConnecting: () => void;
  onConnected: (user: { id: string; name?: string }) => Promise<void>;
  onDisconnected: () => Promise<void>;
};

/**
 * Thin facade over {@link ConnectionFSM}. Preserves the historical
 * event-handler shape consumed by `whatsapp.ts` — each handler simply
 * dispatches a typed event into the state machine.
 */
export function createConnectionNotifier(logger: Logger, config: NotifierConfig): NotifierHandlers {
  const fsm = new ConnectionFSM(logger, config);

  return {
    onQrCode: async () => {
      await fsm.handle({ type: "qrCode" });
    },
    onConnecting: () => {
      void fsm.handle({ type: "connecting" });
    },
    onConnected: async (user) => {
      await fsm.handle({ type: "connected", user });
    },
    onDisconnected: async () => {
      await fsm.handle({ type: "disconnected" });
    },
  };
}
