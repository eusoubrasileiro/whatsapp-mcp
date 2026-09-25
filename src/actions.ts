/**
 * Application-layer actions: orchestrate DB + WhatsApp + Storage.
 *
 * These are the "use cases" that MCP tools delegate to. Extracting them from
 * mcp.ts lets us:
 *  - test them without instantiating a FastMCP server
 *  - keep mcp.ts focused on tool registration / transport concerns
 *  - reuse the same logic from future transports (REST, CLI, …)
 */

import type { MediaType, WhatsAppSocket } from "@amiticia/baileys-client";
import { audioContent, imageContent } from "fastmcp";
import type { Logger } from "pino";

import {
  getContactName,
  getLatestMessage,
  getMessageById,
  updateMessageMediaObjectKey,
} from "./database.ts";
import { describeImage } from "./describe/vision.ts";
import { publicUrlFor, putMedia } from "./storage.ts";
import { toFlacMono16k } from "./transcribe/preprocess.ts";
import { transcribeAudio } from "./transcribe/whisper.ts";
import { downloadMedia, socketState } from "./whatsapp.ts";
import { renderImageDescription, renderTranscription } from "./xml.ts";

export const MEDIA_INLINE_MAX_BYTES = Number(process.env.MEDIA_INLINE_MAX_BYTES ?? 5_242_880);

/** True when the message's media is audio (regular audio or push-to-talk). */
function isAudioMessage(message: {
  media_type?: string | null;
  mimetype?: string | null;
}): boolean {
  const t = message.media_type;
  if (t === "audio" || t === "ptt") return true;
  return Boolean(message.mimetype?.startsWith("audio/"));
}

function isImageMessage(message: {
  media_type?: string | null;
  mimetype?: string | null;
}): boolean {
  if (message.media_type === "image") return true;
  return Boolean(message.mimetype?.startsWith("image/"));
}

/** Throws if the WhatsApp socket is not connected; returns the narrowed socket. */
export function assertSocketActive(): WhatsAppSocket {
  if (!socketState.socket) {
    throw new Error("WhatsApp connection is not active.");
  }
  return socketState.socket;
}

export interface DownloadMediaParams {
  message_id: string;
  chat_jid: string;
  /**
   * For audio messages: when true (default for audio/ptt), preprocess via ffmpeg and
   * run Whisper, returning an XML-wrapped transcription instead of the audio bytes.
   * No-op for non-audio media.
   */
  transcribe?: boolean;
  /**
   * For image messages: when true, run the OpenRouter vision model and return an XML-wrapped
   * description instead of the inline image. Default false (Claude consumers see
   * the image bytes directly via imageContent). No-op for non-image media.
   */
  describe?: boolean;
}

export async function executeDownloadMedia(waLogger: Logger, params: DownloadMediaParams) {
  const { message_id, chat_jid, transcribe, describe } = params;
  waLogger.info(
    `[MCP Tool] Executing download_media for msg ${message_id} in ${chat_jid} (transcribe=${transcribe}, describe=${describe})`,
  );

  const message = getMessageById(message_id, chat_jid);
  if (!message) {
    throw new Error(`Message ${message_id} not found in chat ${chat_jid}.`);
  }
  if (!message.media_type || !message.media_key || !message.direct_path) {
    throw new Error(
      `Message ${message_id} does not contain downloadable media or media metadata is missing.`,
    );
  }

  const mimetype = message.mimetype ?? "application/octet-stream";
  const fileLength = message.file_length ?? 0;
  const isAudio = isAudioMessage(message);
  const isImage = isImageMessage(message);

  // Resolve mode-flag defaults. Audio → transcribe by default; image → describe opt-in only.
  const shouldTranscribe = isAudio && (transcribe ?? true);
  const shouldDescribe = isImage && (describe ?? false);

  // Fetch bytes — from S3 cache if available, else re-download from WhatsApp.
  let buffer: Buffer;
  let ext: string;
  let url: string;
  let cached: boolean;

  if (message.media_object_key) {
    url = publicUrlFor(message.media_object_key);
    ext = message.media_object_key.split(".").pop() ?? "bin";
    waLogger.info(`[MCP Tool] Media already in S3: ${message.media_object_key}`);
    cached = true;
    // Only fetch bytes when needed for an LLM call. Otherwise just return the cached link.
    if (shouldTranscribe || shouldDescribe) {
      buffer = await fetchObjectBytes(message.media_object_key);
    } else {
      const linkBlock = {
        type: "resource_link" as const,
        uri: url,
        name: `${message_id}.${ext}`,
        mimeType: mimetype,
      };
      const textBlock = {
        type: "text" as const,
        text: JSON.stringify(
          {
            status: "cached",
            url,
            media_type: message.media_type,
            mimetype,
            file_size: message.file_length,
          },
          null,
          2,
        ),
      };
      return { content: [linkBlock, textBlock] };
    }
  } else {
    const downloaded = await downloadMedia({
      logger: waLogger,
      mediaKey: message.media_key,
      directPath: message.direct_path,
      mediaUrl: message.media_url ?? null,
      mediaType: message.media_type as MediaType,
      mimetype: message.mimetype ?? null,
      chatJid: chat_jid,
      messageId: message_id,
      fromMe: Boolean(message.is_from_me),
    });
    buffer = downloaded.buffer;
    ext = downloaded.ext;
    const stored = await putMedia({
      chatJid: chat_jid,
      messageId: message_id,
      ext,
      mimetype,
      buffer,
    });
    url = stored.url;
    updateMessageMediaObjectKey(message_id, chat_jid, stored.key);
    cached = false;
  }

  const metaText = JSON.stringify(
    {
      status: cached ? "cached" : "uploaded",
      url,
      media_type: message.media_type,
      mimetype,
      file_size: message.file_length,
    },
    null,
    2,
  );
  const resLink = {
    type: "resource_link" as const,
    uri: url,
    name: `${message_id}.${ext}`,
    mimeType: mimetype,
  };
  const textBlock = { type: "text" as const, text: metaText };

  // Audio + transcribe → return XML transcription instead of audio bytes.
  if (shouldTranscribe) {
    const flac = await toFlacMono16k(buffer);
    const result = await transcribeAudio({
      buffer: flac,
      filename: `${message_id}.flac`,
      logger: waLogger,
    });
    const xml = renderTranscription({
      message_id,
      chat_jid,
      model: result.model,
      duration_s: result.duration_s,
      text: result.text,
    });
    return {
      content: [{ type: "text" as const, text: xml }, resLink, textBlock],
    };
  }

  // Image + describe → return XML description instead of inline image.
  if (shouldDescribe) {
    const result = await describeImage({ buffer, mimetype, logger: waLogger });
    const xml = renderImageDescription({
      message_id,
      chat_jid,
      model: result.model,
      text: result.text,
    });
    return {
      content: [{ type: "text" as const, text: xml }, resLink, textBlock],
    };
  }

  if (mimetype.startsWith("image/") && fileLength < MEDIA_INLINE_MAX_BYTES) {
    const img = await imageContent({ buffer });
    return { content: [img, resLink, textBlock] };
  }

  if (mimetype.startsWith("audio/") && fileLength < MEDIA_INLINE_MAX_BYTES) {
    const aud = await audioContent({ buffer });
    return { content: [aud, resLink, textBlock] };
  }

  return { content: [resLink, textBlock] };
}

