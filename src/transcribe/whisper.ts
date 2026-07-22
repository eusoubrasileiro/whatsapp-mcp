/**
 * Whisper transcription with Groq (primary) → OpenAI (fallback) providers.
 *
 * Mirrors the per-product `whisper.ts` shape in agendazap/wahub/optizap but
 * takes raw bytes (already preprocessed to 16 kHz mono FLAC) instead of a
 * file path. Tuned for pt-BR.
 *
 * Cookbook: Groq's 25 MB silent-fail-at-30 MB ceiling is sidestepped by
 * preprocessing upstream; the sanity guard here just raises a clearer error
 * if the FLAC still exceeds 24 MB after preprocess.
 */

import Groq from "groq-sdk";
import OpenAI from "openai";
import { toFile } from "openai/uploads";
import type { Logger } from "pino";

const TWENTY_FOUR_MB = 24 * 1024 * 1024;

export interface TranscribeResult {
  text: string;
  model: string;
  provider: "groq" | "openai";
  duration_s?: number;
}

export interface TranscribeOptions {
  buffer: Buffer;
  filename?: string;
  language?: string;
  logger?: Logger;
}

export class TranscribeError extends Error {
  override cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "TranscribeError";
    this.cause = cause;
  }
}

/**
 * Transcribe a preprocessed audio buffer.
 *
 * Provider selection:
 *   - GROQ_API_KEY set → Groq (whisper-large-v3-turbo by default).
 *   - else OPENAI_API_KEY set → OpenAI (whisper-1).
 *   - else throw.
 */
export async function transcribeAudio(opts: TranscribeOptions): Promise<TranscribeResult> {
  const { buffer, filename = "audio.flac", language = "pt", logger } = opts;

  if (buffer.length > TWENTY_FOUR_MB) {
    throw new TranscribeError(
      `Preprocessed audio is ${(buffer.length / 1024 / 1024).toFixed(1)} MB — exceeds 24 MB safe ceiling. Chunking not yet implemented; split the source audio before retrying.`,
    );
  }

  const groqKey = process.env.GROQ_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (!groqKey && !openaiKey) {
    throw new TranscribeError(
      "Neither GROQ_API_KEY nor OPENAI_API_KEY is set — cannot transcribe audio.",
    );
  }

  if (groqKey) {
    const model = process.env.WHISPER_MODEL ?? "whisper-large-v3-turbo";
    logger?.debug({ provider: "groq", model, bytes: buffer.length }, "whisper.transcribe start");
    try {
      const groq = new Groq({ apiKey: groqKey });
      const file = await toFile(buffer, filename);
      const response = await groq.audio.transcriptions.create({
        file,
        model,
        language,
        response_format: "verbose_json",
      });
      const text = typeof response === "string" ? response : ((response as any).text ?? "");
      const duration_s =
        typeof response === "object" && response && "duration" in response
          ? Number((response as any).duration)
          : undefined;
      logger?.debug({ provider: "groq", model, chars: text.length }, "whisper.transcribe done");
      return { text, model, provider: "groq", duration_s };
    } catch (err) {
      throw new TranscribeError(`Groq Whisper request failed: ${(err as Error).message}`, err);
    }
  }

  const model = "whisper-1";
  logger?.debug({ provider: "openai", model, bytes: buffer.length }, "whisper.transcribe start");
  try {
    const openai = new OpenAI({ apiKey: openaiKey! });
    const file = await toFile(buffer, filename);
    const response = await openai.audio.transcriptions.create({
      file,
      model,
      language,
      response_format: "verbose_json",
    });
    const text = typeof response === "string" ? response : ((response as any).text ?? "");
    const duration_s =
      typeof response === "object" && response && "duration" in response
        ? Number((response as any).duration)
        : undefined;
    logger?.debug({ provider: "openai", model, chars: text.length }, "whisper.transcribe done");
    return { text, model, provider: "openai", duration_s };
  } catch (err) {
    throw new TranscribeError(`OpenAI Whisper request failed: ${(err as Error).message}`, err);
  }
}
