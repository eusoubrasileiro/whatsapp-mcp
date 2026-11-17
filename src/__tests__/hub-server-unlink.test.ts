import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringsFor } from "../hub/strings.ts";
import { deadAddress, type FakeInstance, startFakeInstance } from "./helpers/fake-instance.ts";
import { englishLeaks } from "./helpers/hub-english.ts";
import {
  type HubHarness,
  type HubHarnessOptions,
  loginForm,
  request,
  startHubHarness,
  TEST_INSTANCE_SECRET,
  TEST_PIN,
  TEST_PUBLIC_URL,
} from "./helpers/hub-harness.ts";
import { recordingLogger } from "./helpers/recording-logger.ts";

const en = stringsFor("en");
const RULE_EN = "Never unlink or re-link a number while WhatsApp shows a restriction countdown";
const RULE_PT = "Nunca desvincule nem vincule de novo um número enquanto o WhatsApp mostrar";

let personal: FakeInstance;
let empresa: FakeInstance;
let hub: HubHarness | undefined;
let lines: string[];

beforeEach(async () => {
  personal = await startFakeInstance({
    status: "connected",
    instance: { label: "personal", description: "Personal line" },
    phone_last4: "5678",
  });
  empresa = await startFakeInstance({
    status: "connected",
    instance: { label: "empresa", description: "Company line" },
    phone_last4: "1234",
  });
});

afterEach(async () => {
  await hub?.close();
  hub = undefined;
  await Promise.all([personal.close(), empresa.close()]);
});

/** A hub over the two fakes, signed in. Unlinking is on unless the test says otherwise. */
async function startHub(options: Partial<HubHarnessOptions> = {}) {
  const recording = recordingLogger();
  lines = recording.lines;
  hub = await startHubHarness({
    instances: [
      { label: "personal", baseUrl: personal.url },
      { label: "empresa", baseUrl: empresa.url },
    ],
    instanceSecret: TEST_INSTANCE_SECRET,
    logger: recording.logger,
    ...options,
  });
  await hub.poller.pollOnce();
  return { hub, cookie: await hub.login() };
}

/** The form a browser posts from the confirmation page of `label`, with `overrides` applied. */
function unlinkForm(
  h: HubHarness,
  cookie: string,
  label: string,
  overrides: Record<string, string> = {},
) {
  return new URLSearchParams({
    csrf: h.gate.csrfToken(cookie, label) ?? "",
    pin: TEST_PIN,
    label,
    ...overrides,
  }).toString();
}

const post = (
  h: HubHarness,
  cookie: string | undefined,
  label: string,
  body: string,
  headers: Record<string, string> = {},
) => request(h.url, `/_hub/unlink/${label}`, { method: "POST", cookie, body, headers });

const calls = () => [personal.unlinkRequests.length, empresa.unlinkRequests.length];

describe("when the hub has no instance secret", () => {
  it("has no button, and answers 404 to the page and to a post, with a session", async () => {
    const { hub: h, cookie } = await startHub({ instanceSecret: undefined });

    expect((await request(h.url, "/", { cookie })).body).not.toContain("/_hub/unlink/");
    expect((await request(h.url, "/_hub/unlink/personal", { cookie })).status).toBe(404);
    const token = h.gate.csrfToken(cookie, "personal") ?? "";
    const res = await post(
      h,
      cookie,
      "personal",
      unlinkForm(h, cookie, "personal", { csrf: token }),
    );
    expect(res.status).toBe(404);
    expect(calls()).toEqual([0, 0]);
  });
});

describe("the card's button", () => {
  it("is on every card when unlinking is on", async () => {
    const { hub: h, cookie } = await startHub();

    const html = (await request(h.url, "/", { cookie })).body;

    for (const label of ["personal", "empresa"]) {
      expect(html).toContain(
        `<a class="unlink-link" href="/_hub/unlink/${label}">Unlink this number</a>`,
      );
    }
  });
});

