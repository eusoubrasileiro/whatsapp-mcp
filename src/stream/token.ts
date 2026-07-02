/**
 * Short-lived, scoped bearer tokens for the `follow_chat` WebSocket stream.
 *
 * WS clients driven by an agent harness (e.g. Claude Code `Monitor`) cannot set
 * an `Authorization` header, so auth rides the URL query string. The token is
 * therefore treated exactly like a bearer secret: opaque, random, short-lived
 * (renewable), and log-redacted at every call site. Its scope — which chats it
 * may see and the direction/transcription flags — is fixed at issue time and
 * enforced server-side, so a leaked token can only ever replay the same narrow
 * stream it was minted for.
 *
 * State is in-memory only: tokens die with the process (and on TTL). That is the
 * right lifetime — a follow_chat token outlives a single turn but not a session,
 * and there is no value in persisting it across restarts.
 */

import { randomBytes } from "node:crypto";

export interface StreamScope {
  /** Chats this stream may see. `null` = all chats. */
  jids: string[] | null;
  /** Forward the user's own (`is_from_me`) messages — true for persona mode. */
  includeFromMe: boolean;
  /** Transcribe inbound voice notes before framing. */
  transcribe: boolean;
}

export interface StreamToken {
  token: string;
  scope: StreamScope;
  /** Epoch ms after which the token no longer verifies. */
  expiresAt: number;
}

export interface StreamTokenStoreOpts {
  /** Token lifetime in ms (default 30 min). */
  ttlMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Injectable token generator (tests). */
  generateToken?: () => string;
}

export interface StreamTokenStore {
  issue(scope: StreamScope): StreamToken;
  verify(token: string): StreamScope | null;
  renew(token: string): StreamToken | null;
}

const DEFAULT_TTL_MS = 30 * 60_000;

function defaultToken(): string {
  return randomBytes(24).toString("base64url");
}

export function createStreamTokenStore(opts: StreamTokenStoreOpts = {}): StreamTokenStore {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? Date.now;
  const generateToken = opts.generateToken ?? defaultToken;
  const store = new Map<string, StreamToken>();

  function live(token: string): StreamToken | null {
    const entry = store.get(token);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      store.delete(token); // prune lazily on access
      return null;
    }
    return entry;
  }

  return {
    issue(scope) {
      const token = generateToken();
      const entry: StreamToken = { token, scope, expiresAt: now() + ttlMs };
      store.set(token, entry);
      return entry;
    },
    verify(token) {
      return live(token)?.scope ?? null;
    },
    renew(token) {
      const entry = live(token);
      if (!entry) return null;
      entry.expiresAt = now() + ttlMs;
      return entry;
    },
  };
}

/** Process-wide store used by the running server (the tool issues, the WS verifies). */
export const streamTokens: StreamTokenStore = createStreamTokenStore({
  ttlMs: process.env.STREAM_TOKEN_TTL_S
    ? Number(process.env.STREAM_TOKEN_TTL_S) * 1000
    : undefined,
});
