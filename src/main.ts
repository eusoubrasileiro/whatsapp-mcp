import pino from "pino";
import { disconnectPrisma, getPrisma } from "./db/client.ts";
import { setQueriesLogger } from "./db/queries.ts";
import { TenantConnectionManager } from "./tenancy/manager.ts";
import { startMcpServer } from "./mcp.ts";
import { ensureBucketReady } from "./storage.ts";
import { createQrServer } from "./qr-server.ts";
import fs from "node:fs";

const dataDir = process.env.WHATSAPP_MCP_DATA_DIR || ".";
fs.mkdirSync(dataDir, { recursive: true });
const waLogger = pino(
  {
    level: process.env.LOG_LEVEL || "info",
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.destination(`${dataDir}/wa-logs.txt`),
);

const mcpLogger = pino(
  {
    level: process.env.LOG_LEVEL || "info",
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.destination(`${dataDir}/mcp-logs.txt`),
);

async function main() {
  mcpLogger.info("Starting WhatsApp MCP Server...");

  let manager: TenantConnectionManager;

  try {
    setQueriesLogger(waLogger);

    // 1. Connect to Postgres
    mcpLogger.info("Initializing database (Postgres/Prisma)...");
    const prisma = getPrisma();
    await prisma.$queryRawUnsafe("SELECT 1");
    mcpLogger.info("Database connection ready.");

    // Seed tenant "default" if DB is empty — preserves single-tenant behavior
    const tenantCount = await prisma.tenant.count();
    if (tenantCount === 0) {
      mcpLogger.info("No tenants in DB -- seeding tenant 'default'.");
      await prisma.tenant.create({
        data: {
          id: "default",
          displayName: "Default",
          expectedWaNumber: process.env.EXPECTED_WA_NUMBER ?? "",
          writeToolsEnabled: true,
        },
      });
    }

    // 2. S3 bucket ready probe
    if (process.env.S3_ENABLED === "true") {
      mcpLogger.info("Ensuring S3 bucket is ready...");
      await ensureBucketReady();
      mcpLogger.info("S3 bucket ready.");
    }

    // 3. Load tenants from DB
    manager = new TenantConnectionManager(dataDir, waLogger);
    await manager.loadFromDb();
    mcpLogger.info(`Loaded ${manager.list().length} tenant(s) from DB.`);

    // 4. Start MCP server FIRST -- stdio handshake must complete before Baileys
    mcpLogger.info("Starting MCP server...");
    await startMcpServer(mcpLogger, waLogger, manager);
    mcpLogger.info("MCP Server started and listening.");
  } catch (error: any) {
    mcpLogger.fatal(
      { err: error },
      "Failed during initialization or MCP server startup",
    );
    process.exit(1);
  }

  // 5. Start QR web server (non-blocking)
  const qrServerPort = Number(process.env.QR_SERVER_PORT ?? 39002);
  const qrServerHost = process.env.QR_SERVER_HOST ?? "127.0.0.1";
  const qrServer = createQrServer(waLogger, manager);
  qrServer.listen(qrServerPort, qrServerHost, () => {
    mcpLogger.info({ host: qrServerHost, port: qrServerPort }, "QR web server listening");
  });
  qrServer.on("error", (err) => {
    mcpLogger.error({ err }, "QR web server error");
  });

  // 6. Start WhatsApp connections LAST -- staggered with p-limit(5)
  mcpLogger.info("Starting WhatsApp connections for all tenants...");
  manager.startAll().catch((error) => {
    mcpLogger.error({ err: error }, "One or more WhatsApp connections failed during startup");
  });

  mcpLogger.info("Application setup complete. Running...");
}

async function shutdown(signal: string) {
  mcpLogger.info(`Received ${signal}. Shutting down gracefully...`);

  await disconnectPrisma().catch((err) => mcpLogger.warn({ err }, "prisma disconnect failed"));

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
