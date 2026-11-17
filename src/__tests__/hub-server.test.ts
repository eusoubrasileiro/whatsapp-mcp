import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PAGE_POLL_INTERVAL_MS } from "../hub/page.ts";
import { createPoller, POLL_INTERVAL_MS } from "../hub/poller.ts";
import { clientAddress, isLoopbackPeer, safeNext } from "../hub/server.ts";
import { type FakeInstance, qrPng, startFakeInstance } from "./helpers/fake-instance.ts";
import {
  type HubHarness,
  loginForm,
  request,
  startHubHarness,
  TEST_COOKIE_KEY,
  TEST_PIN,
  withoutNonce,
} from "./helpers/hub-harness.ts";

const MIN = 60_000;
const revOf = (png: Buffer) => createHash("sha256").update(png).digest("hex").slice(0, 12);

let fakes: FakeInstance[];
let hub: HubHarness | undefined;
let personal: FakeInstance;
let empresa: FakeInstance;

beforeEach(async () => {
  personal = await startFakeInstance({
    status: "connected",
    instance: { label: "personal", description: "Personal line" },
    phone_last4: "5678",
  });
  empresa = await startFakeInstance({
    status: "qr_pending",
    instance: { label: "empresa", description: "Company line" },
    phone_last4: "1234",
  });
  empresa.setQr(await qrPng("empresa-1"));
  fakes = [personal, empresa];
});

afterEach(async () => {
  await hub?.close();
  hub = undefined;
  await Promise.all(fakes.map((fake) => fake.close()));
});

async function startHub(pollerTimeoutMs?: number): Promise<HubHarness> {
  hub = await startHubHarness({
    instances: [
      { label: "personal", baseUrl: personal.url },
      { label: "empresa", baseUrl: empresa.url },
    ],
    pollerTimeoutMs,
  });
  await hub.poller.pollOnce();
  return hub;
}

describe("address helpers", () => {
  it.each([
    ["127.0.0.1", true],
    ["127.8.9.10", true],
    ["::1", true],
    ["::ffff:127.0.0.1", true],
    ["203.0.113.5", false],
    ["10.0.0.7", false],
    ["::ffff:10.0.0.7", false],
    ["2001:db8::1", false],
    ["1127.0.0.1", false],
    [undefined, false],
  ])("treats %s as loopback: %s", (address, expected) => {
    expect(isLoopbackPeer(address)).toBe(expected);
  });

  it("takes the last entry of X-Forwarded-For, never the first", () => {
    expect(clientAddress({ "x-forwarded-for": "1.1.1.1, 2.2.2.2,  3.3.3.3 " }, "10.0.0.1")).toBe(
      "3.3.3.3",
    );
    expect(clientAddress({ "x-forwarded-for": "9.9.9.9" }, "10.0.0.1")).toBe("9.9.9.9");
  });

  it("uses the socket's address when there is no X-Forwarded-For", () => {
    expect(clientAddress({}, "10.0.0.1")).toBe("10.0.0.1");
    expect(clientAddress({}, undefined)).toBe("unknown");
  });

  it.each([
    ["/", "/"],
    ["/empresa", "/empresa"],
    ["/a-1", "/a-1"],
    ["//evil.example.com", "/"],
    ["/a/b", "/"],
    ["/Empresa", "/"],
    ["/_hub/status.json", "/"],
    ["https://evil.example.com", "/"],
    ["javascript:alert(1)", "/"],
    ["", "/"],
    [null, "/"],
    ["/empresa\n", "/"],
  ])("sends a login back to %j as %j", (given, expected) => {
    expect(safeNext(given)).toBe(expected);
  });
});

