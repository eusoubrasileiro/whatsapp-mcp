/**
 * Child-process entry for the e2e suite: boots the real servers through the SAME
 * `startServers` that `src/main.ts` uses, and stops there. It never calls
 * `startWhatsAppConnection`, so no Baileys socket is ever created.
 *
 * Run as: node --experimental-strip-types --import ./no-egress.ts serve.ts
 * Config comes from the environment (the harness in `server.ts` sets it). Prints one JSON
 * line on stdout once everything listens; a failed start prints the error and exits 1.
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { closeDatabase } from "../../src/database.ts";
import { createAppLoggers, startServers } from "../../src/server-startup.ts";

const dataDir = process.env.WHATSAPP_MCP_DATA_DIR;
if (!dataDir || process.env.MCP_TRANSPORT !== "httpstream") {
  console.error("e2e serve: WHATSAPP_MCP_DATA_DIR and MCP_TRANSPORT=httpstream are required");
  process.exit(2);
}

const portOf = (server: Server | null): number | null =>
  (server?.address() as AddressInfo | null)?.port ?? null;

const { mcpLogger, waLogger } = createAppLoggers(dataDir);

const shutdown = () => {
  closeDatabase();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
// The harness holds our stdin open for as long as it lives: if it dies without killing us
// (a crashed test run), the pipe closes and we leave instead of squatting on ports.
process.stdin.resume();
process.stdin.on("close", shutdown);

try {
  const servers = await startServers({ mcpLogger, waLogger });
  console.log(
    JSON.stringify({
      e2e: "ready",
      mcp: Number(process.env.MCP_PORT),
      qr: portOf(servers.qr),
      upload: portOf(servers.upload),
      stream: portOf(servers.stream),
    }),
  );
} catch (err) {
  console.error(`E2E_SERVER_START_FAILED ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
}
