import { randomBytes } from "node:crypto";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  RequestListener,
  ServerResponse,
} from "node:http";
import type { Logger } from "pino";
import type { PinGate } from "./auth.ts";
import {
  mcpUrl,
  renderHubPage,
  renderLockedPage,
  renderPinForm,
  renderUnlinkPage,
  renderUnlinkResult,
  type UnlinkError,
} from "./page.ts";
import type { InstanceView, Poller } from "./poller.ts";
import { en, type Strings } from "./strings.ts";
import type { Unlinker } from "./unlink.ts";

/** The only paths a login may send a visitor back to: one lower-case segment, or `/`. */
const SAFE_NEXT = /^\/[a-z0-9-]*$/;
const LABEL_PATH = /^\/[a-z0-9-]+$/;
const QR_PATH = /^\/_hub\/qr\/([a-z0-9-]+)\.png$/;
const UNLINK_PATH = /^\/_hub\/unlink\/([a-z0-9-]+)$/;
const MAX_LOGIN_BODY_BYTES = 2048;

export interface HubListenerOptions {
  /** The cache the page is built from. Handlers never reach an instance themselves. */
  poller: Pick<Poller, "views" | "qrPng">;
  gate: PinGate;
  logger: Logger;
  /** The hub's own public origin, without a trailing slash. The MCP addresses are built from it. */
  publicUrl: string;
  /**
   * Asks an instance to unlink its number. Without it (`null` or unset) the action does not
   * exist: no button, and `/_hub/unlink/<label>` is a 404.
   */
  unlink?: Unlinker | null;
  /** The words of every page. Defaults to English. */
  t?: Strings;
}

export function safeNext(path: string | null): string {
  return path !== null && SAFE_NEXT.test(path) ? path : "/";
}

/** True for the machine's own loopback addresses, v4, v6 or v4-mapped. */
export function isLoopbackPeer(remoteAddress: string | undefined): boolean {
  return (
    remoteAddress !== undefined &&
    (remoteAddress === "::1" || /^(::ffff:)?127\.\d+\.\d+\.\d+$/.test(remoteAddress))
  );
}

/**
 * Who is asking, for the attempt counters. Behind the proxy that is the LAST entry of
 * `X-Forwarded-For` (the proxy appends the peer it saw; earlier entries are the client's to
 * invent), otherwise the socket's own peer.
 */
export function clientAddress(
  headers: IncomingHttpHeaders,
  remoteAddress: string | undefined,
): string {
  const forwarded = headers["x-forwarded-for"];
  if (typeof forwarded === "string") return (forwarded.split(",").pop() ?? "").trim();
  return remoteAddress ?? "unknown";
}

function pathOf(url: string): string {
  const queryAt = url.indexOf("?");
  return queryAt === -1 ? url : url.slice(0, queryAt);
}

function send(
  res: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: string | Buffer,
): void {
  res.writeHead(status, {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    ...headers,
  });
  res.end(body);
}

function sendHtml(
  res: ServerResponse,
  status: number,
  nonce: string,
  html: string,
  extra: Record<string, string> = {},
): void {
  send(
    res,
    status,
    {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": [
        "default-src 'none'",
        "img-src 'self'",
        `style-src 'nonce-${nonce}'`,
        `script-src 'nonce-${nonce}'`,
        "connect-src 'self'",
        "form-action 'self'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
      ...extra,
    },
    html,
  );
}

function notFound(res: ServerResponse): void {
  send(res, 404, { "content-type": "text/plain; charset=utf-8" }, "not found");
}

