/**
 * Shared message factory for tests.
 *
 * Seven test files had grown their own near-identical `makeMsg` local; adding
 * an eighth tripped the jscpd duplication ratchet. New tests import this one.
 * The existing copies are left alone deliberately — de-duplicating them is a
 * separate change with its own review, not drive-by churn in this commit.
 */

import type { Message } from "../../database.ts";

/** Build a stored-message row, inbound by default. Override anything. */
export function makeMessage(
  overrides: Partial<Message> & { id: string; chat_jid: string; content: string },
): Message {
  return {
    timestamp: new Date("2025-06-01T12:00:00Z"),
    is_from_me: false,
    sender: "5511999999999@s.whatsapp.net",
    ...overrides,
  };
}
