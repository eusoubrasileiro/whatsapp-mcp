import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateContent = vi.fn();

vi.mock("@google/genai", () => ({
  GoogleGenAI: class MockGenAI {
    models = { generateContent };
    constructor(_opts: any) {}
  },
}));

import { DescribeError, describeImage } from "../describe/vision.ts";

describe("describeImage", () => {
  beforeEach(() => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.VISION_MODEL;
    generateContent.mockReset();
  });

  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.VISION_MODEL;
  });

  it("calls gemini-2.5-flash with inlineData and a pt-BR prompt by default", async () => {
    process.env.GEMINI_API_KEY = "g_test";
    generateContent.mockResolvedValue({ text: "Foto de uma pizza grande." });

    const result = await describeImage({
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      mimetype: "image/jpeg",
    });

    expect(generateContent).toHaveBeenCalledOnce();
    const call = generateContent.mock.calls[0][0];
    expect(call.model).toBe("gemini-2.5-flash");
    const parts = call.contents[0].parts;
    expect(parts[0].inlineData.mimeType).toBe("image/jpeg");
    expect(parts[0].inlineData.data).toBe(Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64"));
    expect(parts[1].text).toMatch(/português brasileiro/);
    expect(result).toEqual({ text: "Foto de uma pizza grande.", model: "gemini-2.5-flash" });
  });

  it("honors VISION_MODEL override", async () => {
    process.env.GEMINI_API_KEY = "g_test";
    process.env.VISION_MODEL = "gemini-2.5-pro";
    generateContent.mockResolvedValue({ text: "x" });

    const result = await describeImage({ buffer: Buffer.from([1]), mimetype: "image/png" });
    expect(generateContent.mock.calls[0][0].model).toBe("gemini-2.5-pro");
    expect(result.model).toBe("gemini-2.5-pro");
  });

  it("uses an explicit prompt when provided", async () => {
    process.env.GEMINI_API_KEY = "g_test";
    generateContent.mockResolvedValue({ text: "ok" });

    await describeImage({
      buffer: Buffer.from([1]),
      mimetype: "image/png",
      prompt: "Just say OK.",
    });

    const parts = generateContent.mock.calls[0][0].contents[0].parts;
    expect(parts[1].text).toBe("Just say OK.");
  });

  it("throws DescribeError when GEMINI_API_KEY is unset", async () => {
    await expect(
      describeImage({ buffer: Buffer.from([1]), mimetype: "image/png" }),
    ).rejects.toThrow(DescribeError);
  });

  it("wraps Gemini SDK errors with DescribeError", async () => {
    process.env.GEMINI_API_KEY = "g_test";
    generateContent.mockRejectedValue(new Error("HTTP 429"));

    await expect(
      describeImage({ buffer: Buffer.from([1]), mimetype: "image/png" }),
    ).rejects.toThrow(/Gemini vision request failed: HTTP 429/);
  });

  it("falls back to extracting candidates[].content.parts[].text when top-level .text is missing", async () => {
    process.env.GEMINI_API_KEY = "g_test";
    generateContent.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: "Parte 1." }, { text: " Parte 2." }] } }],
    });

    const result = await describeImage({ buffer: Buffer.from([1]), mimetype: "image/png" });
    expect(result.text).toBe("Parte 1. Parte 2.");
  });

  it("throws DescribeError when response has no extractable text", async () => {
    process.env.GEMINI_API_KEY = "g_test";
    generateContent.mockResolvedValue({ candidates: [] });

    await expect(
      describeImage({ buffer: Buffer.from([1]), mimetype: "image/png" }),
    ).rejects.toThrow(/no text content/);
  });
});