describe("GET /_hub/unlink/<label>", () => {
  it("asks for the PIN without a session, and for a forged one", async () => {
    const { hub: h } = await startHub();

    for (const cookie of [undefined, `wa_hub=v1.9999999999.${"a".repeat(24)}.forged`]) {
      const res = await request(h.url, "/_hub/unlink/personal", { cookie });
      expect(res.status).toBe(401);
      expect(res.body).toContain('action="/_hub/login"');
      expect(res.body).not.toContain('/_hub/unlink/personal"');
    }
    expect(calls()).toEqual([0, 0]);
  });

  it("is a 404 for a number the hub does not show", async () => {
    const { hub: h, cookie } = await startHub();

    for (const label of ["nope", "Personal", "personal/x", "personal.png"]) {
      expect((await request(h.url, `/_hub/unlink/${label}`, { cookie })).status, label).toBe(404);
    }
  });

  it("shows the number, the rule, what will happen and the form, and calls nobody", async () => {
    const { hub: h, cookie } = await startHub();

    const res = await request(h.url, "/_hub/unlink/empresa", { cookie });

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.body).toContain("<h1>Unlink empresa</h1>");
    expect(res.body).toContain("Company line");
    expect(res.body).toContain("number ending 1234");
    expect(res.body).toContain(RULE_EN);
    expect(res.body).toContain('action="/_hub/unlink/empresa"');
    expect(res.body).toContain(`name="csrf" value="${h.gate.csrfToken(cookie, "empresa")}"`);
    expect(calls()).toEqual([0, 0]);
  });

  it.each(["PUT", "DELETE", "PATCH"])("is not answered to %s, and calls nobody", async (method) => {
    const { hub: h, cookie } = await startHub();

    const res = await request(h.url, "/_hub/unlink/personal", { method, cookie });

    expect(res.status).toBe(404);
    expect(calls()).toEqual([0, 0]);
  });
});

