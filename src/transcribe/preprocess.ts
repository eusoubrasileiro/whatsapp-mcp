/**
 * ffmpeg-based audio preprocessing for Whisper.
 *
 * Converts arbitrary input (OGG/Opus from WhatsApp PTT, MP3, M4A, etc.) to
 * 16 kHz mono FLAC — Whisper's internal sample rate, which shrinks payload
 * ~10× and matches Groq's own cookbook recommendation. This keeps typical
 * WhatsApp voice notes (and even 30-min ones) safely under the 25 MB
 * Groq request ceiling without needing chunking.
 *
 * Implementation: spawn ffmpeg via execFile with stdin/stdout piping.
 * Avoids temp files; safe under concurrent calls.
 */

import { spawn } from "node:child_process";

const FFMPEG_BIN = process.env.FFMPEG_BIN ?? "ffmpeg";

export class FfmpegError extends Error {
  stderr?: string;
  code?: number;
  constructor(message: string, stderr?: string, code?: number) {
    super(message);
    this.name = "FfmpegError";
    this.stderr = stderr;
    this.code = code;
  }
}

/**
 * Convert an audio buffer to 16 kHz mono FLAC.
 *
 * Pipes input via stdin and reads output from stdout so we never touch disk.
 * Throws FfmpegError on non-zero exit or missing binary.
 */
export async function toFlacMono16k(input: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-loglevel", "error",
      "-i", "pipe:0",
      "-ar", "16000",
      "-ac", "1",
      "-c:a", "flac",
      "-f", "flac",
      "pipe:1",
    ];

    const proc = spawn(FFMPEG_BIN, args, { stdio: ["pipe", "pipe", "pipe"] });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    proc.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(new FfmpegError(`ffmpeg binary not found at "${FFMPEG_BIN}". Install ffmpeg or set FFMPEG_BIN.`));
        return;
      }
      reject(new FfmpegError(`ffmpeg spawn failed: ${err.message}`));
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdoutChunks));
      } else {
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        reject(new FfmpegError(`ffmpeg exited with code ${code}`, stderr, code ?? undefined));
      }
    });

    proc.stdin.on("error", () => {
      // EPIPE when ffmpeg rejects input early; surface via close handler's stderr.
    });
    proc.stdin.end(input);
  });
}
