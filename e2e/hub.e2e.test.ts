import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type E2eHub, runHubExpectingExit, startHub } from "./support/hub.ts";
import { type E2eServer, startServer } from "./support/server.ts";

/** A made-up number: of it, only the last four digits may ever reach the hub's pages. */
const FAKE_NUMBER = "5500000001234";
const LABELS = ["personal", "empresa"] as const;
const DESCRIPTIONS = { personal: "Personal line", empresa: "Company line" };

let servers: Record<(typeof LABELS)[number], E2eServer>;
let hub: E2eHub;

beforeAll(async () => {
  const [personal, empresa] = await Promise.all(
    LABELS.map((label) =>
      startServer({
        env: {
          INSTANCE_LABEL: label,
          INSTANCE_DESCRIPTION: DESCRIPTIONS[label],
          EXPECTED_WA_NUMBER: FAKE_NUMBER,
        },
      }),
    ),
  );
  servers = { personal, empresa };
  hub = await startHub({
    instances: LABELS.map((label) => ({ label, url: servers[label].qrUrl })),
    pin: "e2e-pin-4821",
  });
});

afterAll(async () => {
  await hub?.stop();
  await Promise.all(Object.values(servers ?? {}).map((server) => server.stop()));
});

async function login(): Promise<string> {
  const res = await fetch(`${hub.url}/_hub/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ pin: hub.pin }),
  });
  expect(res.status).toBe(303);
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

/** Longest stretch of `FAKE_NUMBER` that appears in `text`, in digits. */
function longestRunOfTheNumber(text: string): number {
  let longest = 0;
  for (let start = 0; start < FAKE_NUMBER.length; start++) {
    let end = start;
    while (end < FAKE_NUMBER.length && text.includes(FAKE_NUMBER.slice(start, end + 1))) end++;
    longest = Math.max(longest, end - start);
  }
  return longest;
}

describe("without a session", () => {
  it.each(["/", "/personal", "/empresa", "/_hub/status.json", "/_hub/qr/empresa.png"])(
    "answers %s with the PIN form and nothing about the numbers",
    async (path) => {
      const res = await fetch(`${hub.url}${path}`, { redirect: "manual" });
      const body = await res.text();

      expect(res.status).toBe(401);
      expect(body).toContain('action="/_hub/login"');
      for (const word of ["personal", "empresa", "Personal line", "Company line", "1234"]) {
        if (path.includes(word)) continue; // the path itself comes back as the `next` value
        expect(body).not.toContain(word);
      }
    },
  );

  it("refuses a wrong PIN with the same form", async () => {
    const res = await fetch(`${hub.url}/_hub/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ pin: "not-the-pin" }),
    });

    expect(res.status).toBe(401);
    expect(await res.text()).toContain("That PIN did not work.");
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("with a session", () => {
  it("shows both numbers, each with its label, description, last four digits and state", async () => {
    const cookie = await login();

    const res = await fetch(`${hub.url}/`, { headers: { cookie } });
    const html = await res.text();

    expect(res.status).toBe(200);
    for (const label of LABELS) {
      expect(html).toMatch(new RegExp(`data-label="${label}" data-state="disconnected"`));
      expect(html).toContain(DESCRIPTIONS[label]);
    }
    expect(html.match(/data-role="digits">number ending 1234<\/p>/g)).toHaveLength(2);
    expect(html.match(/<article\b/g)).toHaveLength(2);
    expect(html).toContain("Disconnected");
  });

  it("serves the status JSON with exactly the documented keys", async () => {
    const cookie = await login();

    const res = await fetch(`${hub.url}/_hub/status.json`, { headers: { cookie } });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      instances: LABELS.map((label) => ({
        label,
        description: DESCRIPTIONS[label],
        phone_last4: "1234",
        state: "disconnected",
        down_for_s: null,
        qr_rev: null,
        mcp_url: `${hub.url}/${label}/mcp`,
      })),
    });
  });

  it("has no QR to show where WhatsApp was never connected", async () => {
    const cookie = await login();

    for (const label of LABELS) {
      const res = await fetch(`${hub.url}/_hub/qr/${label}.png`, { headers: { cookie } });
      expect(res.status).toBe(404);
    }
  });

  it("marks the card of /<label>", async () => {
    const cookie = await login();

    const html = await (await fetch(`${hub.url}/empresa`, { headers: { cookie } })).text();

    expect(html).toMatch(/<article class="card is-target" id="card-empresa"/);
  });

  it("repeats nothing of the number but its last four digits, and no instance token", async () => {
    const cookie = await login();
    const responses = await Promise.all(
      ["/", "/personal", "/empresa", "/_hub/status.json"].map((path) =>
        fetch(`${hub.url}${path}`, { headers: { cookie } }),
      ),
    );

    for (const res of responses) {
      const everything = `${await res.text()}\n${[...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n")}`;
      expect(longestRunOfTheNumber(everything)).toBeLessThanOrEqual(4);
      for (const server of Object.values(servers)) expect(everything).not.toContain(server.token);
      expect(everything).not.toContain(hub.pin);
    }
  });
});

describe("when a number stops answering", () => {
  it("shows that card as down within 6 seconds while the page stays fast and the other card stays intact", async () => {
    const cookie = await login();
    await servers.empresa.stop();

    const started = performance.now();
    const deadline = started + 6000;
    let state = "";
    let slowest = 0;
    while (performance.now() < deadline && state !== "down") {
      const before = performance.now();
      const res = await fetch(`${hub.url}/_hub/status.json`, { headers: { cookie } });
      slowest = Math.max(slowest, performance.now() - before);
      const body = await res.json();
      state = body.instances.find((i: { label: string }) => i.label === "empresa").state;
      if (state !== "down") await new Promise((resolve) => setTimeout(resolve, 200));
    }

    expect(state).toBe("down");
    expect(performance.now() - started).toBeLessThan(6000);
    const page = performance.now();
    const html = await (await fetch(`${hub.url}/`, { headers: { cookie } })).text();
    expect(performance.now() - page).toBeLessThan(2000);
    expect(slowest).toBeLessThan(2000);
    expect(html).toMatch(/data-label="empresa" data-state="down"/);
    expect(html).toContain("Down for less than a minute");
    expect(html).toMatch(/data-label="personal" data-state="disconnected"/);
    expect(html).toContain("Company line"); // the last thing it knew about the number
  });
});

describe("started with settings it cannot use", () => {
  it("exits non-zero, says which setting is wrong, and never prints the PIN", async () => {
    const run = await runHubExpectingExit({
      instances: [{ label: "personal", url: "http://127.0.0.1:1" }],
      pin: "abc",
    });

    expect(run.code).not.toBe(0);
    expect(run.code).not.toBeNull();
    expect(run.stderr).toContain("HUB_PIN");
    expect(run.stderr).not.toContain("abc");
    expect(run.stdout).not.toContain("abc");
  });

  it("exits non-zero when the attempt counters on disk are damaged", async () => {
    const run = await runHubExpectingExit({
      instances: [{ label: "personal", url: "http://127.0.0.1:1" }],
      pin: "damaged-counters-pin",
      damagedCounters: true,
    });

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("pin-attempts.json");
    expect(run.stderr).not.toContain("damaged-counters-pin");
  });
});