/** Fetch raw bytes for a cached media object key. Used when transcribe/describe needs them. */
async function fetchObjectBytes(_key: string): Promise<Buffer> {
  // Lazy import to keep storage.ts a leaf module; allows tests to mock if needed.
  const { getMediaBytes } = await import("./storage.ts");
  return getMediaBytes(_key);
}

export async function executeMarkChatRead(
  waLogger: Logger,
  { chat_jid }: { chat_jid: string },
): Promise<string> {
  waLogger.info(`[MCP Tool] Executing mark_chat_read for ${chat_jid}`);
  const socket = assertSocketActive();

  const latest = getLatestMessage(chat_jid);
  if (!latest) {
    throw new Error(`Cannot mark chat ${chat_jid} as read: no messages stored.`);
  }

  const isGroup = chat_jid.endsWith("@g.us");
  const minimalMessage = {
    key: {
      remoteJid: chat_jid,
      id: latest.id,
      fromMe: latest.is_from_me,
      ...(isGroup && latest.sender ? { participant: latest.sender } : {}),
    },
    messageTimestamp: Math.floor(latest.timestamp.getTime() / 1000),
  };

  await socket.chatModify({ markRead: true, lastMessages: [minimalMessage] as any }, chat_jid);

  return `Chat ${chat_jid} marked as read.`;
}

// ── Connection actions ─────────────────────────────────────────────

export async function executeLogout(): Promise<string> {
  if (socketState.socket) {
    await socketState.socket.logout();
    return "Logged out. Reconnecting for new QR code — call get_connection_status in a few seconds to scan.";
  }
  return "Not currently connected.";
}

// ── Group actions ──────────────────────────────────────────────────

export async function executeGetGroupInfo({ group_jid }: { group_jid: string }): Promise<string> {
  const socket = assertSocketActive();
  if (!group_jid.endsWith("@g.us")) {
    throw new Error(`Invalid group JID: "${group_jid}". Must end with "@g.us".`);
  }

  const metadata = await socket.groupMetadata(group_jid);

  return JSON.stringify(
    {
      jid: metadata.id,
      name: metadata.subject,
      description: metadata.desc ?? null,
      owner: metadata.owner ?? null,
      creation_time: metadata.creation ? new Date(metadata.creation * 1000).toISOString() : null,
      participant_count: metadata.participants.length,
      participants: metadata.participants.map((p: any) => ({
        jid: p.id,
        name: getContactName(p.id) ?? p.id.split("@")[0],
        admin: p.admin ?? null,
      })),
    },
    null,
    2,
  );
}

// ── Message actions ────────────────────────────────────────────────

export async function executeReactToMessage({
  chat_jid,
  message_id,
  emoji,
  from_me,
}: {
  chat_jid: string;
  message_id: string;
  emoji: string;
  from_me: boolean;
}): Promise<string> {
  const socket = assertSocketActive();

  await socket.sendMessage(chat_jid, {
    react: {
      text: emoji,
      key: {
        remoteJid: chat_jid,
        id: message_id,
        fromMe: from_me,
      },
    },
  });

  return emoji
    ? `Reacted with ${emoji} to message ${message_id}.`
    : `Removed reaction from message ${message_id}.`;
}

export async function executeDeleteMessage({
  chat_jid,
  message_id,
  from_me,
}: {
  chat_jid: string;
  message_id: string;
  from_me: boolean;
}): Promise<string> {
  const socket = assertSocketActive();

  await socket.sendMessage(chat_jid, {
    delete: {
      remoteJid: chat_jid,
      id: message_id,
      fromMe: from_me,
    },
  });

  return `Message ${message_id} deleted successfully.`;
}
