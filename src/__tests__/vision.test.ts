import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DescribeError, describeImage } from "../describe/vision.ts";

const fetchMock = vi.fn();

function okBody(content: unknown) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

describe("describeImage", () => {
  beforeEach(() => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.VISION_MODEL;
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.VISION_MODEL;
    vi.unstubAllGlobals();
  });

  it("POSTs an OpenAI-shaped chat completion to OpenRouter with a base64 data URL and pt-BR prompt", async () => {
    process.env.OPENROUTER_API_KEY = "or_test";
    fetchMock.mockResolvedValue(okBody("Foto de uma pizza grande."));
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

    const result = await describeImage({ buffer: bytes, mimetype: "image/jpeg" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer or_test");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("openai/gpt-6-luna");
    const content = body.messages[0].content;
    expect(content[0]).toEqual({
      type: "text",
      text: expect.stringMatching(/português brasileiro/),
    });
    expect(content[1]).toEqual({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${bytes.toString("base64")}` },
    });
    expect(result).toEqual({ text: "Foto de uma pizza grande.", model: "openai/gpt-6-luna" });
  });

  it("honors VISION_MODEL override", async () => {
    process.env.OPENROUTER_API_KEY = "or_test";
    process.env.VISION_MODEL = "qwen/qwen3.8-flash";
    fetchMock.mockResolvedValue(okBody("x"));

    const result = await describeImage({ buffer: Buffer.from([1]), mimetype: "image/png" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe("qwen/qwen3.8-flash");
    expect(result.model).toBe("qwen/qwen3.8-flash");
  });

  it("uses an explicit prompt when provided", async () => {
    process.env.OPENROUTER_API_KEY = "or_test";
    fetchMock.mockResolvedValue(okBody("ok"));

    await describeImage({
      buffer: Buffer.from([1]),
      mimetype: "image/png",
      prompt: "Just say OK.",
    });

    const content = JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content;
    expect(content[0].text).toBe("Just say OK.");
  });

  it("throws DescribeError when OPENROUTER_API_KEY is unset, without calling the network", async () => {
    await expect(
      describeImage({ buffer: Buffer.from([1]), mimetype: "image/png" }),
    ).rejects.toThrow(/OPENROUTER_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("wraps HTTP errors with DescribeError", async () => {
    process.env.OPENROUTER_API_KEY = "or_test";
    fetchMock.mockResolvedValue(new Response("rate limited", { status: 429 }));

    await expect(
      describeImage({ buffer: Buffer.from([1]), mimetype: "image/png" }),
    ).rejects.toThrow(/vision request failed: HTTP 429/);
  });

  it("wraps network errors with DescribeError", async () => {
    process.env.OPENROUTER_API_KEY = "or_test";
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));

    await expect(
      describeImage({ buffer: Buffer.from([1]), mimetype: "image/png" }),
    ).rejects.toThrow(DescribeError);
  });

  it("joins text parts when content comes back as an array", async () => {
    process.env.OPENROUTER_API_KEY = "or_test";
    fetchMock.mockResolvedValue(
      okBody([
        { type: "text", text: "Parte 1." },
        { type: "text", text: " Parte 2." },
      ]),
    );

    const result = await describeImage({ buffer: Buffer.from([1]), mimetype: "image/png" });
    expect(result.text).toBe("Parte 1. Parte 2.");
  });

  it("throws DescribeError when response has no extractable text", async () => {
    process.env.OPENROUTER_API_KEY = "or_test";
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ choices: [] }), { status: 200 }));

    await expect(
      describeImage({ buffer: Buffer.from([1]), mimetype: "image/png" }),
    ).rejects.toThrow(/no text content/);
  });
});
