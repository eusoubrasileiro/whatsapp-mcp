import fs from "node:fs";
import type { Logger } from "pino";

/**
 * What the watchdog must remember across the very restart it causes.
 *
 * Lives in a plain JSON file under the data dir rather than the SQLite store:
 * the watchdog is operational plumbing, and the data layer is a critical path.
 */
type WatchdogState = {
  /** Epoch-ms timestamps of the self-restarts still inside the rolling window. */
  restarts: number[];
  /**
   * True from the moment the watchdog restarts the process until the socket is
   * next live. The restarted process has no FSM memory of the outage, so this
   * is what lets it announce the reconnect.
   */
  awaitingRecovery: boolean;
};

export type WatchdogStore = {
  /** Never throws: anything unreadable reads as an empty history. */
  load: () => WatchdogState;
  /** Throws when the state cannot be written, so the caller can fail closed. */
  save: (state: WatchdogState) => void;
};

function emptyState(): WatchdogState {
  return { restarts: [], awaitingRecovery: false };
}

export function createFileWatchdogStore(file: string, logger: Logger): WatchdogStore {
  return {
    load() {
      let raw: string;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          logger.warn({ err, file }, "Watchdog state file unreadable — starting with no history");
        }
        return emptyState();
      }

      try {
        const parsed = JSON.parse(raw) as { restarts?: unknown; awaitingRecovery?: unknown };
        if (!Array.isArray(parsed.restarts)) return emptyState();
        return {
          restarts: parsed.restarts.filter(
            (ts): ts is number => typeof ts === "number" && Number.isFinite(ts),
          ),
          awaitingRecovery: parsed.awaitingRecovery === true,
        };
      } catch (err) {
        logger.warn({ err, file }, "Watchdog state file corrupt — starting with no history");
        return emptyState();
      }
    },

    save(state) {
      // Write-then-rename so a crash mid-write never leaves a truncated file.
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, file);
    },
  };
}
