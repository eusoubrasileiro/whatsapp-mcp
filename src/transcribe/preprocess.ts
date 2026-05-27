/**
 * ffmpeg-based audio preprocessing for Whisper.
 *
 * Converts arbitrary input (OGG/Opus from WhatsApp PTT, MP3, M4A, etc.) to
 * 16 kHz mono FLAC — Whisper's internal sample rate, which shrinks payload
 * ~10× and matches Groq's own cookbook recommendation. This keeps typical
 * WhatsApp voice notes (and even 30-min ones) safely under the 25 MB
 * Groq request ceiling without needing chunking.
 *
 * Input is staged to a temp file before invoking ffmpeg so the demuxer can
 * seek. Non-streamable containers (MP4/M4A with moov atom at end of file —
 * the layout most mobile encoders emit) silently corrupt when fed via a
 * non-seekable stdin pipe: ffmpeg writes ~empty output and exits 0. See
 * GitHub issue #4.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// "Invalid data found when processing input" is too generic — ffmpeg also
// emits it as a recoverable warning on some valid containers. The two markers
// below fire only on the actual demux-truncation failure mode (issue #4).
const DEMUX_ERROR_MARKERS = [
  "Error during demuxing",
  "partial file",
];

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
 * Stages the input to a temp file (deleted in a finally) so ffmpeg's demuxer
 * can seek — required for MP4/M4A containers with moov-at-end. Throws
 * FfmpegError on non-zero exit, missing binary, or a 0-exit that left
 * demux-error markers in stderr.
 */
export async function toFlacMono16k(input: Buffer): Promise<Buffer> {
  // Resolved per-call so tests (and operators) can switch FFMPEG_BIN at runtime.
  const ffmpegBin = process.env.FFMPEG_BIN ?? "ffmpeg";
  const stageDir = await mkdtemp(join(tmpdir(), "wa-flac-"));
  const inputPath = join(stageDir, "in");
  try {
    await writeFile(inputPath, input);

    return await new Promise<Buffer>((resolve, reject) => {
      const args = [
        "-hide_banner",
        "-loglevel", "error",
        "-i", inputPath,
        "-ar", "16000",
        "-ac", "1",
        "-c:a", "flac",
        "-f", "flac",
        "pipe:1",
      ];

      const proc = spawn(ffmpegBin, args, { stdio: ["ignore", "pipe", "pipe"] });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      proc.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

      proc.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") {
          reject(new FfmpegError(`ffmpeg binary not found at "${ffmpegBin}". Install ffmpeg or set FFMPEG_BIN.`));
          return;
        }
        reject(new FfmpegError(`ffmpeg spawn failed: ${err.message}`));
      });

      proc.on("close", (code) => {
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        if (code !== 0) {
          reject(new FfmpegError(`ffmpeg exited with code ${code}`, stderr, code ?? undefined));
          return;
        }
        // Defense-in-depth: ffmpeg sometimes exits 0 after a partial demux,
        // emitting a tiny silent FLAC. Surface those as FfmpegError instead of
        // letting Whisper reject downstream with a misleading "audio too short".
        const demuxFailed = DEMUX_ERROR_MARKERS.some((m) => stderr.includes(m));
        if (demuxFailed) {
          reject(new FfmpegError(
            "ffmpeg exited 0 but stderr reports a demux failure — input is likely corrupt or its container is unsupported",
            stderr,
            0,
          ));
          return;
        }
        resolve(Buffer.concat(stdoutChunks));
      });
    });
  } finally {
    await rm(stageDir, { recursive: true, force: true }).catch(() => { /* best effort */ });
  }
}