describe("without a session", () => {
  it.each(["/", "/_hub/status.json", "/_hub/qr/empresa.png", "/nothing/here", "/_hub/login"])(
    "answers %s with 401, the PIN form and nothing else",
    async (path) => {
      const { url } = await startHub();

      const res = await request(url, path);

      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(res.body).toContain('<form class="gate-card" method="post" action="/_hub/login">');
      expect(res.body).not.toContain("That PIN did not work.");
      expect(res.body).not.toContain('role="alert"');
      for (const secret of ["personal", "empresa", "Company line", "1234", "5678", "instances"]) {
        expect(res.body).not.toContain(secret);
      }
      expect(res.body).not.toContain("<img");
      expect(res.body).not.toContain("<script");
    },
  );

  it("echoes only the requested path, whether or not such a number exists", async () => {
    const { url } = await startHub();

    const real = await request(url, "/empresa");
    const imaginary = await request(url, "/nobody");

    expect(real.body).toContain('name="next" value="/empresa"');
    expect(withoutNonce(real.body).replace("/empresa", "/nobody")).toBe(
      withoutNonce(imaginary.body),
    );
    expect(real.body.split('value="/empresa"').join("")).not.toContain("empresa");
  });

  it.each([
    ["/", "/"],
    ["/_hub/status.json", "/"],
    ["/Not-Valid", "/"],
    ["/a/b?x=1", "/"],
    ["/personal?x=1", "/personal"],
  ])("sends %s back to %s after the PIN", async (path, next) => {
    const { url } = await startHub();

    const res = await request(url, path);

    expect(res.body).toContain(`name="next" value="${next}"`);
  });

  it("refuses every other method the same way", async () => {
    const { url } = await startHub();

    for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
      expect((await request(url, "/", { method })).status).toBe(401);
    }
  });

  it.each(["/.well-known/oauth-protected-resource", "/.well-known/", "/favicon.ico"])(
    "answers %s with an empty 404, never HTML",
    async (path) => {
      const { url } = await startHub();

      const res = await request(url, path);

      expect(res.status).toBe(404);
      expect(res.body).toBe("");
    },
  );

  it("answers /live to a loopback peer with no X-Forwarded-For", async () => {
    const { url } = await startHub();

    const res = await request(url, "/live");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(JSON.parse(res.body)).toEqual({ live: true });
  });

  it("treats /live like any other path when the request came through the proxy", async () => {
    const { url } = await startHub();

    const res = await request(url, "/live", { headers: { "x-forwarded-for": "127.0.0.1" } });

    expect(res.status).toBe(401);
    expect(res.body).toContain("/_hub/login");
  });

  it("does not answer a live probe with a session cookie differently when proxied", async () => {
    const { url, login } = await startHub().then((h) => ({ url: h.url, login: h.login }));
    const cookie = await login();

    const res = await request(url, "/live", { cookie, headers: { "x-forwarded-for": "1.2.3.4" } });

    expect(res.status).toBe(404);
    expect(res.body).toContain("no number called &quot;live&quot;");
  });
});

