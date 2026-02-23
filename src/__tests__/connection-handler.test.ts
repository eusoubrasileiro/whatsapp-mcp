import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleConnectionClose, type ConnectionCloseDeps } from "../connection-handler.ts";

const LOGGED_OUT = 401;
const CONNECTION_CLOSED = 428;

function makeDeps(overrides: Partial<ConnectionCloseDeps> = {}): ConnectionCloseDeps {
  return {
    logger: { warn: vi.fn(), error: vi.fn() } as any,
    connectionState: {
      status: "connected",
      qrCode: "some-qr",
      qrAscii: "ascii-qr",
      user: "TestUser",
    },
    socketState: { socket: {} as any },
    startConnection: vi.fn().mockResolvedValue({} as any),
    rmSync: vi.fn(),
    mkdirSync: vi.fn(),
    setTimeoutFn: vi.fn(),
    pRetryFn: vi.fn().mockResolvedValue({} as any),
    authDir: "/tmp/test_auth",
    loggedOutCode: LOGGED_OUT,
    ...overrides,
  };
}

describe("handleConnectionClose", () => {
  // ── Suite A: State Reset ──────────────────────────────────────────

  describe("state reset (both paths)", () => {
    it("resets connectionState on non-logout close", () => {
      const deps = makeDeps();
      handleConnectionClose(CONNECTION_CLOSED, undefined, "connectionClosed", deps);

      expect(deps.connectionState.status).toBe("disconnected");
      expect(deps.connectionState.qrCode).toBeNull();
      expect(deps.connectionState.qrAscii).toBeNull();
      expect(deps.connectionState.user).toBeNull();
    });

    it("resets socketState.socket to null", () => {
      const deps = makeDeps();
      handleConnectionClose(CONNECTION_CLOSED, undefined, "connectionClosed", deps);

      expect(deps.socketState.socket).toBeNull();
    });

    it("resets connectionState on logout close", () => {
      const deps = makeDeps();
      handleConnectionClose(LOGGED_OUT, undefined, "loggedOut", deps);

      expect(deps.connectionState.status).toBe("disconnected");
      expect(deps.connectionState.qrCode).toBeNull();
      expect(deps.connectionState.qrAscii).toBeNull();
      expect(deps.connectionState.user).toBeNull();
      expect(deps.socketState.socket).toBeNull();
    });
  });

  // ── Suite B: Non-Logout Reconnection (retry path) ────────────────

  describe("non-logout reconnection", () => {
    it("calls pRetryFn with startConnection", () => {
      const deps = makeDeps();
      handleConnectionClose(CONNECTION_CLOSED, undefined, "connectionClosed", deps);

      expect(deps.pRetryFn).toHaveBeenCalledTimes(1);
      // Verify the retry function calls startConnection
      const retryFn = (deps.pRetryFn as ReturnType<typeof vi.fn>).mock.calls[0][0];
      retryFn();
      expect(deps.startConnection).toHaveBeenCalled();
    });

    it("does NOT throw or exit when pRetryFn rejects", async () => {
      const deps = makeDeps({
        pRetryFn: vi.fn().mockRejectedValue(new Error("all retries exhausted")),
      });

      // Must not throw — the handler catches the rejection internally
      handleConnectionClose(CONNECTION_CLOSED, undefined, "connectionClosed", deps);

      // Let the microtask queue flush so .catch() runs
      await vi.waitFor(() => {
        expect(deps.logger.error).toHaveBeenCalledWith(
          expect.objectContaining({ err: expect.any(Error) }),
          expect.stringContaining("All reconnection attempts failed"),
        );
      });
    });

    it("does NOT clear auth_info directory", () => {
      const deps = makeDeps();
      handleConnectionClose(CONNECTION_CLOSED, undefined, "connectionClosed", deps);

      expect(deps.rmSync).not.toHaveBeenCalled();
      expect(deps.mkdirSync).not.toHaveBeenCalled();
    });

    it("does NOT call setTimeoutFn", () => {
      const deps = makeDeps();
      handleConnectionClose(CONNECTION_CLOSED, undefined, "connectionClosed", deps);

      expect(deps.setTimeoutFn).not.toHaveBeenCalled();
    });
  });

  // ── Suite C: Logout Path ──────────────────────────────────────────

  describe("logout path", () => {
    it("clears auth_info directory (rmSync + mkdirSync)", () => {
      const deps = makeDeps();
      handleConnectionClose(LOGGED_OUT, undefined, "loggedOut", deps);

      expect(deps.rmSync).toHaveBeenCalledWith("/tmp/test_auth", {
        recursive: true,
        force: true,
      });
      expect(deps.mkdirSync).toHaveBeenCalledWith("/tmp/test_auth", {
        recursive: true,
      });
    });

    it("schedules reconnection via setTimeoutFn with 2000ms delay", () => {
      const deps = makeDeps();
      handleConnectionClose(LOGGED_OUT, undefined, "loggedOut", deps);

      expect(deps.setTimeoutFn).toHaveBeenCalledTimes(1);
      expect(deps.setTimeoutFn).toHaveBeenCalledWith(expect.any(Function), 2000);
    });

    it("setTimeout callback calls startConnection", () => {
      const deps = makeDeps();
      handleConnectionClose(LOGGED_OUT, undefined, "loggedOut", deps);

      // Extract and invoke the setTimeout callback
      const cb = (deps.setTimeoutFn as ReturnType<typeof vi.fn>).mock.calls[0][0];
      cb();
      expect(deps.startConnection).toHaveBeenCalledTimes(1);
    });

    it("setTimeout callback handles startConnection rejection gracefully", async () => {
      const deps = makeDeps({
        startConnection: vi.fn().mockRejectedValue(new Error("restart failed")),
      });
      handleConnectionClose(LOGGED_OUT, undefined, "loggedOut", deps);

      // Extract and invoke the setTimeout callback
      const cb = (deps.setTimeoutFn as ReturnType<typeof vi.fn>).mock.calls[0][0];
      cb();

      await vi.waitFor(() => {
        expect(deps.logger.error).toHaveBeenCalledWith(
          expect.objectContaining({ err: expect.any(Error) }),
          "Failed to restart connection after logout",
        );
      });
    });

    it("does NOT call pRetryFn", () => {
      const deps = makeDeps();
      handleConnectionClose(LOGGED_OUT, undefined, "loggedOut", deps);

      expect(deps.pRetryFn).not.toHaveBeenCalled();
    });
  });
});
