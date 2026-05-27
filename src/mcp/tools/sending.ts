import { z } from "zod";
import { normalizeJid } from "@amiticia/baileys-client";

import { assertSocketActive } from "../../actions.ts";
import { sendWhatsAppMedia, sendWhatsAppMessage } from "../../whatsapp.ts";
import type { ToolDeps, ToolRegistrar } from "./types.ts";

export function registerSendingTools(server: ToolRegistrar, deps: ToolDeps): void {
  const { mcpLogger, waLogger } = deps;

  server.addTool({
    name: "send_message",
    description: "Send a text message to a contact or group",
    parameters: z.object({
      recipient: z.string().describe("Recipient JID (e.g., 'number@s.whatsapp.net' or 'group@g.us')"),
      message: z.string().min(1).describe("The text message to send"),
    }),
    execute: async ({ recipient, message }) => {
      mcpLogger.info(`[MCP Tool] Executing send_message to ${recipient}`);
      assertSocketActive();

      const normalizedRecipient = normalizeJid(recipient);
      if (!normalizedRecipient.includes("@")) {
        throw new Error(`Invalid recipient format: "${recipient}". JID must contain "@".`);
      }

      const result = await sendWhatsAppMessage(waLogger, normalizedRecipient, message);

      if (result && result.key && result.key.id) {
        return `Message sent successfully to ${normalizedRecipient} (ID: ${result.key.id}).`;
      } else {
        throw new Error(`Failed to send message to ${normalizedRecipient}.`);
      }
    },
  });

  server.addTool({
    name: "send_file",
    description: "Send a file (image, video, document, audio) to a contact or group. file_path accepts: (a) http(s) URL, (b) base64 data: URL — context-heavy, only viable for tiny payloads, (c) absolute path that exists ON THE MCP SERVER (NOT your local disk — the server runs in a remote Docker container and cannot read host files). To send a host-disk file: POST raw bytes to `<MCP host>/upload` (Bearer auth = MCP_AUTH_TOKEN), receive `{url}`, then pass that URL here. Max 16 MB. For type=image the bytes must be JPEG or PNG (WebP screenshots are rejected — convert to PNG first).",
    parameters: z.object({
      recipient: z.string().describe("Recipient JID"),
      file_path: z.string().describe("http(s) URL, base64 data: URL, or server-side absolute path. To send a local host file with a remote MCP, upload it to <MCP host>/upload first and pass the returned URL. Max 16 MB."),
      caption: z.string().optional().describe("Optional caption for images/videos/documents"),
      type: z.enum(['image', 'video', 'document', 'audio']).optional().default('image').describe("Type of the media. For 'image': only JPEG/PNG bytes are accepted (WebP rejected — convert to PNG first). For 'video': MP4/3GPP only. For 'audio': AAC/AMR/MP3/M4A/OGG. (default: image)"),
    }),
    execute: async ({ recipient, file_path, caption, type }) => {
      mcpLogger.info(`[MCP Tool] Executing send_file to ${recipient}: ${file_path}`);
      assertSocketActive();

      const normalizedRecipient = normalizeJid(recipient);
      let result: Awaited<ReturnType<typeof sendWhatsAppMedia>>;
      try {
        result = await sendWhatsAppMedia(waLogger, normalizedRecipient, file_path, caption, type);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to send ${type} to ${normalizedRecipient}: ${reason}`);
      }

      if (result && result.key && result.key.id) {
        return `${type.charAt(0).toUpperCase() + type.slice(1)} sent successfully to ${normalizedRecipient} (ID: ${result.key.id}).`;
      } else {
        throw new Error(`Failed to send ${type} to ${normalizedRecipient} (no message ID returned — socket may be disconnected)`);
      }
    },
  });
}