describe("POST /_hub/unlink/<label>: what is checked, in order", () => {
  it("asks for the PIN without a session, and calls nobody", async () => {
    const { hub: h, cookie } = await startHub();

    const res = await post(h, undefined, "personal", unlinkForm(h, cookie, "personal"));

    expect(res.status).toBe(401);
    expect(res.body).toContain('action="/_hub/login"');
    expect(calls()).toEqual([0, 0]);
  });

  it("is a 404 for a number the hub does not show, and calls nobody", async () => {
    const { hub: h, cookie } = await startHub();

    expect((await post(h, cookie, "nope", unlinkForm(h, cookie, "nope"))).status).toBe(404);
    expect(calls()).toEqual([0, 0]);
  });

  it("refuses a body longer than a form can be", async () => {
    const { hub: h, cookie } = await startHub();

    const res = await post(h, cookie, "personal", `pin=${"x".repeat(5000)}`);

    expect(res.status).toBe(413);
    expect(calls()).toEqual([0, 0]);
  });

  const refused: [
    string,
    number,
    "expired" | "wrongPin" | "wrongLabel",
    (
      h: HubHarness,
      c: string,
    ) => { fields?: Record<string, string>; headers?: Record<string, string>; as?: string },
  ][] = [
    ["no token", 403, "expired", () => ({ fields: { csrf: "" } })],
    ["a wrong token", 403, "expired", () => ({ fields: { csrf: "0".repeat(64) } })],
    [
      "another number's token",
      403,
      "expired",
      (h, c) => ({ fields: { csrf: h.gate.csrfToken(c, "empresa") ?? "" } }),
    ],
    [
      "a token from another session",
      403,
      "expired",
      (h) => ({
        fields: { csrf: h.gate.csrfToken(h.gate.issueCookie().split(";")[0], "personal") ?? "" },
      }),
    ],
    [
      "a foreign Origin",
      403,
      "expired",
      () => ({ headers: { origin: "https://evil.example.com" } }),
    ],
    ["the Origin null", 403, "expired", () => ({ headers: { origin: "null" } })],
    ["a wrong PIN", 401, "wrongPin", () => ({ fields: { pin: "not-the-pin" } })],
    ["an empty PIN", 401, "wrongPin", () => ({ fields: { pin: "" } })],
    ["another name typed", 400, "wrongLabel", () => ({ fields: { label: "empresa" } })],
    ["the name in capitals", 400, "wrongLabel", () => ({ fields: { label: "PERSONAL" } })],
    ["no name", 400, "wrongLabel", () => ({ fields: { label: "" } })],
  ];

  it.each(refused)(
    "refuses %s with %i, says so, shows the rule again and calls nobody",
    async (_name, status, key, change) => {
      const { hub: h, cookie } = await startHub();
      const { fields, headers } = change(h, cookie);

      const res = await post(
        h,
        cookie,
        "personal",
        unlinkForm(h, cookie, "personal", fields),
        headers,
      );

      expect(res.status).toBe(status);
      expect(res.body).toContain(`<p class="error" role="alert">${en.unlink[key]}</p>`);
      expect(res.body).toContain(RULE_EN);
      expect(res.body).toContain(`name="csrf" value="${h.gate.csrfToken(cookie, "personal")}"`);
      expect(calls()).toEqual([0, 0]);
    },
  );

  it("does not reveal which part of a refused post was wrong beyond its own sentence", async () => {
    const { hub: h, cookie } = await startHub();

    const res = await post(
      h,
      cookie,
      "personal",
      unlinkForm(h, cookie, "personal", { pin: "not-the-pin" }),
    );

    expect(res.body).not.toContain(TEST_PIN);
    expect(res.body).not.toContain("not-the-pin");
  });

  it("accepts the public address as its Origin, and no Origin at all", async () => {
    const { hub: h, cookie } = await startHub();

    const withOrigin = await post(h, cookie, "personal", unlinkForm(h, cookie, "personal"), {
      origin: TEST_PUBLIC_URL,
    });
    const without = await post(h, cookie, "empresa", unlinkForm(h, cookie, "empresa"));

    expect([withOrigin.status, without.status]).toEqual([200, 200]);
    expect(calls()).toEqual([1, 1]);
  });

  it("checks the token before the PIN, so a forged post cannot burn the PIN's attempts", async () => {
    const { hub: h, cookie } = await startHub();

    for (let attempt = 0; attempt < 8; attempt++) {
      const forged = unlinkForm(h, cookie, "personal", { csrf: "bad", pin: "wrong" });
      expect((await post(h, cookie, "personal", forged)).status).toBe(403);
    }

    const login = await request(h.url, "/_hub/login", {
      method: "POST",
      body: loginForm(TEST_PIN),
    });
    expect(login.status).toBe(303);
  });
});

