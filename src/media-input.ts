import fs from "node:fs/promises";
import path from "node:path";
import { isWithin, type LocalSendConfig, readLocalSendConfig } from "./local-send-dir.ts";
import {
  extensionFor,
  mimeFromExtension,
  sniffMedia,
  sniffMimetype as sniffMimetypeImpl,
} from "./sniffed-media.ts";

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
 * Re-exported from `sniffed-media.ts` for back-compat with callers that
 * import directly from `media-input.ts` (notably `upload-server.ts`).
 * New code should import from `sniffed-media.ts` directly.
 */
export const sniffMimetype = sniffMimetypeImpl;

/**
 * Re-exported from `sniffed-media.ts` — same back-compat rationale as
 * `sniffMimetype`. New code should use `extensionFor` directly.
 */
export function extFromMime(mime: string): string {
  return extensionFor(mime);
}

/**
 * Turn a `file_path` argument from the `send_file` MCP tool into a raw buffer.
 *
 * Accepts three shapes (auto-detected by prefix):
 *   - absolute filesystem path inside the local send directory (`local-send-dir.ts`)
 *   - http(s) URL (fetched with 15s timeout, 16 MB cap)
 *   - data: URL (base64 only)
 *
 * Any other shape — `file://`, `ftp://`, relative paths — is rejected with a
 * message that names the detected shape and reason. Errors are caller-surfaced
 * via the MCP `send_file` tool, so phrasing matters for the agent UX.
 */
export async function resolveMediaInput(
  input: string,
  local: LocalSendConfig = readLocalSendConfig(),
): Promise<ResolvedMedia> {
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
    throw new Error(`send_file: "${input}" is not an absolute path, http(s) URL, or data: URL`);
  }

  return resolveLocalPath(input, local);
}

/**
 * Reads `absPath` only when its real path (every symlink and `..` resolved) lies inside the real
 * send directory. A send directory that is, holds or sits inside a protected directory (the
 * pairing credentials, the database) sends nothing: whatever else lies next to those is this
 * server's own too. The final open refuses a symlink, so a link swapped in after the check is not
 * followed either.
 */
async function resolveLocalPath(absPath: string, local: LocalSendConfig): Promise<ResolvedMedia> {
  const root = await fs.realpath(local.root).catch(() => {
    throw new Error(
      `send_file: local files are only sent from ${local.root}, which does not exist on this server. ${SEND_INSTEAD}`,
    );
  });
  for (const dir of local.protectedDirs) {
    // A protected directory not created yet is judged by its path.
    const protectedDir = await fs.realpath(dir).catch(() => path.resolve(dir));
    if (isWithin(root, protectedDir) || isWithin(protectedDir, root)) {
      throw new Error(
        `send_file: local files are not sent from ${local.root}, because it holds this server's own files (${dir}). Point SEND_FILE_LOCAL_DIR at a directory of its own. ${SEND_INSTEAD}`,
      );
    }
  }
  try {
    const real = await fs.realpath(absPath);
    if (!isWithin(root, real)) {
      throw new Error(
        `send_file: ${absPath} is outside ${local.root}, the only directory this server sends local files from. ${SEND_INSTEAD}`,
      );
    }
    const handle = await fs.open(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error(`send_file: ${absPath} is not a regular file`);
      if (stat.size > MAX_MEDIA_BYTES) {
        throw new Error(
          `send_file: local file ${absPath} is ${stat.size} bytes, exceeds 16 MB limit`,
        );
      }
      const buffer = await handle.readFile();
      const ext = path.extname(absPath).slice(1).toLowerCase();
      const sniffed = sniffMedia(buffer);
      const mimetype = sniffed?.mimetype ?? mimeFromExtension(ext) ?? "application/octet-stream";
      return { buffer, fileName: path.basename(absPath), mimetype };
    } finally {
      await handle.close();
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("send_file:")) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`send_file: cannot read local file ${absPath}: ${reason}`);
  }
}

const SEND_INSTEAD =
  "To send a file from elsewhere, POST it to /upload and pass the returned URL, or pass an http(s) or data: URL.";

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
  const mimetype = sniffMimetypeImpl(buffer) ?? declaredMime ?? "application/octet-stream";

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
      throw new Error(`send_file: remote resource at ${url} exceeded 16 MB during read`);
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
        throw new Error(`send_file: remote resource at ${url} exceeded 16 MB during read`);
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
      const ext = contentType ? extensionFor(contentType.split(";")[0].trim()) : "bin";
      return `${decodeURIComponent(last)}.${ext}`;
    }
  } catch {
    // fall through
  }
  const ext = contentType ? extensionFor(contentType.split(";")[0].trim()) : "bin";
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
    throw new Error(
      "send_file: data URL must be base64-encoded (no plain-text data URLs supported)",
    );
  }
  const buffer = Buffer.from(data, "base64");
  if (buffer.length === 0) {
    throw new Error("send_file: data URL decoded to empty buffer (malformed base64?)");
  }
  if (buffer.length > MAX_MEDIA_BYTES) {
    throw new Error(`send_file: data URL decodes to ${buffer.length} bytes, exceeds 16 MB limit`);
  }
  const declared = (mediatype ?? "application/octet-stream").trim();
  // Sniffer wins over the caller's declared mediatype — that's the
  // whole point of the resolver: produce a mimetype that matches the bytes.
  const mimetype = sniffMimetypeImpl(buffer) ?? declared;
  return { buffer, fileName: `media.${extensionFor(mimetype)}`, mimetype };
}
