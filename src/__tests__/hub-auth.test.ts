import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPinGate, type PinGate } from "../hub/auth.ts";
import { HubConfigError } from "../hub/config.ts";
import type { NtfyMessage } from "../ntfy.ts";

const PIN = "correct-test-pin";
const KEY = "signing-key-for-tests-0123456789abcdef";
const MIN = 60_000;
const T0 = 1_800_000_000_000;

let stateDir: string;
let clock: number;
let pushes: NtfyMessage[];

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-auth-"));
  clock = T0;
  pushes = [];
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function gate(overrides: { cookieKey?: string; dir?: string } = {}): PinGate {
  return createPinGate({
    pin: PIN,
    cookieKey: overrides.cookieKey ?? KEY,
    stateDir: overrides.dir ?? stateDir,
    now: () => clock,
    sendNtfy: async (message) => {
      pushes.push(message);
    },
  });
}

const attemptsFile = () => path.join(stateDir, "pin-attempts.json");

describe("PIN check", () => {
  it("accepts the right PIN and refuses a wrong one", () => {
    const g = gate();

    expect(g.attempt("203.0.113.1", PIN).outcome).toBe("ok");
    expect(g.attempt("203.0.113.1", "nope").outcome).toBe("wrong");
  });

  it.each([
    ["a PIN that shares a prefix with the real one", PIN.slice(0, -1)],
    ["a PIN that extends the real one", `${PIN}x`],
    ["an empty PIN", ""],
    ["a PIN that shares nothing", "zzzzzzzzzzzzzzzz"],
  ])("refuses %s", (_name, submitted) => {
    expect(gate().attempt("203.0.113.1", submitted).outcome).toBe("wrong");
  });
});

describe("per-address lock: 5 wrong PINs in 15 minutes", () => {
  it("does not lock on 4 wrong PINs: the right one still works", () => {
    const g = gate();
    for (let i = 0; i < 4; i++) g.attempt("a", "bad");

    expect(g.attempt("a", PIN).outcome).toBe("ok");
  });

  it("locks on the 5th wrong PIN and refuses the 6th even when it is right", () => {
    const g = gate();
    for (let i = 0; i < 4; i++) expect(g.attempt("a", "bad").outcome).toBe("wrong");

    expect(g.attempt("a", "bad").outcome).toBe("wrong"); // the 5th is evaluated like any other
    expect(g.attempt("a", PIN)).toEqual({ outcome: "locked", retryAfterS: 900 });
  });

  it("reports how long is left, rounded up to the second", () => {
    const g = gate();
    for (let i = 0; i < 5; i++) g.attempt("a", "bad");

    clock += 5_500;

    expect(g.attempt("a", PIN)).toEqual({ outcome: "locked", retryAfterS: 895 });
  });

  it("keeps refusing until exactly 15 minutes after the 5th, then accepts", () => {
    const g = gate();
    for (let i = 0; i < 5; i++) g.attempt("a", "bad");

    clock = T0 + 15 * MIN - 1;
    expect(g.attempt("a", PIN).outcome).toBe("locked");

    clock = T0 + 15 * MIN;
    expect(g.attempt("a", PIN).outcome).toBe("ok");
  });

  it("measures the lock from the 5th wrong PIN, not from the first", () => {
    const g = gate();
    for (let i = 0; i < 4; i++) g.attempt("a", "bad");
    clock += 10 * MIN;
    g.attempt("a", "bad"); // 5th, ten minutes after the 1st

    clock += 14 * MIN;
    expect(g.attempt("a", PIN).outcome).toBe("locked");
    clock += 1 * MIN;
    expect(g.attempt("a", PIN).outcome).toBe("ok");
  });

  it("does not evaluate or count attempts made during the lock", () => {
    const g = gate();
    for (let i = 0; i < 5; i++) g.attempt("a", "bad");
    for (let i = 0; i < 10; i++) expect(g.attempt("a", "bad").outcome).toBe("locked");

    clock = T0 + 15 * MIN;
    // The count restarts from zero: four more wrong PINs are not a lock.
    for (let i = 0; i < 4; i++) expect(g.attempt("a", "bad").outcome).toBe("wrong");
    expect(g.attempt("a", PIN).outcome).toBe("ok");
  });

  it("locks again after 5 more wrong PINs once the lock has ended", () => {
    const g = gate();
    for (let i = 0; i < 5; i++) g.attempt("a", "bad");
    clock = T0 + 15 * MIN;
    for (let i = 0; i < 5; i++) g.attempt("a", "bad");

    expect(g.attempt("a", PIN).outcome).toBe("locked");
  });

  it("forgets wrong PINs older than 15 minutes", () => {
    const g = gate();
    for (let i = 0; i < 4; i++) g.attempt("a", "bad");

    clock += 15 * MIN; // exactly 15 minutes: the earlier four no longer count
    expect(g.attempt("a", "bad").outcome).toBe("wrong");
    expect(g.attempt("a", PIN).outcome).toBe("ok");
  });

  it("still counts a wrong PIN made 15 minutes less a millisecond ago", () => {
    const g = gate();
    for (let i = 0; i < 4; i++) g.attempt("a", "bad");

    clock += 15 * MIN - 1;
    g.attempt("a", "bad");

    expect(g.attempt("a", PIN).outcome).toBe("locked");
  });

  it("does not lock other addresses", () => {
    const g = gate();
    for (let i = 0; i < 5; i++) g.attempt("a", "bad");

    expect(g.attempt("a", PIN).outcome).toBe("locked");
    expect(g.attempt("b", PIN).outcome).toBe("ok");
  });

  it("does not let a right PIN erase the wrong ones before it", () => {
    const g = gate();
    for (let i = 0; i < 4; i++) g.attempt("a", "bad");
    g.attempt("a", PIN);

    g.attempt("a", "bad");

    expect(g.attempt("a", PIN).outcome).toBe("locked");
  });
});

