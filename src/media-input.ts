import fs from "node:fs/promises";
import path from "node:path";

export const MAX_MEDIA_BYTES = 16 * 1024 * 1024; // WhatsApp / WABA hard cap
export const FETCH_TIMEOUT_MS = 15_000;

export type ResolvedMedia = {
  buffer: Buffer;
  fileName: string;
  /**
   * MIME type sniffed from the buffer's magic bytes. Falls back to the
   * declared mediatype (data: URL), Content-Type (http), or extension
   * (local path) only when sniffing yields nothing.
   *
   * Sending tools (`sendWhatsAppMedia`) use this to gate the type↔mime
   * allow-list and forward an explicit mimetype to Baileys, so WABA
   * Cloud-API webhook fan-out doesn't drop on mismatched envelopes.
   */
  mimetype: string;
};

export type MediaSendType = "image" | "video" | "document" | "audio";

const ALLOWED_MIMES: Record<Exclude<MediaSendType, "document">, readonly string[]> = {
  image: ["image/jpeg", "image/png"],
  video: ["video/mp4", "video/3gpp"],
  audio: ["audio/aac", "audio/amr", "audio/mpeg", "audio/mp4", "audio/ogg"],
};

/**
 * Validates that a sniffed mimetype matches what Meta's WABA Cloud-API
 * will actually relay. Image/video/audio have strict allow-lists; document
 * is intentionally permissive (Meta accepts a broad set we don't enumerate).
 *
 * The WebP-as-image case is called out explicitly because it's the
 * silent-failure most likely to bite agents using browser screenshots:
 * the recipient device renders WebP fine, but WABA drops the webhook.
 */
export function assertMimeForType(type: MediaSendType, mimetype: string): void {
  if (type === "document") return;

  const allowed = ALLOWED_MIMES[type];
  if (allowed.includes(mimetype)) return;

  if (type === "image" && mimetype === "image/webp") {
    throw new Error(
      `send_file: image/webp can only be sent as a sticker — WABA Cloud-API drops WebP-as-image silently. ` +
        `Convert to PNG/JPEG first, or send via a sticker-typed tool when one is available.`,
    );
  }

  throw new Error(
    `send_file: ${mimetype} bytes cannot be sent as type="${type}" — ` +
      `WABA Cloud-API allows ${allowed.join(", ")} only.`,
  );
}

/**
 * Magic-byte sniffer for the formats WhatsApp/WABA accepts. Returns null
 * when bytes match nothing — caller falls back to declared type.
 */
export function sniffMimetype(buffer: Buffer): string | null {
  if (buffer.length < 4) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "image/png";
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  // GIF: "GIF87a" or "GIF89a"
  if (
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38
  ) {
    return "image/gif";
  }

  // WebP: "RIFF" .... "WEBP"
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "image/webp";
  }

  // PDF: "%PDF"
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
    return "application/pdf";
  }

  // ISO Base Media (MP4, M4A, MOV) — bytes 4..8 = "ftyp"
  if (
    buffer.length >= 12 &&
    buffer[4] === 0x66 &&
    buffer[5] === 0x74 &&
    buffer[6] === 0x79 &&
    buffer[7] === 0x70
  ) {
    const brand = buffer.slice(8, 12).toString("ascii");
    if (brand === "M4A ") return "audio/mp4";
    if (brand === "qt  ") return "video/quicktime";
    if (brand.startsWith("3gp")) return "video/3gpp";
    return "video/mp4";
  }

  // OGG: "OggS"
  if (buffer[0] === 0x4f && buffer[1] === 0x67 && buffer[2] === 0x67 && buffer[3] === 0x53) {
    return "audio/ogg";
  }

  // WAV: "RIFF" .... "WAVE"
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x41 &&
    buffer[10] === 0x56 &&
    buffer[11] === 0x45
  ) {
    return "audio/wav";
  }

  // MP3 frame header (FF Ex/Fx) or ID3v2 tag ("ID3")
  if (
    (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) ||
    (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33)
  ) {
    return "audio/mpeg";
  }

  return null;
}

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
    const ext = path.extname(absPath).slice(1).toLowerCase();
    const mimetype = sniffMimetype(buffer) ?? mimeFromExt(ext) ?? "application/octet-stream";
    return { buffer, fileName: path.basename(absPath), mimetype };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("send_file:")) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`send_file: cannot read local file ${absPath}: ${reason}`);
  }
}

function mimeFromExt(ext: string): string | null {
  const entry = Object.entries(MIME_TO_EXT).find(([, e]) => e === ext);
  return entry ? entry[0] : null;
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
  const contentTypeHeader = res.headers.get("content-type");
  const declaredMime = contentTypeHeader?.split(";")[0].trim() || null;
  const mimetype =
    sniffMimetype(buffer) ?? declaredMime ?? "application/octet-stream";

  return {
    buffer,
    fileName: fileNameFromUrl(url, contentTypeHeader),
    mimetype,
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
  const declared = (mediatype ?? "application/octet-stream").trim();
  // Sniffer wins over the caller's declared mediatype — that's the
  // whole point of the resolver: produce a mimetype that matches the bytes.
  const mimetype = sniffMimetype(buffer) ?? declared;
  return { buffer, fileName: `media.${extFromMime(mimetype)}`, mimetype };
}
