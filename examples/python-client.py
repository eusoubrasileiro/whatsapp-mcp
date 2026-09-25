"""
Minimal Python client for whatsapp-mcp over HTTPS JSON-RPC.

Usage:
    export MCP_URL='https://mcp.example.com/mcp'
    export MCP_AUTH_TOKEN='...'
    python3 python-client.py                    # list chats (limit 5)
    python3 python-client.py list_contacts      # any tool name
    python3 python-client.py send_message '{"recipient":"5531...@s.whatsapp.net","message":"hi"}'

No MCP SDK. Pure httpx. Suitable for n8n "Execute Command" nodes, scripts,
glue code, etc. Requires Python 3.10+ and `pip install httpx`.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any

import httpx

MCP_URL = os.environ.get("MCP_URL")
MCP_AUTH_TOKEN = os.environ.get("MCP_AUTH_TOKEN")

if not MCP_URL or not MCP_AUTH_TOKEN:
    sys.exit("MCP_URL and MCP_AUTH_TOKEN env vars are required")


class MCPClient:
    """Thin JSON-RPC driver for an MCP httpStream endpoint."""

    def __init__(self, url: str, token: str) -> None:
        self._url = url
        self._id = 0
        self._session_id: str | None = None
        self._http = httpx.Client(
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
            },
            timeout=30.0,
        )

    def _next_id(self) -> int:
        self._id += 1
        return self._id

    def _post(self, payload: dict[str, Any]) -> dict[str, Any]:
        headers = {}
        if self._session_id:
            headers["Mcp-Session-Id"] = self._session_id
        res = self._http.post(self._url, json=payload, headers=headers)
        res.raise_for_status()
        sid = res.headers.get("mcp-session-id")
        if sid:
            self._session_id = sid
        return res.json()

    def initialize(self) -> dict[str, Any]:
        return self._post(
            {
                "jsonrpc": "2.0",
                "id": self._next_id(),
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "python-client", "version": "0.1.0"},
                },
            }
        )

    def list_tools(self) -> dict[str, Any]:
        return self._post(
            {"jsonrpc": "2.0", "id": self._next_id(), "method": "tools/list"}
        )

    def call_tool(self, name: str, args: dict[str, Any] | None = None) -> dict[str, Any]:
        return self._post(
            {
                "jsonrpc": "2.0",
                "id": self._next_id(),
                "method": "tools/call",
                "params": {"name": name, "arguments": args or {}},
            }
        )

    def close(self) -> None:
        self._http.close()


def main() -> None:
    tool_name = sys.argv[1] if len(sys.argv) > 1 else "list_chats"
    tool_args: dict[str, Any] = (
        json.loads(sys.argv[2]) if len(sys.argv) > 2 else {"limit": 5}
    )

    client = MCPClient(MCP_URL, MCP_AUTH_TOKEN)
    try:
        client.initialize()
        result = client.call_tool(tool_name, tool_args)
        print(json.dumps(result, indent=2, ensure_ascii=False))
    finally:
        client.close()


if __name__ == "__main__":
    main()
