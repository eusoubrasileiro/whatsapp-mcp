import { describe, expect, it } from "vitest";
import { formatFileSent, formatMessageSent } from "../mcp/tools/send-results.ts";

const LINE = { label: "empresa", description: "the company line" };

describe("formatMessageSent", () => {
  it("is today's sentence when there is no identity", () => {
    expect(formatMessageSent("10000000000005@lid", "m1", null)).toBe(
      "Message sent successfully to 10000000000005@lid (ID: m1).",
    );
  });

  it("appends the line after today's sentence, so today's string is a strict prefix", () => {
    const plain = formatMessageSent("10000000000005@lid", "m1", null);
    const named = formatMessageSent("10000000000005@lid", "m1", LINE);

    expect(named).toBe(
      'Message sent successfully to 10000000000005@lid (ID: m1). Sent from the "empresa" line.',
    );
    expect(named.startsWith(plain)).toBe(true);
  });
});

describe("formatFileSent", () => {
  it.each([
    ["image", "Image"],
    ["video", "Video"],
    ["document", "Document"],
    ["audio", "Audio"],
  ])("is today's sentence for a %s when there is no identity", (type, shown) => {
    expect(formatFileSent(type, "10000000000005@lid", "f1", null)).toBe(
      `${shown} sent successfully to 10000000000005@lid (ID: f1).`,
    );
  });

  it("appends the line after today's sentence", () => {
    const plain = formatFileSent("image", "10000000000005@lid", "f1", null);
    const named = formatFileSent("image", "10000000000005@lid", "f1", LINE);

    expect(named).toBe(
      'Image sent successfully to 10000000000005@lid (ID: f1). Sent from the "empresa" line.',
    );
    expect(named.startsWith(plain)).toBe(true);
  });
});
