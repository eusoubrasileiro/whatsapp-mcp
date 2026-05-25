/**
 * XML envelope renderers for MCP tool responses.
 *
 * Matches the Anthropic-style XML-tag convention used across AmiticIA's
 * Claude-based stack (cf. wahub ADR-007 / prompt loader). Downstream agents
 * parse the wrapper tag (`<transcription>` / `<image_description>`) to
 * reliably separate model output from surrounding metadata.
 */

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderAttrs(attrs: Array<[string, string | number | undefined]>): string {
  return attrs
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}="${escapeAttr(String(v))}"`)
    .join(" ");
}

export interface TranscriptionEnvelope {
  message_id: string;
  chat_jid: string;
  model: string;
  duration_s?: number;
  text: string;
}

export function renderTranscription(env: TranscriptionEnvelope): string {
  const attrs = renderAttrs([
    ["message_id", env.message_id],
    ["chat_jid", env.chat_jid],
    ["model", env.model],
    ["duration_s", env.duration_s],
  ]);
  return `<transcription ${attrs}>\n${escapeText(env.text)}\n</transcription>`;
}

export interface ImageDescriptionEnvelope {
  message_id: string;
  chat_jid: string;
  model: string;
  text: string;
}

export function renderImageDescription(env: ImageDescriptionEnvelope): string {
  const attrs = renderAttrs([
    ["message_id", env.message_id],
    ["chat_jid", env.chat_jid],
    ["model", env.model],
  ]);
  return `<image_description ${attrs}>\n${escapeText(env.text)}\n</image_description>`;
}