describe("lock for everyone: 20 wrong PINs in 60 minutes", () => {
  function guessFromManyAddresses(g: PinGate, count: number, spacingMs = MIN): void {
    for (let i = 0; i < count; i++) {
      g.attempt(`198.51.100.${i}`, "bad");
      clock += spacingMs;
    }
  }

  it("does not lock on 19 wrong PINs from 19 addresses", () => {
    const g = gate();
    guessFromManyAddresses(g, 19);

    expect(g.attempt("203.0.113.9", PIN).outcome).toBe("ok");
    expect(pushes).toHaveLength(0);
  });

  it("locks everyone on the 20th, a fresh address and the right PIN included", () => {
    const g = gate();
    guessFromManyAddresses(g, 20);

    expect(g.attempt("203.0.113.9", PIN).outcome).toBe("locked");
    expect(g.attempt("198.51.100.0", PIN).outcome).toBe("locked");
  });

  it("holds the lock for 60 minutes from the 20th wrong PIN, to the millisecond", () => {
    const g = gate();
    guessFromManyAddresses(g, 20, 0);
    const lockedAt = clock;

    clock = lockedAt + 60 * MIN - 1;
    expect(g.attempt("203.0.113.9", PIN)).toEqual({ outcome: "locked", retryAfterS: 1 });

    clock = lockedAt + 60 * MIN;
    expect(g.attempt("203.0.113.9", PIN).outcome).toBe("ok");
  });

  it("sends exactly one push per lock: high priority, fixed title, no secret", () => {
    const g = gate();
    guessFromManyAddresses(g, 20);
    for (let i = 0; i < 5; i++) g.attempt("203.0.113.9", "bad"); // refused: no second push

    expect(pushes).toHaveLength(1);
    expect(pushes[0].title).toBe("WhatsApp hub: PIN is being guessed");
    expect(pushes[0].priority).toBe(4);
    expect(pushes[0].message).toBe(
      "20 wrong PINs in the last hour. The PIN form is locked for 60 minutes.",
    );
    expect(JSON.stringify(pushes[0])).not.toContain(PIN);
    expect(JSON.stringify(pushes[0])).not.toContain(KEY);
    expect(JSON.stringify(pushes[0])).not.toContain("198.51.100");
  });

  it("sends a second push for a second lock", () => {
    const g = gate();
    guessFromManyAddresses(g, 20);
    clock += 61 * MIN;
    guessFromManyAddresses(g, 20);

    expect(pushes).toHaveLength(2);
  });

  it("counts from zero after the lock has ended", () => {
    const g = gate();
    guessFromManyAddresses(g, 20, 0);
    clock += 60 * MIN;

    guessFromManyAddresses(g, 19, 0);

    expect(g.attempt("203.0.113.9", PIN).outcome).toBe("ok");
    expect(pushes).toHaveLength(1);
  });

  it("forgets wrong PINs older than 60 minutes, to the millisecond", () => {
    const g = gate();
    guessFromManyAddresses(g, 19, 0);

    clock += 60 * MIN; // the 19 are exactly an hour old
    g.attempt("203.0.113.8", "bad");
    expect(g.attempt("203.0.113.9", PIN).outcome).toBe("ok");
    expect(pushes).toHaveLength(0);
  });

  it("still counts a wrong PIN made an hour less a millisecond ago", () => {
    const g = gate();
    guessFromManyAddresses(g, 19, 0);

    clock += 60 * MIN - 1;
    g.attempt("203.0.113.8", "bad");

    expect(g.attempt("203.0.113.9", PIN).outcome).toBe("locked");
    expect(pushes).toHaveLength(1);
  });

  it("does not count the refused attempts of a locked address", () => {
    const g = gate();
    for (let i = 0; i < 5; i++) g.attempt("a", "bad");
    for (let i = 0; i < 30; i++) g.attempt("a", "bad"); // refused, so not counted

    expect(g.attempt("b", PIN).outcome).toBe("ok");
    expect(pushes).toHaveLength(0);
  });

  it("survives a push that fails", async () => {
    const failing = createPinGate({
      pin: PIN,
      cookieKey: KEY,
      stateDir,
      now: () => clock,
      sendNtfy: () => Promise.reject(new Error("ntfy down")),
    });

    guessFromManyAddresses(failing, 20, 0);

    expect(failing.attempt("203.0.113.9", PIN).outcome).toBe("locked");
    await new Promise((resolve) => setImmediate(resolve)); // an unhandled rejection would fail the run
  });

  it("works without any push sender", () => {
    const quiet = createPinGate({ pin: PIN, cookieKey: KEY, stateDir, now: () => clock });
    for (let i = 0; i < 20; i++) quiet.attempt(`198.51.100.${i}`, "bad");

    expect(quiet.attempt("203.0.113.9", PIN).outcome).toBe("locked");
  });
});

