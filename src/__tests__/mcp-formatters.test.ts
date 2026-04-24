import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initializeDatabase, resetDatabase, storeContact } from "../database.ts";
import { formatDbMessageForJson, formatDbChatForJson } from "../mcp.ts";

describe("formatDbMessageForJson", () => {
  beforeEach(() => initializeDatabase(":memory:"));
  afterEach(() => resetDatabase());

  it("uses contact name as sender_display when available", () => {
    storeContact({ jid: "5511@s.whatsapp.net", name: "Alice" });
    const out = formatDbMessageForJson({
      id: "m", chat_jid: "5511@s.whatsapp.net", sender: "5511@s.whatsapp.net",
      content: "hi", timestamp: new Date("2025-06-01T12:00:00Z"), is_from_me: false,
      chat_name: "Alice",
    } as any);
    expect(out.sender_display).toBe("Alice");
  });

  it("falls back to bare phone (split @) when no contact entry", () => {
    const out = formatDbMessageForJson({
      id: "m", chat_jid: "5599@s.whatsapp.net", sender: "5599@s.whatsapp.net",
      content: "hi", timestamp: new Date("2025-06-01T12:00:00Z"), is_from_me: false,
      chat_name: null,
    } as any);
    expect(out.sender_display).toBe("5599");
  });

  it("uses 'Me' for outgoing messages with null sender", () => {
    const out = formatDbMessageForJson({
      id: "m", chat_jid: "5599@s.whatsapp.net", sender: null,
      content: "hi", timestamp: new Date("2025-06-01T12:00:00Z"), is_from_me: true,
      chat_name: null,
    } as any);
    expect(out.sender_display).toBe("Me");
  });

  it("emits a media block with downloaded=false when media_object_key is null", () => {
    const out = formatDbMessageForJson({
      id: "m", chat_jid: "x@s.whatsapp.net", sender: "x@s.whatsapp.net",
      content: "[Image]", timestamp: new Date("2025-06-01T12:00:00Z"), is_from_me: false,
      chat_name: null,
      media_type: "image", mimetype: "image/jpeg", file_length: 100, media_object_key: null,
    } as any);
    expect((out as any).media).toEqual({
      type: "image", mimetype: "image/jpeg", file_size: 100, downloaded: false, object_key: null,
    });
  });

  it("emits a media block with downloaded=true when media_object_key is set", () => {
    const out = formatDbMessageForJson({
      id: "m", chat_jid: "x@s.whatsapp.net", sender: "x@s.whatsapp.net",
      content: "[Image]", timestamp: new Date("2025-06-01T12:00:00Z"), is_from_me: false,
      chat_name: null,
      media_type: "image", mimetype: "image/jpeg", file_length: 100,
      media_object_key: "t/default/x/m.jpg",
    } as any);
    expect((out as any).media.downloaded).toBe(true);
    expect((out as any).media.object_key).toBe("t/default/x/m.jpg");
  });

  it("omits media block for text-only messages", () => {
    const out = formatDbMessageForJson({
      id: "m", chat_jid: "x@s.whatsapp.net", sender: "x@s.whatsapp.net",
      content: "hello", timestamp: new Date("2025-06-01T12:00:00Z"), is_from_me: false,
      chat_name: null, media_type: null,
    } as any);
    expect((out as any).media).toBeUndefined();
  });
});

describe("formatDbChatForJson", () => {
  it("flags @g.us jids as is_group=true", () => {
    const out = formatDbChatForJson({
      jid: "abc@g.us", name: "My Group",
      last_message_time: new Date("2025-06-01T12:00:00Z"),
    } as any);
    expect(out.is_group).toBe(true);
  });

  it("flags @s.whatsapp.net jids as is_group=false and falls back name to phone segment", () => {
    const out = formatDbChatForJson({
      jid: "5599@s.whatsapp.net", name: null,
      last_message_time: null,
    } as any);
    expect(out.is_group).toBe(false);
    expect(out.name).toBe("5599");
  });
});
