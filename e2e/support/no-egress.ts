/**
 * Preloaded (`node --import`) into every server the e2e suite spawns: the process may talk to
 * loopback and to unix sockets, nothing else.
 *
 * Why: the suite must NEVER open a WhatsApp connection (docs/account-restrictions.md). The
 * start-up code under test does not, but one MCP tool (`get_connection_status` while
 * disconnected) and any future code path can. This is the mechanical backstop: the first
 * non-loopback `connect` (a Baileys websocket, a fetch, a DNS-named host) ends the process
 * with exit code 97 BEFORE any packet leaves the machine, and names the target on stderr.
 *
 * It patches `net.Socket.prototype.connect`, which every client in the process funnels through
 * (net, tls, undici/fetch, http, ws, the minio client).
 */
import net from "node:net";

export const EGRESS_BLOCKED_EXIT_CODE = 97;

const LOOPBACK_HOST = /^(localhost|127(\.\d{1,3}){3}|::1|\[::1\])$/i;

interface Target {
  host: string | null;
  port: string | null;
  ipc: boolean;
}

/** `connect()` takes `(options)`, `(port, host?)`, `(path)` or Node's own normalised `[options]`. */
function targetOf(args: unknown[]): Target {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first && typeof first === "object") {
    const o = first as { host?: string; port?: number | string; path?: string };
    if (o.path) return { host: null, port: null, ipc: true };
    return { host: o.host ?? "localhost", port: String(o.port ?? ""), ipc: false };
  }
  if (typeof first === "number" || /^\d+$/.test(String(first))) {
    return {
      host: typeof args[1] === "string" ? args[1] : "localhost",
      port: String(first),
      ipc: false,
    };
  }
  return { host: null, port: null, ipc: true };
}

const connect = net.Socket.prototype.connect;

net.Socket.prototype.connect = function patchedConnect(this: net.Socket, ...args: unknown[]) {
  const target = targetOf(args);
  if (!target.ipc && !LOOPBACK_HOST.test(target.host ?? "")) {
    process.stderr.write(`E2E_EGRESS_BLOCKED ${target.host}:${target.port}\n`);
    process.exit(EGRESS_BLOCKED_EXIT_CODE);
  }
  return (connect as (...a: unknown[]) => net.Socket).apply(this, args);
} as typeof net.Socket.prototype.connect;
