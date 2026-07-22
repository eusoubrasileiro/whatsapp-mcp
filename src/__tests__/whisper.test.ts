import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const groqCreate = vi.fn();
const openaiCreate = vi.fn();

vi.mock("groq-sdk", () => ({
  default: class MockGroq {
    audio = { transcriptions: { create: groqCreate } };
  },
}));

vi.mock("openai", () => ({
  default: class MockOpenAI {
    audio = { transcriptions: { create: openaiCreate } };
  },
}));

vi.mock("openai/uploads", () => ({
  toFile: vi.fn(async (buf: Buffer, name: string) => ({ __fakeFile: true, buf, name })),
}));

import { TranscribeError, transcribeAudio } from "../transcribe/whisper.ts";

describe("transcribeAudio", () => {
  beforeEach(() => {
    delete process.env.GROQ_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.WHISPER_MODEL;
    groqCreate.mockReset();
    openaiCreate.mockReset();
  });

  afterEach(() => {
    delete process.env.GROQ_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.WHISPER_MODEL;
  });

  it("uses Groq whisper-large-v3-turbo when GROQ_API_KEY is set", async () => {
    process.env.GROQ_API_KEY = "gsk_test";
    groqCreate.mockResolvedValue({ text: "olá mundo", duration: 12.5 });

    const result = await transcribeAudio({ buffer: Buffer.from("fake-flac"), filename: "x.flac" });

    expect(groqCreate).toHaveBeenCalledOnce();
    expect(groqCreate.mock.calls[0][0]).toMatchObject({
      model: "whisper-large-v3-turbo",
      language: "pt",
      response_format: "verbose_json",
    });
    expect(openaiCreate).not.toHaveBeenCalled();
    expect(result).toEqual({
      text: "olá mundo",
      model: "whisper-large-v3-turbo",
      provider: "groq",
      duration_s: 12.5,
    });
  });

  it("honors WHISPER_MODEL override", async () => {
    process.env.GROQ_API_KEY = "gsk_test";
    process.env.WHISPER_MODEL = "whisper-large-v3";
    groqCreate.mockResolvedValue({ text: "x", duration: 1 });

    const result = await transcribeAudio({ buffer: Buffer.from("f") });
    expect(groqCreate.mock.calls[0][0].model).toBe("whisper-large-v3");
    expect(result.model).toBe("whisper-large-v3");
  });

  it("falls back to OpenAI whisper-1 when only OPENAI_API_KEY is set", async () => {
    process.env.OPENAI_API_KEY = "sk_test";
    openaiCreate.mockResolvedValue({ text: "hello", duration: 5 });

    const result = await transcribeAudio({ buffer: Buffer.from("f") });

    expect(openaiCreate).toHaveBeenCalledOnce();
    expect(openaiCreate.mock.calls[0][0]).toMatchObject({ model: "whisper-1", language: "pt" });
    expect(groqCreate).not.toHaveBeenCalled();
    expect(result).toEqual({
      text: "hello",
      model: "whisper-1",
      provider: "openai",
      duration_s: 5,
    });
  });

  it("throws when neither key is set", async () => {
    await expect(transcribeAudio({ buffer: Buffer.from("f") })).rejects.toThrow(
      /GROQ_API_KEY.*OPENAI_API_KEY/,
    );
  });

  it("wraps Groq SDK error with TranscribeError", async () => {
    process.env.GROQ_API_KEY = "gsk_test";
    groqCreate.mockRejectedValue(new Error("HTTP 429 rate limit"));

    await expect(transcribeAudio({ buffer: Buffer.from("f") })).rejects.toThrow(
      /Groq Whisper request failed: HTTP 429/,
    );
  });

  it("wraps OpenAI SDK error with TranscribeError", async () => {
    process.env.OPENAI_API_KEY = "sk_test";
    openaiCreate.mockRejectedValue(new Error("HTTP 503"));

    await expect(transcribeAudio({ buffer: Buffer.from("f") })).rejects.toThrow(
      /OpenAI Whisper request failed: HTTP 503/,
    );
  });

  it("rejects with TranscribeError when buffer exceeds 24 MB safe ceiling", async () => {
    process.env.GROQ_API_KEY = "gsk_test";
    const big = Buffer.alloc(25 * 1024 * 1024);
    await expect(transcribeAudio({ buffer: big })).rejects.toThrow(TranscribeError);
    expect(groqCreate).not.toHaveBeenCalled();
  });
});
