import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Module mocks (hoisted before imports) ────────────────────────────

vi.mock("../database.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../database.ts")>();
  return {
    ...actual,
    getMessageById: vi.fn(),
    updateMessageMediaObjectKey: vi.fn(),
    getContactName: vi.fn().mockReturnValue(null),
  };
});

// Inline stub avoids importOriginal resolving @amiticia/baileys-client (not present in CI).
vi.mock("../whatsapp.ts", () => ({
  socketState: { socket: null as any },
  connectionState: {
    status: "disconnected",
    qrCode: null,
    qrAscii: null,
    user: null,
    syncProgress: { chats: 0, contacts: 0, messages: 0, lastBatchAt: null },
  },
  getConnectionState: () => ({
    status: "disconnected",
    qrCode: null,
    qrAscii: null,
    user: null,
    syncProgress: { chats: 0, contacts: 0, messages: 0, lastBatchAt: null },
  }),
  startWhatsAppConnection: vi.fn(),
  sendWhatsAppMessage: vi.fn(),
  sendWhatsAppMedia: vi.fn(),
  downloadMedia: vi.fn(),
}));

vi.mock("../storage.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../storage.ts")>();
  return {
    ...actual,
    putMedia: vi.fn(),
    publicUrlFor: vi.fn((key: string) => `https://media.example.com/${key}`),
    getMediaBytes: vi.fn(),
  };
});

vi.mock("../transcribe/preprocess.ts", () => ({
  toFlacMono16k: vi.fn(),
}));

vi.mock("../transcribe/whisper.ts", () => ({
  transcribeAudio: vi.fn(),
}));

vi.mock("../describe/vision.ts", () => ({
  describeImage: vi.fn(),
}));

vi.mock("fastmcp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fastmcp")>();
  return {
    ...actual,
    imageContent: vi.fn().mockResolvedValue({ type: "image", data: "base64img", mimeType: "image/jpeg" }),
    audioContent: vi.fn().mockResolvedValue({ type: "audio", data: "base64aud", mimeType: "audio/ogg" }),
  };
});

import { executeDownloadMedia } from "../actions.ts";
import { getMessageById, updateMessageMediaObjectKey } from "../database.ts";
import { downloadMedia } from "../whatsapp.ts";
import { putMedia, publicUrlFor, getMediaBytes } from "../storage.ts";
import { toFlacMono16k } from "../transcribe/preprocess.ts";
import { transcribeAudio } from "../transcribe/whisper.ts";
import { describeImage } from "../describe/vision.ts";
import pino from "pino";

