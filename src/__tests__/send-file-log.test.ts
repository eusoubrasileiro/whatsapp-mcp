import { describe, expect, it } from "vitest";
import { summarizeFileInput } from "../file-input-summary.ts";
import { registerSendingTools } from "../mcp/tools/sending.ts";
import type { ToolRegistrar } from "../mcp/tools/types.ts";
import { recordingLogger } from "./helpers/recording-logger.ts";

describe("summarizeFileInput", () => {
  it.each([
    ["data:image/png;base64,iVBORw0KGgoAAAA", "data:image/png URL (37 chars)"],
    ["DATA:audio/ogg,xyz", "data:audio/ogg URL (18 chars)"],
    ["data:;base64,AAAA", "data:? URL (17 chars)"],
    [
      "https://wa.example.com/empresa/media/t/x/uploads/a.png",
      "https://wa.example.com/empresa/media/t/x/uploads/a.png",
    ],
    ["https://user:pa55@host.example/f.pdf?sig=abc#frag", "https://host.example/f.pdf"],
    ["http://host.example:8080/a b.png?x=1", "http://host.example:8080/a%20b.png"],
    ["ftp://user:pa55@files.example/f.bin", "ftp://files.example/f.bin"],
    ["https://", "(malformed URL)"],
    ["/srv/outbox/photo.png", "/srv/outbox/photo.png"],
  ])("logs %j as %j", (input, summary) => {
    expect(summarizeFileInput(input)).toBe(summary);
  });
});

describe("send_file log line", () => {
  it("names the input by its summary, never its payload or query", async () => {
    const { logger, lines } = recordingLogger();
    const tools: Record<string, { execute: (a: unknown) => Promise<unknown> }> = {};
    registerSendingTools(
      {
        addTool: (t: { name: string; execute: (a: unknown) => Promise<unknown> }) => {
          tools[t.name] = t;
        },
      } as unknown as ToolRegistrar,
      { mcpLogger: logger, waLogger: logger },
    );

    // Not connected: the tool fails after its first log line, which is all this test reads.
    await tools.send_file
      .execute({
        recipient: "5531@s.whatsapp.net",
        file_path: "data:image/png;base64,c2VjcmV0LXBheWxvYWQ=",
        type: "image",
        allow_cold_contact: false,
      })
      .catch(() => {});

    const log = lines.join("");
    expect(log).toContain(
      "Executing send_file to 5531@s.whatsapp.net: data:image/png URL (42 chars)",
    );
    expect(log).not.toContain("c2VjcmV0");
  });
});
