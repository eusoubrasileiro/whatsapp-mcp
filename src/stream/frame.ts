/**
 * Pure builder: one persisted DB message → one `follow_chat` stream frame.
 * No I/O — the caller resolves `senderDisplay` (via `getContactName`, mirroring
 * `formatDbMessageForJson`) and any voice-note `transcription` before calling.
 *
 * Field conventions mirror `src/formatters.ts` so the stream and the pull tools
 * describe the same message the same way.
 */

import type { Message } from "../database.ts";

export interface StreamFrameReplyTo {
  id: string;
  sender_display: string;
  excerpt: string;
}

export interface StreamFrameMedia {
  type: string;
  mimetype: string | null;
  /** Whisper transcript for audio/ptt when transcription was requested, else null. */
  transcription: string | null;
  /** Handle to pass to `download_media` (with `chat_jid`) to fetch the bytes. */
  fetch_id: string;
}

export interface StreamFrame {
  seq: number;
  id: string;
  chat_jid: string;
  chat_name: string;
  sender_jid: string | null;
  sender_display: string;
  is_from_me: boolean;
  content: string;
  timestamp: string;
  /**
   * Quoted-reply context ("Para o Dave 👆"). Always `null` today: the current
   * parse/persistence layer does not carry the quoted message. The field is part
   * of the contract so consumers can start reading it the moment the data lands
   * (see docs/agent-presence-stream-recipe.md → "Known gaps").
   */
  reply_to: StreamFrameReplyTo | null;
  media: StreamFrameMedia | null;
}

export function buildStreamFrame(
  msg: Message,
  seq: number,
  senderDisplay: string,
  transcription: string | null = null,
): StreamFrame {
  return {
    seq,
    id: msg.id,
    chat_jid: msg.chat_jid,
    chat_name: msg.chat_name ?? "Unknown Chat",
    sender_jid: msg.sender ?? null,
    sender_display: senderDisplay,
    is_from_me: msg.is_from_me,
    content: msg.content,
    timestamp: msg.timestamp.toISOString(),
    reply_to: null,
    media: msg.media_type
      ? {
          type: msg.media_type,
          mimetype: msg.mimetype ?? null,
          transcription,
          fetch_id: msg.id,
        }
      : null,
  };
}
