import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { FfmpegError, toFlacMono16k } from "../transcribe/preprocess.ts";

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
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  // data chunk
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    const sample = Math.floor(Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0x3fff);
    buf.writeInt16LE(sample, 44 + i * 2);
  }
  return buf;
}

async function ffprobe(
  buf: Buffer,
): Promise<{ codec: string; sampleRate: number; channels: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=codec_name,sample_rate,channels",
        "-of",
        "default=noprint_wrappers=1",
        "pipe:0",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
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
    proc.stdin.on("error", () => {
      /* ffprobe may close stdin early once it has the header */
    });
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
      const proc = spawn(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:duration=1:sample_rate=44100",
          "-ac",
          "2",
          "-f",
          "wav",
          "pipe:1",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const out: Buffer[] = [];
      proc.stdout.on("data", (c) => out.push(c));
      proc.on("close", (code) =>
        code === 0
          ? resolve(Buffer.concat(out))
          : reject(new Error(`ffmpeg fixture exited ${code}`)),
      );
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

  it("transcribes M4A with moov-at-end (WhatsApp/mobile encoder layout)", async () => {
    // Default `ffmpeg -f mp4 file.m4a` writes moov atom at the END of the file —
    // the very layout that broke when piped via stdin (non-seekable → demux fails
    // partway, exits 0, returns ~empty FLAC). The fixture must be generated to a
    // real file (mp4 mux refuses non-seekable output for moov-at-end), then read
    // back as a Buffer to mimic how baileys delivers media bytes.
    const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");

    const dir = mkdtempSync(path.join(tmpdir(), "wa-m4a-fixture-"));
    const m4aPath = path.join(dir, "in.m4a");
    try {
      // Fixture must be ≥ ~1 MB so the buffered stdin pipe overflows and ffmpeg
      // actually starts demuxing before all bytes arrive — that's what trips the
      // seek-on-moov-at-end failure. A tiny <100 KB fixture is buffered whole and
      // hides the bug.
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(
          "ffmpeg",
          [
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=90:sample_rate=44100",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            // No -movflags +faststart → moov atom stays at end of file (default)
            "-f",
            "mp4",
            "-y",
            m4aPath,
          ],
          { stdio: ["ignore", "ignore", "pipe"] },
        );
        proc.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`m4a fixture exited ${code}`)),
        );
        proc.on("error", reject);
      });

      const m4a = readFileSync(m4aPath);
      const flac = await toFlacMono16k(m4a);

      // 90s of mono FLAC at 16 kHz is ~700 KB–1.8 MB; broken silent stub is ~8 KB.
      expect(flac.length).toBeGreaterThan(200_000);
      expect(flac.subarray(0, 4).toString()).toBe("fLaC");

      const meta = await ffprobe(flac);
      expect(meta.codec).toBe("flac");
      expect(meta.sampleRate).toBe(16000);
      expect(meta.channels).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes a complete STREAMINFO — total-samples and MD5 are filled in", async () => {
    // REGRESSION (2026-08-25). The encoder wrote to `pipe:1`, which is not
    // seekable, so ffmpeg could never rewind to patch STREAMINFO after the last
    // frame: total-samples, min/max frame size and the MD5 signature all stayed
    // zero. Groq's Whisper endpoint accepted that header. OpenRouter's upstream
    // rejects it with a bare `HTTP 400 — Provider returned 400`, deterministically
    // (4/4 vs 4/4 measured against a real voice note), so the OpenRouter cutover
    // silently broke every voice note while the bytes themselves decoded fine
    // in ffmpeg, ffprobe and every local player. Asserting on playability alone
    // cannot catch this — only the header fields can.
    const flac = await toFlacMono16k(makeSineWav(2));

    expect(flac.subarray(0, 4).toString()).toBe("fLaC");
    expect(flac[4] & 0x7f).toBe(0); // first metadata block is STREAMINFO
    expect(flac.readUIntBE(5, 3)).toBe(34); // ...and it is the spec's 34 bytes

    // STREAMINFO starts at byte 8. Total samples is a 36-bit field: the low
    // nibble of byte 21 followed by bytes 22-25.
    const totalSamples = (flac[21] & 0x0f) * 2 ** 32 + flac.readUInt32BE(22);
    expect(totalSamples).toBe(2 * 16000); // 2 s at 16 kHz, exactly

    // Bytes 26-41 are the MD5 of the unencoded audio. All-zero means "unknown",
    // which is what a non-seekable write leaves behind.
    expect(flac.subarray(26, 42).every((b) => b === 0)).toBe(false);

    // Min/max frame size (bytes 12-17) are patched in the same rewind.
    expect(flac.readUIntBE(15, 3)).toBeGreaterThan(0); // max frame size
  });

  it("throws clear FfmpegError when ffmpeg binary missing", async () => {
    const prev = process.env.FFMPEG_BIN;
    process.env.FFMPEG_BIN = "/nonexistent/ffmpeg-binary-zzz";
    try {
      await expect(toFlacMono16k(Buffer.from([1, 2, 3]))).rejects.toThrow(FfmpegError);
    } finally {
      if (prev === undefined) delete process.env.FFMPEG_BIN;
      else process.env.FFMPEG_BIN = prev;
    }
  });
});
