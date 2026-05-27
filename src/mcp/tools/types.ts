import type { FastMCP } from "fastmcp";
import type { Logger } from "pino";

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
}