describe("the PIN on the unlink form shares the login's counters", () => {
  const from = (address: string) => ({ "x-forwarded-for": address });
  const wrongLogin = (h: HubHarness, address: string) =>
    request(h.url, "/_hub/login", {
      method: "POST",
      body: loginForm("wrong"),
      headers: from(address),
    });
  const wrongUnlink = (h: HubHarness, cookie: string, address: string) =>
    post(h, cookie, "personal", unlinkForm(h, cookie, "personal", { pin: "wrong" }), from(address));

  it("locks the address after five wrong PINs between the two forms, for both forms", async () => {
    const { hub: h, cookie } = await startHub();
    for (let n = 0; n < 4; n++) await wrongLogin(h, "203.0.113.9");
    expect((await wrongUnlink(h, cookie, "203.0.113.9")).status).toBe(401);

    const right = await post(
      h,
      cookie,
      "personal",
      unlinkForm(h, cookie, "personal"),
      from("203.0.113.9"),
    );
    const login = await request(h.url, "/_hub/login", {
      method: "POST",
      body: loginForm(TEST_PIN),
      headers: from("203.0.113.9"),
    });

    expect(right.status).toBe(429);
    expect(right.body).toContain(`<p class="error" role="alert">${en.unlink.locked}</p>`);
    expect(right.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(login.status).toBe(429);
    expect(calls()).toEqual([0, 0]);
  });

  it("leaves another address alone", async () => {
    const { hub: h, cookie } = await startHub();
    for (let n = 0; n < 5; n++) await wrongUnlink(h, cookie, "203.0.113.9");

    const res = await post(
      h,
      cookie,
      "personal",
      unlinkForm(h, cookie, "personal"),
      from("203.0.113.77"),
    );

    expect(res.status).toBe(200);
    expect(calls()).toEqual([1, 0]);
  });

  it("locks everyone after twenty wrong PINs from anywhere, the login form included", async () => {
    const { hub: h, cookie } = await startHub();
    for (let n = 0; n < 20; n++) await wrongUnlink(h, cookie, `198.51.100.${n}`);

    const login = await request(h.url, "/_hub/login", {
      method: "POST",
      body: loginForm(TEST_PIN),
      headers: from("192.0.2.1"),
    });
    const right = await post(
      h,
      cookie,
      "personal",
      unlinkForm(h, cookie, "personal"),
      from("192.0.2.2"),
    );

    expect(login.status).toBe(429);
    expect(right.status).toBe(429);
    expect(h.pushes).toHaveLength(1);
    expect(calls()).toEqual([0, 0]);
  });
});

describe("a confirmed unlink", () => {
  it("asks only the number in the path, with the secret, and says it was unlinked", async () => {
    const { hub: h, cookie } = await startHub();

    const res = await post(h, cookie, "empresa", unlinkForm(h, cookie, "empresa"), {
      origin: TEST_PUBLIC_URL,
    });

    expect(res.status).toBe(200);
    expect(res.body).toContain(`<h1>${en.unlink.unlinkedTitle}</h1>`);
    expect(res.body).toContain("&quot;empresa&quot; was disconnected.");
    expect(empresa.unlinkRequests).toEqual([
      { method: "POST", authorization: `Bearer ${TEST_INSTANCE_SECRET}` },
    ]);
    expect(personal.unlinkRequests).toEqual([]);
  });

  it("logs one line, with the number and the outcome, and nothing secret", async () => {
    const { hub: h, cookie } = await startHub();

    await post(h, cookie, "empresa", unlinkForm(h, cookie, "empresa"));

    const logged = lines.filter((line) => line.includes("unlink"));
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0])).toMatchObject({ label: "empresa", outcome: "unlinked" });
    expect(lines.join("")).not.toContain(TEST_INSTANCE_SECRET);
    expect(lines.join("")).not.toContain(TEST_PIN);
  });

  it("says a number that was not connected was not connected", async () => {
    personal.setUnlinkAnswer(200, { unlinked: false });
    const { hub: h, cookie } = await startHub();

    const res = await post(h, cookie, "personal", unlinkForm(h, cookie, "personal"));

    expect(res.status).toBe(200);
    expect(res.body).toContain(`<h1>${en.unlink.notConnectedTitle}</h1>`);
    expect(JSON.parse(lines.filter((line) => line.includes("unlink"))[0])).toMatchObject({
      label: "personal",
      outcome: "not_connected",
    });
  });

  it("never shows what the instance said, in a success or a failure", async () => {
    personal.setUnlinkAnswer(200, { unlinked: true, message: "INSTANCE-OWN-WORDS" });
    empresa.setUnlinkAnswer(500, "INSTANCE-OWN-ERROR <b>");
    const { hub: h, cookie } = await startHub();

    const ok = await post(h, cookie, "personal", unlinkForm(h, cookie, "personal"));
    const bad = await post(h, cookie, "empresa", unlinkForm(h, cookie, "empresa"));

    expect(ok.body).not.toContain("INSTANCE-OWN");
    expect(bad.body).not.toContain("INSTANCE-OWN");
    expect(lines.join("")).not.toContain("INSTANCE-OWN");
  });

  const failures: [string, () => Promise<Partial<HubHarnessOptions>>][] = [
    [
      "answers 401",
      async () => {
        personal.setUnlinkAnswer(401, "");
        return {};
      },
    ],
    [
      "answers 500",
      async () => {
        personal.setUnlinkAnswer(500, "boom");
        return {};
      },
    ],
    [
      "answers something that is not the documented JSON",
      async () => {
        personal.setUnlinkAnswer(200, "<html>");
        return {};
      },
    ],
    [
      "does not answer in time",
      async () => {
        personal.setHang(true);
        return { unlinkTimeoutMs: 200 };
      },
    ],
    [
      "is not there",
      async () => ({
        instances: [
          { label: "personal", baseUrl: await deadAddress() },
          { label: "empresa", baseUrl: empresa.url },
        ],
      }),
    ],
  ];

  it.each(failures)("says it cannot tell, with 502, when the instance %s", async (_name, setup) => {
    const { hub: h, cookie } = await startHub(await setup());

    const res = await post(h, cookie, "personal", unlinkForm(h, cookie, "personal"));

    expect(res.status).toBe(502);
    expect(res.body).toContain(`<h1>${en.unlink.failedTitle}</h1>`);
    expect(JSON.parse(lines.filter((line) => line.includes("unlink"))[0])).toMatchObject({
      label: "personal",
      outcome: "failed",
    });
    expect(empresa.unlinkRequests).toEqual([]);
  });

  it("puts the secret in no page, header or log line", async () => {
    const { hub: h, cookie } = await startHub();
    const seen = [
      await request(h.url, "/", { cookie }),
      await request(h.url, "/_hub/unlink/personal", { cookie }),
      await post(h, cookie, "personal", unlinkForm(h, cookie, "personal")),
      await post(h, cookie, "personal", unlinkForm(h, cookie, "personal", { pin: "x" })),
    ];

    for (const res of seen) {
      expect(res.body).not.toContain(TEST_INSTANCE_SECRET);
      expect([...res.headers.values()].join("\n")).not.toContain(TEST_INSTANCE_SECRET);
    }
    expect(lines.join("")).not.toContain(TEST_INSTANCE_SECRET);
  });
});

