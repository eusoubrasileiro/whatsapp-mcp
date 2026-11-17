import { afterEach, describe, expect, it } from "vitest";
import { type FakeInstance, qrPng, startFakeInstance } from "./helpers/fake-instance.ts";
import {
  type HubHarness,
  loginForm,
  request,
  startHubHarness,
  TEST_COOKIE_KEY,
  TEST_PIN,
} from "./helpers/hub-harness.ts";

/** Everything an instance could say that the hub must never repeat. */
const FULL_NUMBER = "5500000001234";
const SECRETS = {
  user: `${FULL_NUMBER}:7@s.whatsapp.net`,
  phone: FULL_NUMBER,
  token: "tok-ZZ9-instance-secret",
  contact: "Maria Secretname",
  message: "meet me at the secret place",
  nested: { id: "9988776655443", note: "nested-secret-value" },
};
const ALLOWED_KEYS = [
  "label",
  "description",
  "phone_last4",
  "state",
  "down_for_s",
  "qr_rev",
  "mcp_url",
];

let hub: HubHarness | undefined;
let fakes: FakeInstance[] = [];

afterEach(async () => {
  await hub?.close();
  hub = undefined;
  await Promise.all(fakes.map((fake) => fake.close()));
  fakes = [];
});

async function chatty(label: string, status: string): Promise<FakeInstance> {
  const fake = await startFakeInstance({
    status,
    instance: { label, description: `${label} line`, token: SECRETS.token },
    phone_last4: "1234",
    user: SECRETS.user,
    phone: SECRETS.phone,
    token: SECRETS.token,
    contact_name: SECRETS.contact,
    last_message: SECRETS.message,
    extra: SECRETS.nested,
    jids: [`${FULL_NUMBER}@s.whatsapp.net`],
  });
  fakes.push(fake);
  return fake;
}

/** Longest run of consecutive digits from `needle` found in `haystack`, as a length. */
function longestSharedDigitRun(haystack: string, needle: string): number {
  let longest = 0;
  for (let start = 0; start < needle.length; start++) {
    let end = start;
    while (end < needle.length && haystack.includes(needle.slice(start, end + 1))) end++;
    longest = Math.max(longest, end - start);
  }
  return longest;
}

describe("what the hub never says", () => {
  it("repeats nothing of the number but its last four digits, anywhere, in any response", async () => {
    const connected = await chatty("personal", "connected");
    const waiting = await chatty("empresa", "qr_pending");
    waiting.setQr(await qrPng("leak-check"));
    hub = await startHubHarness({
      instances: [
        { label: "personal", baseUrl: connected.url },
        { label: "empresa", baseUrl: waiting.url },
      ],
    });
    await hub.poller.pollOnce();
    const cookie = await hub.login();

    const responses = [
      await request(hub.url, "/"), // PIN form
      await request(hub.url, "/", { cookie }),
      await request(hub.url, "/empresa", { cookie }),
      await request(hub.url, "/nobody", { cookie }),
      await request(hub.url, "/_hub/status.json", { cookie }),
      await request(hub.url, "/_hub/login", { method: "POST", body: loginForm("wrong-pin-x") }),
    ];
    // The login that works, too: its headers carry the cookie.
    responses.push(
      await request(hub.url, "/_hub/login", { method: "POST", body: loginForm(TEST_PIN) }),
    );

    const afterBearer: string[] = [];
    for (const res of responses) {
      const everything = `${res.body}\n${[...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n")}`;
      expect(
        longestSharedDigitRun(everything, FULL_NUMBER),
        `${res.status} leaked digits`,
      ).toBeLessThanOrEqual(4);
      for (const secret of [
        SECRETS.user,
        SECRETS.phone,
        SECRETS.token,
        SECRETS.contact,
        SECRETS.message,
        SECRETS.nested.id,
        SECRETS.nested.note,
        TEST_PIN,
        TEST_COOKIE_KEY,
      ]) {
        expect(everything).not.toContain(secret);
      }
      afterBearer.push(...[...everything.matchAll(/Bearer (\S+)/g)].map((m) => m[1]));
    }
    // The connect-a-client snippets carry a placeholder where a token goes, and only that.
    expect(afterBearer.length).toBeGreaterThan(0);
    for (const word of afterBearer) expect(word).toMatch(/^&lt;token&gt;/);
  });

  it("serves status.json with exactly the allowed keys per number, and nothing at the top", async () => {
    const connected = await chatty("personal", "connected");
    hub = await startHubHarness({ instances: [{ label: "personal", baseUrl: connected.url }] });
    await hub.poller.pollOnce();
    const cookie = await hub.login();

    const body = JSON.parse((await request(hub.url, "/_hub/status.json", { cookie })).body);

    expect(Object.keys(body)).toEqual(["instances"]);
    expect(Object.keys(body.instances[0])).toEqual(ALLOWED_KEYS);
  });

  it("keeps the last four digits only when the instance sent exactly four digits", async () => {
    const fake = await startFakeInstance({
      status: "connected",
      instance: { label: "personal", description: "Personal" },
      phone_last4: FULL_NUMBER,
    });
    fakes.push(fake);
    hub = await startHubHarness({ instances: [{ label: "personal", baseUrl: fake.url }] });
    await hub.poller.pollOnce();
    const cookie = await hub.login();

    const res = await request(hub.url, "/", { cookie });
    const status = await request(hub.url, "/_hub/status.json", { cookie });

    expect(JSON.parse(status.body).instances[0].phone_last4).toBeNull();
    expect(longestSharedDigitRun(res.body + status.body, FULL_NUMBER)).toBeLessThanOrEqual(4);
    expect(res.body).toMatch(/data-role="digits" hidden><\/p>/);
  });
});
