import { z } from "zod";
import { formatDbMessageForJson } from "../../formatters.ts";
import { getNewMessagesCore, waitForMessagesCore } from "../../monitoring.ts";
import { executeFollowChat, resolveStreamBaseUrl } from "../../stream/follow.ts";
import { streamTokens } from "../../stream/token.ts";
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
    "Opaque cursor: pass the previous call's `next_since` verbatim to get only messages after it (exclusive, monotonic — never re-delivers the last one). Omit on the first call to start from now. An ISO-8601 timestamp is also accepted to backfill recent history (inclusive from that time).",
  );

const includeFromMeParam = z
  .boolean()
  .optional()
  .default(false)
  .describe(
    "Include YOUR OWN (is_from_me) messages. Default false — the agent's own replies are always excluded regardless.",
  );

export function registerMonitoringTools(server: ToolRegistrar, deps: ToolDeps): void {
  const { mcpLogger } = deps;

  server.addTool({
    name: "get_new_messages",
    description:
      "Delta read: messages received since a cursor, across one or many chats — the cheap way to poll for replies instead of re-scanning each chat. Returns { messages, next_since }; pass next_since back on the next call. Excludes your own messages by default and always excludes this agent's own sends.",
    parameters: z.object({
      chat_jids: chatJidsParam,
      since: sinceParam,
      limit: z
        .number()
        .int()
        .positive()
        .max(200)
        .optional()
        .default(50)
        .describe("Max messages (default 50)"),
      include_from_me: includeFromMeParam,
    }),
    execute: async ({ chat_jids, since, limit, include_from_me }) => {
      mcpLogger.info(
        `[MCP Tool] get_new_messages since=${since ?? "(now)"} chats=${chat_jids?.length ?? "all"}`,
      );
      const result = getNewMessagesCore({
        chatJids: chat_jids,
        since,
        limit,
        includeFromMe: include_from_me,
      });
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
        .describe(
          `Max seconds to block before returning (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}). Loop with next_since to cover longer waits.`,
        ),
      include_from_me: includeFromMeParam,
    }),
    execute: async ({ chat_jids, since, timeout_seconds, include_from_me }, { reportProgress }) => {
      mcpLogger.info(
        `[MCP Tool] wait_for_messages timeout=${timeout_seconds}s chats=${chat_jids?.length ?? "all"}`,
      );
      let beats = 0;
      const result = await waitForMessagesCore({
        chatJids: chat_jids,
        since,
        includeFromMe: include_from_me,
        timeoutMs: timeout_seconds * 1000,
        heartbeatMs: HEARTBEAT_MS,
        // Keep the proxied HTTP connection warm during a long block.
        onHeartbeat: () => {
          void reportProgress?.({
            progress: ++beats,
            total: Math.ceil((timeout_seconds * 1000) / HEARTBEAT_MS),
          });
        },
      });
      return JSON.stringify(
        { messages: result.messages.map(formatDbMessageForJson), next_since: result.next_since },
        null,
        2,
      );
    },
  });

  server.addTool({
    name: "follow_chat",
    description:
      "Become PRESENT in one or more chats: returns a stream URL that pushes each inbound message as it arrives, designed to be attached to your harness's background monitor (e.g. Claude Code Monitor({ws:{url}})) so you are woken per message while continuing other work. THIS is the tool for: monitoring a chat, watching a group, following a conversation, acting as the user's persona in a chat, chatting with people over hours. For a one-shot bounded wait for a reply you expect within minutes, use wait_for_messages. For a deployed headless service with its own HTTPS endpoint, use register_webhook.",
    parameters: z.object({
      chat_jids: chatJidsParam,
      include_from_me: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "Forward YOUR OWN (is_from_me) messages too — default true so persona mode sees replies you type from your phone and doesn't answer twice. The agent's own MCP sends are always suppressed.",
        ),
      transcribe: z
        .boolean()
        .optional()
        .default(true)
        .describe("Transcribe inbound voice notes before pushing the frame (default true)."),
    }),
    execute: async ({ chat_jids, include_from_me, transcribe }) => {
      mcpLogger.info(
        `[MCP Tool] follow_chat chats=${chat_jids?.length ?? "all"} include_from_me=${include_from_me}`,
      );
      const result = executeFollowChat(
        { chatJids: chat_jids, includeFromMe: include_from_me, transcribe },
        { tokens: streamTokens, baseUrl: resolveStreamBaseUrl() },
      );
      return JSON.stringify(result, null, 2);
    },
  });
}
