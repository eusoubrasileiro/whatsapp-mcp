/**
 * Send-path guards shared by `send_message` and `send_file`.
 *
 * Kept out of the FastMCP tool bodies so the policy is testable on its own.
 * Both guards are env-switchable: an operator can restore the old
 * fire-and-forget behavior without a redeploy.
 */

import { waitForAckError } from "./ack-bus.ts";
import { formatAckErrorForAgent } from "./ack-errors.ts";

type Env = Record<string, string | undefined>;

/**
 * How long to wait for a rejection ack before declaring the send accepted.
 *
 * The observed ack latency is ~40 ms, so the 3 s default carries ~75× headroom.
 * Latency here is deliberately not optimised: a slow, correct answer beats a
 * fast one that leaves the agent believing a dead message was delivered.
 * `0` disables the wait entirely.
 */
export function getSendAckWaitMs(env: Env = process.env): number {
  const raw = env.SEND_ACK_WAIT_MS;
  if (raw === undefined) return 3000;
  const parsed = Number(raw);
  // Junk or negative must not silently disable the guard.
  if (!Number.isFinite(parsed) || parsed < 0) return 3000;
  return parsed;
}

/** Whether to verify the recipient exists before sending. On unless explicitly disabled. */
export function isPresendCheckEnabled(env: Env = process.env): boolean {
  return env.SEND_PRESEND_CHECK !== "false";
}

/**
 * Throw if the server rejected the message we just sent.
 *
 * `sendMessage()` resolving means "written to the socket", not "accepted" — the
 * refusal arrives moments later. Without this, `send_message` returns
 * "sent successfully" for messages that never existed to the recipient.
 */
export async function assertSendAccepted(
  msgId: string,
  recipient: string,
  waitMs: number,
): Promise<void> {
  if (waitMs <= 0) return;

  const ackError = await waitForAckError(msgId, waitMs);
  if (!ackError) return;

  throw new Error(formatAckErrorForAgent(ackError, recipient));
}
