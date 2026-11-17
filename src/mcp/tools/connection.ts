import { spawn } from "node:child_process";
import type { Logger } from "pino";
import QRCode from "qrcode";
import { z } from "zod";
import { executeLogout } from "../../actions.ts";
import { buildConnectionReport, isQrReady, QR_PNG_PATH } from "../../connection-report.ts";
import { connectionState, socketState, startWhatsAppConnection } from "../../whatsapp.ts";
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

      if (isQrReady(connectionState)) {
        await QRCode.toFile(QR_PNG_PATH, connectionState.qrCode, { scale: 10 });
        mcpLogger.info({ qrPath: QR_PNG_PATH }, "QR code saved as PNG");

        openImageInViewer(QR_PNG_PATH, mcpLogger);
      }

      const report = buildConnectionReport(connectionState, {
        identity: deps.identity ?? null,
        pairedId: socketState.socket?.user?.id,
        now: Date.now(),
      });

      if (report.reconnect) {
        // Trigger lazy reconnection
        startWhatsAppConnection(waLogger).catch((err) => {
          mcpLogger.error({ err }, "Reconnection attempt from get_connection_status failed");
        });
      }

      return JSON.stringify(report.body, null, 2);
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
