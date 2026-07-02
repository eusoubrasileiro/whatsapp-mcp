import { describe, it, expect } from "vitest";

import { createStreamTokenStore } from "../stream/token.ts";

describe("stream token store", () => {
  function fixedClock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => { t += ms; } };
  }

  it("issues an opaque token that verifies back to the same scope", () => {
    const store = createStreamTokenStore({ ttlMs: 60_000 });
    const scope = { jids: ["c1@s.whatsapp.net"], includeFromMe: true, transcribe: true };
    const issued = store.issue(scope);

    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{16,}$/); // opaque, url-safe
    expect(store.verify(issued.token)).toEqual(scope);
  });

  it("returns null for an unknown token", () => {
    const store = createStreamTokenStore({});
    expect(store.verify("nope")).toBeNull();
  });

  it("expires a token after its TTL", () => {
    const clock = fixedClock();
    const store = createStreamTokenStore({ ttlMs: 1000, now: clock.now });
    const { token } = store.issue({ jids: null, includeFromMe: false, transcribe: true });

    clock.advance(999);
    expect(store.verify(token)).not.toBeNull();
    clock.advance(2);
    expect(store.verify(token)).toBeNull();
  });

  it("renew extends the expiry and keeps the same token + scope", () => {
    const clock = fixedClock();
    const store = createStreamTokenStore({ ttlMs: 1000, now: clock.now });
    const scope = { jids: ["g@g.us"], includeFromMe: true, transcribe: false };
    const { token } = store.issue(scope);

    clock.advance(900);
    const renewed = store.renew(token);
    expect(renewed?.token).toBe(token);
    expect(renewed?.scope).toEqual(scope);

    clock.advance(900); // past the ORIGINAL expiry, within the renewed one
    expect(store.verify(token)).toEqual(scope);
  });

  it("renew returns null for an expired or unknown token", () => {
    const clock = fixedClock();
    const store = createStreamTokenStore({ ttlMs: 1000, now: clock.now });
    const { token } = store.issue({ jids: null, includeFromMe: false, transcribe: true });
    clock.advance(1001);
    expect(store.renew(token)).toBeNull();
    expect(store.renew("unknown")).toBeNull();
  });

  it("issues distinct tokens for distinct calls", () => {
    const store = createStreamTokenStore({});
    const a = store.issue({ jids: null, includeFromMe: false, transcribe: true });
    const b = store.issue({ jids: null, includeFromMe: false, transcribe: true });
    expect(a.token).not.toBe(b.token);
  });
});
