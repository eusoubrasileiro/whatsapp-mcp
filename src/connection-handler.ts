import type { Logger } from "pino";
import type { WhatsAppSocket, ConnectionStatus } from "./whatsapp.ts";

export type ConnectionCloseDeps = {
  logger: Logger;
  connectionState: {
    status: ConnectionStatus;
    qrCode: string | null;
    qrAscii: string | null;
    user: string | null;
  };
  socketState: { socket: WhatsAppSocket | null };
  startConnection: () => Promise<WhatsAppSocket>;
  rmSync: (path: string, opts: { recursive: boolean; force: boolean }) => void;
  mkdirSync: (path: string, opts: { recursive: boolean }) => void;
  setTimeoutFn: (cb: () => void, ms: number) => void;
  pRetryFn: (
    fn: () => Promise<WhatsAppSocket>,
    opts: {
      retries: number;
      minTimeout: number;
      maxTimeout: number;
      factor: number;
      onFailedAttempt: (err: { attemptNumber: number; retriesLeft: number }) => void;
    },
  ) => Promise<WhatsAppSocket>;
  authDir: string;
  loggedOutCode: number;
};

export function handleConnectionClose(
  statusCode: number | undefined,
  lastError: Error | undefined,
  reasonName: string,
  deps: ConnectionCloseDeps,
): void {
  const { logger, connectionState, socketState } = deps;

  // Reset connection state
  connectionState.status = "disconnected";
  connectionState.qrCode = null;
  connectionState.qrAscii = null;
  connectionState.user = null;
  socketState.socket = null;

  logger.warn(
    { err: lastError },
    `Connection closed. Reason: ${reasonName}`,
  );

  if (statusCode !== deps.loggedOutCode) {
    // Non-logout: retry with exponential backoff
    deps
      .pRetryFn(() => deps.startConnection(), {
        retries: 10,
        minTimeout: 1000,
        maxTimeout: 60000,
        factor: 2,
        onFailedAttempt: (err) => {
          logger.warn(
            `Reconnect attempt ${err.attemptNumber} failed, ${err.retriesLeft} retries left`,
          );
        },
      })
      .catch((err) => {
        logger.error(
          { err },
          "All reconnection attempts failed. Server stays alive — call get_connection_status to retry.",
        );
      });
  } else {
    // Logout: clear credentials and reconnect after delay
    logger.warn("Logged out from WhatsApp. Clearing credentials and reconnecting...");
    deps.rmSync(deps.authDir, { recursive: true, force: true });
    deps.mkdirSync(deps.authDir, { recursive: true });
    deps.setTimeoutFn(() => {
      deps.startConnection().catch((err) => {
        logger.error({ err }, "Failed to restart connection after logout");
      });
    }, 2000);
  }
}
