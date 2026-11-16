import { resolvePublicQrUrl } from "./connection-notifier.ts";
import { ConnectionWatchdog, readWatchdogEnv } from "./connection-watchdog.ts";
import { closeDatabase } from "./database.ts";
import { createNtfy, resolveNtfyConfig } from "./ntfy.ts";
import { createAppLoggers, startServers } from "./server-startup.ts";
import { createFileWatchdogStore } from "./watchdog-store.ts";
import { getConnectionState, startWhatsAppConnection } from "./whatsapp.ts";

const dataDir = process.env.WHATSAPP_MCP_DATA_DIR || ".";
const { waLogger, mcpLogger } = createAppLoggers(dataDir);

/**
 * End the process for the container's restart policy. Same cleanup as
 * `shutdown`, but never lets a failing cleanup step keep a wedged process alive.
 */
function exitForRestart(code: number): never {
  try {
    closeDatabase();
  } catch (err) {
    mcpLogger.error({ err }, "closeDatabase failed during watchdog exit");
  }
  waLogger.flush();
  mcpLogger.flush();
  process.exit(code);
}

let watchdog: ConnectionWatchdog | null = null;

async function main() {
  mcpLogger.info("Starting WhatsApp MCP Server...");

  try {
    // Database, webhook registry, S3 bucket, then the MCP server (handshake first), then the
    // QR / upload / follow_chat servers — and nothing that touches WhatsApp.
    await startServers({ mcpLogger, waLogger });
  } catch (error: any) {
    mcpLogger.fatal({ err: error }, "Failed during initialization or MCP server startup");

    process.exit(1);
  }

  // Dead-man switch: if the WhatsApp socket stays down, push ntfy and exit so
  // `restart: unless-stopped` revives the container (2026-11-13: 63 h wedge).
  watchdog = new ConnectionWatchdog(waLogger, {
    ...readWatchdogEnv(),
    getState: getConnectionState,
    sendNtfy: createNtfy(waLogger, resolveNtfyConfig()),
    publicQrUrl: resolvePublicQrUrl(),
    store: createFileWatchdogStore(`${dataDir}/watchdog-state.json`, waLogger),
    exit: exitForRestart,
  });
  watchdog.start();

  // Start WhatsApp connection in background (non-blocking)
  // MCP tools already handle socketState.socket being null gracefully
  mcpLogger.info("Attempting to connect to WhatsApp...");
  startWhatsAppConnection(waLogger).catch((error) => {
    mcpLogger.error({ err: error }, "WhatsApp connection failed during startup");
  });

  mcpLogger.info("Application setup complete. Running...");
}

async function shutdown(signal: string) {
  mcpLogger.info(`Received ${signal}. Shutting down gracefully...`);

  watchdog?.stop();

  closeDatabase();

  waLogger.flush();
  mcpLogger.flush();

  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch((error) => {
  mcpLogger.fatal({ err: error }, "Unhandled error during application startup");
  waLogger.flush();
  mcpLogger.flush();
  process.exit(1);
});
