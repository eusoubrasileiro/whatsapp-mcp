import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import pino, { type Logger } from "pino";

// Replace child_process so no real viewer is launched and we can drive 'error'.
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
import { spawn } from "node:child_process";
import { openImageInViewer } from "../mcp/tools/connection.ts";

function silentLogger(): Logger {
  return pino({ level: "silent" });
}

class FakeChild extends EventEmitter {
  unref = vi.fn();
}

const origPlatform = process.platform;
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

describe("openImageInViewer", () => {
  afterEach(() => {
    setPlatform(origPlatform);
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("does not crash when the opener binary is missing (regression: unhandled ENOENT)", () => {
    setPlatform("linux");
    vi.stubEnv("DISPLAY", ":0");
    const child = new FakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    openImageInViewer("/tmp/x.png", silentLogger());

    // An 'error' listener MUST be attached. Without one, emitting 'error' on an
    // EventEmitter throws synchronously — exactly the crash that took prod down.
    expect(child.listenerCount("error")).toBeGreaterThan(0);
    expect(() =>
      child.emit("error", Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" })),
    ).not.toThrow();
  });

  it("does not spawn anything in a headless environment (no DISPLAY/WAYLAND)", () => {
    setPlatform("linux");
    vi.stubEnv("DISPLAY", "");
    vi.stubEnv("WAYLAND_DISPLAY", "");

    openImageInViewer("/tmp/x.png", silentLogger());

    expect(spawn).not.toHaveBeenCalled();
  });

  it("spawns the platform opener when a desktop session is present", () => {
    setPlatform("linux");
    vi.stubEnv("DISPLAY", ":0");
    const child = new FakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    openImageInViewer("/tmp/x.png", silentLogger());

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawn).mock.calls[0][0]).toBe("xdg-open");
  });
});
