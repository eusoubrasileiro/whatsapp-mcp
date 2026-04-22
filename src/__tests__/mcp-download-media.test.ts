import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Module mocks (hoisted before imports) ────────────────────────────

vi.mock("../db/queries.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/queries.ts")>();
  return {
    ...actual,
    getMessageById: vi.fn(),
    updateMessageMediaObjectKey: vi.fn(),
    getContactName: vi.fn().mockResolvedValue(null),
  };
});

vi.mock("../whatsapp.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../whatsapp.ts")>();
  return {
    ...actual,
    downloadMedia: vi.fn(),
  };
});

vi.mock("../storage.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../storage.ts")>();
  return {
    ...actual,
    putMedia: vi.fn(),
    publicUrlFor: vi.fn((key: string) => `https://media.example.com/${key}`),
  };
});

vi.mock("fastmcp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fastmcp")>();
  return {
    ...actual,
    imageContent: vi.fn().mockResolvedValue({ type: "image", data: "base64img", mimeType: "image/jpeg" }),
    audioContent: vi.fn().mockResolvedValue({ type: "audio", data: "base64aud", mimeType: "audio/ogg" }),
  };
});

import { executeDownloadMedia } from "../mcp.ts";
import { getMessageById, updateMessageMediaObjectKey } from "../db/queries.ts";
import { downloadMedia } from "../whatsapp.ts";
import { putMedia, publicUrlFor } from "../storage.ts";
import type { TenantConnectionManager } from "../tenancy/manager.ts";
import pino from "pino";

const logger = pino({ level: "silent" });

const fakeManager = {} as TenantConnectionManager;

function makeMediaMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg-001",
    chat_jid: "5511@s.whatsapp.net",
    sender: "5511@s.whatsapp.net",
    content: "",
    timestamp: new Date("2025-01-01T10:00:00Z"),
    is_from_me: false,
    media_type: "image",
    media_key: "key123",
    direct_path: "/path/to/media",
    media_url: "https://cdn.whatsapp.net/something",
    mimetype: "image/jpeg",
    file_length: 1024,
    file_sha256: null,
    file_enc_sha256: null,
    media_object_key: null,
    ...overrides,
  };
}

describe("executeDownloadMedia", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(putMedia).mockResolvedValue({
      key: "t/default/5511@s.whatsapp.net/msg-001.jpg",
      url: "https://media.example.com/t/default/5511@s.whatsapp.net/msg-001.jpg",
    });
    vi.mocked(downloadMedia).mockResolvedValue({
      buffer: Buffer.from("fake-image-bytes"),
      mimetype: "image/jpeg",
      ext: "jpg",
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("image under inline limit returns image block + resource_link + text", async () => {
    const msg = makeMediaMessage({ mimetype: "image/jpeg", file_length: 1024 });
    vi.mocked(getMessageById).mockResolvedValue(msg as any);

    const result = await executeDownloadMedia(logger, fakeManager, {
      message_id: "msg-001",
      chat_jid: "5511@s.whatsapp.net",
      tenant_id: "default",
    });

    expect(result.content).toHaveLength(3);
    expect(result.content[0]).toMatchObject({ type: "image" });
    expect(result.content[1]).toMatchObject({ type: "resource_link", uri: expect.stringContaining("media.example.com") });
    expect(result.content[2]).toMatchObject({ type: "text" });
    expect(downloadMedia).toHaveBeenCalledOnce();
    expect(putMedia).toHaveBeenCalledOnce();
    expect(updateMessageMediaObjectKey).toHaveBeenCalledWith("default", "msg-001", "5511@s.whatsapp.net", "t/default/5511@s.whatsapp.net/msg-001.jpg");
  });

  it("PDF returns resource_link + text only (no inline block)", async () => {
    vi.mocked(downloadMedia).mockResolvedValue({
      buffer: Buffer.from("pdf-bytes"),
      mimetype: "application/pdf",
      ext: "pdf",
    });
    vi.mocked(putMedia).mockResolvedValue({
      key: "t/default/5511@s.whatsapp.net/msg-001.pdf",
      url: "https://media.example.com/t/default/5511@s.whatsapp.net/msg-001.pdf",
    });
    const msg = makeMediaMessage({ mimetype: "application/pdf", media_type: "document", file_length: 50_000 });
    vi.mocked(getMessageById).mockResolvedValue(msg as any);

    const result = await executeDownloadMedia(logger, fakeManager, {
      message_id: "msg-001",
      chat_jid: "5511@s.whatsapp.net",
      tenant_id: "default",
    });

    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toMatchObject({ type: "resource_link" });
    expect(result.content[1]).toMatchObject({ type: "text" });
    expect(result.content.every((c: any) => c.type !== "image" && c.type !== "audio")).toBe(true);
  });

  it("cache hit skips Baileys download and returns resource_link from stored key", async () => {
    const msg = makeMediaMessage({
      media_object_key: "t/default/5511@s.whatsapp.net/msg-001.jpg",
    });
    vi.mocked(getMessageById).mockResolvedValue(msg as any);

    const result = await executeDownloadMedia(logger, fakeManager, {
      message_id: "msg-001",
      chat_jid: "5511@s.whatsapp.net",
      tenant_id: "default",
    });

    expect(downloadMedia).not.toHaveBeenCalled();
    expect(putMedia).not.toHaveBeenCalled();
    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toMatchObject({ type: "resource_link" });
    expect(result.content[1]).toMatchObject({ type: "text", text: expect.stringContaining("cached") });
    expect(publicUrlFor).toHaveBeenCalledWith("t/default/5511@s.whatsapp.net/msg-001.jpg");
  });

  it("audio under inline limit returns audio block + resource_link + text", async () => {
    vi.mocked(downloadMedia).mockResolvedValue({
      buffer: Buffer.from("ogg-bytes"),
      mimetype: "audio/ogg",
      ext: "ogg",
    });
    vi.mocked(putMedia).mockResolvedValue({
      key: "t/default/5511@s.whatsapp.net/msg-001.ogg",
      url: "https://media.example.com/t/default/5511@s.whatsapp.net/msg-001.ogg",
    });
    const msg = makeMediaMessage({ mimetype: "audio/ogg", media_type: "audio", file_length: 512 });
    vi.mocked(getMessageById).mockResolvedValue(msg as any);

    const result = await executeDownloadMedia(logger, fakeManager, {
      message_id: "msg-001",
      chat_jid: "5511@s.whatsapp.net",
      tenant_id: "default",
    });

    expect(result.content[0]).toMatchObject({ type: "audio" });
    expect(result.content).toHaveLength(3);
  });

  it("throws when message is not found", async () => {
    vi.mocked(getMessageById).mockResolvedValue(null);

    await expect(
      executeDownloadMedia(logger, fakeManager, { message_id: "ghost", chat_jid: "jid@s.whatsapp.net", tenant_id: "default" }),
    ).rejects.toThrow("not found");
  });

  it("throws when message has no media_key", async () => {
    const msg = makeMediaMessage({ media_key: null });
    vi.mocked(getMessageById).mockResolvedValue(msg as any);

    await expect(
      executeDownloadMedia(logger, fakeManager, { message_id: "msg-001", chat_jid: "5511@s.whatsapp.net", tenant_id: "default" }),
    ).rejects.toThrow("media metadata is missing");
  });
});
