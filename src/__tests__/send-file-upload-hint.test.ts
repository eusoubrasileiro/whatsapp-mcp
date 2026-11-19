import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { registerSendingTools } from "../mcp/tools/sending.ts";
import type { ToolRegistrar } from "../mcp/tools/types.ts";

/** send_file's file_path hint as it shipped before UPLOAD_PUBLIC_URL existed — byte for byte. */
const TODAYS_FILE_PATH_HINT =
  "http(s) URL, base64 data: URL, or server-side absolute path. To send a local host file with a remote MCP, upload it to <MCP host>/upload first and pass the returned URL. Max 16 MB.";

interface Captured {
  description: string;
  parameters: { shape: Record<string, { description?: string }> };
}

/** Registers the sending tools against a stub and returns send_file as registered. */
function sendFile(): Captured {
  const tools: Record<string, Captured> = {};
  const registrar = {
    addTool: (tool: Captured & { name: string }) => {
      tools[tool.name] = tool;
    },
  } as unknown as ToolRegistrar;
  const logger = pino({ level: "silent" });
  registerSendingTools(registrar, { mcpLogger: logger, waLogger: logger });
  return tools.send_file as Captured;
}

const filePathHint = () => sendFile().parameters.shape.file_path?.description;

afterEach(() => {
  delete process.env.UPLOAD_PUBLIC_URL;
});

describe("send_file upload hint", () => {
  it("is today's text, byte for byte, when UPLOAD_PUBLIC_URL is not set", () => {
    expect(filePathHint()).toBe(TODAYS_FILE_PATH_HINT);
  });

  it("names the configured upload URL exactly when it is an https URL", () => {
    process.env.UPLOAD_PUBLIC_URL = "https://wa.example.com/empresa/upload";

    expect(filePathHint()).toBe(
      TODAYS_FILE_PATH_HINT.replace("<MCP host>/upload", "https://wa.example.com/empresa/upload"),
    );
    expect(filePathHint()).toContain(
      "upload it to https://wa.example.com/empresa/upload first and pass the returned URL.",
    );
  });

  it("accepts an http URL too, such as a local stack", () => {
    process.env.UPLOAD_PUBLIC_URL = "http://localhost:39003/upload";

    expect(filePathHint()).toContain("upload it to http://localhost:39003/upload first");
  });

  it("ignores whitespace around the URL", () => {
    process.env.UPLOAD_PUBLIC_URL = "  https://wa.example.com/empresa/upload \n";

    expect(filePathHint()).toContain("upload it to https://wa.example.com/empresa/upload first");
  });

  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["a bare host and path", "wa.example.com/empresa/upload"],
    ["not a URL", "not a url"],
    ["a non-http scheme", "ftp://wa.example.com/upload"],
    ["a script scheme", "javascript:alert(1)"],
    ["a scheme-relative URL", "//wa.example.com/upload"],
  ])("falls back to today's text when it is %s", (_name, value) => {
    process.env.UPLOAD_PUBLIC_URL = value;

    expect(filePathHint()).toBe(TODAYS_FILE_PATH_HINT);
  });

  it("changes nothing else in the tool", () => {
    const before = sendFile();
    process.env.UPLOAD_PUBLIC_URL = "https://wa.example.com/empresa/upload";
    const after = sendFile();

    expect(after.description).toBe(before.description);
    for (const [name, schema] of Object.entries(before.parameters.shape)) {
      if (name === "file_path") continue;
      expect(after.parameters.shape[name]?.description).toBe(schema.description);
    }
    expect(Object.keys(after.parameters.shape)).toEqual(Object.keys(before.parameters.shape));
  });
});

describe("send_file description", () => {
  it("says local paths are read only from the server's send directory", () => {
    expect(sendFile().description).toContain(
      "(c) absolute path of a file ON THE MCP SERVER, inside its send directory (SEND_FILE_LOCAL_DIR, default <data dir>/outbox; any other path is refused)",
    );
  });
});
