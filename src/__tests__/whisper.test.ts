/**
 * Whisper transcription — OpenRouter by default, Groq/OpenAI as rollback lanes.
 *
 * These tests stub `fetch`, not an SDK. The previous suite mocked `groq-sdk`
 * and `openai`, which meant it asserted "we called the SDK we imported" and
 * would have passed no matter what the vendor actually accepts on the wire.
 * Another transcription client of ours shipped with a wrong claim about OpenRouter's
 * request format for exactly that reason. Pinning URL, method, form fields and
 * auth header is the part that can actually regress.
 *
 * Every test blanks ALL provider keys first. Asserting "it went to OpenRouter"
 * is worthless if a leftover GROQ_API_KEY could have produced the same result.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TranscribeError, transcribeAudio } from "../transcribe/whisper.ts";

const KEYS = ["OPENROUTER_API_KEY", "GROQ_API_KEY", "OPENAI_API_KEY"] as const;
const VARS = [...KEYS, "AUDIO_PROVIDER", "WHISPER_MODEL"] as const;

function clearEnv() {
  for (const v of VARS) delete process.env[v];
}

/** Last fetch call, decomposed into the things worth asserting. */
function lastCall() {
  const calls = fetchMock.mock.calls;
  const [url, init] = calls[calls.length - 1] as [string, RequestInit];
  const form = init.body as FormData;
  return {
    url,
    method: init.method,
    auth: (init.headers as Record<string, string>).Authorization,
    model: form.get("model"),
    language: form.get("language"),
    response_format: form.get("response_format"),
    file: form.get("file") as File,
  };
}

const fetchMock = vi.fn();

function okJson(body: unknown) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

