import pino from "pino";
import { initializeDatabase, setDatabaseLogger, closeDatabase } from "./database.ts";
import { startWhatsAppConnection, getConnectionState, triggerResync } from "./whatsapp.ts";
import { startMcpServer } from "./mcp.ts";
import { ensureBucketReady } from "./storage.ts";
import { createQrServer } from "./qr-server.ts";
import fs from "node:fs";

const dataDir = process.env.WHATSAPP_MCP_DATA_DIR || '.';
fs.mkdirSync(dataDir, { recursive: true });

function createAppLogger(filename: string) {
  return pino(
    {
      level: process.env.LOG_LEVEL || "info",
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.destination(`${dataDir}/${filename}`)
  );
}

const waLogger = createAppLogger("wa-logs.txt");
const mcpLogger = createAppLogger("mcp-logs.txt");

async function main() {
  mcpLogger.info("Starting WhatsApp MCP Server...");

  try {
    // Set database logger before any database operations
    setDatabaseLogger(waLogger);

    mcpLogger.info("Initializing database...");
    initializeDatabase();
    mcpLogger.info("Database initialized successfully.");

    if (process.env.S3_ENABLED === "true") {
      mcpLogger.info("Ensuring S3 bucket is ready...");
      await ensureBucketReady();
      mcpLogger.info("S3 bucket ready.");
    }

    // Start MCP server FIRST — stdio handshake must complete before any async network I/O
    mcpLogger.info("Starting MCP server...");
    await startMcpServer(mcpLogger, waLogger);
    mcpLogger.info("MCP Server started and listening.");
  } catch (error: any) {
    mcpLogger.fatal(
      { err: error },
      "Failed during initialization or MCP server startup"
    );

    process.exit(1);
  }

  // Start QR web server (non-blocking) — port 39002 by default.
  const qrServerPort = Number(process.env.QR_SERVER_PORT ?? 39002);
  const qrServerHost = process.env.QR_SERVER_HOST ?? "127.0.0.1";
  const qrServer = createQrServer(waLogger, getConnectionState, () => triggerResync(waLogger));
  qrServer.listen(qrServerPort, qrServerHost, () => {
    mcpLogger.info({ host: qrServerHost, port: qrServerPort }, "QR web server listening");
  });
  qrServer.on("error", (err) => {
    mcpLogger.error({ err }, "QR web server error");
  });

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