describe("in Brazilian Portuguese", () => {
  const pt = stringsFor("pt-BR");

  it("writes the button, the confirmation, every refusal and every result in Portuguese", async () => {
    personal.setUnlinkAnswer(200, { unlinked: false });
    const { hub: h, cookie } = await startHub({ lang: "pt-BR" });
    const pages = [
      await request(h.url, "/", { cookie }),
      await request(h.url, "/_hub/unlink/personal", { cookie }),
      await post(h, cookie, "personal", unlinkForm(h, cookie, "personal", { csrf: "bad" })),
      await post(h, cookie, "personal", unlinkForm(h, cookie, "personal", { pin: "bad" })),
      await post(h, cookie, "personal", unlinkForm(h, cookie, "personal", { label: "bad" })),
      await post(h, cookie, "personal", unlinkForm(h, cookie, "personal")),
      await post(h, cookie, "empresa", unlinkForm(h, cookie, "empresa")),
    ];

    expect(pages.map((page) => page.status)).toEqual([200, 200, 403, 401, 400, 200, 200]);
    expect(pages[0].body).toContain(`>${pt.unlink.open}</a>`);
    for (const page of pages.slice(1, 5)) {
      expect(page.body).toContain(RULE_PT);
      expect(page.body).not.toContain(RULE_EN);
    }
    expect(pages[5].body).toContain(`<h1>${pt.unlink.notConnectedTitle}</h1>`);
    expect(pages[6].body).toContain(`<h1>${pt.unlink.unlinkedTitle}</h1>`);
    for (const page of pages) {
      expect(page.body).toContain('<html lang="pt-BR">');
      expect(englishLeaks(page.body)).toEqual([]);
    }
  });
});
