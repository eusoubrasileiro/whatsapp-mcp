import { z } from "zod";
import QRCode from "qrcode";
import { spawn } from "node:child_process";

import { connectionState, startWhatsAppConnection } from "../../whatsapp.ts";
import { executeLogout } from "../../actions.ts";
import type { ToolDeps, ToolRegistrar } from "./types.ts";

export function registerConnectionTools(server: ToolRegistrar, deps: ToolDeps): void {
  const { mcpLogger, waLogger } = deps;

  server.addTool({
    name: "get_connection_status",
    description: "Get current WhatsApp connection status and QR code if pending",
    parameters: z.object({}),
    execute: async () => {
      mcpLogger.info("[MCP Tool] Executing get_connection_status");

      if (connectionState.status === 'qr_pending' && connectionState.qrCode) {
        const qrPath = "/tmp/whatsapp-mcp-qr.png";
        await QRCode.toFile(qrPath, connectionState.qrCode, { scale: 10 });
        mcpLogger.info({ qrPath }, "QR code saved as PNG");

        const child = spawn("xdg-open", [qrPath], {
          detached: true,
          stdio: "ignore",
        });
        child.unref();

        return JSON.stringify({
          status: "qr_pending",
          qr_code_path: qrPath,
          message: "QR code saved and opened. Scan with WhatsApp mobile (Settings > Linked Devices). Call this tool again after scanning.",
        }, null, 2);
      }

      const result: Record<string, unknown> = {
        status: connectionState.status,
      };

      if (connectionState.user) {
        result.user = connectionState.user;
      }

      if (connectionState.status === 'connected') {
        result.message = "WhatsApp is connected and ready";
      } else if (connectionState.status === 'syncing') {
        result.message = "WhatsApp is connected but syncing history. Some operations may fail.";
        result.sync_progress = {
          chats: connectionState.syncProgress.chats,
          contacts: connectionState.syncProgress.contacts,
          messages: connectionState.syncProgress.messages,
          last_batch_ago_seconds: connectionState.syncProgress.lastBatchAt
            ? Math.round((Date.now() - connectionState.syncProgress.lastBatchAt.getTime()) / 1000)
            : null,
        };
      } else if (connectionState.status === 'connecting') {
        result.message = "Connecting to WhatsApp...";
      } else {
        result.message = "WhatsApp is disconnected. Attempting to reconnect...";
        // Trigger lazy reconnection
        startWhatsAppConnection(waLogger).catch((err) => {
          mcpLogger.error({ err }, "Reconnection attempt from get_connection_status failed");
        });
      }

      return JSON.stringify(result, null, 2);
    }
  });

  server.addTool({
    name: "logout",
    description: "Log out from WhatsApp and clear session data",
    parameters: z.object({}),
    execute: async () => {
      mcpLogger.info("[MCP Tool] Executing logout");
      return executeLogout();
    }
  });
}
