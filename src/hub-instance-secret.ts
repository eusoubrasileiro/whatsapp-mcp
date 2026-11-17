import { createHash, timingSafeEqual } from "node:crypto";
import type { Logger } from "pino";

/** The shortest `HUB_INSTANCE_SECRET` an instance will accept. */
export const MIN_HUB_SECRET_LENGTH = 32;

/**
 * The secret that lets the hub unlink this number, or `null` when the unlink route must not
 * exist: unset, empty, or too short. A too-short value is warned about once and never printed.
 * It never stops the instance from starting: that would take a WhatsApp number down.
 */
export function readHubInstanceSecret(
  env: Record<string, string | undefined>,
  logger: Logger,
): string | null {
  const secret = env.HUB_INSTANCE_SECRET;
  if (!secret) return null;
  if (secret.length < MIN_HUB_SECRET_LENGTH) {
    logger.warn(
      `HUB_INSTANCE_SECRET is shorter than ${MIN_HUB_SECRET_LENGTH} characters: the hub cannot unlink this number`,
    );
    return null;
  }
  return secret;
}

const digest = (text: string) => createHash("sha256").update(text).digest();

/** True when `authorization` is exactly `Bearer <secret>`. Compared in constant time. */
export function isBearerOf(authorization: string | undefined, secret: string): boolean {
  const given = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  const match = timingSafeEqual(digest(given), digest(secret));
  return given !== "" && match;
}
