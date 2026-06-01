import { z } from "zod";

import {
  executeDeregisterWebhook,
  executeListWebhooks,
  executeRegisterWebhook,
} from "../../webhooks/actions.ts";
import type { ToolDeps, ToolRegistrar } from "./types.ts";

export function registerWebhooksTools(server: ToolRegistrar, deps: ToolDeps): void {
  const { mcpLogger } = deps;

  server.addTool({
    name: "register_webhook",
    description:
      "Subscribe a URL to inbound WhatsApp messages so an agent becomes reactive (real-time push). Only messages from chats on `allowed_jids` are forwarded; everyone else is silently ignored. Returns the subscription id.",
    parameters: z.object({
      target_url: z.string().url().describe("HTTPS endpoint that receives inbound_message events"),
      allowed_jids: z
        .array(z.string())
        .min(1)
        .describe('Chats (person/group JIDs) allowed to wake this subscription. Use ["*"] for all chats.'),
      secret: z
        .string()
        .optional()
        .describe("Shared secret used to sign deliveries (HMAC) or as a Bearer token. Recommended."),
      auth_mode: z
        .enum(["hmac", "bearer"])
        .optional()
        .default("hmac")
        .describe("How the secret authenticates deliveries: 'hmac' signature header (default) or 'bearer' Authorization"),
      transcribe: z
        .boolean()
        .optional()
        .default(true)
        .describe("Auto-transcribe forwarded voice notes before delivery (default true)"),
      label: z.string().optional().describe("Human label for managing this subscription"),
    }),
    execute: async ({ target_url, allowed_jids, secret, auth_mode, transcribe, label }) => {
      mcpLogger.info(`[MCP Tool] Executing register_webhook for ${target_url} (${allowed_jids.length} jid(s))`);
      const result = executeRegisterWebhook({ target_url, allowed_jids, secret, auth_mode, transcribe, label });
      return JSON.stringify(result, null, 2);
    },
  });

  server.addTool({
    name: "deregister_webhook",
    description: "Remove a webhook subscription by id (from register_webhook / list_webhooks).",
    parameters: z.object({
      id: z.string().describe("The subscription id to remove"),
    }),
    execute: async ({ id }) => {
      mcpLogger.info(`[MCP Tool] Executing deregister_webhook for ${id}`);
      return JSON.stringify(executeDeregisterWebhook(id), null, 2);
    },
  });

  server.addTool({
    name: "list_webhooks",
    description: "List active webhook subscriptions for this tenant (secrets redacted).",
    parameters: z.object({}),
    execute: async () => {
      mcpLogger.info("[MCP Tool] Executing list_webhooks");
      return JSON.stringify(executeListWebhooks(), null, 2);
    },
  });
}
