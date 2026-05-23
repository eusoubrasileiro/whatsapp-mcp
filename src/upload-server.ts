import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Logger } from "pino";
import { MAX_MEDIA_BYTES, extFromMime, sniffMimetype } from "./media-input.ts";

export interface UploadServerOptions {
  /**
   * Persists the uploaded bytes and returns a publicly-readable URL. Injected
   * so tests can stub out the S3 layer; in `main.ts` it's bound to the
   * `putUpload` function from `storage.ts`.
   */
  putUpload: (params: {
    buffer: Buffer;
    mimetype: string;
    ext: string;
  }) => Promise<{ key: string; url: string }>;

  /**
   * If set, `POST /upload` requires `Authorization: Bearer <token>`. Match the
   * MCP endpoint's auth so the same secret unlocks both surfaces.
   * `GET /health` stays public so Traefik / Docker health probes work.
   */
  authToken?: string;

  maxBytes?: number;
}

/**
 * Bridges the host-filesystem → remote-MCP-container gap for `send_file`.
 * The agent POSTs raw file bytes here, gets back a public URL, and passes
 * that URL to `send_file` — no base64 in the agent's context window.
 *
 * The endpoint sniffs the magic bytes (`sniffMimetype`) and rejects anything
 * unrecognised: this keeps random executables / oversized junk out of the
 * media bucket. WABA-specific MIME gating still happens at send time in
 * `assertMimeForType`, so this is a coarser first-pass filter.
 */
export function createUploadServer(
  logger: Logger,
  options: UploadServerOptions,
): Server {
  const maxBytes = options.maxBytes ?? MAX_MEDIA_BYTES;

  return http.createServer(async (req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    try {
      if (method === "GET" && url === "/health") {
        sendJson(res, 200, { status: "ok" });
        return;
      }

      if (url === "/upload") {
        if (method !== "POST") {
          res.writeHead(405, { allow: "POST", "content-type": "text/plain" });
          res.end("method not allowed");
          return;
        }

        if (!authorize(req, options.authToken)) {
          res.writeHead(401, { "content-type": "text/plain" });
          res.end("unauthorized");
          return;
        }

        const body = await readBodyCapped(req, maxBytes);
        if (body === "too-large") {
          res.writeHead(413, { "content-type": "text/plain" });
          res.end(`payload exceeds ${maxBytes} bytes`);
          return;
        }

        if (body.length === 0) {
          res.writeHead(400, { "content-type": "text/plain" });
          res.end("empty body");
          return;
        }

        const mimetype = sniffMimetype(body);
        if (!mimetype) {
          res.writeHead(415, { "content-type": "text/plain" });
          res.end("unsupported media type (could not sniff MIME from bytes)");
          return;
        }

        const ext = extFromMime(mimetype);
        const { key, url: publicUrl } = await options.putUpload({
          buffer: body,
          mimetype,
          ext,
        });

        logger.info({ key, mimetype, size: body.length }, "upload stored");

        sendJson(res, 200, {
          url: publicUrl,
          key,
          mimetype,
          size: body.length,
        });
        return;
      }

      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    } catch (err) {
      logger.error({ err, url, method }, "upload-server request failed");
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("internal error");
      } else {
        res.end();
      }
    }
  });
}

function authorize(req: IncomingMessage, authToken: string | undefined): boolean {
  if (!authToken) return true;
  const header = req.headers.authorization;
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw || !raw.startsWith("Bearer ")) return false;
  return raw.slice(7) === authToken;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function readBodyCapped(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Buffer | "too-large"> {
  const declared = Number(req.headers["content-length"] ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    req.resume();
    return "too-large";
  }

  return await new Promise<Buffer | "too-large">((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;

    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      total += chunk.length;
      if (total > maxBytes) {
        aborted = true;
        req.resume();
        resolve("too-large");
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (aborted) return;
      resolve(Buffer.concat(chunks));
    });

    req.on("error", (err) => {
      if (aborted) return;
      reject(err);
    });
  });
}
