/**
 * The token that guards this server's network listeners: the MCP endpoint over HTTP and the
 * `/upload` server. Both act as this WhatsApp line, so without a token they would act for anyone
 * who reaches the port.
 *
 * No token fails closed: startup refuses to open either listener, and the MCP endpoint refuses
 * every request. `MCP_ALLOW_NO_AUTH=true` is the one explicit way to run open, for a development
 * machine. stdio needs no token: its caller is the process that started this server.
 */
import type { IncomingHttpHeaders } from "node:http";

/** `MCP_AUTH_TOKEN`, or `undefined` when unset or blank. A set token is used exactly as given. */
export function readAuthToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.MCP_AUTH_TOKEN;
  return raw !== undefined && raw.trim() !== "" ? raw : undefined;
}

/** True only for `MCP_ALLOW_NO_AUTH=true` (case and surrounding spaces ignored). */
export function allowsNoAuth(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MCP_ALLOW_NO_AUTH?.trim().toLowerCase() === "true";
}

/** Throws, naming each listener that would be open, when a listener would start without a token. */
export function assertListenersGuarded(env: NodeJS.ProcessEnv = process.env): void {
  if (readAuthToken(env) !== undefined || allowsNoAuth(env)) return;
  const open: string[] = [];
  if ((env.MCP_TRANSPORT ?? "stdio").toLowerCase() !== "stdio") open.push("the MCP endpoint");
  if (env.S3_ENABLED === "true") open.push("the upload server");
  if (open.length === 0) return;
  throw new Error(
    `MCP_AUTH_TOKEN is not set, so ${open.join(" and ")} would accept anyone. Set MCP_AUTH_TOKEN, or MCP_ALLOW_NO_AUTH=true on a development machine.`,
  );
}

/** The startup warning when the HTTP endpoint runs open by the flag; `null` otherwise. */
export function openEndpointWarning(
  token: string | undefined,
  allowNoAuth: boolean,
): string | null {
  return token === undefined && allowNoAuth
    ? "MCP_ALLOW_NO_AUTH=true and no MCP_AUTH_TOKEN — the HTTP MCP endpoint accepts anyone. Development only."
    : null;
}

/**
 * FastMCP's `authenticate`: returns for an allowed request, throws a 401 `Response` otherwise.
 * `request` is `undefined` over stdio.
 */
export function authenticateMcpRequest(
  request: { headers: IncomingHttpHeaders } | undefined,
  token: string | undefined,
  allowNoAuth: boolean,
): Record<string, never> {
  if (!request) return {};
  if (token === undefined) {
    if (allowNoAuth) return {};
    throw new Response(null, { status: 401, statusText: "MCP_AUTH_TOKEN is not set" });
  }
  const header = request.headers.authorization;
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw?.startsWith("Bearer ")) {
    throw new Response(null, {
      status: 401,
      statusText: "Missing or invalid Authorization header",
    });
  }
  if (raw.slice(7) !== token) {
    throw new Response(null, { status: 401, statusText: "Invalid token" });
  }
  return {};
}
