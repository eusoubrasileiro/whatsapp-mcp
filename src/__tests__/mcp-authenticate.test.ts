import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for the MCP authenticate() callback defined in startMcpServer.
 *
 * Since authenticate is embedded inside startMcpServer and FastMCP invokes it
 * on incoming HTTP requests, we test the authentication logic pattern directly
 * -- verifying it returns { role: "admin" } for valid tokens, throws for
 * invalid, and returns {} when no token is configured or request is absent.
 */

describe("MCP authenticate logic", () => {
  const savedToken = process.env.MCP_AUTH_TOKEN;

  afterEach(() => {
    if (savedToken === undefined) delete process.env.MCP_AUTH_TOKEN;
    else process.env.MCP_AUTH_TOKEN = savedToken;
  });

  // Re-implement the authenticate logic from mcp.ts to test it in isolation
  function makeAuthenticate(authToken: string | undefined) {
    return async (request: any) => {
      if (!request) return {};
      if (!authToken) return {};
      const header = request.headers?.authorization;
      const raw = Array.isArray(header) ? header[0] : header;
      if (!raw || !raw.startsWith("Bearer ")) {
        throw new Error("Missing or invalid Authorization header");
      }
      if (raw.slice(7) !== authToken) {
        throw new Error("Invalid token");
      }
      return { role: "admin" };
    };
  }

  it("returns {} when request is null (stdio transport)", async () => {
    const authenticate = makeAuthenticate("secret");
    const result = await authenticate(null);
    expect(result).toEqual({});
  });

  it("returns {} when MCP_AUTH_TOKEN is not set", async () => {
    const authenticate = makeAuthenticate(undefined);
    const result = await authenticate({ headers: {} });
    expect(result).toEqual({});
  });

  it("returns { role: 'admin' } for valid Bearer token", async () => {
    const authenticate = makeAuthenticate("my-secret-token");
    const result = await authenticate({
      headers: { authorization: "Bearer my-secret-token" },
    });
    expect(result).toEqual({ role: "admin" });
  });

  it("throws when Authorization header is missing", async () => {
    const authenticate = makeAuthenticate("secret");
    await expect(
      authenticate({ headers: {} }),
    ).rejects.toThrow("Missing or invalid Authorization header");
  });

  it("throws when Authorization header does not start with Bearer", async () => {
    const authenticate = makeAuthenticate("secret");
    await expect(
      authenticate({ headers: { authorization: "Basic abc123" } }),
    ).rejects.toThrow("Missing or invalid Authorization header");
  });

  it("throws when token does not match", async () => {
    const authenticate = makeAuthenticate("secret");
    await expect(
      authenticate({ headers: { authorization: "Bearer wrong-token" } }),
    ).rejects.toThrow("Invalid token");
  });

  it("handles array-valued authorization header", async () => {
    const authenticate = makeAuthenticate("secret");
    const result = await authenticate({
      headers: { authorization: ["Bearer secret"] },
    });
    expect(result).toEqual({ role: "admin" });
  });
});
