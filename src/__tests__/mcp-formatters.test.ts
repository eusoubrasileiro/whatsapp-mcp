import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeDatabase, resetDatabase, storeContact } from "../database.ts";
import { formatDbChatForJson, formatDbMessageForJson } from "../formatters.ts";

describe("formatDbMessageForJson", () => {
  beforeEach(() => initializeDatabase(":memory:"));
  afterEach(() => resetDatabase());

  it("uses contact name as sender_display when available", () => {
    storeContact({ jid: "5511@s.whatsapp.net", name: "Alice" });
    const out = formatDbMessageForJson({
      id: "m",
      chat_jid: "5511@s.whatsapp.net",
      sender: "5511@s.whatsapp.net",
      content: "hi",
      timestamp: new Date("2025-06-01T12:00:00Z"),
      is_from_me: false,
      chat_name: "Alice",
    } as any);
    expect(out.sender_display).toBe("Alice");
  });

  it("falls back to bare phone (split @) when no contact entry", () => {
    const out = formatDbMessageForJson({
      id: "m",
      chat_jid: "5599@s.whatsapp.net",
      sender: "5599@s.whatsapp.net",
      content: "hi",
      timestamp: new Date("2025-06-01T12:00:00Z"),
      is_from_me: false,
      chat_name: null,
    } as any);
    expect(out.sender_display).toBe("5599");
  });

  it("uses 'Me' for outgoing messages with null sender", () => {
    const out = formatDbMessageForJson({
      id: "m",
      chat_jid: "5599@s.whatsapp.net",
      sender: null,
      content: "hi",
      timestamp: new Date("2025-06-01T12:00:00Z"),
      is_from_me: true,
      chat_name: null,
    } as any);
    expect(out.sender_display).toBe("Me");
  });

  it("emits a media block with downloaded=false when media_object_key is null", () => {
    const out = formatDbMessageForJson({
      id: "m",
      chat_jid: "x@s.whatsapp.net",
      sender: "x@s.whatsapp.net",
      content: "[Image]",
      timestamp: new Date("2025-06-01T12:00:00Z"),
      is_from_me: false,
      chat_name: null,
      media_type: "image",
      mimetype: "image/jpeg",
      file_length: 100,
      media_object_key: null,
    } as any);
    expect((out as any).media).toEqual({
      type: "image",
      mimetype: "image/jpeg",
      file_size: 100,
      downloaded: false,
      object_key: null,
    });
  });

  it("emits a media block with downloaded=true when media_object_key is set", () => {
    const out = formatDbMessageForJson({
      id: "m",
      chat_jid: "x@s.whatsapp.net",
      sender: "x@s.whatsapp.net",
      content: "[Image]",
      timestamp: new Date("2025-06-01T12:00:00Z"),
      is_from_me: false,
      chat_name: null,
      media_type: "image",
      mimetype: "image/jpeg",
      file_length: 100,
      media_object_key: "t/default/x/m.jpg",
    } as any);
    expect((out as any).media.downloaded).toBe(true);
    expect((out as any).media.object_key).toBe("t/default/x/m.jpg");
  });

  it("omits media block for text-only messages", () => {
    const out = formatDbMessageForJson({
      id: "m",
      chat_jid: "x@s.whatsapp.net",
      sender: "x@s.whatsapp.net",
      content: "hello",
      timestamp: new Date("2025-06-01T12:00:00Z"),
      is_from_me: false,
      chat_name: null,
      media_type: null,
    } as any);
    expect((out as any).media).toBeUndefined();
  });
});

describe("formatDbChatForJson", () => {
  beforeEach(() => initializeDatabase(":memory:"));
  afterEach(() => resetDatabase());

  it("flags @g.us jids as is_group=true", () => {
    const out = formatDbChatForJson({
      jid: "abc@g.us",
      name: "My Group",
      last_message_time: new Date("2025-06-01T12:00:00Z"),
    } as any);
    expect(out.is_group).toBe(true);
  });

  it("flags @s.whatsapp.net jids as is_group=false and falls back name to phone segment", () => {
    const out = formatDbChatForJson({
      jid: "5599@s.whatsapp.net",
      name: null,
      last_message_time: null,
    } as any);
    expect(out.is_group).toBe(false);
    expect(out.name).toBe("5599");
  });

  it("returns last_message_time as ISO string when set", () => {
    const ts = new Date("2025-06-01T12:00:00Z");
    const out = formatDbChatForJson({
      jid: "abc@g.us",
      name: "G",
      last_message_time: ts,
    } as any);
    expect(out.last_message_time).toBe("2025-06-01T12:00:00.000Z");
  });

  it("returns null last_message_time when not set", () => {
    const out = formatDbChatForJson({
      jid: "abc@g.us",
      name: "G",
      last_message_time: null,
    } as any);
    expect(out.last_message_time).toBeNull();
  });

  it("uses contact name as last_sender_display when last_sender has a contact entry", () => {
    storeContact({ jid: "5511@s.whatsapp.net", name: "Alice" });
    const out = formatDbChatForJson({
      jid: "abc@g.us",
      name: "G",
      last_message_time: null,
      last_sender: "5511@s.whatsapp.net",
      last_is_from_me: false,
    } as any);
    expect(out.last_sender_display).toBe("Alice");
  });

  it("falls back to phone segment as last_sender_display when no contact entry", () => {
    const out = formatDbChatForJson({
      jid: "abc@g.us",
      name: "G",
      last_message_time: null,
      last_sender: "5599@s.whatsapp.net",
      last_is_from_me: false,
    } as any);
    expect(out.last_sender_display).toBe("5599");
  });

  it("returns 'Me' as last_sender_display when last_sender is null and last_is_from_me is true", () => {
    const out = formatDbChatForJson({
      jid: "abc@g.us",
      name: "G",
      last_message_time: null,
      last_sender: null,
      last_is_from_me: true,
    } as any);
    expect(out.last_sender_display).toBe("Me");
  });

  it("returns null last_sender_display when no sender and not from me", () => {
    const out = formatDbChatForJson({
      jid: "abc@g.us",
      name: "G",
      last_message_time: null,
      last_sender: null,
      last_is_from_me: false,
    } as any);
    expect(out.last_sender_display).toBeNull();
  });

  it("propagates last_is_from_me from the chat row", () => {
    const out = formatDbChatForJson({
      jid: "abc@s.whatsapp.net",
      name: "X",
      last_message_time: null,
      last_is_from_me: true,
    } as any);
    expect(out.last_is_from_me).toBe(true);
  });

  it("includes last_message_preview from last_message field", () => {
    const out = formatDbChatForJson({
      jid: "abc@s.whatsapp.net",
      name: "X",
      last_message_time: null,
      last_message: "Hey there!",
    } as any);
    expect(out.last_message_preview).toBe("Hey there!");
  });

  it("returns null last_message_preview when no last_message", () => {
    const out = formatDbChatForJson({
      jid: "abc@s.whatsapp.net",
      name: "X",
      last_message_time: null,
      last_message: null,
    } as any);
    expect(out.last_message_preview).toBeNull();
  });
});
