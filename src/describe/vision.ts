/**
 * Image description via OpenRouter (OpenAI-compatible chat completions).
 *
 * The image travels inline as a base64 data URL, so no upload step or vendor
 * SDK is needed — one plain `fetch`, same pattern as `transcribe/whisper.ts`,
 * reusing its `OPENROUTER_API_KEY`. The default model is a cheap, fast
 * image-input model picked from the live OpenRouter catalogue; `VISION_MODEL`
 * swaps it with no code change.
 */

import type { Logger } from "pino";

const DEFAULT_PROMPT_PT = [
  "Descreva esta imagem em português brasileiro de forma objetiva e útil",
  "para um agente que ajuda pequenos negócios via WhatsApp. Inclua:",
  "(1) tipo de conteúdo (foto, captura de tela, documento, etc.),",
  "(2) elementos visuais principais,",
  "(3) qualquer texto legível transcrito literalmente.",
  "Seja conciso (no máximo 3 parágrafos curtos).",
].join(" ");

export interface DescribeResult {
  text: string;
  model: string;
}

export interface DescribeOptions {
  buffer: Buffer;
  mimetype: string;
  prompt?: string;
  logger?: Logger;
}

export class DescribeError extends Error {
  override cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "DescribeError";
    this.cause = cause;
  }
}

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_VISION_MODEL = "openai/gpt-6-luna";

export async function describeImage(opts: DescribeOptions): Promise<DescribeResult> {
  const { buffer, mimetype, prompt = DEFAULT_PROMPT_PT, logger } = opts;

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new DescribeError("OPENROUTER_API_KEY is not set — cannot describe image.");
  }

  const model = process.env.VISION_MODEL?.trim() || DEFAULT_VISION_MODEL;
  logger?.debug({ model, mimetype, bytes: buffer.length }, "vision.describe start");

  const payload = {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          {
            type: "image_url",
            image_url: { url: `data:${mimetype};base64,${buffer.toString("base64")}` },
          },
        ],
      },
    ],
  };

  let res: Response;
  try {
    res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new DescribeError(`OpenRouter vision request failed: ${(err as Error).message}`, err);
  }

  const body = await res.text();
  if (!res.ok) {
    throw new DescribeError(
      `OpenRouter vision request failed: HTTP ${res.status} — ${body.trim()}`,
    );
  }

  let text = "";
  try {
    text = extractText(JSON.parse(body));
  } catch (err) {
    throw new DescribeError("OpenRouter vision response was not valid JSON.", err);
  }
  if (!text) {
    throw new DescribeError("OpenRouter returned no text content.");
  }
  logger?.debug({ model, chars: text.length }, "vision.describe done");
  return { text: text.trim(), model };
}

interface ChatCompletion {
  choices?: { message?: { content?: unknown } }[];
}

/** `content` is a string on most providers, an array of typed parts on some. */
function extractText(response: ChatCompletion): string {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === "object" && "text" in p ? String(p.text ?? "") : ""))
      .join("");
  }
  return "";
}
