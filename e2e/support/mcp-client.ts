/**
 * A deliberately small MCP client for the Streamable HTTP transport, written over `fetch` so
 * the suite adds no dependency: initialize, `notifications/initialized`, then JSON-RPC calls
 * carrying the `Mcp-Session-Id` the server handed out.
 */

const ACCEPT = "application/json, text/event-stream";

export interface RpcResponse {
  status: number;
  sessionId: string | null;
  /** The JSON-RPC message, or `null` when the response carried none (401, 202). */
  message: { id?: number; result?: any; error?: { code: number; message: string } } | null;
}

/** The first JSON-RPC message in a response, whether sent as plain JSON or as SSE `data:` lines. */
function parseBody(text: string, contentType: string): RpcResponse["message"] {
  if (!text.trim()) return null;
  if (!contentType.includes("text/event-stream")) return JSON.parse(text);
  const data = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .find(Boolean);
  return data ? JSON.parse(data) : null;
}

/** One raw JSON-RPC POST; `token: undefined` sends no Authorization header at all. */
export async function post(
  url: string,
  body: unknown,
  headers: Record<string, string | undefined> = {},
): Promise<RpcResponse> {
  const sent: Record<string, string> = { "content-type": "application/json", accept: ACCEPT };
  for (const [name, value] of Object.entries(headers)) if (value !== undefined) sent[name] = value;
  const res = await fetch(url, { method: "POST", headers: sent, body: JSON.stringify(body) });
  return {
    status: res.status,
    sessionId: res.headers.get("mcp-session-id"),
    message: parseBody(await res.text(), res.headers.get("content-type") ?? ""),
  };
}

export const initializeRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "whatsapp-mcp-e2e", version: "0.0.0" },
  },
};

interface ToolResult {
  isError: boolean;
  text: string;
}

export interface McpSession {
  serverInfo: { name: string; version: string };
  listTools(): Promise<string[]>;
  callTool(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

/** Opens a session with the Bearer token; throws if the server does not accept it. */
export async function openSession(url: string, token: string): Promise<McpSession> {
  const auth = `Bearer ${token}`;
  const init = await post(url, initializeRequest, { authorization: auth });
  if (init.status !== 200 || !init.sessionId || !init.message?.result) {
    throw new Error(`initialize failed: HTTP ${init.status} ${JSON.stringify(init.message)}`);
  }
  const headers = { authorization: auth, "mcp-session-id": init.sessionId };
  await post(url, { jsonrpc: "2.0", method: "notifications/initialized" }, headers);

  let nextId = 2;
  const request = async (method: string, params?: unknown) => {
    const res = await post(url, { jsonrpc: "2.0", id: nextId++, method, params }, headers);
    if (res.status !== 200 || res.message?.error) {
      throw new Error(`${method} failed: HTTP ${res.status} ${JSON.stringify(res.message)}`);
    }
    return res.message?.result;
  };

  return {
    serverInfo: init.message.result.serverInfo,
    async listTools() {
      const result = await request("tools/list");
      return (result.tools as Array<{ name: string }>).map((t) => t.name);
    },
    async callTool(name, args = {}) {
      const result = await request("tools/call", { name, arguments: args });
      const text = (result.content as Array<{ type: string; text?: string }>)
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n");
      return { isError: Boolean(result.isError), text };
    },
    async close() {
      await fetch(url, { method: "DELETE", headers });
    },
  };
}
