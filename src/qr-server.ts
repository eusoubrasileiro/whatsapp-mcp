import http, { type Server } from "node:http";
import type { ConnectionState } from "@amiticia/baileys-client";
import type { Logger } from "pino";
import QRCode from "qrcode";
import { CLOCK_RESETTING_STATUSES, LIVE_STATUSES } from "./connection-status.ts";
import { readNonNegativeNumber } from "./env-config.ts";
import { createRouter, type Route } from "./http-router.ts";
import { isBearerOf } from "./hub-instance-secret.ts";
import { type InstanceIdentity, phoneLast4 } from "./instance-identity.ts";

function readGraceSeconds(): number {
  return readNonNegativeNumber(process.env.HEALTH_DISCONNECTED_GRACE_S, 300);
}

export type QrServerOptions = {
  /** Injectable clock in epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Seconds the socket may stay non-live before `/health` answers 503.
   * Defaults to `HEALTH_DISCONNECTED_GRACE_S` (300). `0` disables the 503
   * entirely, so an operator can stop a restart loop without a redeploy.
   */
  disconnectedGraceS?: number;
  /**
   * Which WhatsApp line this server is. When set, `/health` gains `instance` and
   * `phone_last4`; when unset or `null` it is byte-identical to before.
   */
  identity?: InstanceIdentity | null;
  /**
   * Live accessor for the paired account's own phone-number JID (`socket.user.id`), the source
   * of `phone_last4` while a user is paired. Without it `phone_last4` can only come from
   * `EXPECTED_WA_NUMBER`.
   */
  pairedUserId?: () => string | null | undefined;
  /**
   * Lets the hub unlink this number: `POST /internal/unlink`, answered only to
   * `Authorization: Bearer <secret>`. The use case is injected (this module must not reach the
   * WhatsApp adapter); `run` resolves `true` when it logged a connected number out and `false`
   * when there was nothing to log out. Unset or `null`: the route does not exist.
   */
  unlink?: { secret: string; run: () => Promise<boolean> } | null;
};

/**
 * The `/health` keys that name the line. `phone_last4` is `undefined` when no number is known,
 * and `JSON.stringify` drops an `undefined` value, so the key is then absent from the body.
 */
function lineFields(identity: InstanceIdentity, pairedUserId: string | null | undefined) {
  return { instance: { ...identity }, phone_last4: phoneLast4(pairedUserId) };
}

/**
 * `POST /internal/unlink`. The router's own `auth: "bearer"` compares with `===` and answers
 * with text, so the check is done here: constant time, and a refusal is an empty 401 that
 * never reaches the use case.
 */
function unlinkRoute(
  unlink: { secret: string; run: () => Promise<boolean> },
  logger: Logger,
): Route {
  return {
    method: "POST",
    path: "/internal/unlink",
    handler: async (req, res) => {
      if (!isBearerOf(req.headers.authorization, unlink.secret)) {
        res.writeHead(401);
        res.end();
        return;
      }
      const json = { "content-type": "application/json; charset=utf-8" };
      try {
        const unlinked = await unlink.run();
        logger.info({ unlinked }, "the hub unlinked this number");
        res.writeHead(200, json);
        res.end(JSON.stringify({ unlinked }));
      } catch (err) {
        logger.error({ err }, "the hub asked to unlink this number and it failed");
        res.writeHead(502, json);
        res.end(JSON.stringify({ unlinked: false }));
      }
    },
  };
}

export function createQrServer(
  logger: Logger,
  getState: () => ConnectionState,
  options: QrServerOptions = {},
): Server {
  const now = options.now ?? (() => Date.now());
  const graceS = options.disconnectedGraceS ?? readGraceSeconds();
  const identity = options.identity ?? null;

  /**
   * When the socket was last observed in a clock-resetting status. Sampled on
   * each `/health` request — the endpoint Docker polls every 30s — rather than
   * pushed from the connection hooks, because `connectionState` is an object
   * owned and mutated by baileys-client, so there is no transition callback to
   * hang a timestamp off. Sampling makes the reported downtime lag reality by
   * at most one poll interval, and it lags in the safe direction: the last
   * *observed* good moment is never later than the real one.
   */
  let lastLiveAt = now();

  const routes: Route[] = [
    {
      method: "GET",
      path: "/health",
      handler: async (_req, res) => {
        const state = getState();
        if (CLOCK_RESETTING_STATUSES.has(state.status)) lastLiveAt = now();

        const disconnectedForS = Math.max(0, Math.floor((now() - lastLiveAt) / 1000));
        const wedged = graceS > 0 && disconnectedForS > graceS;

        const body = JSON.stringify({
          // `status` stays the WhatsApp connection status — the deploy runbook
          // and existing tests read it. The ok/degraded verdict is `health`.
          status: state.status,
          health: LIVE_STATUSES.has(state.status) ? "ok" : "degraded",
          user: state.user,
          syncProgress: state.syncProgress,
          disconnected_for_s: disconnectedForS,
          grace_s: graceS,
          // Public endpoint: the line's name, and the LAST FOUR digits of its number, never more.
          ...(identity ? lineFields(identity, options.pairedUserId?.()) : {}),
        });
        // Informational only: 503 flags a wedged socket to humans and external
        // monitors. It does NOT restart anything — plain Docker never restarts an
        // unhealthy container, and Traefik drops unhealthy containers from its
        // routes (2026-11-13: 63h of 404s on the MCP and QR URLs). The Docker
        // healthcheck therefore probes /live; the in-process watchdog
        // (connection-watchdog.ts) is what exits and lets `restart:
        // unless-stopped` bring the container back.
        res.writeHead(wedged ? 503 : 200, {
          "content-type": "application/json; charset=utf-8",
        });
        res.end(body);
      },
    },
    {
      // Process liveness for the Docker healthcheck: 200 whenever this HTTP
      // server answers, whatever the WhatsApp socket is doing. Keeping the
      // container "healthy" keeps Traefik routing to it, so the QR page stays
      // reachable exactly when a disconnect needs it.
      method: "GET",
      path: "/live",
      handler: async (_req, res) => {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ live: true }));
      },
    },
    {
      method: "GET",
      path: "/qr.png",
      handler: async (_req, res) => {
        const state = getState();
        if (state.status !== "qr_pending" || !state.qrCode) {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("no QR pending");
          return;
        }
        const png = await QRCode.toBuffer(state.qrCode, {
          errorCorrectionLevel: "M",
          width: 512,
          margin: 2,
        });
        res.writeHead(200, {
          "content-type": "image/png",
          "cache-control": "no-store",
        });
        res.end(png);
      },
    },
    ...(options.unlink ? [unlinkRoute(options.unlink, logger)] : []),
  ];

  return http.createServer(createRouter(routes, { logger }));
}