describe("counters survive a restart", () => {
  it("keeps an address locked in a new gate on the same state directory", () => {
    const first = gate();
    for (let i = 0; i < 5; i++) first.attempt("203.0.113.7", "bad");

    clock += 5 * MIN;
    const restarted = gate();

    expect(restarted.attempt("203.0.113.7", PIN).outcome).toBe("locked");
    expect(restarted.attempt("203.0.113.8", PIN).outcome).toBe("ok");
  });

  it("keeps the wrong-PIN count, not just the lock", () => {
    const first = gate();
    for (let i = 0; i < 4; i++) first.attempt("a", "bad");

    const restarted = gate();
    restarted.attempt("a", "bad");

    expect(restarted.attempt("a", PIN).outcome).toBe("locked");
  });

  it("keeps the lock for everyone", () => {
    const first = gate();
    for (let i = 0; i < 20; i++) first.attempt(`198.51.100.${i}`, "bad");

    expect(gate().attempt("203.0.113.9", PIN).outcome).toBe("locked");
  });

  it("writes after every wrong attempt, and keeps the address and the PIN out of the file", () => {
    const g = gate();
    g.attempt("203.0.113.7", "bad-guess");
    const afterOne = fs.readFileSync(attemptsFile(), "utf8");
    g.attempt("203.0.113.7", "another-guess");

    const text = fs.readFileSync(attemptsFile(), "utf8");
    expect(text).not.toBe(afterOne);
    expect(text).not.toContain("203.0.113.7");
    expect(text).not.toContain(PIN);
    expect(text).not.toContain("guess");
    expect(fs.readdirSync(stateDir)).toEqual(["pin-attempts.json"]); // no temp file left behind
  });

  it("stores the address as a hash keyed by the cookie key", () => {
    gate().attempt("203.0.113.7", "bad");
    const expected = createHmac("sha256", KEY).update("addr:203.0.113.7").digest("hex");

    expect(Object.keys(JSON.parse(fs.readFileSync(attemptsFile(), "utf8")).addresses)).toEqual([
      expected,
    ]);
  });

  it("drops addresses whose lock and window have both ended", () => {
    const g = gate();
    g.attempt("old-address", "bad");
    clock += 16 * MIN;
    g.attempt("new-address", "bad");

    const addresses = JSON.parse(fs.readFileSync(attemptsFile(), "utf8")).addresses;

    expect(Object.keys(addresses)).toEqual([
      createHmac("sha256", KEY).update("addr:new-address").digest("hex"),
    ]);
  });

  it("keeps an address that is still locked", () => {
    const g = gate();
    for (let i = 0; i < 5; i++) g.attempt("locked-address", "bad");
    clock += 1 * MIN;
    g.attempt("other", "bad");

    const addresses = JSON.parse(fs.readFileSync(attemptsFile(), "utf8")).addresses;

    expect(Object.keys(addresses)).toHaveLength(2);
  });

  it("starts with empty counters when there is no file yet, and writes none for a right PIN", () => {
    gate().attempt("a", PIN);

    expect(fs.existsSync(attemptsFile())).toBe(false);
  });

  it.each([
    ["not JSON", "this is not json"],
    ["an empty file", ""],
    ["a JSON array", "[]"],
    ["no global bucket", JSON.stringify({ addresses: {} })],
    ["no address table", JSON.stringify({ global: { failures: [], lockedUntil: 0 } })],
    ["a bucket without failures", JSON.stringify({ global: { lockedUntil: 0 }, addresses: {} })],
    [
      "failures that are not numbers",
      JSON.stringify({ global: { failures: ["x"], lockedUntil: 0 }, addresses: {} }),
    ],
    [
      "a lock that is not a number",
      JSON.stringify({ global: { failures: [], lockedUntil: "never" }, addresses: {} }),
    ],
    [
      "a damaged address bucket",
      JSON.stringify({ global: { failures: [], lockedUntil: 0 }, addresses: { abc: 7 } }),
    ],
  ])("refuses to start on a file that is %s, never with empty counters", (_name, content) => {
    fs.writeFileSync(attemptsFile(), content);

    expect(() => gate()).toThrow(HubConfigError);
  });

  it("names the file and never the PIN or the key when it refuses", () => {
    fs.writeFileSync(attemptsFile(), "garbage");

    try {
      gate();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("pin-attempts.json");
      expect((err as Error).message).not.toContain(PIN);
      expect((err as Error).message).not.toContain(KEY);
    }
  });

  it("accepts a well-formed file, including a lock that has already ended", () => {
    fs.writeFileSync(
      attemptsFile(),
      JSON.stringify({ global: { failures: [1], lockedUntil: 2 }, addresses: {} }),
    );

    expect(gate().attempt("a", PIN).outcome).toBe("ok");
  });
});

