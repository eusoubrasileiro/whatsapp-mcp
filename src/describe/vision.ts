/**
 * Image description via Google Gemini 2.5 Flash.
 *
 * Cheapest acceptable vision model for pt-BR WhatsApp images (menus, products,
 * documents, screenshots). Reuses GEMINI_API_KEY env var.
 */

import { GoogleGenAI } from "@google/genai";
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

export async function describeImage(opts: DescribeOptions): Promise<DescribeResult> {
  const { buffer, mimetype, prompt = DEFAULT_PROMPT_PT, logger } = opts;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new DescribeError("GEMINI_API_KEY is not set — cannot describe image.");
  }

  const model = process.env.VISION_MODEL ?? "gemini-2.5-flash";
  logger?.debug({ model, mimetype, bytes: buffer.length }, "vision.describe start");

  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: mimetype, data: buffer.toString("base64") } },
            { text: prompt },
          ],
        },
      ],
    });

    const text = (response as any).text ?? extractText(response);
    if (!text || typeof text !== "string") {
      throw new DescribeError("Gemini returned no text content.");
    }
    logger?.debug({ model, chars: text.length }, "vision.describe done");
    return { text: text.trim(), model };
  } catch (err) {
    if (err instanceof DescribeError) throw err;
    throw new DescribeError(`Gemini vision request failed: ${(err as Error).message}`, err);
  }
}

function extractText(response: any): string {
  const candidates = response?.candidates ?? [];
  for (const cand of candidates) {
    const parts = cand?.content?.parts ?? [];
    const merged = parts
      .map((p: any) => p?.text ?? "")
      .filter(Boolean)
      .join("");
    if (merged) return merged;
  }
  return "";
}
