import { spawn } from "node:child_process";
import type { Logger } from "pino";
import QRCode from "qrcode";
import { z } from "zod";
import { executeLogout } from "../../actions.ts";
import { connectionState, startWhatsAppConnection } from "../../whatsapp.ts";
import type { ToolDeps, ToolRegistrar } from "./types.ts";

/**
 * Open an image in the OS viewer — safely.
 *
 * Two guarantees, both load-bearing on a headless server (the canonical Docker
 * deployment): (1) we never even attempt to spawn when there's no desktop
 * session, and (2) we always attach an 'error' listener, because a missing
 * opener binary makes `spawn` emit an 'error' event — and an EventEmitter with
 * no 'error' listener rethrows it as an uncaught exception that crashes the
 * whole process. That crash previously took the production container down
 * whenever `get_connection_status` was called while a QR was pending.
 */
export function openImageInViewer(imagePath: string, logger: Logger): void {
  const hasDesktop =
    process.platform === "darwin" ||
    process.platform === "win32" ||
    Boolean(process.env.DISPLAY) ||
    Boolean(process.env.WAYLAND_DISPLAY);
  if (!hasDesktop) {
    logger.info({ imagePath }, "Headless environment — QR PNG saved but not auto-opened");
    return;
  }
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    const child = spawn(opener, [imagePath], { detached: true, stdio: "ignore" });
    child.on("error", (err) => logger.warn({ err, imagePath }, "Failed to auto-open QR image"));
    child.unref();
  } catch (err) {
    logger.warn({ err, imagePath }, "Failed to spawn image viewer");
  }
}

export function registerConnectionTools(server: ToolRegistrar, deps: ToolDeps): void {
  const { mcpLogger, waLogger } = deps;

  server.addTool({
    name: "get_connection_status",
    description: "Get current WhatsApp connection status and QR code if pending",
    parameters: z.object({}),
    execute: async () => {
      mcpLogger.info("[MCP Tool] Executing get_connection_status");

      if (connectionState.status === "qr_pending" && connectionState.qrCode) {
        const qrPath = "/tmp/whatsapp-mcp-qr.png";
        await QRCode.toFile(qrPath, connectionState.qrCode, { scale: 10 });
        mcpLogger.info({ qrPath }, "QR code saved as PNG");

        openImageInViewer(qrPath, mcpLogger);

        return JSON.stringify(
          {
            status: "qr_pending",
            qr_code_path: qrPath,
            message:
              "QR code saved (and opened if a desktop session is available). Scan with WhatsApp mobile (Settings > Linked Devices), or open the QR web page. Call this tool again after scanning.",
          },
          null,
          2,
        );
      }

      const result: Record<string, unknown> = {
        status: connectionState.status,
      };

      if (connectionState.user) {
        result.user = connectionState.user;
      }

      if (connectionState.status === "connected") {
        result.message = "WhatsApp is connected and ready";
      } else if (connectionState.status === "syncing") {
        result.message = "WhatsApp is connected but syncing history. Some operations may fail.";
        result.sync_progress = {
          chats: connectionState.syncProgress.chats,
          contacts: connectionState.syncProgress.contacts,
          messages: connectionState.syncProgress.messages,
          last_batch_ago_seconds: connectionState.syncProgress.lastBatchAt
            ? Math.round((Date.now() - connectionState.syncProgress.lastBatchAt.getTime()) / 1000)
            : null,
        };
      } else if (connectionState.status === "connecting") {
        result.message = "Connecting to WhatsApp...";
      } else {
        result.message = "WhatsApp is disconnected. Attempting to reconnect...";
        // Trigger lazy reconnection
        startWhatsAppConnection(waLogger).catch((err) => {
          mcpLogger.error({ err }, "Reconnection attempt from get_connection_status failed");
        });
      }

      return JSON.stringify(result, null, 2);
    },
  });

  server.addTool({
    name: "logout",
    description: "Log out from WhatsApp and clear session data",
    parameters: z.object({}),
    execute: async () => {
      mcpLogger.info("[MCP Tool] Executing logout");
      return executeLogout();
    },
  });
}