describe("session cookie", () => {
  const sign = (body: string, key = KEY) =>
    createHmac("sha256", key).update(body).digest("base64url");
  const cookieOf = (setCookie: string) => setCookie.split(";")[0].slice("wa_hub=".length);
  const withCookie = (value: string) => `wa_hub=${value}`;

  it("is set with exactly the documented attributes and a 30-day life", () => {
    const setCookie = gate().issueCookie();

    expect(setCookie).toMatch(
      /^wa_hub=v1\.\d+\.[0-9a-f]{24}\.[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000$/,
    );
    const expires = Number(cookieOf(setCookie).split(".")[1]);
    expect(expires).toBe(Math.floor(T0 / 1000) + 2_592_000);
  });

  it("is signed with HMAC-SHA256 over its first three parts", () => {
    const value = cookieOf(gate().issueCookie());
    const [version, expires, id, signature] = value.split(".");

    expect(signature).toBe(sign(`${version}.${expires}.${id}`));
  });

  it("differs between two logins", () => {
    const g = gate();

    expect(cookieOf(g.issueCookie())).not.toBe(cookieOf(g.issueCookie()));
  });

  it("is accepted, alone or among other cookies", () => {
    const g = gate();
    const value = cookieOf(g.issueCookie());

    expect(g.hasSession(withCookie(value))).toBe(true);
    expect(g.hasSession(`theme=dark; ${withCookie(value)}; other=1`)).toBe(true);
  });

  it("is accepted in a gate that restarted with the same key", () => {
    const value = cookieOf(gate().issueCookie());

    expect(gate().hasSession(withCookie(value))).toBe(true);
  });

  it("is valid until its expiry second and not after", () => {
    const g = gate();
    const value = cookieOf(g.issueCookie());
    const expiresMs = Number(value.split(".")[1]) * 1000;

    clock = expiresMs - 1000;
    expect(g.hasSession(withCookie(value))).toBe(true);
    clock = expiresMs;
    expect(g.hasSession(withCookie(value))).toBe(false);
    clock = expiresMs + 86_400_000;
    expect(g.hasSession(withCookie(value))).toBe(false);
  });

  it.each([
    ["no cookie header at all", undefined],
    ["an empty header", ""],
    ["other cookies only", "theme=dark; a=b"],
    ["an empty value", "wa_hub="],
    ["garbage", "wa_hub=garbage"],
    ["a cookie that merely ends in the right name", "xwa_hub=v1.1.2.3"],
  ])("refuses %s", (_name, header) => {
    expect(gate().hasSession(header)).toBe(false);
  });

  it("refuses a forged signature", () => {
    const g = gate();
    const value = cookieOf(g.issueCookie());
    const last = value.endsWith("A") ? "B" : "A";

    expect(g.hasSession(withCookie(value.slice(0, -1) + last))).toBe(false);
  });

  it("refuses a truncated value", () => {
    const g = gate();
    const value = cookieOf(g.issueCookie());

    expect(g.hasSession(withCookie(value.slice(0, -5)))).toBe(false);
    expect(g.hasSession(withCookie(value.slice(0, 20)))).toBe(false);
  });

  it("refuses a value with an extra part", () => {
    const g = gate();
    const value = cookieOf(g.issueCookie());

    expect(g.hasSession(withCookie(`${value}.extra`))).toBe(false);
  });

  it("refuses a cookie signed with another key", () => {
    const foreign = gate({ cookieKey: "another-signing-key-0123456789abcdefgh" });

    expect(gate().hasSession(withCookie(cookieOf(foreign.issueCookie())))).toBe(false);
  });

  it("refuses a longer expiry grafted onto a real signature", () => {
    const g = gate();
    const [version, expires, id, signature] = cookieOf(g.issueCookie()).split(".");
    const grafted = `${version}.${Number(expires) + 99_999_999}.${id}.${signature}`;

    expect(g.hasSession(withCookie(grafted))).toBe(false);
  });

  it("refuses an expired value even though its signature is genuine", () => {
    const g = gate();
    const body = `v1.${Math.floor(T0 / 1000) - 10}.${"ab".repeat(12)}`;

    expect(g.hasSession(withCookie(`${body}.${sign(body)}`))).toBe(false);
  });

  it("refuses another version even though its signature is genuine", () => {
    const g = gate();
    const body = `v2.${Math.floor(T0 / 1000) + 1000}.${"ab".repeat(12)}`;

    expect(g.hasSession(withCookie(`${body}.${sign(body)}`))).toBe(false);
  });

  it.each([
    ["a non-numeric expiry", `v1.soon.${"ab".repeat(12)}`],
    ["a malformed id", "v1.99999999999.not-hex"],
  ])("refuses %s even though its signature is genuine", (_name, body) => {
    const g = gate();

    expect(g.hasSession(withCookie(`${body}.${sign(body)}`))).toBe(false);
  });

  it("refuses a signature written in a non-canonical way", () => {
    const g = gate();
    const value = cookieOf(g.issueCookie());

    expect(g.hasSession(withCookie(`${value}=`))).toBe(false);
    expect(g.hasSession(withCookie(`${value}!`))).toBe(false);
  });

  it.each(["=", ";;;", "wa_hub", "wa_hub==", "\u0000", "wa_hub=%%%"])(
    "does not throw on the unparseable cookie header %j",
    (header) => {
      expect(gate().hasSession(header)).toBe(false);
    },
  );
});
