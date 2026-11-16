import type { ConnectionStatus } from "@amiticia/baileys-client";

/**
 * Statuses in which the WhatsApp socket is actually usable. Anything else is
 * reported as `degraded`, whatever the HTTP status ends up being.
 */
export const LIVE_STATUSES: ReadonlySet<ConnectionStatus> = new Set<ConnectionStatus>([
  "connected",
  "syncing",
]);

/**
 * Statuses that reset the degradation clock.
 *
 * `qr_pending` is deliberately included even though it is *not* live: it means
 * the server is waiting on a human to scan, which no container restart can fix
 * — a restart would destroy the very QR code the operator is looking at. So a
 * pairing-needed container reports `degraded` with HTTP 200, forever, and the
 * clock only starts once pairing moves on.
 *
 * `connecting` is deliberately *excluded*. The 2026-07-28 outage sat wedged for
 * ~21h while `/health` answered 200; a reconnect loop that flaps
 * disconnected→connecting→disconnected must accumulate downtime, or the grace
 * window can never elapse and the container stays "healthy" through a wedge.
 *
 * Shared by `/health` (qr-server.ts) and the in-process watchdog
 * (connection-watchdog.ts) so the two can never disagree about what "down" is.
 */
export const CLOCK_RESETTING_STATUSES: ReadonlySet<ConnectionStatus> = new Set<ConnectionStatus>([
  ...LIVE_STATUSES,
  "qr_pending",
]);
