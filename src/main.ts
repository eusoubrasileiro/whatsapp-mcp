import pino from "pino";
import { initializeDatabase, setDatabaseLogger, closeDatabase } from "./database.ts";
import { startWhatsAppConnection } from "./whatsapp.ts";
import { startMcpServer } from "./mcp.ts";

const dataDir = process.env.WHATSAPP_MCP_DATA_DIR || '.';
const waLogger = pino(
  {
    level: process.env.LOG_LEVEL || "info",
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.destination(`${dataDir}/wa-logs.txt`)
);

const mcpLogger = pino(
  {
    level: process.env.LOG_LEVEL || "info",
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.destination(`${dataDir}/mcp-logs.txt`)
);

async function main() {
  mcpLogger.info("Starting WhatsApp MCP Server...");

  try {
    // Set database logger before any database operations
    setDatabaseLogger(waLogger);

    mcpLogger.info("Initializing database...");
    initializeDatabase();
    mcpLogger.info("Database initialized successfully.");

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
