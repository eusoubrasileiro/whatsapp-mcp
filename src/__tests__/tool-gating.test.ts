import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFindUniqueOrThrow = vi.fn();
vi.mock("../db/client.ts", () => ({
  getPrisma: vi.fn(() => ({
    tenant: { findUniqueOrThrow: mockFindUniqueOrThrow },
  })),
}));

import { assertToolAllowed } from "../tenancy/tool-gating.ts";

const WRITE_TOOLS = [
  "send_message",
  "send_file",
  "react_to_message",
  "delete_message",
  "mark_chat_read",
] as const;

function makeTenant(overrides: Record<string, unknown> = {}) {
  return {
    id: "t-alice",
    writeToolsEnabled: false,
    allowedWriteTools: [],
    ...overrides,
  };
}

describe("assertToolAllowed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("writeToolsEnabled=false", () => {
    for (const tool of WRITE_TOOLS) {
      it(`rejects ${tool} when writeToolsEnabled is false`, async () => {
        mockFindUniqueOrThrow.mockResolvedValue(makeTenant({ writeToolsEnabled: false }));
        await expect(assertToolAllowed("t-alice", tool)).rejects.toThrow("Write tools disabled");
      });
    }
  });

  describe("writeToolsEnabled=true, allowedWriteTools=[] (all allowed)", () => {
    for (const tool of WRITE_TOOLS) {
      it(`allows ${tool} when writeToolsEnabled is true and allowedWriteTools is empty`, async () => {
        mockFindUniqueOrThrow.mockResolvedValue(makeTenant({ writeToolsEnabled: true, allowedWriteTools: [] }));
        await expect(assertToolAllowed("t-alice", tool)).resolves.toBeUndefined();
      });
    }
  });

  describe("writeToolsEnabled=true, allowedWriteTools=[send_message]", () => {
    it("allows send_message", async () => {
      mockFindUniqueOrThrow.mockResolvedValue(
        makeTenant({ writeToolsEnabled: true, allowedWriteTools: ["send_message"] }),
      );
      await expect(assertToolAllowed("t-alice", "send_message")).resolves.toBeUndefined();
    });

    for (const tool of WRITE_TOOLS.filter((t) => t !== "send_message")) {
      it(`rejects ${tool}`, async () => {
        mockFindUniqueOrThrow.mockResolvedValue(
          makeTenant({ writeToolsEnabled: true, allowedWriteTools: ["send_message"] }),
        );
        await expect(assertToolAllowed("t-alice", tool)).rejects.toThrow("not in allowed list");
      });
    }
  });

  it("throws when tenant is not found", async () => {
    mockFindUniqueOrThrow.mockRejectedValue(new Error("No Tenant found"));
    await expect(assertToolAllowed("nonexistent", "send_message")).rejects.toThrow();
  });

  describe("read tools are NOT in the write tools set", () => {
    const READ_TOOLS = [
      "get_connection_status",
      "list_messages",
      "get_messages_today",
      "search_messages",
      "list_chats",
      "get_chat",
      "get_message_context",
      "search_contacts",
      "list_contacts",
      "get_group_info",
      "download_media",
      "logout",
    ] as const;

    for (const tool of READ_TOOLS) {
      it(`${tool} is not a write tool`, () => {
        expect(WRITE_TOOLS as readonly string[]).not.toContain(tool);
      });
    }
  });

  describe("writeToolsEnabled=true, allowedWriteTools has multiple tools", () => {
    it("allows all listed tools and rejects unlisted ones", async () => {
      const allowed = ["send_message", "react_to_message"];
      mockFindUniqueOrThrow.mockResolvedValue(
        makeTenant({ writeToolsEnabled: true, allowedWriteTools: allowed }),
      );

      await expect(assertToolAllowed("t-alice", "send_message")).resolves.toBeUndefined();
      await expect(assertToolAllowed("t-alice", "react_to_message")).resolves.toBeUndefined();
      await expect(assertToolAllowed("t-alice", "send_file")).rejects.toThrow("not in allowed list");
      await expect(assertToolAllowed("t-alice", "delete_message")).rejects.toThrow("not in allowed list");
    });
  });
});
