import { Writable } from "node:stream";
import pino, { type Logger } from "pino";

/** A logger whose output lines the test can read. */
export function recordingLogger(level = "info"): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  return { logger: pino({ level }, sink), lines };
}
