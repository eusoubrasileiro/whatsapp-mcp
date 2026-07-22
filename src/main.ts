import fs from "node:fs";
import pino from "pino";
import { closeDatabase, initializeDatabase, setDatabaseLogger } from "./database.ts";
import { startMcpServer } from "./mcp.ts";
import { createQrServer } from "./qr-server.ts";
import { ensureBucketReady, putUpload } from "./storage.ts";
import { createStreamServer } from "./stream/server.ts";
import { streamTokens } from "./stream/token.ts";
import { createUploadServer } from "./upload-server.ts";
import { loadRegistry } from "./webhooks/registry.ts";
import {
  getConnectionState,
  startWhatsAppConnection,
  transcribeMediaMessage,
  triggerRepair,
} from "./whatsapp.ts";

const dataDir = process.env.WHATSAPP_MCP_DATA_DIR || ".";
fs.mkdirSync(dataDir, { recursive: true });

function createAppLogger(filename: string) {
  return pino(
    {
      level: process.env.LOG_LEVEL || "info",
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.destination(`${dataDir}/${filename}`),
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

    // Hydrate webhook subscriptions before the WhatsApp connection emits, so
    // inbound messages match against the persisted set on the very first upsert.
    loadRegistry();

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
    mcpLogger.fatal({ err: error }, "Failed during initialization or MCP server startup");

    process.exit(1);
  }

  // Start QR web server (non-blocking) — port 39002 by default.
  const qrServerPort = Number(process.env.QR_SERVER_PORT ?? 39002);
  const qrServerHost = process.env.QR_SERVER_HOST ?? "127.0.0.1";
  const qrServer = createQrServer(waLogger, getConnectionState, () => triggerRepair(waLogger));
  qrServer.listen(qrServerPort, qrServerHost, () => {
    mcpLogger.info({ host: qrServerHost, port: qrServerPort }, "QR web server listening");
  });
  qrServer.on("error", (err) => {
    mcpLogger.error({ err }, "QR web server error");
  });

  // Start upload server (non-blocking) — only if S3 plane is enabled.
  // Lets agents POST host-disk files and get a public URL to pass to send_file.
  if (process.env.S3_ENABLED === "true") {
    const uploadPort = Number(process.env.UPLOAD_SERVER_PORT ?? 39003);
    const uploadHost = process.env.UPLOAD_SERVER_HOST ?? "127.0.0.1";
    const uploadServer = createUploadServer(waLogger, {
      putUpload,
      authToken: process.env.MCP_AUTH_TOKEN,
    });
    uploadServer.listen(uploadPort, uploadHost, () => {
      mcpLogger.info({ host: uploadHost, port: uploadPort }, "Upload server listening");
    });
    uploadServer.on("error", (err) => {
      mcpLogger.error({ err }, "Upload server error");
    });
  }

  // Start follow_chat WebSocket stream server (non-blocking) — port 39004 by
  // default. Backs the `follow_chat` tool: an interactive agent attaches the
  // returned wss URL to its harness background monitor and is woken per message.
  const streamPort = Number(process.env.STREAM_SERVER_PORT ?? 39004);
  const streamHost = process.env.STREAM_SERVER_HOST ?? "127.0.0.1";
  const streamServer = createStreamServer({
    logger: waLogger,
    tokens: streamTokens,
    // Bound to the WA logger; downloads + Whisper-transcribes an inbound voice
    // note on demand for streams whose token opted into transcription.
    transcribe: (msg) => transcribeMediaMessage(msg, waLogger),
  });
  streamServer.listen(streamPort, streamHost, () => {
    mcpLogger.info({ host: streamHost, port: streamPort }, "follow_chat stream server listening");
  });
  streamServer.on("error", (err) => {
    mcpLogger.error({ err }, "follow_chat stream server error");
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
