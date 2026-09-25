/**
 * Testable core of the `follow_chat` MCP tool: mint a scoped stream token and
 * turn it into the `wss://…/stream?token=…` URL an agent attaches to its harness
 * background monitor. No FastMCP, no server — pure token + URL assembly.
 */

import type { StreamTokenStore } from "./token.ts";

export interface FollowChatParams {
  /** Chats to follow. Omit, empty, or `["*"]` = all chats. */
  chatJids?: string[] | null;
  /** Persona mode wants your own messages too — default true. */
  includeFromMe?: boolean;
  /** Transcribe inbound voice notes — default true. */
  transcribe?: boolean;
}

export interface FollowChatDeps {
  tokens: StreamTokenStore;
  /** Public base URL of the stream endpoint, e.g. `wss://mcp.example.com/stream`. */
  baseUrl: string;
}

export interface FollowChatResult {
  ws_url: string;
  expires_at: string;
  note: string;
}

const NOTE =
  "Attach with your harness's background monitor (e.g. Monitor({ws:{url}})). " +
  "Each frame is one inbound message. Reply with send_message; your own sends " +
  "are suppressed and won't wake you. On reconnect, pass ?since=<last seq's cursor> " +
  "to gap-fill. The token is a bearer secret — keep it out of logs.";

/** `["*"]`, empty, or null → null (all chats); otherwise the list as given. */
function normalizeJids(chatJids?: string[] | null): string[] | null {
  if (!chatJids || chatJids.length === 0) return null;
  if (chatJids.includes("*")) return null;
  return chatJids;
}

export function executeFollowChat(
  params: FollowChatParams,
  deps: FollowChatDeps,
): FollowChatResult {
  const scope = {
    jids: normalizeJids(params.chatJids),
    includeFromMe: params.includeFromMe ?? true,
    transcribe: params.transcribe ?? true,
  };
  const issued = deps.tokens.issue(scope);

  const url = new URL(deps.baseUrl);
  url.searchParams.set("token", issued.token);

  return {
    ws_url: url.toString(),
    expires_at: new Date(issued.expiresAt).toISOString(),
    note: NOTE,
  };
}

/** Resolve the public stream base URL from env, with a local-dev fallback. */
export function resolveStreamBaseUrl(): string {
  if (process.env.STREAM_PUBLIC_URL) return process.env.STREAM_PUBLIC_URL;
  const host = process.env.STREAM_SERVER_HOST ?? "127.0.0.1";
  const port = process.env.STREAM_SERVER_PORT ?? "39004";
  return `ws://${host}:${port}/stream`;
}
