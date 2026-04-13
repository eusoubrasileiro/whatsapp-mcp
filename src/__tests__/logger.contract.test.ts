import { describe, expect, it } from "vitest";
import pino from "pino";

// Contract test pinning the pino API surface consumed by src/main.ts.
// Must stay green across pino 9 → 10.
// A failure means pino's defaults or API diverged from what main.ts expects.

type CapturedLine = {
  level: number;
  msg: string;
  time: unknown;
  [k: string]: unknown;
};

function makeCapturingLogger(level = "info") {
  const lines: CapturedLine[] = [];
  const stream = {
    write(chunk: string) {
      for (const line of chunk.split("\n")) {
        if (!line) continue;
        lines.push(JSON.parse(line));
      }
    },
  };
  const logger = pino(
    {
      level,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    stream,
  );
  return { logger, lines };
}

describe("pino logger contract", () => {
  it("exposes stdTimeFunctions.isoTime", () => {
    expect(typeof pino.stdTimeFunctions.isoTime).toBe("function");
  });

  it("exposes pino.destination used for file outputs", () => {
    expect(typeof pino.destination).toBe("function");
  });

  it("produces JSON lines with level, msg, and time fields on .info()", () => {
    const { logger, lines } = makeCapturingLogger();
    logger.info("hello");
    expect(lines).toHaveLength(1);
    const entry = lines[0];
    expect(entry.msg).toBe("hello");
    expect(entry.level).toBe(30); // info
    expect(typeof entry.time).toBe("string");
    expect(entry.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("accepts object+message signature logger.info({foo: 1}, 'msg')", () => {
    const { logger, lines } = makeCapturingLogger();
    logger.info({ foo: 1 }, "hi");
    expect(lines[0].msg).toBe("hi");
    expect(lines[0].foo).toBe(1);
  });

  it("accepts error-binding signature logger.error({err}, 'msg')", () => {
    const { logger, lines } = makeCapturingLogger();
    const err = new Error("boom");
    logger.error({ err }, "failed");
    expect(lines[0].msg).toBe("failed");
    expect(lines[0].err).toBeDefined();
  });

  it("respects log level — debug is filtered at level=info", () => {
    const { logger, lines } = makeCapturingLogger("info");
    logger.debug("noise");
    logger.info("keep");
    expect(lines).toHaveLength(1);
    expect(lines[0].msg).toBe("keep");
  });

  it("flush() exists and is callable", () => {
    const { logger } = makeCapturingLogger();
    expect(typeof logger.flush).toBe("function");
    expect(() => logger.flush()).not.toThrow();
  });

  it("fatal() exists (used in src/main.ts catch blocks)", () => {
    const { logger, lines } = makeCapturingLogger();
    logger.fatal({ err: new Error("x") }, "dead");
    expect(lines[0].level).toBe(60);
  });
});
