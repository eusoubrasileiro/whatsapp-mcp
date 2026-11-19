/**
 * HTTP requests to URLs an agent chose, which must never reach this host's private side.
 *
 * `send_file` downloads a URL and sends the body to a chat; a webhook POSTs to a URL. Both URLs
 * come from an MCP caller, which may be an agent steered by an inbound message. Unchecked, either
 * reaches what only this container can: loopback, the Docker network every stack on the host
 * shares (other numbers' stores and status ports, other products), the LAN, and the cloud
 * metadata service at 169.254.169.254.
 *
 * The check runs where the connection is made, not before: the DNS lookup the socket uses is
 * wrapped, so the address checked is the address connected to, and a name that answers public
 * once and private the next time (DNS rebinding) cannot slip between a check and a connect. An IP
 * literal skips DNS, so it is checked before the request. Redirects are followed by hand and each
 * hop goes through the same gate. Every request opens its own socket (`agent: false`): a socket
 * pooled by another client in this process, such as the media store's, is never reused for a URL
 * that was not checked.
 */
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/** IPv4 ranges that are not globally reachable (IANA special-purpose registry). */
const NON_PUBLIC_V4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT, also Tailscale
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // private, Docker networks
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
];

/** IPv6 ranges that are not globally reachable, or that embed an IPv4 address. */
const NON_PUBLIC_V6: ReadonlyArray<readonly [string, number]> = [
  ["::", 96], // unspecified, loopback, IPv4-compatible
  ["64:ff9b::", 96], // NAT64, embeds an IPv4 address
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard
  ["2001::", 32], // Teredo, tunnels to an IPv4 address
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4, embeds an IPv4 address
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
];

const NON_PUBLIC = new net.BlockList();
for (const [prefix, bits] of NON_PUBLIC_V4) NON_PUBLIC.addSubnet(prefix, bits, "ipv4");
for (const [prefix, bits] of NON_PUBLIC_V6) NON_PUBLIC.addSubnet(prefix, bits, "ipv6");

/**
 * True for a globally reachable IP address. Anything else, including a string that is not an IP
 * address, is false. An IPv4-mapped IPv6 address (`::ffff:10.0.0.1`) is judged as its IPv4.
 */
export function isPublicAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 0) return false;
  return !NON_PUBLIC.check(ip, family === 4 ? "ipv4" : "ipv6");
}

export type OutboundFailure = "blocked" | "timeout" | "too-large" | "network";

/** Why an outbound request did not produce a response. */
export class OutboundError extends Error {
  readonly kind: OutboundFailure;
  constructor(kind: OutboundFailure, message: string) {
    super(message);
    this.name = "OutboundError";
    this.kind = kind;
  }
}

/** `dns.lookup` with `all: true`, the only shape the guard calls. */
export type LookupAll = (
  hostname: string,
  options: dns.LookupAllOptions,
  callback: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void,
) => void;

/** Which destinations a request may reach. The defaults are the production policy. */
export interface DestinationPolicy {
  /** Decides each address a request would connect to. Default: {@link isPublicAddress}. */
  isAllowed?: (ip: string) => boolean;
  /** Resolves a host name. Default: `dns.lookup`. */
  lookup?: LookupAll;
}

function blocked(host: string, ip: string): OutboundError {
  const what = host === ip ? `${ip} is` : `${host} resolves to ${ip},`;
  return new OutboundError("blocked", `refused: ${what} a private, loopback or link-local address`);
}

/**
 * A socket `lookup` that resolves every address of `hostname` and fails unless all of them are
 * allowed. Answers in whichever shape the socket asked for.
 */
export function guardLookup(
  isAllowed: (ip: string) => boolean,
  lookup: LookupAll,
): net.LookupFunction {
  return (hostname, options, callback) => {
    lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, "");
      const refused = addresses.find((a) => !isAllowed(a.address));
      if (refused) return callback(blocked(hostname, refused.address), "");
      if (addresses.length === 0) {
        return callback(new OutboundError("network", `${hostname} has no address`), "");
      }
      if (options.all) return callback(null, addresses);
      return callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

export interface OutboundRequest extends DestinationPolicy {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  /** Whole exchange, every redirect included. */
  timeoutMs: number;
  /** Largest response body accepted. */
  maxBytes: number;
  /** Redirects followed (as GET). A redirect beyond this is returned as the response. */
  maxRedirects: number;
  /** false: the body is drained unread and `body` is empty. Default true. */
  readBody?: boolean;
}

export interface OutboundResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  /** The URL that answered, after redirects. */
  url: string;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Performs one request to `url` under the destination policy; see the module comment. */
export async function outboundRequest(
  url: string,
  opts: OutboundRequest,
): Promise<OutboundResponse> {
  const isAllowed = opts.isAllowed ?? isPublicAddress;
  const lookup = guardLookup(isAllowed, opts.lookup ?? (dns.lookup as LookupAll));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    let target = new URL(url);
    let method = opts.method ?? "GET";
    let body = opts.body;
    for (let hop = 0; ; hop++) {
      const res = await send(target, { method, headers: opts.headers, body }, lookup, isAllowed, {
        signal: controller.signal,
      });
      const location = res.headers.location;
      if (REDIRECTS.has(res.statusCode ?? 0) && location && hop < opts.maxRedirects) {
        res.resume();
        target = new URL(location, target);
        method = "GET";
        body = undefined;
        continue;
      }
      const read = opts.readBody === false ? drain(res) : readCapped(res, opts.maxBytes);
      return {
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: await read,
        url: target.href,
      };
    }
  } catch (err) {
    if (controller.signal.aborted) {
      throw new OutboundError("timeout", `timed out after ${opts.timeoutMs}ms`);
    }
    if (err instanceof OutboundError) throw err;
    throw new OutboundError("network", err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

interface Outgoing {
  method: string;
  headers?: Record<string, string>;
  body?: string;
}

function send(
  target: URL,
  out: Outgoing,
  lookup: net.LookupFunction,
  isAllowed: (ip: string) => boolean,
  { signal }: { signal: AbortSignal },
): Promise<http.IncomingMessage> {
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new OutboundError("blocked", `refused: ${target.protocol} URLs are not fetched`);
  }
  // A literal address never reaches `lookup`, so it is judged here. URL brackets IPv6.
  const host = target.hostname.replace(/^\[(.*)\]$/, "$1");
  if (net.isIP(host) !== 0 && !isAllowed(host)) throw blocked(host, host);
  const client = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      target,
      { method: out.method, headers: out.headers, lookup, signal, agent: false },
      resolve,
    );
    req.on("error", reject);
    req.end(out.body);
  });
}

/** Rejects when the connection closes before the body ended (a timeout destroys it). */
function rejectOnEarlyClose(res: http.IncomingMessage, reject: (err: Error) => void): void {
  res.on("error", reject);
  res.on("close", () => {
    if (!res.complete) reject(new OutboundError("network", "connection closed before the end"));
  });
}

function drain(res: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    rejectOnEarlyClose(res, reject);
    res.on("end", () => resolve(Buffer.alloc(0)));
    res.resume();
  });
}

function readCapped(res: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers["content-length"]);
  if (declared > maxBytes) {
    res.destroy();
    return Promise.reject(
      new OutboundError("too-large", `response is ${declared} bytes, over the ${maxBytes} limit`),
    );
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    res.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        res.destroy();
        reject(new OutboundError("too-large", `response exceeded the ${maxBytes} byte limit`));
        return;
      }
      chunks.push(chunk);
    });
    rejectOnEarlyClose(res, reject);
    res.on("end", () => resolve(Buffer.concat(chunks)));
  });
}