const logger = pino({ level: "silent" });

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

  // Test 4: image <5MB returns imageContent block + resource_link + text
  it("image under inline limit returns image block + resource_link + text", async () => {
    const msg = makeMediaMessage({ mimetype: "image/jpeg", file_length: 1024 });
    vi.mocked(getMessageById).mockReturnValue(msg as any);

    const result = await executeDownloadMedia(logger, {
      message_id: "msg-001",
      chat_jid: "5511@s.whatsapp.net",
    });

    expect(result.content).toHaveLength(3);
    expect(result.content[0]).toMatchObject({ type: "image" });
    expect(result.content[1]).toMatchObject({ type: "resource_link", uri: expect.stringContaining("media.example.com") });
    expect(result.content[2]).toMatchObject({ type: "text" });
    expect(downloadMedia).toHaveBeenCalledOnce();
    expect(putMedia).toHaveBeenCalledOnce();
    expect(updateMessageMediaObjectKey).toHaveBeenCalledWith("msg-001", "5511@s.whatsapp.net", "t/default/5511@s.whatsapp.net/msg-001.jpg");
  });

  // Test 5: PDF returns resource_link only, no inline content
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
    vi.mocked(getMessageById).mockReturnValue(msg as any);

    const result = await executeDownloadMedia(logger, {
      message_id: "msg-001",
      chat_jid: "5511@s.whatsapp.net",
    });

    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toMatchObject({ type: "resource_link" });
    expect(result.content[1]).toMatchObject({ type: "text" });
    expect(result.content.every((c: any) => c.type !== "image" && c.type !== "audio")).toBe(true);
  });

  // Test 6: second call with media_object_key set skips Baileys, regenerates URL
  it("cache hit skips Baileys download and returns resource_link from stored key", async () => {
    const msg = makeMediaMessage({
      media_object_key: "t/default/5511@s.whatsapp.net/msg-001.jpg",
    });
    vi.mocked(getMessageById).mockReturnValue(msg as any);

    const result = await executeDownloadMedia(logger, {
      message_id: "msg-001",
      chat_jid: "5511@s.whatsapp.net",
    });

    expect(downloadMedia).not.toHaveBeenCalled();
    expect(putMedia).not.toHaveBeenCalled();
    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toMatchObject({ type: "resource_link" });
    expect(result.content[1]).toMatchObject({ type: "text", text: expect.stringContaining("cached") });
    expect(publicUrlFor).toHaveBeenCalledWith("t/default/5511@s.whatsapp.net/msg-001.jpg");
  });

  // Edge: audio with transcribe:false returns audio block (regression — pre-feature behavior)
  it("audio + transcribe=false returns audio block + resource_link + text", async () => {
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
    vi.mocked(getMessageById).mockReturnValue(msg as any);

    const result = await executeDownloadMedia(logger, {
      message_id: "msg-001",
      chat_jid: "5511@s.whatsapp.net",
      transcribe: false,
    });

    expect(result.content[0]).toMatchObject({ type: "audio" });
    expect(result.content).toHaveLength(3);
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  // Edge: message not found
  it("throws when message is not found", async () => {
    vi.mocked(getMessageById).mockReturnValue(null);

    await expect(
      executeDownloadMedia(logger, { message_id: "ghost", chat_jid: "jid@s.whatsapp.net" }),
    ).rejects.toThrow("not found");
  });

  // Edge: message has no media metadata
  it("throws when message has no media_key", async () => {
    const msg = makeMediaMessage({ media_key: null });
    vi.mocked(getMessageById).mockReturnValue(msg as any);

    await expect(
      executeDownloadMedia(logger, { message_id: "msg-001", chat_jid: "5511@s.whatsapp.net" }),
    ).rejects.toThrow("media metadata is missing");
  });

  // G1 — video under inline limit must NOT be inlined (only image/* and audio/* are inlineable)
  it("video under inline limit returns resource_link + text only (no inline block)", async () => {
    vi.mocked(downloadMedia).mockResolvedValue({
      buffer: Buffer.from("mp4-bytes"),
      mimetype: "video/mp4",
      ext: "mp4",
    });
    vi.mocked(putMedia).mockResolvedValue({
      key: "t/default/5511@s.whatsapp.net/msg-001.mp4",
      url: "https://media.example.com/t/default/5511@s.whatsapp.net/msg-001.mp4",
    });
    const msg = makeMediaMessage({ mimetype: "video/mp4", media_type: "video", file_length: 1024 });
    vi.mocked(getMessageById).mockReturnValue(msg as any);

    const result = await executeDownloadMedia(logger, {
      message_id: "msg-001", chat_jid: "5511@s.whatsapp.net",
    });
    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toMatchObject({ type: "resource_link" });
    expect(result.content.every((c: any) => c.type !== "image" && c.type !== "audio")).toBe(true);
  });

  // G2 — image over MEDIA_INLINE_MAX_BYTES must skip inline image block
  it("image over MEDIA_INLINE_MAX_BYTES skips the inline image block", async () => {
    const big = 10 * 1024 * 1024; // 10 MB > default 5 MB limit
    vi.mocked(downloadMedia).mockResolvedValue({
      buffer: Buffer.alloc(16),
      mimetype: "image/jpeg",
      ext: "jpg",
    });
    vi.mocked(putMedia).mockResolvedValue({
      key: "t/default/5511@s.whatsapp.net/msg-001.jpg",
      url: "https://media.example.com/t/default/5511@s.whatsapp.net/msg-001.jpg",
    });
    const msg = makeMediaMessage({ mimetype: "image/jpeg", file_length: big });
    vi.mocked(getMessageById).mockReturnValue(msg as any);

    const result = await executeDownloadMedia(logger, {
      message_id: "msg-001", chat_jid: "5511@s.whatsapp.net",
    });
    expect(result.content).toHaveLength(2);
    expect(result.content.every((c: any) => c.type !== "image")).toBe(true);
  });

  // ── New: transcribe / describe behavior on download_media ─────────────────

  it("audio + transcribe default (true) returns <transcription> XML, no audioContent", async () => {
    vi.mocked(downloadMedia).mockResolvedValue({
      buffer: Buffer.from("ogg-bytes"),
      mimetype: "audio/ogg",
      ext: "ogg",
    });
    vi.mocked(putMedia).mockResolvedValue({
      key: "t/default/5511@s.whatsapp.net/msg-001.ogg",
      url: "https://media.example.com/t/default/5511@s.whatsapp.net/msg-001.ogg",
    });
    vi.mocked(toFlacMono16k).mockResolvedValue(Buffer.from("flac-bytes"));
    vi.mocked(transcribeAudio).mockResolvedValue({
      text: "Olá tudo bem?",
      model: "whisper-large-v3-turbo",
      provider: "groq",
      duration_s: 4.2,
    });
    const msg = makeMediaMessage({ mimetype: "audio/ogg", media_type: "audio", file_length: 512 });
    vi.mocked(getMessageById).mockReturnValue(msg as any);

    const result = await executeDownloadMedia(logger, {
      message_id: "msg-001",
      chat_jid: "5511@s.whatsapp.net",
    });

    expect(toFlacMono16k).toHaveBeenCalledOnce();
    expect(transcribeAudio).toHaveBeenCalledOnce();
    expect(result.content).toHaveLength(3);
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as any).text).toContain('<transcription message_id="msg-001"');
    expect((result.content[0] as any).text).toContain("Olá tudo bem?");
    expect((result.content[0] as any).text).toContain('model="whisper-large-v3-turbo"');
    expect(result.content.every((c: any) => c.type !== "audio")).toBe(true);
  });

  it("ptt + transcribe default (true) is treated as audio", async () => {
    vi.mocked(downloadMedia).mockResolvedValue({
      buffer: Buffer.from("opus-bytes"),
      mimetype: "audio/ogg; codecs=opus",
      ext: "ogg",
    });
    vi.mocked(putMedia).mockResolvedValue({
      key: "t/default/5511@s.whatsapp.net/msg-001.ogg",
      url: "https://media.example.com/k.ogg",
    });
    vi.mocked(toFlacMono16k).mockResolvedValue(Buffer.from("flac"));
    vi.mocked(transcribeAudio).mockResolvedValue({
      text: "voice note",
      model: "whisper-large-v3-turbo",
      provider: "groq",
    });
    const msg = makeMediaMessage({ mimetype: "audio/ogg; codecs=opus", media_type: "ptt", file_length: 200 });
    vi.mocked(getMessageById).mockReturnValue(msg as any);

    const result = await executeDownloadMedia(logger, {
      message_id: "msg-001",
      chat_jid: "5511@s.whatsapp.net",
    });
    expect((result.content[0] as any).text).toContain("<transcription");
  });

  it("image + describe=true returns <image_description> XML, no imageContent", async () => {
    vi.mocked(downloadMedia).mockResolvedValue({
      buffer: Buffer.from("jpg-bytes"),
      mimetype: "image/jpeg",
      ext: "jpg",
    });
    vi.mocked(putMedia).mockResolvedValue({
      key: "t/default/5511@s.whatsapp.net/msg-001.jpg",
      url: "https://media.example.com/x.jpg",
    });
    vi.mocked(describeImage).mockResolvedValue({
      text: "Cardápio de pizzaria com 12 sabores.",
      model: "gemini-2.5-flash",
    });
    const msg = makeMediaMessage({ mimetype: "image/jpeg", media_type: "image", file_length: 1024 });
    vi.mocked(getMessageById).mockReturnValue(msg as any);

    const result = await executeDownloadMedia(logger, {
      message_id: "msg-001",
      chat_jid: "5511@s.whatsapp.net",
      describe: true,
    });

    expect(describeImage).toHaveBeenCalledOnce();
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as any).text).toContain('<image_description message_id="msg-001"');
    expect((result.content[0] as any).text).toContain("Cardápio de pizzaria");
    expect(result.content.every((c: any) => c.type !== "image")).toBe(true);
  });

  it("image + describe omitted (default false) returns the standard imageContent block", async () => {
    vi.mocked(downloadMedia).mockResolvedValue({
      buffer: Buffer.from("jpg-bytes"),
      mimetype: "image/jpeg",
      ext: "jpg",
    });
    vi.mocked(putMedia).mockResolvedValue({
      key: "t/default/5511@s.whatsapp.net/msg-001.jpg",
      url: "https://media.example.com/x.jpg",
    });
    const msg = makeMediaMessage({ mimetype: "image/jpeg", media_type: "image", file_length: 1024 });
    vi.mocked(getMessageById).mockReturnValue(msg as any);

    const result = await executeDownloadMedia(logger, {
      message_id: "msg-001",
      chat_jid: "5511@s.whatsapp.net",
    });

    expect(describeImage).not.toHaveBeenCalled();
    expect(result.content[0]).toMatchObject({ type: "image" });
  });

  it("document + transcribe=true is a no-op (returns resource_link, no LLM call)", async () => {
    vi.mocked(downloadMedia).mockResolvedValue({
      buffer: Buffer.from("pdf-bytes"),
      mimetype: "application/pdf",
      ext: "pdf",
    });
    vi.mocked(putMedia).mockResolvedValue({
      key: "t/default/5511@s.whatsapp.net/msg-001.pdf",
      url: "https://media.example.com/x.pdf",
    });
    const msg = makeMediaMessage({ mimetype: "application/pdf", media_type: "document", file_length: 50_000 });
    vi.mocked(getMessageById).mockReturnValue(msg as any);

    const result = await executeDownloadMedia(logger, {
      message_id: "msg-001",
      chat_jid: "5511@s.whatsapp.net",
      transcribe: true,
      describe: true,
    });

    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(describeImage).not.toHaveBeenCalled();
    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toMatchObject({ type: "resource_link" });
  });

  it("cache hit + transcribe=true fetches bytes from storage and transcribes", async () => {
    vi.mocked(getMediaBytes).mockResolvedValue(Buffer.from("cached-audio"));
    vi.mocked(toFlacMono16k).mockResolvedValue(Buffer.from("flac"));
    vi.mocked(transcribeAudio).mockResolvedValue({
      text: "cached transcript",
      model: "whisper-large-v3-turbo",
      provider: "groq",
    });
    const msg = makeMediaMessage({
      mimetype: "audio/ogg",
      media_type: "audio",
      file_length: 1024,
      media_object_key: "t/default/5511@s.whatsapp.net/msg-001.ogg",
    });
    vi.mocked(getMessageById).mockReturnValue(msg as any);

    const result = await executeDownloadMedia(logger, {
      message_id: "msg-001",
      chat_jid: "5511@s.whatsapp.net",
    });

    expect(downloadMedia).not.toHaveBeenCalled();
    expect(getMediaBytes).toHaveBeenCalledWith("t/default/5511@s.whatsapp.net/msg-001.ogg");
    expect(transcribeAudio).toHaveBeenCalledOnce();
    expect((result.content[0] as any).text).toContain("<transcription");
  });

  // G3 — file_length === MEDIA_INLINE_MAX_BYTES skips inline (source uses strict <)
  it("file_length equal to MEDIA_INLINE_MAX_BYTES skips the inline block (strict <)", async () => {
    const limit = Number(process.env.MEDIA_INLINE_MAX_BYTES ?? 5_242_880);
    vi.mocked(downloadMedia).mockResolvedValue({
      buffer: Buffer.alloc(16),
      mimetype: "image/jpeg",
      ext: "jpg",
    });
    vi.mocked(putMedia).mockResolvedValue({
      key: "t/default/5511@s.whatsapp.net/msg-001.jpg",
      url: "https://media.example.com/t/default/5511@s.whatsapp.net/msg-001.jpg",
    });
    const msg = makeMediaMessage({ mimetype: "image/jpeg", file_length: limit });
    vi.mocked(getMessageById).mockReturnValue(msg as any);

    const result = await executeDownloadMedia(logger, {
      message_id: "msg-001", chat_jid: "5511@s.whatsapp.net",
    });
    expect(result.content.every((c: any) => c.type !== "image")).toBe(true);
  });
});
