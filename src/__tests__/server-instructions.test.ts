import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { identityParagraph } from "../instance-identity.ts";
import { buildServerInstructions } from "../mcp.ts";

/**
 * SHA-256 (hex) of the server instructions as they were before instance identities existed.
 * Computed once from `git show ac5361e:src/mcp.ts`: the text of the `SERVER_INSTRUCTIONS`
 * template literal after `.trim()`, as UTF-8 (968 characters). With no identity the server
 * must keep sending exactly these bytes.
 */
const BASE_INSTRUCTIONS_SHA256 = "e9b06df52390f92ddf69175c59ee2da9a5f210c1fc39dffb62a9371dff59ad48";

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

describe("buildServerInstructions", () => {
  it("is byte-identical to the pre-identity instructions when there is no identity", () => {
    expect(sha256(buildServerInstructions(null))).toBe(BASE_INSTRUCTIONS_SHA256);
  });

  it("opens with the identity paragraph and a blank line, then today's text unchanged", () => {
    const identity = { label: "empresa", description: "the company line" };

    const text = buildServerInstructions(identity);

    const paragraph = identityParagraph(identity);
    expect(text.startsWith(`${paragraph}\n\n`)).toBe(true);
    expect(sha256(text.slice(paragraph.length + 2))).toBe(BASE_INSTRUCTIONS_SHA256);
  });

  it("opens with the exact paragraph, description included", () => {
    const text = buildServerInstructions({ label: "empresa", description: "the company line" });

    expect(text.split("\n").slice(0, 2)).toEqual([
      'THIS SERVER IS ONE WHATSAPP LINE — "empresa": the company line',
      "Every tool here reads and sends as this line only. Any other WhatsApp number is a " +
        "different MCP server with its own tools, chats and message IDs — nothing carries " +
        'over between them. Before you send, check that "empresa" is the line the user means; ' +
        "get_connection_status reports the line and its paired phone number.",
    ]);
    expect(text.split("\n")[2]).toBe("");
  });

  it("opens with the exact paragraph, no description", () => {
    const text = buildServerInstructions({ label: "empresa" });

    expect(text.split("\n")[0]).toBe('THIS SERVER IS ONE WHATSAPP LINE — "empresa".');
    expect(sha256(text.slice(identityParagraph({ label: "empresa" }).length + 2))).toBe(
      BASE_INSTRUCTIONS_SHA256,
    );
  });
});
