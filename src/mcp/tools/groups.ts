import { z } from "zod";

import { executeGetGroupInfo } from "../../actions.ts";
import type { ToolDeps, ToolRegistrar } from "./types.ts";

export function registerGroupsTools(server: ToolRegistrar, deps: ToolDeps): void {
  const { mcpLogger } = deps;

  server.addTool({
    name: "get_group_info",
    description: "Get metadata for a WhatsApp group (name, description, participants, admins)",
    parameters: z.object({
      group_jid: z.string().describe("The group JID (must end with '@g.us')"),
    }),
    execute: async ({ group_jid }) => {
      mcpLogger.info(`[MCP Tool] Executing get_group_info for ${group_jid}`);
      return executeGetGroupInfo({ group_jid });
    },
  });
}
