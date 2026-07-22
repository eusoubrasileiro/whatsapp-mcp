/**
 * XML envelope renderers for MCP tool responses.
 *
 * Matches the Anthropic-style XML-tag convention used across AmiticIA's
 * Claude-based stack (cf. wahub ADR-007 / prompt loader). Downstream agents
 * parse the wrapper tag (`<transcription>` / `<image_description>`) to
 * reliably separate model output from surrounding metadata.
 *
 * Envelopes are described declaratively as `{ tag, attrs, body }` and rendered
 * by a single `renderEnvelope` function. New envelope shapes only need a new
 * data builder (or an inline literal) — no new escape / formatting code.
 */

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export type EnvelopeAttr = readonly [string, string | number | undefined];

export interface Envelope {
  tag: string;
  attrs: ReadonlyArray<EnvelopeAttr>;
  body: string;
}

export function renderEnvelope(env: Envelope): string {
  const rendered = env.attrs
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}="${escapeAttr(String(v))}"`)
    .join(" ");
  const openTag = rendered.length > 0 ? `<${env.tag} ${rendered}>` : `<${env.tag}>`;
  return `${openTag}\n${escapeText(env.body)}\n</${env.tag}>`;
}

export interface TranscriptionEnvelope {
  message_id: string;
  chat_jid: string;
  model: string;
  duration_s?: number;
  text: string;
}

export function renderTranscription(env: TranscriptionEnvelope): string {
  return renderEnvelope({
    tag: "transcription",
    attrs: [
      ["message_id", env.message_id],
      ["chat_jid", env.chat_jid],
      ["model", env.model],
      ["duration_s", env.duration_s],
    ],
    body: env.text,
  });
}

export interface ImageDescriptionEnvelope {
  message_id: string;
  chat_jid: string;
  model: string;
  text: string;
}

export function renderImageDescription(env: ImageDescriptionEnvelope): string {
  return renderEnvelope({
    tag: "image_description",
    attrs: [
      ["message_id", env.message_id],
      ["chat_jid", env.chat_jid],
      ["model", env.model],
    ],
    body: env.text,
  });
}
