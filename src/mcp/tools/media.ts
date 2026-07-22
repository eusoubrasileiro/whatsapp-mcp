import { z } from "zod";

import { executeDownloadMedia } from "../../actions.ts";
import type { ToolDeps, ToolRegistrar } from "./types.ts";

export function registerMediaTools(server: ToolRegistrar, deps: ToolDeps): void {
  const { waLogger } = deps;

  server.addTool({
    name: "download_media",
    description: [
      "Download media (image, video, audio, document, sticker) from a WhatsApp message via S3-compatible storage.",
      "",
      "For audio messages (audio/ptt), `transcribe` defaults to true: the bytes are preprocessed (16 kHz mono FLAC)",
      "and run through Whisper (Groq whisper-large-v3-turbo, falling back to OpenAI whisper-1). The response is an",
      "XML-wrapped <transcription> text block instead of the raw audio. Pass `transcribe: false` to get audio bytes.",
      "",
      "For image messages, `describe` is opt-in (default false). When true, the bytes are sent to Gemini 2.5 Flash",
      "and the response is an XML-wrapped <image_description> text block instead of the inline image.",
      "",
      "For non-audio/non-image media (documents, video, stickers), both flags are no-ops and the tool returns the",
      "standard resource_link.",
    ].join("\n"),
    parameters: z.object({
      message_id: z.string().describe("The ID of the message containing media"),
      chat_jid: z.string().describe("The JID of the chat where the message is"),
      transcribe: z
        .boolean()
        .optional()
        .describe(
          "Audio only: transcribe to text (default true for audio/ptt). Set false to receive raw audio bytes.",
        ),
      describe: z
        .boolean()
        .optional()
        .describe(
          "Image only: caption via Gemini 2.5 Flash (default false). Set true to receive an <image_description> text block instead of the inline image.",
        ),
    }),
    execute: executeDownloadMedia.bind(null, waLogger),
  });
}