/** The request body as text, or `null` when it is longer than `limit` bytes. */
function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLong = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (tooLong) return;
      if (size > limit) {
        tooLong = true;
        chunks.length = 0;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function createHubListener(options: HubListenerOptions): RequestListener {
  const { poller, gate, logger, publicUrl } = options;
  const unlink = options.unlink ?? null;
  const t = options.t ?? en;

  /** The posted form, or `null` after answering 413 to one longer than a form can be. */
  async function readForm(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<URLSearchParams | null> {
    const body = await readBody(req, MAX_LOGIN_BODY_BYTES);
    if (body !== null) return new URLSearchParams(body);
    send(
      res,
      413,
      { "content-type": "text/plain; charset=utf-8", connection: "close" },
      "too large",
    );
    return null;
  }

  async function login(req: IncomingMessage, res: ServerResponse, nonce: string): Promise<void> {
    const form = await readForm(req, res);
    if (form === null) return;
    const next = safeNext(form.get("next"));
    const result = gate.attempt(
      clientAddress(req.headers, req.socket.remoteAddress),
      form.get("pin") ?? "",
    );
    if (result.outcome === "ok") {
      send(res, 303, { location: next, "set-cookie": gate.issueCookie() }, "");
    } else if (result.outcome === "locked") {
      sendHtml(res, 429, nonce, renderLockedPage({ nonce, t }), {
        "retry-after": String(result.retryAfterS),
      });
    } else {
      sendHtml(res, 401, nonce, renderPinForm({ nonce, next, failed: true, t }));
    }
  }

  function showPage(res: ServerResponse, nonce: string, path: string): void {
    const views = poller.views();
    const asked = path === "/" ? null : path.slice(1);
    const known = asked === null || views.some((view) => view.label === asked);
    sendHtml(
      res,
      known ? 200 : 404,
      nonce,
      renderHubPage({
        nonce,
        views,
        target: asked,
        unknownLabel: known ? null : asked,
        publicUrl,
        canUnlink: unlink !== null,
        t,
      }),
    );
  }

  /** The confirmation page for `view`, with a fresh token for this session. */
  function sendUnlinkPage(
    req: IncomingMessage,
    res: ServerResponse,
    nonce: string,
    view: InstanceView,
    refusal: { status: number; error: UnlinkError; extra?: Record<string, string> } | null,
  ): void {
    const csrf = gate.csrfToken(req.headers.cookie, view.label) ?? "";
    const html = renderUnlinkPage({ nonce, view, csrf, error: refusal?.error, t });
    sendHtml(res, refusal?.status ?? 200, nonce, html, refusal?.extra);
  }

  /**
   * Unlinking is the one thing here that cannot be undone from the page, so a post runs only when
   * every check holds, in this order: a session; a token and an Origin that prove the form came
   * from this page; an address that is not locked and the right PIN (counted like a login);
   * and the number typed again.
   */
  async function unlinkSubmit(
    req: IncomingMessage,
    res: ServerResponse,
    nonce: string,
    unlinker: Unlinker,
    view: InstanceView,
  ): Promise<void> {
    const form = await readForm(req, res);
    if (form === null) return;
    const refuse = (status: number, error: UnlinkError, extra?: Record<string, string>) =>
      sendUnlinkPage(req, res, nonce, view, { status, error, extra });

    const origin = req.headers.origin;
    if (
      !gate.csrfMatches(req.headers.cookie, view.label, form.get("csrf") ?? "") ||
      (origin !== undefined && origin !== publicUrl)
    ) {
      return refuse(403, "expired");
    }
    const result = gate.attempt(
      clientAddress(req.headers, req.socket.remoteAddress),
      form.get("pin") ?? "",
    );
    if (result.outcome === "locked") {
      return refuse(429, "locked", { "retry-after": String(result.retryAfterS) });
    }
    if (result.outcome === "wrong") return refuse(401, "wrongPin");
    if (form.get("label") !== view.label) return refuse(400, "wrongLabel");

    const outcome = await unlinker.run(view.label);
    logger.info({ label: view.label, outcome }, "hub unlink");
    sendHtml(
      res,
      outcome === "failed" ? 502 : 200,
      nonce,
      renderUnlinkResult({ nonce, label: view.label, outcome, t }),
    );
  }

  async function unlinkRoute(
    req: IncomingMessage,
    res: ServerResponse,
    nonce: string,
    label: string,
  ): Promise<void> {
    const view = poller.views().find((candidate) => candidate.label === label);
    if (!unlink || !view) return notFound(res);
    if (req.method === "POST") return unlinkSubmit(req, res, nonce, unlink, view);
    if (req.method === "GET") return sendUnlinkPage(req, res, nonce, view, null);
    notFound(res);
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const nonce = randomBytes(16).toString("base64");
    const method = req.method ?? "GET";
    const path = pathOf(req.url ?? "/");

    if (method === "GET") {
      // The Docker healthcheck, and only from inside the container: never through the proxy.
      const direct = req.headers["x-forwarded-for"] === undefined;
      if (path === "/live" && direct && isLoopbackPeer(req.socket.remoteAddress)) {
        send(res, 200, { "content-type": "application/json; charset=utf-8" }, '{"live":true}');
        return;
      }
      // MCP clients probe these; they must not be answered with a page.
      if (path === "/favicon.ico" || path.startsWith("/.well-known/")) {
        send(res, 404, {}, "");
        return;
      }
    }
    if (method === "POST" && path === "/_hub/login") return login(req, res, nonce);

    if (!gate.hasSession(req.headers.cookie)) {
      sendHtml(res, 401, nonce, renderPinForm({ nonce, next: safeNext(path), failed: false, t }));
      return;
    }
    const unlinkTarget = UNLINK_PATH.exec(path);
    if (unlinkTarget) return unlinkRoute(req, res, nonce, unlinkTarget[1]);
    if (method !== "GET") return notFound(res);

    if (path === "/_hub/status.json") {
      const instances = poller
        .views()
        .map((view) => ({ ...view, mcp_url: mcpUrl(publicUrl, view.label) }));
      const json = JSON.stringify({ instances });
      send(res, 200, { "content-type": "application/json; charset=utf-8" }, json);
      return;
    }
    const qr = QR_PATH.exec(path);
    if (qr) {
      const png = poller.qrPng(qr[1]);
      if (png) send(res, 200, { "content-type": "image/png" }, png);
      else notFound(res);
      return;
    }
    if (path === "/" || LABEL_PATH.test(path)) return showPage(res, nonce, path);
    notFound(res);
  }

  return async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      logger.error({ err, method: req.method }, "hub request failed");
      if (!res.headersSent)
        send(res, 500, { "content-type": "text/plain; charset=utf-8" }, "internal error");
      else res.end();
    }
  };
}
