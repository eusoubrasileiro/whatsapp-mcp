import { describe, expect, it } from "vitest";
import {
  allowsNoAuth,
  assertListenersGuarded,
  authenticateMcpRequest,
  openEndpointWarning,
  readAuthToken,
} from "../listener-auth.ts";

describe("readAuthToken", () => {
  it.each([
    [{}, undefined],
    [{ MCP_AUTH_TOKEN: "" }, undefined],
    [{ MCP_AUTH_TOKEN: " \t" }, undefined],
    [{ MCP_AUTH_TOKEN: "s3cret" }, "s3cret"],
    [{ MCP_AUTH_TOKEN: " s3cret " }, " s3cret "],
  ])("reads %j as %j", (env, token) => {
    expect(readAuthToken(env)).toBe(token);
  });
});

describe("allowsNoAuth", () => {
  it.each([
    [undefined, false],
    ["", false],
    ["1", false],
    ["yes", false],
    ["false", false],
    ["true", true],
    [" True ", true],
  ])("MCP_ALLOW_NO_AUTH=%j allows: %s", (flag, allowed) => {
    expect(allowsNoAuth(flag === undefined ? {} : { MCP_ALLOW_NO_AUTH: flag })).toBe(allowed);
  });
});

describe("assertListenersGuarded", () => {
  it.each([
    ["stdio with no store", {}],
    ["explicit stdio", { MCP_TRANSPORT: "STDIO" }],
    ["HTTP with a token", { MCP_TRANSPORT: "httpstream", MCP_AUTH_TOKEN: "t" }],
    ["upload with a token", { S3_ENABLED: "true", MCP_AUTH_TOKEN: "t" }],
    [
      "HTTP and upload, flagged",
      { MCP_TRANSPORT: "http", S3_ENABLED: "true", MCP_ALLOW_NO_AUTH: "true" },
    ],
    ["a store that is not enabled", { S3_ENABLED: "TRUE" }],
  ])("lets %s start", (_kind, env) => {
    expect(() => assertListenersGuarded(env)).not.toThrow();
  });

  it.each([
    [{ MCP_TRANSPORT: "httpstream" }, "the MCP endpoint"],
    [{ MCP_TRANSPORT: "unknown" }, "the MCP endpoint"],
    [{ S3_ENABLED: "true" }, "the upload server"],
    [{ MCP_TRANSPORT: "sse", S3_ENABLED: "true" }, "the MCP endpoint and the upload server"],
  ])("refuses %j, naming %s", (env, open) => {
    expect(() => assertListenersGuarded(env)).toThrow(
      `MCP_AUTH_TOKEN is not set, so ${open} would accept anyone. Set MCP_AUTH_TOKEN, or MCP_ALLOW_NO_AUTH=true on a development machine.`,
    );
  });
});

describe("openEndpointWarning", () => {
  it("warns only when there is no token and the flag opens the endpoint", () => {
    expect(openEndpointWarning(undefined, true)).toBe(
      "MCP_ALLOW_NO_AUTH=true and no MCP_AUTH_TOKEN — the HTTP MCP endpoint accepts anyone. Development only.",
    );
    expect(openEndpointWarning(undefined, false)).toBeNull();
    expect(openEndpointWarning("t", true)).toBeNull();
    expect(openEndpointWarning("t", false)).toBeNull();
  });
});

describe("authenticateMcpRequest", () => {
  const request = (authorization?: string | string[]) => ({
    headers: { authorization } as { authorization?: string },
  });

  async function statusOf(run: () => unknown): Promise<number | "allowed"> {
    try {
      run();
      return "allowed";
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      return (thrown as Response).status;
    }
  }

  it("trusts stdio, which has no request, with or without a token", async () => {
    expect(await statusOf(() => authenticateMcpRequest(undefined, undefined, false))).toBe(
      "allowed",
    );
    expect(await statusOf(() => authenticateMcpRequest(undefined, "t", false))).toBe("allowed");
  });

  it("refuses every HTTP request when there is no token and no flag", async () => {
    expect(
      await statusOf(() => authenticateMcpRequest(request("Bearer anything"), undefined, false)),
    ).toBe(401);
    expect(await statusOf(() => authenticateMcpRequest(request(), undefined, false))).toBe(401);
  });

  it("lets every HTTP request in when there is no token and the flag is set", async () => {
    expect(await statusOf(() => authenticateMcpRequest(request(), undefined, true))).toBe(
      "allowed",
    );
  });

  it.each([
    [undefined, 401],
    ["s3cret", 401],
    ["Basic s3cret", 401],
    ["Bearer nope", 401],
    ["Bearer s3cret ", 401],
    ["Bearer s3cret", "allowed"],
    [["Bearer s3cret", "Bearer nope"], "allowed"],
  ])("with a token, Authorization %j → %s", async (header, outcome) => {
    expect(await statusOf(() => authenticateMcpRequest(request(header), "s3cret", true))).toBe(
      outcome,
    );
  });
});
