/**
 * Whisper transcription via OpenRouter, with Groq/OpenAI kept as rollback lanes.
 *
 * Takes raw bytes (already preprocessed to 16 kHz mono FLAC by `preprocess.ts`)
 * rather than a file path, and is tuned for pt-BR.
 *
 * MIGRATED 2026-08-24. This used the `groq-sdk` and `openai` SDKs and picked
 * between them by which key happened to be set. Both are gone:
 *
 *   - All three vendors expose the SAME OpenAI-shaped multipart
 *     `POST {baseUrl}/audio/transcriptions`, so one plain `fetch` serves every
 *     route and two SDKs no longer need to be in the image for one endpoint.
 *     (Another client of ours claimed OpenRouter needs a JSON+base64 body
 *     instead. That is wrong — OpenRouter documents both shapes, and multipart
 *     was verified end-to-end against a real voice note on 2026-07-31. That
 *     client's tests mocked `fetch`, so they never exercised the claim.)
 *
 *   - The route is chosen by `AUDIO_PROVIDER`, never by key presence. Choosing
 *     by key presence is how a leftover `GROQ_API_KEY` silently keeps traffic
 *     on the old vendor while the migration is reported as done — which matters
 *     here because the Groq account is being closed.
 *
 * Ported from an internal sibling project's transcription client.
 *
 * Cookbook: the 25 MB provider ceiling is sidestepped by preprocessing
 * upstream; the guard here just raises a clearer error if the FLAC still
 * exceeds 24 MB after preprocess.
 */

import type { Logger } from "pino";

const TWENTY_FOUR_MB = 24 * 1024 * 1024;

/**
 * Where each provider lives and what it calls Whisper Large v3. Only these
 * three values differ between routes; the request below serves all of them.
 *
 * `openai/whisper-large-v3` is the same Whisper this used to hit on Groq, and
 * OpenRouter may even route it back to Groq upstream. We simply no longer hold
 * a Groq account.
 *
 * CORRECTION 2026-08-24: an earlier version of this comment claimed OpenRouter
 * has no `-turbo` build. Wrong — `openai/whisper-large-v3-turbo` has been
 * available since 2026-05-01, is ~6x faster (4 decoder layers vs 32) and is
 * cheaper on every provider. Staying on large-v3 is a deliberate call, not a
 * lack of options: the vendor concedes "minor quality degradation" and no
 * pt-BR WER comparison exists to size it. `WHISPER_MODEL` trials it with no
 * code change.
 */
const AUDIO_ROUTES = {
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/whisper-large-v3",
    keyName: "OPENROUTER_API_KEY",
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    model: "whisper-large-v3",
    keyName: "GROQ_API_KEY",
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    model: "whisper-1",
    keyName: "OPENAI_API_KEY",
  },
} as const;

/** Not exported: nothing outside this module names a route. */
type AudioProvider = keyof typeof AUDIO_ROUTES;

export interface TranscribeResult {
  text: string;
  model: string;
  provider: AudioProvider;
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

function resolveProvider(): AudioProvider {
  const raw = process.env.AUDIO_PROVIDER?.trim().toLowerCase();
  if (!raw) return "openrouter";
  if (raw in AUDIO_ROUTES) return raw as AudioProvider;
  throw new TranscribeError(
    `AUDIO_PROVIDER="${raw}" is not a known route (${Object.keys(AUDIO_ROUTES).join(", ")}).`,
  );
}

/**
 * Pull the transcript out of the response body.
 *
 * A body we do not recognise THROWS rather than being passed off as speech:
 * handing `{"error":...}` to an agent as the sender's words fabricates what a
 * human said, which is worse than failing. `whatsapp.ts` already catches and
 * returns null, so a throw degrades to "no transcription", never to a lie.
 */
function readTranscript(body: string): { text: string; duration_s?: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // A provider that ignored response_format and replied with the bare string.
    return { text: body.trim() };
  }
  if (typeof parsed === "object" && parsed !== null && "text" in parsed) {
    const { text, duration } = parsed as { text?: unknown; duration?: unknown };
    if (typeof text === "string") {
      return {
        text: text.trim(),
        duration_s: typeof duration === "number" ? duration : undefined,
      };
    }
  }
  throw new TranscribeError("Transcription response was not in a recognised format.");
}

/**
 * Transcribe a preprocessed audio buffer.
 *
 * Route comes from `AUDIO_PROVIDER` (default `openrouter`); `WHISPER_MODEL`
 * overrides the model on whichever route is active.
 */
export async function transcribeAudio(opts: TranscribeOptions): Promise<TranscribeResult> {
  const { buffer, filename = "audio.flac", language = "pt", logger } = opts;

  if (buffer.length > TWENTY_FOUR_MB) {
    throw new TranscribeError(
      `Preprocessed audio is ${(buffer.length / 1024 / 1024).toFixed(1)} MB — exceeds 24 MB safe ceiling. Chunking not yet implemented; split the source audio before retrying.`,
    );
  }

  const provider = resolveProvider();
  const route = AUDIO_ROUTES[provider];
  const apiKey = process.env[route.keyName];
  if (!apiKey) {
    throw new TranscribeError(
      `${route.keyName} is not set — cannot transcribe audio via ${provider}.`,
    );
  }
  const model = process.env.WHISPER_MODEL?.trim() || route.model;

  logger?.debug({ provider, model, bytes: buffer.length }, "whisper.transcribe start");

  const form = new FormData();
  form.append("file", new File([new Uint8Array(buffer)], filename));
  form.append("model", model);
  // Fixed to Portuguese: guessing the language of a two-second voice note is
  // how a transcript comes back in Spanish.
  form.append("language", language);
  // verbose_json (not "text") because `duration` feeds the duration_s attribute
  // of the <transcription> envelope agents read. OpenRouter supports only
  // json/verbose_json; Groq and OpenAI accept verbose_json too.
  form.append("response_format", "verbose_json");

  let res: Response;
  try {
    res = await fetch(`${route.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
  } catch (err) {
    throw new TranscribeError(`${provider} Whisper request failed: ${(err as Error).message}`, err);
  }

  const body = (await res.text()).trim();
  if (!res.ok) {
    throw new TranscribeError(`${provider} Whisper request failed: HTTP ${res.status} — ${body}`);
  }

  const { text, duration_s } = readTranscript(body);
  if (!text) {
    // Returning "" would let an agent answer confidently about audio nobody heard.
    throw new TranscribeError(`${provider} Whisper returned an empty transcript.`);
  }

  logger?.debug({ provider, model, chars: text.length }, "whisper.transcribe done");
  return { text, model, provider, duration_s };
}
