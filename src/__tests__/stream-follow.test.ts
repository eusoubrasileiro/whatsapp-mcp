import { describe, expect, it } from "vitest";

import { executeFollowChat } from "../stream/follow.ts";
import { createStreamTokenStore } from "../stream/token.ts";

function deps(ttlMs = 60_000) {
  return { tokens: createStreamTokenStore({ ttlMs }), baseUrl: "wss://mcp.example.com/stream" };
}

describe("executeFollowChat", () => {
  it("returns a ws_url carrying the issued token and an expiry", () => {
    const d = deps();
    const res = executeFollowChat(
      { chatJids: ["g@g.us"], includeFromMe: true, transcribe: true },
      d,
    );

    const url = new URL(res.ws_url);
    expect(url.protocol).toBe("wss:");
    expect(url.pathname).toBe("/stream");
    const token = url.searchParams.get("token");
    expect(token).toBeTruthy();
    // The token verifies to the requested scope.
    expect(d.tokens.verify(token!)).toEqual({
      jids: ["g@g.us"],
      includeFromMe: true,
      transcribe: true,
    });
    expect(res.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(res.note).toMatch(/Monitor/);
  });

  it('treats omitted / ["*"] chat_jids as all chats (null scope)', () => {
    const d = deps();
    const all = executeFollowChat({ includeFromMe: true, transcribe: true }, d);
    const star = executeFollowChat({ chatJids: ["*"], includeFromMe: true, transcribe: true }, d);
    for (const res of [all, star]) {
      const token = new URL(res.ws_url).searchParams.get("token")!;
      expect(d.tokens.verify(token)!.jids).toBeNull();
    }
  });

  it("defaults include_from_me and transcribe to true (persona mode)", () => {
    const d = deps();
    const res = executeFollowChat({ chatJids: ["g@g.us"] }, d);
    const token = new URL(res.ws_url).searchParams.get("token")!;
    expect(d.tokens.verify(token)).toEqual({
      jids: ["g@g.us"],
      includeFromMe: true,
      transcribe: true,
    });
  });
});
