import fs from "node:fs";
import type { Server } from "node:http";
import pino, { type Logger } from "pino";
import { initializeDatabase, setDatabaseLogger } from "./database.ts";
import { startMcpServer } from "./mcp.ts";
import { createQrServer } from "./qr-server.ts";
import { ensureBucketReady, putUpload } from "./storage.ts";
import { createStreamServer } from "./stream/server.ts";
import { streamTokens } from "./stream/token.ts";
import { createUploadServer } from "./upload-server.ts";
import { loadRegistry } from "./webhooks/registry.ts";
import { getConnectionState, transcribeMediaMessage } from "./whatsapp.ts";

/**
 * Everything the process starts BEFORE it connects to WhatsApp: database, webhook
 * registry, S3 bucket, the MCP server and the three side HTTP servers. `main.ts` calls
 * {@link startServers} and only then starts the watchdog and the WhatsApp connection.
 *
 * It lives in its own module so the e2e suite (`e2e/`) can boot the real servers without a
 * Baileys socket. It must never import or call `startWhatsAppConnection`: a connection is a
 * third-party reach-out with an account-restriction risk (docs/account-restrictions.md).
 */

export interface AppLoggers {
  waLogger: Logger;
  mcpLogger: Logger;
}

/** Creates `dataDir` (and parents) and one pino logger writing to a file in it per concern. */
export function createAppLoggers(dataDir: string): AppLoggers {
  fs.mkdirSync(dataDir, { recursive: true });
  const create = (filename: string): Logger =>
    pino(
      {
        level: process.env.LOG_LEVEL || "info",
        timestamp: pino.stdTimeFunctions.isoTime,
      },
      pino.destination(`${dataDir}/${filename}`),
    );
  return { waLogger: create("wa-logs.txt"), mcpLogger: create("mcp-logs.txt") };
}

export interface StartServersDeps {
  mcpLogger: Logger;
  waLogger: Logger;
}

export interface RunningServers {
  /** QR page + `/health` + `/live`. */
  qr: Server;
  /** `POST /upload`; `null` unless `S3_ENABLED=true`. */
  upload: Server | null;
  /** `follow_chat` WebSocket stream. */
  stream: Server;
}

/**
 * Resolves once each side server is listening, or has failed to bind: a taken port is
 * logged and does not stop the process (same as the original non-blocking `listen`).
 */
function listen(
  server: Server,
  label: string,
  host: string,
  port: number,
  mcpLogger: Logger,
): Promise<void> {
  return new Promise((resolve) => {
    server.once("listening", () => {
      mcpLogger.info({ address: server.address() }, `${label} listening`);
      resolve();
    });
    server.on("error", (err) => {
      mcpLogger.error({ err }, `${label} error`);
      resolve();
    });
    server.listen(port, host);
  });
}

/**
 * Rejects when the database, S3 bucket or MCP server cannot start; the caller decides
 * whether that is fatal. Order is load-bearing: the MCP server starts before any side
 * server, and nothing here touches WhatsApp.
 */
export async function startServers(deps: StartServersDeps): Promise<RunningServers> {
  const { mcpLogger, waLogger } = deps;
  const s3Enabled = process.env.S3_ENABLED === "true";

  // Set database logger before any database operations
  setDatabaseLogger(waLogger);

  mcpLogger.info("Initializing database...");
  initializeDatabase();
  mcpLogger.info("Database initialized successfully.");

  // Hydrate webhook subscriptions before the WhatsApp connection emits, so
  // inbound messages match against the persisted set on the very first upsert.
  loadRegistry();

  if (s3Enabled) {
    mcpLogger.info("Ensuring S3 bucket is ready...");
    await ensureBucketReady();
    mcpLogger.info("S3 bucket ready.");
  }

  // Start MCP server FIRST — stdio handshake must complete before any async network I/O
  mcpLogger.info("Starting MCP server...");
  await startMcpServer(mcpLogger, waLogger);
  mcpLogger.info("MCP Server started and listening.");

  // QR web server — port 39002 by default.
  const qr = createQrServer(waLogger, getConnectionState);

  // Upload server — only if S3 plane is enabled. Lets agents POST host-disk files and
  // get a public URL to pass to send_file.
  const upload = s3Enabled
    ? createUploadServer(waLogger, { putUpload, authToken: process.env.MCP_AUTH_TOKEN })
    : null;

  // follow_chat WebSocket stream server — port 39004 by default. Backs the `follow_chat`
  // tool: an interactive agent attaches the returned wss URL to its harness background
  // monitor and is woken per message.
  const stream = createStreamServer({
    logger: waLogger,
    tokens: streamTokens,
    // Bound to the WA logger; downloads + Whisper-transcribes an inbound voice
    // note on demand for streams whose token opted into transcription.
    transcribe: (msg) => transcribeMediaMessage(msg, waLogger),
  });

  await Promise.all([
    listen(
      qr,
      "QR web server",
      process.env.QR_SERVER_HOST ?? "127.0.0.1",
      Number(process.env.QR_SERVER_PORT ?? 39002),
      mcpLogger,
    ),
    upload
      ? listen(
          upload,
          "Upload server",
          process.env.UPLOAD_SERVER_HOST ?? "127.0.0.1",
          Number(process.env.UPLOAD_SERVER_PORT ?? 39003),
          mcpLogger,
        )
      : Promise.resolve(),
    listen(
      stream,
      "follow_chat stream server",
      process.env.STREAM_SERVER_HOST ?? "127.0.0.1",
      Number(process.env.STREAM_SERVER_PORT ?? 39004),
      mcpLogger,
    ),
  ]);

  return { qr, upload, stream };
}
