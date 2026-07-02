import { z } from "zod";

import { getNewMessagesCore, waitForMessagesCore } from "../../monitoring.ts";
import { formatDbMessageForJson } from "../../formatters.ts";
import type { ToolDeps, ToolRegistrar } from "./types.ts";

// Long-poll caps. The default is short so the agent stays responsive; the max is
// kept under typical reverse-proxy idle windows (Traefik) — the agent loops with
// the rolling `next_since` cursor to cover hour-scale reply latency cheaply.
const DEFAULT_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 240;
const HEARTBEAT_MS = 20_000;

const chatJidsParam = z
  .array(z.string())
  .optional()
  .describe('Chats to watch (person/group JIDs). Omit or use ["*"] for all chats.');

const sinceParam = z
  .string()
  .optional()
  .describe(
    "ISO-8601 cursor; returns messages at or after it (inclusive). Pass the previous call's `next_since`. Omit on the first call to start from now. Inclusive boundary → dedupe by (id, chat_jid).",
  );

const includeFromMeParam = z
  .boolean()
  .optional()
  .default(false)
  .describe("Include YOUR OWN (is_from_me) messages. Default false — the agent's own replies are always excluded regardless.");

export function registerMonitoringTools(server: ToolRegistrar, deps: ToolDeps): void {
  const { mcpLogger } = deps;

  server.addTool({
    name: "get_new_messages",
    description:
      "Delta read: messages received since a cursor, across one or many chats — the cheap way to poll for replies instead of re-scanning each chat. Returns { messages, next_since }; pass next_since back on the next call. Excludes your own messages by default and always excludes this agent's own sends.",
    parameters: z.object({
      chat_jids: chatJidsParam,
      since: sinceParam,
      limit: z.number().int().positive().max(200).optional().default(50).describe("Max messages (default 50)"),
      include_from_me: includeFromMeParam,
    }),
    execute: async ({ chat_jids, since, limit, include_from_me }) => {
      mcpLogger.info(`[MCP Tool] get_new_messages since=${since ?? "(now)"} chats=${chat_jids?.length ?? "all"}`);
      const result = getNewMessagesCore({ chatJids: chat_jids, since, limit, includeFromMe: include_from_me });
      return JSON.stringify(
        { messages: result.messages.map(formatDbMessageForJson), next_since: result.next_since },
        null,
        2,
      );
    },
  });

  server.addTool({
    name: "wait_for_messages",
    description:
      "Bounded await: block until the next matching message or timeout, then return { messages, next_since }. Returns immediately if one already arrived since the cursor. Use ONLY when you expect a reply within minutes of something you just sent and have nothing else to do meanwhile. Do NOT loop this to stay present in a chat — each empty return wastes one of your turns; for standing presence (monitor/watch/follow/act-as-persona) use `follow_chat` and attach the stream to your harness's background monitor. Excludes your own messages by default and always excludes this agent's own sends.",
    // Backstop above our own cap so FastMCP never times out the call first.
    timeoutMs: (MAX_TIMEOUT_S + 30) * 1000,
    parameters: z.object({
      chat_jids: chatJidsParam,
      since: sinceParam,
      timeout_seconds: z
        .number()
        .int()
        .positive()
        .max(MAX_TIMEOUT_S)
        .optional()
        .default(DEFAULT_TIMEOUT_S)
        .describe(`Max seconds to block before returning (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}). Loop with next_since to cover longer waits.`),
      include_from_me: includeFromMeParam,
    }),
    execute: async ({ chat_jids, since, timeout_seconds, include_from_me }, { reportProgress }) => {
      mcpLogger.info(`[MCP Tool] wait_for_messages timeout=${timeout_seconds}s chats=${chat_jids?.length ?? "all"}`);
      let beats = 0;
      const result = await waitForMessagesCore({
        chatJids: chat_jids,
        since,
        includeFromMe: include_from_me,
        timeoutMs: timeout_seconds * 1000,
        heartbeatMs: HEARTBEAT_MS,
        // Keep the proxied HTTP connection warm during a long block.
        onHeartbeat: () => {
          void reportProgress?.({ progress: ++beats, total: Math.ceil((timeout_seconds * 1000) / HEARTBEAT_MS) });
        },
      });
      return JSON.stringify(
        { messages: result.messages.map(formatDbMessageForJson), next_since: result.next_since },
        null,
        2,
      );
    },
  });
}
