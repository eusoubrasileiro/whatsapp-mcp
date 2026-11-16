import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileWatchdogStore } from "../watchdog-store.ts";

describe("createFileWatchdogStore", () => {
  let dir: string;
  let file: string;
  const logger = pino({ level: "silent" });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-store-"));
    file = path.join(dir, "watchdog-state.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("starts with an empty history when the file does not exist yet", () => {
    expect(createFileWatchdogStore(file, logger).load()).toEqual({
      restarts: [],
      awaitingRecovery: false,
    });
  });

  it("round-trips through a brand-new store instance, like a restarted process", () => {
    createFileWatchdogStore(file, logger).save({
      restarts: [1_700_000_000_000, 1_700_000_900_000],
      awaitingRecovery: true,
    });
    expect(createFileWatchdogStore(file, logger).load()).toEqual({
      restarts: [1_700_000_000_000, 1_700_000_900_000],
      awaitingRecovery: true,
    });
  });

  it("reads a corrupt file as an empty history instead of throwing", () => {
    fs.writeFileSync(file, "{not json");
    expect(createFileWatchdogStore(file, logger).load()).toEqual({
      restarts: [],
      awaitingRecovery: false,
    });
  });

  it("reads a wrong-shaped file as an empty history and drops non-numeric entries", () => {
    fs.writeFileSync(file, JSON.stringify({ restarts: "yesterday" }));
    expect(createFileWatchdogStore(file, logger).load()).toEqual({
      restarts: [],
      awaitingRecovery: false,
    });

    fs.writeFileSync(
      file,
      JSON.stringify({ restarts: [1_700_000_000_000, "x", null, Number.NaN] }),
    );
    expect(createFileWatchdogStore(file, logger).load()).toEqual({
      restarts: [1_700_000_000_000],
      awaitingRecovery: false,
    });
  });

  it("reads a file written before awaitingRecovery existed as not awaiting", () => {
    fs.writeFileSync(file, JSON.stringify({ restarts: [1_700_000_000_000] }));
    expect(createFileWatchdogStore(file, logger).load().awaitingRecovery).toBe(false);
  });

  it("throws on save when the directory is unwritable, so the caller can fail closed", () => {
    const store = createFileWatchdogStore(path.join(dir, "missing-dir", "state.json"), logger);
    expect(() => store.save({ restarts: [1], awaitingRecovery: false })).toThrow();
  });
});
