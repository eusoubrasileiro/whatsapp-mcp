import type { FastMCP } from "fastmcp";
import type { Logger } from "pino";
import type { InstanceIdentity } from "../../instance-identity.ts";

/**
 * Structural subset of `FastMCP` exercised by tool registries. Lets us pass a
 * lightweight stub in tests without instantiating the real server.
 */
export interface ToolRegistrar {
  addTool: FastMCP["addTool"];
}

export interface ToolDeps {
  mcpLogger: Logger;
  waLogger: Logger;
  /** Which WhatsApp line this server is; absent or `null` when no `INSTANCE_LABEL` is set. */
  identity?: InstanceIdentity | null;
}