describe("headers on every response", () => {
  it("sends the four hardening headers on pages, JSON, images, redirects and errors", async () => {
    const h = await startHub();
    const cookie = await h.login();

    const responses = [
      await request(h.url, "/"), // 401 form
      await request(h.url, "/", { cookie }), // page
      await request(h.url, "/_hub/status.json", { cookie }),
      await request(h.url, "/_hub/qr/empresa.png", { cookie }),
      await request(h.url, "/_hub/qr/personal.png", { cookie }), // 404
      await request(h.url, "/a/b", { cookie }), // 404
      await request(h.url, "/favicon.ico"),
      await request(h.url, "/live"),
      await request(h.url, "/_hub/login", {
        method: "POST",
        body: loginForm(TEST_PIN, "/personal"),
      }), // 303
      await request(h.url, "/_hub/login", { method: "POST", body: loginForm("wrong") }), // 401
    ];

    for (const res of responses) {
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });

  it("sends a strict content security policy with a fresh nonce on every HTML response", async () => {
    const h = await startHub();
    const cookie = await h.login();

    const nonces: string[] = [];
    for (const res of [
      await request(h.url, "/"),
      await request(h.url, "/", { cookie }),
      await request(h.url, "/nobody", { cookie }),
    ]) {
      const csp = res.headers.get("content-security-policy") ?? "";
      const nonce = /style-src 'nonce-([^']+)'/.exec(csp)?.[1] ?? "";
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
      expect(csp).toBe(
        `default-src 'none'; img-src 'self'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
      );
      expect(res.body).toContain(`<style nonce="${nonce}">`);
      nonces.push(nonce);
    }
    expect(new Set(nonces).size).toBe(3);
  });

  it("puts the nonce on the page's script, and loads nothing from another origin", async () => {
    const h = await startHub();
    const cookie = await h.login();

    const res = await request(h.url, "/", { cookie });

    const nonce = /<style nonce="([^"]+)">/.exec(res.body)?.[1];
    expect(res.body).toContain(`<script nonce="${nonce}">`);
    expect(res.body).not.toMatch(/https?:\/\//);
    expect(res.body).not.toMatch(/<link\b|@import|<iframe|<object|<embed/i);
    expect(res.body).not.toMatch(/\sstyle=/); // an inline style attribute would need unsafe-inline
    expect(res.body.match(/<script\b/g)).toHaveLength(1);
  });

  it("serves no CSP on JSON and images, which carry no markup", async () => {
    const h = await startHub();
    const cookie = await h.login();

    expect(
      (await request(h.url, "/_hub/status.json", { cookie })).headers.get("content-type"),
    ).toBe("application/json; charset=utf-8");
    expect(
      (await request(h.url, "/_hub/qr/empresa.png", { cookie })).headers.get("content-type"),
    ).toBe("image/png");
  });
});

describe("logging in", () => {
  it("accepts the right PIN: 303 to the requested path with the session cookie", async () => {
    const { url } = await startHub();

    const res = await request(url, "/_hub/login", {
      method: "POST",
      body: loginForm(TEST_PIN, "/empresa"),
    });

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/empresa");
    expect(res.headers.get("set-cookie")).toMatch(
      /^wa_hub=v1\.\d+\.[0-9a-f]{24}\.[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000$/,
    );
    expect(res.body).toBe("");
  });

  it("sends a visitor who was not given a path to /", async () => {
    const { url } = await startHub();

    const res = await request(url, "/_hub/login", { method: "POST", body: loginForm(TEST_PIN) });

    expect(res.headers.get("location")).toBe("/");
  });

  it.each([
    "//evil.example.com",
    "https://evil.example.com/",
    "/a/b",
    "/UPPER",
    "javascript:alert(1)",
  ])("never redirects to the unsafe path %s", async (next) => {
    const { url } = await startHub();

    const res = await request(url, "/_hub/login", {
      method: "POST",
      body: loginForm(TEST_PIN, next),
    });

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
  });

  it("opens the page afterwards, and the deep link lands on that number's card", async () => {
    const h = await startHub();
    const form = await request(h.url, "/empresa");
    const next = /name="next" value="([^"]*)"/.exec(form.body)?.[1] ?? "";
    const loggedIn = await request(h.url, "/_hub/login", {
      method: "POST",
      body: loginForm(TEST_PIN, next),
    });
    const cookie = (loggedIn.headers.get("set-cookie") ?? "").split(";")[0];

    const page = await request(h.url, loggedIn.headers.get("location") ?? "/", { cookie });

    expect(page.status).toBe(200);
    expect(page.body).toMatch(/<article class="card is-target"[^>]*data-label="empresa"/);
  });

  it("answers a wrong PIN with the same form and the same sentence every time", async () => {
    const { url } = await startHub();

    const sharingPrefix = await request(url, "/_hub/login", {
      method: "POST",
      body: loginForm(TEST_PIN.slice(0, -1), "/empresa"),
    });
    const sharingNothing = await request(url, "/_hub/login", {
      method: "POST",
      body: loginForm("zzzzzzzzzzzzzzzz", "/empresa"),
    });
    const empty = await request(url, "/_hub/login", {
      method: "POST",
      body: "next=%2Fempresa",
    });

    expect(sharingPrefix.status).toBe(401);
    expect(sharingPrefix.body).toContain("That PIN did not work.");
    expect(withoutNonce(sharingPrefix.body)).toBe(withoutNonce(sharingNothing.body));
    expect(withoutNonce(sharingPrefix.body)).toBe(withoutNonce(empty.body));
    expect(sharingPrefix.headers.get("set-cookie")).toBeNull();
    expect(sharingPrefix.body.match(/<p\b/g)).toHaveLength(1); // the one sentence, nothing about counts
    expect(/<p class="error" role="alert">([^<]*)<\/p>/.exec(sharingPrefix.body)?.[1]).toBe(
      "That PIN did not work.",
    );
  });

  it("keeps the requested path through a wrong PIN", async () => {
    const { url } = await startHub();

    const res = await request(url, "/_hub/login", {
      method: "POST",
      body: loginForm("nope", "/empresa"),
    });

    expect(res.body).toContain('name="next" value="/empresa"');
  });

  it("refuses a login body that is too large without evaluating it", async () => {
    const { url } = await startHub();

    const huge = await request(url, "/_hub/login", {
      method: "POST",
      body: `${loginForm(TEST_PIN, "/")}&junk=${"x".repeat(5000)}`,
    });
    const justRight = await request(url, "/_hub/login", {
      method: "POST",
      body: `${loginForm(TEST_PIN)}&junk=${"x".repeat(1500)}`,
    });

    expect(huge.status).toBe(413);
    expect(huge.headers.get("set-cookie")).toBeNull();
    expect(justRight.status).toBe(303);
  });

  it("takes a login body of exactly 2048 bytes and refuses one byte more", async () => {
    const { url } = await startHub();
    const form = `${loginForm(TEST_PIN)}&junk=`;
    const padded = (bytes: number) => form + "x".repeat(bytes - form.length);

    const atLimit = await request(url, "/_hub/login", { method: "POST", body: padded(2048) });
    const oneMore = await request(url, "/_hub/login", { method: "POST", body: padded(2049) });

    expect(atLimit.status).toBe(303);
    expect(oneMore.status).toBe(413);
  });

  it("does not take GET on the login path for an attempt", async () => {
    const h = await startHub();
    const cookie = await h.login();

    expect((await request(h.url, "/_hub/login", { cookie })).status).toBe(404);
  });
});

describe("locking", () => {
  const wrong = (url: string, headers: Record<string, string> = {}) =>
    request(url, "/_hub/login", { method: "POST", body: loginForm("wrong"), headers });
  const right = (url: string, headers: Record<string, string> = {}) =>
    request(url, "/_hub/login", { method: "POST", body: loginForm(TEST_PIN), headers });

  it("locks an address after 5 wrong PINs: the 6th is refused with 429 even when right", async () => {
    const h = await startHub();
    for (let i = 0; i < 5; i++) expect((await wrong(h.url)).status).toBe(401);

    const refused = await right(h.url);

    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("900");
    expect(refused.headers.get("set-cookie")).toBeNull();
    expect(refused.body).not.toContain("<form");
    expect(refused.body).toContain("Too many wrong PINs");
    expect(refused.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("accepts the right PIN one second after the 15 minutes", async () => {
    const h = await startHub();
    for (let i = 0; i < 5; i++) await wrong(h.url);

    h.clock.now += 15 * MIN - 1;
    expect((await right(h.url)).status).toBe(429);
    h.clock.now += 1;
    expect((await right(h.url)).status).toBe(303);
  });

  it("counts addresses by the LAST X-Forwarded-For entry", async () => {
    const h = await startHub();
    for (let i = 0; i < 5; i++)
      await wrong(h.url, { "x-forwarded-for": `10.9.9.${i}, 203.0.113.9` });

    // Same last entry, a different invented first entry: still the locked address.
    expect((await right(h.url, { "x-forwarded-for": "1.1.1.1, 203.0.113.9" })).status).toBe(429);
    // Same first entry as the attacker used, but another last entry: a different address.
    expect((await right(h.url, { "x-forwarded-for": "10.9.9.0, 198.51.100.4" })).status).toBe(303);
    // And the socket's own address is not the locked one either.
    expect((await right(h.url)).status).toBe(303);
  });

  it("locks the form for everyone after 20 wrong PINs from 20 addresses, with one push", async () => {
    const h = await startHub();
    for (let i = 0; i < 20; i++) {
      await wrong(h.url, { "x-forwarded-for": `198.51.100.${i}` });
      h.clock.now += 1000;
    }

    const refused = await right(h.url, { "x-forwarded-for": "203.0.113.77" });
    await right(h.url, { "x-forwarded-for": "203.0.113.78" });

    expect(refused.status).toBe(429);
    expect(h.pushes).toHaveLength(1);
    expect(h.pushes[0]).toMatchObject({
      title: "WhatsApp hub: PIN is being guessed",
      priority: 4,
    });
  });

  it("stays locked across a restart of the hub on the same state directory", async () => {
    const h = await startHub();
    for (let i = 0; i < 5; i++) await wrong(h.url);
    const { createPinGate } = await import("../hub/auth.ts");

    const restarted = createPinGate({
      pin: TEST_PIN,
      cookieKey: TEST_COOKIE_KEY,
      stateDir: h.stateDir,
      now: () => h.clock.now,
    });

    expect(restarted.attempt("127.0.0.1", TEST_PIN).outcome).toBe("locked");
  });
});

describe("session cookies", () => {
  it("lets a genuine cookie in and keeps it working on every later request", async () => {
    const h = await startHub();
    const cookie = await h.login();

    for (let i = 0; i < 3; i++) expect((await request(h.url, "/", { cookie })).status).toBe(200);
  });

  it.each([
    ["a forged signature", (c: string) => `${c.slice(0, -2)}AA`],
    ["a truncated value", (c: string) => c.slice(0, -12)],
    ["an empty value", () => "wa_hub="],
    ["another cookie's name", (c: string) => c.replace("wa_hub", "other")],
  ])("shows the PIN form to a visitor with %s", async (_name, tamper) => {
    const h = await startHub();
    const cookie = tamper(await h.login());

    const res = await request(h.url, "/", { cookie });

    expect(res.status).toBe(401);
    expect(res.body).toContain("/_hub/login");
  });

  it("shows the PIN form to a visitor whose cookie has expired", async () => {
    const h = await startHub();
    const cookie = await h.login();

    h.clock.now += 30 * 24 * 60 * MIN;

    expect((await request(h.url, "/", { cookie })).status).toBe(401);
  });

  it("shows the PIN form to a visitor whose cookie was signed with another key", async () => {
    const h = await startHub();
    const { createPinGate } = await import("../hub/auth.ts");
    const foreign = createPinGate({
      pin: TEST_PIN,
      cookieKey: "another-signing-key-0123456789abcdefgh",
      stateDir: h.stateDir.concat(""),
      now: () => h.clock.now,
    });
    const cookie = foreign.issueCookie().split(";")[0];

    expect((await request(h.url, "/", { cookie })).status).toBe(401);
  });
});

describe("with a session", () => {
  it("shows one card per number, in the configured order, with label, description, last four and state", async () => {
    const h = await startHub();
    const cookie = await h.login();

    const res = await request(h.url, "/", { cookie });

    expect(res.status).toBe(200);
    const cards = [
      ...res.body.matchAll(
        /<article class="card[^"]*"[^>]*data-label="([^"]+)" data-state="([^"]+)"/g,
      ),
    ];
    expect(cards.map((c) => [c[1], c[2]])).toEqual([
      ["personal", "connected"],
      ["empresa", "waiting_qr"],
    ]);
    for (const text of [
      "Personal line",
      "number ending 5678",
      "Connected",
      "Company line",
      "number ending 1234",
      "Waiting for you to scan the QR code",
    ]) {
      expect(res.body).toContain(text);
    }
  });

  it("shows the QR of the waiting number inline, wide enough to scan, with a sentence naming the phone", async () => {
    const h = await startHub();
    const cookie = await h.login();
    const rev = revOf(await qrPng("empresa-1"));

    const res = await request(h.url, "/", { cookie });

    const img = /<img class="qr-img"[^>]*\ssrc="[^"]*"[^>]*>/.exec(res.body)?.[0] ?? "";
    expect(img).toContain(`src="/_hub/qr/empresa.png?rev=${rev}"`);
    expect(Number(/width="(\d+)"/.exec(img)?.[1])).toBeGreaterThanOrEqual(280);
    expect(res.body).toContain(
      "Pick up the phone for &quot;empresa&quot; (number ending 1234) and scan this code: WhatsApp → Settings → Linked devices → Link a device.",
    );
    expect(res.body.match(/<img\b/g)).toHaveLength(2); // one slot per card; only the waiting one has a src
    expect(res.body.match(/\ssrc="/g)).toHaveLength(1);
    const maxWidth = Number(/\.qr-img \{[^}]*max-width: (\d+)px/.exec(res.body)?.[1]);
    expect(maxWidth).toBeGreaterThanOrEqual(280);
  });

  it("marks the card of /<label> and only that one", async () => {
    const h = await startHub();
    const cookie = await h.login();

    const res = await request(h.url, "/empresa", { cookie });

    expect(res.status).toBe(200);
    expect(res.body.match(/class="card is-target"/g)).toHaveLength(1);
    expect(res.body).toMatch(/<article class="card is-target" id="card-empresa"/);
    expect(res.body).not.toContain("no number called");
  });

  it("marks nothing on the front page", async () => {
    const h = await startHub();
    const cookie = await h.login();

    expect((await request(h.url, "/", { cookie })).body).not.toContain('class="card is-target"');
  });

  it("answers an unknown label with the page and a 404, marking nothing", async () => {
    const h = await startHub();
    const cookie = await h.login();

    const res = await request(h.url, "/nobody", { cookie });

    expect(res.status).toBe(404);
    expect(res.body).toContain("There is no number called &quot;nobody&quot;.");
    expect(res.body).not.toContain('class="card is-target"');
    expect(res.body.match(/<article\b/g)).toHaveLength(2);
  });

  it.each(["/personal/", "/a/b", "/Personal", "/_hub/nothing", "/_hub/qr/", "/_hub/qr/x.jpg"])(
    "answers %s with a plain 404",
    async (path) => {
      const h = await startHub();
      const cookie = await h.login();

      const res = await request(h.url, path, { cookie });

      expect(res.status).toBe(404);
      expect(res.body).toBe("not found");
    },
  );

  it.each(["POST", "PUT", "DELETE"])("answers %s on a page with a plain 404", async (method) => {
    const h = await startHub();
    const cookie = await h.login();

    expect((await request(h.url, "/", { cookie, method })).status).toBe(404);
  });

  it("serves exactly the documented status JSON for two numbers", async () => {
    const h = await startHub();
    const cookie = await h.login();
    const rev = revOf(await qrPng("empresa-1"));

    const res = await request(h.url, "/_hub/status.json", { cookie });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      instances: [
        {
          label: "personal",
          description: "Personal line",
          phone_last4: "5678",
          state: "connected",
          down_for_s: null,
          qr_rev: null,
        },
        {
          label: "empresa",
          description: "Company line",
          phone_last4: "1234",
          state: "waiting_qr",
          down_for_s: null,
          qr_rev: rev,
        },
      ],
    });
    expect(Object.keys(JSON.parse(res.body))).toEqual(["instances"]);
  });

  it("serves the pending QR as a PNG, and 404 where none is pending or the number is unknown", async () => {
    const h = await startHub();
    const cookie = await h.login();

    const qr = await request(h.url, "/_hub/qr/empresa.png", { cookie });

    expect(qr.status).toBe(200);
    expect(qr.headers.get("content-type")).toBe("image/png");
    expect(qr.bytes.equals(await qrPng("empresa-1"))).toBe(true);
    expect((await request(h.url, "/_hub/qr/personal.png", { cookie })).status).toBe(404);
    expect((await request(h.url, "/_hub/qr/nobody.png", { cookie })).status).toBe(404);
  });

  it("shows a rotated QR, and then a paired number, one poll cycle later", async () => {
    const h = await startHub();
    const cookie = await h.login();
    const before = JSON.parse((await request(h.url, "/_hub/status.json", { cookie })).body);
    const second = await qrPng("empresa-2");

    empresa.setQr(second);
    await h.poller.pollOnce();
    const rotated = JSON.parse((await request(h.url, "/_hub/status.json", { cookie })).body);
    const served = await request(h.url, "/_hub/qr/empresa.png", { cookie });

    expect(rotated.instances[1].qr_rev).toBe(revOf(second));
    expect(rotated.instances[1].qr_rev).not.toBe(before.instances[1].qr_rev);
    expect(served.bytes.equals(second)).toBe(true);

    empresa.setHealth({
      status: "connected",
      instance: { label: "empresa", description: "Company line" },
      phone_last4: "1234",
    });
    await h.poller.pollOnce();
    const paired = JSON.parse((await request(h.url, "/_hub/status.json", { cookie })).body);

    expect(paired.instances[1]).toMatchObject({ state: "connected", qr_rev: null });
    expect((await request(h.url, "/_hub/qr/empresa.png", { cookie })).status).toBe(404);
  });

  it("shows a change within 5 seconds: the poll interval plus the page interval", () => {
    expect(POLL_INTERVAL_MS + PAGE_POLL_INTERVAL_MS).toBeLessThanOrEqual(5000);
  });

  it("answers in under 2 seconds while one number never answers, and shows it down", async () => {
    const h = await startHub(300);
    const cookie = await h.login();
    empresa.setHang(true);
    h.poller.start();

    const started = performance.now();
    const res = await request(h.url, "/", { cookie });
    const elapsed = performance.now() - started;

    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(2000);
    await vi.waitFor(() => expect(h.poller.views()[1].state).toBe("down"), { timeout: 3000 });
    const after = await request(h.url, "/", { cookie });
    expect(after.body).toMatch(/data-label="empresa" data-state="down"/);
    expect(after.body).toContain("Down for less than a minute");
    expect(after.body).toMatch(/data-label="personal" data-state="connected"/);
    expect(after.body).toContain("Personal line");
  });

  it("answers 500 without detail when the page cannot be built", async () => {
    const broken = createPoller({ instances: [] });
    broken.views = () => {
      throw new Error("boom with secret-detail");
    };
    const h = await startHubHarness({ instances: [], poller: broken });
    hub = h;
    const cookie = await h.login();

    const res = await request(h.url, "/", { cookie });

    expect(res.status).toBe(500);
    expect(res.body).toBe("internal error");
  });
});
