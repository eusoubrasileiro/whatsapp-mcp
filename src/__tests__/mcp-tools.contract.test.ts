import { describe, expect, it } from "vitest";
import { FastMCP } from "fastmcp";
import { z } from "zod";

// Contract tests pinning the zod + fastmcp API surface consumed by src/mcp.ts.
// These must stay green BEFORE and AFTER any bump of `zod` or `fastmcp`.
// A failure here means the installed version's API diverged from what mcp.ts expects.

describe("fastmcp construction contract", () => {
  it("instantiates with {name, version}", () => {
    const server = new FastMCP({ name: "test", version: "0.0.0" });
    expect(server).toBeInstanceOf(FastMCP);
  });

  it("accepts addTool with {name, description, parameters: zSchema, execute}", () => {
    const server = new FastMCP({ name: "test", version: "0.0.0" });
    expect(() => {
      server.addTool({
        name: "noop",
        description: "noop tool",
        parameters: z.object({}),
        execute: async () => "ok",
      });
    }).not.toThrow();
  });

  it("accepts addResource with {uri, name, description, load}", () => {
    const server = new FastMCP({ name: "test", version: "0.0.0" });
    expect(() => {
      server.addResource({
        uri: "schema://test/main",
        name: "Test",
        description: "Test resource",
        async load() {
          return { text: "hello" };
        },
      });
    }).not.toThrow();
  });
});

describe("zod schema parsing contract", () => {
  it("z.object({}) accepts empty input", () => {
    const schema = z.object({});
    expect(schema.safeParse({}).success).toBe(true);
  });

  it("z.string().min(1) rejects empty string and accepts non-empty", () => {
    const schema = z.string().min(1);
    expect(schema.safeParse("").success).toBe(false);
    expect(schema.safeParse("hi").success).toBe(true);
  });

  it("z.number().int().positive() rejects 0, negative, and floats", () => {
    const schema = z.number().int().positive();
    expect(schema.safeParse(0).success).toBe(false);
    expect(schema.safeParse(-1).success).toBe(false);
    expect(schema.safeParse(1.5).success).toBe(false);
    expect(schema.safeParse(1).success).toBe(true);
  });

  it("z.number().int().nonnegative() accepts 0 and rejects -1", () => {
    const schema = z.number().int().nonnegative();
    expect(schema.safeParse(0).success).toBe(true);
    expect(schema.safeParse(-1).success).toBe(false);
  });

  it("optional+default produces the default when field is absent or undefined", () => {
    const schema = z.object({
      limit: z.number().int().positive().optional().default(50),
    });
    expect(schema.parse({}).limit).toBe(50);
    expect(schema.parse({ limit: undefined }).limit).toBe(50);
  });

  it("optional+default allows explicit values", () => {
    const schema = z.object({
      include: z.boolean().optional().default(true),
    });
    expect(schema.parse({ include: false }).include).toBe(false);
    expect(schema.parse({}).include).toBe(true);
  });

  it("z.enum default works", () => {
    const schema = z.object({
      type: z.enum(["image", "video", "document", "audio"]).optional().default("image"),
    });
    expect(schema.parse({}).type).toBe("image");
    expect(schema.parse({ type: "video" }).type).toBe("video");
    expect(schema.safeParse({ type: "bogus" }).success).toBe(false);
  });

  it("optional without default leaves the field undefined", () => {
    const schema = z.object({
      q: z.string().optional(),
    });
    const parsed = schema.parse({});
    expect(parsed.q).toBeUndefined();
  });

  it(".describe() preserves schema parse behavior", () => {
    const described = z.string().min(1).describe("some description");
    expect(described.safeParse("").success).toBe(false);
    expect(described.safeParse("x").success).toBe(true);
  });

  it("mirrors the list_messages parameter schema used in src/mcp.ts", () => {
    const schema = z.object({
      chat_jid: z.string().describe("JID"),
      limit: z.number().int().positive().optional().default(20),
      page: z.number().int().nonnegative().optional().default(0),
      from_date: z.string().optional(),
      to_date: z.string().optional(),
    });
    const parsed = schema.parse({ chat_jid: "123@s.whatsapp.net" });
    expect(parsed).toEqual({
      chat_jid: "123@s.whatsapp.net",
      limit: 20,
      page: 0,
      from_date: undefined,
      to_date: undefined,
    });
    expect(schema.safeParse({}).success).toBe(false); // missing required chat_jid
  });
});
