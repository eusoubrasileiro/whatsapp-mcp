import fs from "node:fs/promises";
import path from "node:path";

export const MAX_MEDIA_BYTES = 16 * 1024 * 1024; // WhatsApp / WABA hard cap
export const FETCH_TIMEOUT_MS = 15_000;

export type ResolvedMedia = {
  buffer: Buffer;
  fileName: string;
};

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/webm": "weba",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "text/plain": "txt",
};

function extFromMime(mime: string): string {
  return MIME_TO_EXT[mime.toLowerCase()] ?? "bin";
}

/**
 * Turn a `file_path` argument from the `send_file` MCP tool into a raw buffer.
 *
 * Accepts three shapes (auto-detected by prefix):
 *   - absolute filesystem path (e.g. `/tmp/img.png`)
 *   - http(s) URL (fetched with 15s timeout, 16 MB cap)
 *   - data: URL (base64 only)
 *
 * Any other shape — `file://`, `ftp://`, relative paths — is rejected with a
 * message that names the detected shape and reason. Errors are caller-surfaced
 * via the MCP `send_file` tool, so phrasing matters for the agent UX.
 */
export async function resolveMediaInput(input: string): Promise<ResolvedMedia> {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error("send_file: file_path must be a non-empty string");
  }

  if (input.startsWith("data:")) {
    return resolveDataUrl(input);
  }

  if (input.startsWith("http://") || input.startsWith("https://")) {
    return resolveHttpUrl(input);
  }

  if (input.startsWith("file://")) {
    throw new Error(`send_file: scheme "file://" not allowed — pass an absolute path instead`);
  }

  // Any other scheme like "ftp://", "minio://", "s3://" — reject explicitly.
  const schemeMatch = input.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (schemeMatch) {
    throw new Error(`send_file: scheme "${schemeMatch[1]}://" not allowed`);
  }

  if (!path.isAbsolute(input)) {
    throw new Error(
      `send_file: "${input}" is not an absolute path, http(s) URL, or data: URL`,
    );
  }

  return resolveLocalPath(input);
}

async function resolveLocalPath(absPath: string): Promise<ResolvedMedia> {
  try {
    const buffer = await fs.readFile(absPath);
    if (buffer.length > MAX_MEDIA_BYTES) {
      throw new Error(
        `send_file: local file ${absPath} is ${buffer.length} bytes, exceeds 16 MB limit`,
      );
    }
    return { buffer, fileName: path.basename(absPath) };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("send_file:")) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`send_file: cannot read local file ${absPath}: ${reason}`);
  }
}

async function resolveHttpUrl(url: string): Promise<ResolvedMedia> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal, redirect: "follow" });
  } catch (err) {
    clearTimeout(timeout);
    const isAbort =
      err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message));
    if (isAbort) {
      throw new Error(`send_file: fetch ${url} timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`send_file: fetch ${url} failed: ${reason}`);
  }
  clearTimeout(timeout);

  if (!res.ok) {
    throw new Error(`send_file: fetch ${url} returned HTTP ${res.status}`);
  }

  const contentLengthHeader = res.headers.get("content-length");
  if (contentLengthHeader) {
    const declared = Number(contentLengthHeader);
    if (Number.isFinite(declared) && declared > MAX_MEDIA_BYTES) {
      throw new Error(
        `send_file: remote resource is ${declared} bytes (Content-Length), exceeds 16 MB limit`,
      );
    }
  }

  const buffer = await readBodyCapped(res, url);

  return {
    buffer,
    fileName: fileNameFromUrl(url, res.headers.get("content-type")),
  };
}

async function readBodyCapped(res: Response, url: string): Promise<Buffer> {
  if (!res.body) {
    const ab = await res.arrayBuffer();
    if (ab.byteLength > MAX_MEDIA_BYTES) {
      throw new Error(
        `send_file: remote resource at ${url} exceeded 16 MB during read`,
      );
    }
    return Buffer.from(ab);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_MEDIA_BYTES) {
        await reader.cancel();
        throw new Error(
          `send_file: remote resource at ${url} exceeded 16 MB during read`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

function fileNameFromUrl(url: string, contentType: string | null): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    if (last && /\.[a-z0-9]{1,8}$/i.test(last)) return decodeURIComponent(last);
    if (last) {
      const ext = contentType ? extFromMime(contentType.split(";")[0].trim()) : "bin";
      return `${decodeURIComponent(last)}.${ext}`;
    }
  } catch {
    // fall through
  }
  const ext = contentType ? extFromMime(contentType.split(";")[0].trim()) : "bin";
  return `media.${ext}`;
}

function resolveDataUrl(input: string): ResolvedMedia {
  // data:[<mediatype>][;base64],<data>
  const match = input.match(/^data:([^,;]+)?(;base64)?,(.*)$/s);
  if (!match) {
    throw new Error("send_file: malformed data URL");
  }
  const [, mediatype, base64Flag, data] = match;
  if (!base64Flag) {
    throw new Error("send_file: data URL must be base64-encoded (no plain-text data URLs supported)");
  }
  const buffer = Buffer.from(data, "base64");
  if (buffer.length === 0) {
    throw new Error("send_file: data URL decoded to empty buffer (malformed base64?)");
  }
  if (buffer.length > MAX_MEDIA_BYTES) {
    throw new Error(
      `send_file: data URL decodes to ${buffer.length} bytes, exceeds 16 MB limit`,
    );
  }
  const mime = (mediatype ?? "application/octet-stream").trim();
  return { buffer, fileName: `media.${extFromMime(mime)}` };
}
