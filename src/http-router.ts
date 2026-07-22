import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import type { Logger } from "pino";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface RouteContext {
  logger: Logger;
}

export interface Route {
  method: HttpMethod;
  path: string;
  /**
   * `"bearer"` gates the route behind `Authorization: Bearer <bearerToken>`
   * (the router's `bearerToken` option). If the router has no bearerToken,
   * the route is treated as public — same semantics as the legacy
   * upload-server / mcp HTTP guard when `MCP_AUTH_TOKEN` is unset.
   */
  auth?: "bearer";
  handler: (req: IncomingMessage, res: ServerResponse, ctx: RouteContext) => Promise<void> | void;
}

export interface RouterOptions {
  logger: Logger;
  bearerToken?: string;
}

/**
 * Lightweight dispatcher shared by `qr-server` and `upload-server`. Wraps the
 * patterns both servers were hand-rolling: method+path match, Bearer auth,
 * `405 + Allow` for path-without-method, `404 not found`, and `500 internal
 * error` for handler exceptions (preserving partially-sent responses).
 */
export function createRouter(routes: Route[], opts: RouterOptions): RequestListener {
  const { logger, bearerToken } = opts;

  return async function routerListener(req, res) {
    const url = req.url ?? "/";
    const method = (req.method ?? "GET").toUpperCase();
    const path = pathOf(url);

    try {
      const pathMatches = routes.filter((r) => r.path === path);

      if (pathMatches.length === 0) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }

      const route = pathMatches.find((r) => r.method === method);
      if (!route) {
        const allow = pathMatches.map((r) => r.method).join(", ");
        res.writeHead(405, { allow, "content-type": "text/plain" });
        res.end("method not allowed");
        return;
      }

      if (route.auth === "bearer" && bearerToken !== undefined) {
        if (!authorizeBearer(req, bearerToken)) {
          res.writeHead(401, { "content-type": "text/plain" });
          res.end("unauthorized");
          return;
        }
      }

      await route.handler(req, res, { logger });
    } catch (err) {
      logger.error({ err, url, method }, "http-router request failed");
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("internal error");
      } else {
        res.end();
      }
    }
  };
}

function pathOf(url: string): string {
  const queryIdx = url.indexOf("?");
  return queryIdx === -1 ? url : url.slice(0, queryIdx);
}

function authorizeBearer(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw?.startsWith("Bearer ")) return false;
  return raw.slice(7) === token;
}
