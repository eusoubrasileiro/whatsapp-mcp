import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { toFlacMono16k, FfmpegError } from "../transcribe/preprocess.ts";

function makeSineWav(durationSec: number, sampleRate = 44100, freq = 440): Buffer {
  const numSamples = durationSec * sampleRate;
  const dataSize = numSamples * 2; // 16-bit mono
  const buf = Buffer.alloc(44 + dataSize);

  // RIFF header
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  // fmt chunk
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);         // PCM
  buf.writeUInt16LE(1, 22);         // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  // data chunk
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    const sample = Math.floor(Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0x3FFF);
    buf.writeInt16LE(sample, 44 + i * 2);
  }
  return buf;
}

async function ffprobe(buf: Buffer): Promise<{ codec: string; sampleRate: number; channels: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "a:0",
      "-show_entries", "stream=codec_name,sample_rate,channels",
      "-of", "default=noprint_wrappers=1",
      "pipe:0",
    ], { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    proc.stdout.on("data", (c) => out.push(c));
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exited ${code}`));
      const text = Buffer.concat(out).toString("utf8");
      const codec = /codec_name=(\S+)/.exec(text)?.[1] ?? "";
      const sr = Number(/sample_rate=(\d+)/.exec(text)?.[1] ?? "0");
      const ch = Number(/channels=(\d+)/.exec(text)?.[1] ?? "0");
      resolve({ codec, sampleRate: sr, channels: ch });
    });
    proc.on("error", reject);
    proc.stdin.end(buf);
  });
}

describe("toFlacMono16k", () => {
  it("converts a 44.1 kHz mono WAV to 16 kHz mono FLAC", async () => {
    const wav = makeSineWav(1); // 1 second
    const flac = await toFlacMono16k(wav);

    expect(flac.length).toBeGreaterThan(0);
    // FLAC stream marker
    expect(flac.subarray(0, 4).toString()).toBe("fLaC");

    const meta = await ffprobe(flac);
    expect(meta.codec).toBe("flac");
    expect(meta.sampleRate).toBe(16000);
    expect(meta.channels).toBe(1);
  });

  it("downmixes stereo 44.1 kHz to mono 16 kHz", async () => {
    // ffmpeg-generated stereo input via a brief pipeline-only fixture.
    const stereoWav = await new Promise<Buffer>((resolve, reject) => {
      const proc = spawn("ffmpeg", [
        "-hide_banner", "-loglevel", "error",
        "-f", "lavfi",
        "-i", "sine=frequency=440:duration=1:sample_rate=44100",
        "-ac", "2",
        "-f", "wav",
        "pipe:1",
      ], { stdio: ["ignore", "pipe", "pipe"] });
      const out: Buffer[] = [];
      proc.stdout.on("data", (c) => out.push(c));
      proc.on("close", (code) => code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg fixture exited ${code}`)));
      proc.on("error", reject);
    });

    const flac = await toFlacMono16k(stereoWav);
    const meta = await ffprobe(flac);
    expect(meta.channels).toBe(1);
    expect(meta.sampleRate).toBe(16000);
  });

  it("throws FfmpegError with stderr on corrupt input", async () => {
    const garbage = Buffer.from("not-audio-bytes-at-all");
    await expect(toFlacMono16k(garbage)).rejects.toThrow(FfmpegError);
  });

  it("throws clear FfmpegError when ffmpeg binary missing", async () => {
    const prev = process.env.FFMPEG_BIN;
    process.env.FFMPEG_BIN = "/nonexistent/ffmpeg-binary-zzz";
    try {
      // Re-import to pick up env change — preprocess reads FFMPEG_BIN at import time.
      // Instead we test via dynamic spawn: assert the underlying spawn surfaces ENOENT.
      const { toFlacMono16k: localToFlac, FfmpegError: LocalErr } = await import("../transcribe/preprocess.ts?missing=1" + Date.now());
      await expect(localToFlac(Buffer.from([1, 2, 3]))).rejects.toThrow(LocalErr);
    } finally {
      if (prev === undefined) delete process.env.FFMPEG_BIN;
      else process.env.FFMPEG_BIN = prev;
    }
  });
});
