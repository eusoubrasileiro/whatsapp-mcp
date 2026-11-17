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
 * URL that ntfy pushes link to for scanning. `PUBLIC_QR_URL` wins; without
 * it, fall back to this instance's own QR image (same bind defaults as
 * `main.ts`), so an unconfigured deployment never links to someone else's page.
 * The QR server has no page of its own, so the fallback is the image itself.
 */
export function resolvePublicQrUrl(env: Record<string, string | undefined> = process.env): string {
  if (env.PUBLIC_QR_URL) return env.PUBLIC_QR_URL;
  const bind = env.QR_SERVER_HOST || "127.0.0.1";
  const port = env.QR_SERVER_PORT || "39002";
  let host = bind;
  if (bind === "0.0.0.0" || bind === "::") host = "localhost";
  else if (bind.includes(":")) host = `[${bind}]`;
  return `http://${host}:${port}/qr.png`;
}

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
