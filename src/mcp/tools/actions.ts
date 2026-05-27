import { z } from "zod";

import {
  executeDeleteMessage,
  executeMarkChatRead,
  executeReactToMessage,
} from "../../actions.ts";
import type { ToolDeps, ToolRegistrar } from "./types.ts";

export function registerActionsTools(server: ToolRegistrar, deps: ToolDeps): void {
  const { mcpLogger } = deps;

  server.addTool({
    name: "react_to_message",
    description: "React to a message with an emoji",
    parameters: z.object({
      chat_jid: z.string().describe("The chat JID where the message is"),
      message_id: z.string().describe("The ID of the message to react to"),
      emoji: z.string().describe("The emoji to react with (e.g., '👍', '❤️', '😂'). Use empty string to remove reaction."),
      from_me: z.boolean().optional().default(false).describe("Whether the target message was sent by you"),
    }),
    execute: async ({ chat_jid, message_id, emoji, from_me }) => {
      mcpLogger.info(`[MCP Tool] Executing react_to_message: ${emoji} on ${message_id} in ${chat_jid}`);
      return executeReactToMessage({ chat_jid, message_id, emoji, from_me });
    },
  });

  server.addTool({
    name: "delete_message",
    description: "Delete (revoke) a message you sent",
    parameters: z.object({
      chat_jid: z.string().describe("The chat JID where the message is"),
      message_id: z.string().describe("The ID of the message to delete"),
      from_me: z.boolean().optional().default(true).describe("Whether the message was sent by you (default true)"),
    }),
    execute: async ({ chat_jid, message_id, from_me }) => {
      mcpLogger.info(`[MCP Tool] Executing delete_message: ${message_id} in ${chat_jid}`);
      return executeDeleteMessage({ chat_jid, message_id, from_me });
    },
  });

  server.addTool({
    name: "mark_chat_read",
    description: "Mark all messages in a chat as read",
    parameters: z.object({
      chat_jid: z.string().describe("The chat JID to mark as read"),
    }),
    execute: executeMarkChatRead.bind(null, mcpLogger),
  });
}
