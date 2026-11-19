/**
 * Where a webhook may be delivered.
 *
 * A `target_url` comes from an MCP caller, which may be an agent steered by an inbound message,
 * and each delivery POSTs that chat's messages to it. A public host is the default. An internal
 * one (loopback, the Docker network, the LAN) receives deliveries only when the operator lists its
 * host name in `WEBHOOK_PRIVATE_HOSTS` — for a subscriber that really runs beside this server.
 *
 * Registration refuses what is internal on its face, without DNS: an internal IP literal,
 * `localhost`, a single-label name such as a Docker service. Delivery goes through
 * `outbound-http.ts`, which checks the address actually connected to, so a public-looking name
 * that resolves inside is refused there.
 */
import net from "node:net";
import { type DestinationPolicy, isPublicAddress } from "../outbound-http.ts";

/** The URL's host as a bare name: lowercase, no IPv6 brackets, no trailing dot. */
function bareHost(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "");
}

/** `WEBHOOK_PRIVATE_HOSTS`: comma-separated host names, compared exactly after {@link bareHost}. */
function readPrivateWebhookHosts(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const entries = (env.WEBHOOK_PRIVATE_HOSTS ?? "").split(",").map((h) => bareHost(h.trim()));
  return new Set(entries.filter((h) => h.length > 0));
}

function looksInternal(host: string): boolean {
  if (net.isIP(host) !== 0) return !isPublicAddress(host);
  return host === "localhost" || host.endsWith(".localhost") || !host.includes(".");
}

/** Throws when the target is internal on its face and the operator did not list it. */
export function assertWebhookTarget(url: URL, privateHosts = readPrivateWebhookHosts()): void {
  const host = bareHost(url.hostname);
  if (privateHosts.has(host) || !looksInternal(host)) return;
  throw new Error(
    `target_url host "${host}" is private or internal; webhooks go only to public hosts unless the operator lists the host in WEBHOOK_PRIVATE_HOSTS.`,
  );
}

/** The destination policy for one delivery: public only, unless the operator listed the host. */
export function deliveryPolicy(
  targetUrl: string,
  privateHosts = readPrivateWebhookHosts(),
): DestinationPolicy {
  return privateHosts.has(bareHost(new URL(targetUrl).hostname)) ? { isAllowed: () => true } : {};
}