describe("transcribeAudio", () => {
  beforeEach(() => {
    clearEnv();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    clearEnv();
    vi.unstubAllGlobals();
  });

  // --- default route --------------------------------------------------------

  it("posts to OpenRouter with whisper-large-v3 by default", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
    fetchMock.mockResolvedValue(okJson({ text: "olá mundo", duration: 12.5 }));

    const result = await transcribeAudio({ buffer: Buffer.from("fake-flac") });

    const call = lastCall();
    expect(call.url).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
    expect(call.method).toBe("POST");
    expect(call.auth).toBe("Bearer sk-or-v1-test");
    expect(call.model).toBe("openai/whisper-large-v3");
    expect(result).toMatchObject({ text: "olá mundo", provider: "openrouter" });
  });

  it("pins language to pt — guessing on a 2-second note returns Spanish", async () => {
    process.env.OPENROUTER_API_KEY = "k";
    fetchMock.mockResolvedValue(okJson({ text: "oi" }));
    await transcribeAudio({ buffer: Buffer.from("x") });
    expect(lastCall().language).toBe("pt");
  });

  it("requests verbose_json so duration_s survives for the XML envelope", async () => {
    process.env.OPENROUTER_API_KEY = "k";
    fetchMock.mockResolvedValue(okJson({ text: "oi", duration: 3.25 }));
    const result = await transcribeAudio({ buffer: Buffer.from("x") });
    expect(lastCall().response_format).toBe("verbose_json");
    expect(result.duration_s).toBe(3.25);
  });

  it("still succeeds when the provider omits duration", async () => {
    // OpenRouter documents segment/duration data for OpenAI-compatible upstreams
    // only. A missing duration must drop one XML attribute, never fail the call.
    process.env.OPENROUTER_API_KEY = "k";
    fetchMock.mockResolvedValue(okJson({ text: "sem duração" }));
    const result = await transcribeAudio({ buffer: Buffer.from("x") });
    expect(result.text).toBe("sem duração");
    expect(result.duration_s).toBeUndefined();
  });

  it("uploads the given filename so extension-validating providers accept it", async () => {
    process.env.OPENROUTER_API_KEY = "k";
    fetchMock.mockResolvedValue(okJson({ text: "oi" }));
    await transcribeAudio({ buffer: Buffer.from("x"), filename: "ABC123.flac" });
    expect(lastCall().file.name).toBe("ABC123.flac");
  });

  // --- routing is explicit, never key-presence ------------------------------

  it("does not drift back to Groq just because GROQ_API_KEY is still set", async () => {
    // The whole point of AUDIO_PROVIDER. A stale key in a compose file must not
    // silently keep traffic on a vendor whose account is being closed.
    process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
    process.env.GROQ_API_KEY = "gsk_leftover";
    fetchMock.mockResolvedValue(okJson({ text: "oi" }));

    const result = await transcribeAudio({ buffer: Buffer.from("x") });

    expect(lastCall().url).toContain("openrouter.ai");
    expect(result.provider).toBe("openrouter");
  });

  it("routes to Groq only when AUDIO_PROVIDER=groq", async () => {
    process.env.AUDIO_PROVIDER = "groq";
    process.env.GROQ_API_KEY = "gsk_test";
    fetchMock.mockResolvedValue(okJson({ text: "oi" }));

    const result = await transcribeAudio({ buffer: Buffer.from("x") });

    const call = lastCall();
    expect(call.url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect(call.model).toBe("whisper-large-v3");
    expect(call.auth).toBe("Bearer gsk_test");
    expect(result.provider).toBe("groq");
  });

  it("routes to OpenAI only when AUDIO_PROVIDER=openai", async () => {
    process.env.AUDIO_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test";
    fetchMock.mockResolvedValue(okJson({ text: "oi" }));

    const result = await transcribeAudio({ buffer: Buffer.from("x") });

    expect(lastCall().url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(lastCall().model).toBe("whisper-1");
    expect(result.provider).toBe("openai");
  });

  it("WHISPER_MODEL overrides the model on whichever route is active", async () => {
    process.env.OPENROUTER_API_KEY = "k";
    process.env.WHISPER_MODEL = "mistralai/voxtral-small-24b-2507";
    fetchMock.mockResolvedValue(okJson({ text: "oi" }));
    await transcribeAudio({ buffer: Buffer.from("x") });
    expect(lastCall().model).toBe("mistralai/voxtral-small-24b-2507");
  });

  it("rejects an unknown AUDIO_PROVIDER instead of guessing", async () => {
    process.env.AUDIO_PROVIDER = "deepinfra";
    process.env.OPENROUTER_API_KEY = "k";
    await expect(transcribeAudio({ buffer: Buffer.from("x") })).rejects.toBeInstanceOf(
      TranscribeError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // --- failure modes --------------------------------------------------------

  it("names the missing key for the active route", async () => {
    await expect(transcribeAudio({ buffer: Buffer.from("x") })).rejects.toThrow(
      /OPENROUTER_API_KEY/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces HTTP status and body on a provider error", async () => {
    process.env.OPENROUTER_API_KEY = "k";
    fetchMock.mockResolvedValue({ ok: false, status: 429, text: async () => "rate limited" });
    await expect(transcribeAudio({ buffer: Buffer.from("x") })).rejects.toThrow(/429/);
  });

  it("throws rather than passing an unrecognised body off as speech", async () => {
    // Handing {"error":...} to an agent as the sender's words is the worst
    // available failure — it fabricates what a human said.
    process.env.OPENROUTER_API_KEY = "k";
    fetchMock.mockResolvedValue(okJson({ error: { message: "bad model" } }));
    await expect(transcribeAudio({ buffer: Buffer.from("x") })).rejects.toBeInstanceOf(
      TranscribeError,
    );
  });

  it("throws on an empty transcript instead of returning silence", async () => {
    process.env.OPENROUTER_API_KEY = "k";
    fetchMock.mockResolvedValue(okJson({ text: "   " }));
    await expect(transcribeAudio({ buffer: Buffer.from("x") })).rejects.toBeInstanceOf(
      TranscribeError,
    );
  });

  it("rejects oversized audio before spending a request", async () => {
    process.env.OPENROUTER_API_KEY = "k";
    const tooBig = Buffer.alloc(24 * 1024 * 1024 + 1);
    await expect(transcribeAudio({ buffer: tooBig })).rejects.toThrow(/24 MB/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
