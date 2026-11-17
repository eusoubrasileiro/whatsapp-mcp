import type { ConnectionState } from "@amiticia/baileys-client";

/** A disconnected `ConnectionState`, with whatever the test needs overridden. */
export function stateOf(overrides: Partial<ConnectionState> = {}): ConnectionState {
  return {
    status: "disconnected",
    qrCode: null,
    qrAscii: null,
    user: null,
    syncProgress: { chats: 0, contacts: 0, messages: 0, lastBatchAt: null },
    ...overrides,
  };
}
