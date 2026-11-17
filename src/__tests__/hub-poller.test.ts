import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPoller, POLL_INTERVAL_MS, REQUEST_TIMEOUT_MS } from "../hub/poller.ts";
import {
  deadAddress,
  type FakeInstance,
  qrPng,
  startFakeInstance,
} from "./helpers/fake-instance.ts";

const open: FakeInstance[] = [];

async function fake(health?: unknown): Promise<FakeInstance> {
  const instance = await startFakeInstance(health);
  open.push(instance);
  return instance;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((instance) => instance.close()));
});

const revOf = (png: Buffer) => createHash("sha256").update(png).digest("hex").slice(0, 12);

let clock = 1_700_000_000_000;
const now = () => clock;

function pollerFor(
  instances: { label: string; baseUrl: string }[],
  options: { timeoutMs?: number; intervalMs?: number } = {},
) {
  return createPoller({ instances, now, timeoutMs: 500, ...options });
}

describe("poller timing constants", () => {
  it("polls every 2 s with a 1 s timeout", () => {
    expect(POLL_INTERVAL_MS).toBe(2000);
    expect(REQUEST_TIMEOUT_MS).toBe(1000);
  });
});

describe("poller: reading an instance", () => {
  it("reports a connected number with its description and last four digits", async () => {
    const a = await fake({
      status: "connected",
      instance: { label: "empresa", description: "Company line" },
      phone_last4: "1234",
      user: "5500000001234@s.whatsapp.net",
    });
    const poller = pollerFor([{ label: "empresa", baseUrl: a.url }]);

    await poller.pollOnce();

    expect(poller.views()).toEqual([
      {
        label: "empresa",
        description: "Company line",
        phone_last4: "1234",
        state: "connected",
        down_for_s: null,
        qr_rev: null,
      },
    ]);
  });

  it("starts as connecting before the first answer, without claiming it is down", async () => {
    const a = await fake();
    const poller = pollerFor([{ label: "a", baseUrl: a.url }]);

    expect(poller.views()[0]).toMatchObject({ state: "starting", down_for_s: null });
  });

  it("reports waiting_qr with the QR bytes and a 12-character revision", async () => {
    const png = await qrPng("one");
    const a = await fake({ status: "qr_pending", phone_last4: "1234" });
    a.setQr(png);
    const poller = pollerFor([{ label: "a", baseUrl: a.url }]);

    await poller.pollOnce();

    const [view] = poller.views();
    expect(view.state).toBe("waiting_qr");
    expect(view.qr_rev).toBe(revOf(png));
    expect(view.qr_rev).toMatch(/^[0-9a-f]{12}$/);
    expect(poller.qrPng("a")?.equals(png)).toBe(true);
  });

  it.each([["connecting"], ["syncing"]])("reports %s as starting", async (status) => {
    const a = await fake({ status });
    const poller = pollerFor([{ label: "a", baseUrl: a.url }]);

    await poller.pollOnce();

    expect(poller.views()[0].state).toBe("starting");
  });

  it("reports qr_pending as starting while the QR image is not there yet", async () => {
    const a = await fake({ status: "qr_pending" });
    const poller = pollerFor([{ label: "a", baseUrl: a.url }]);

    await poller.pollOnce();

    expect(poller.views()[0]).toMatchObject({ state: "starting", qr_rev: null });
    expect(poller.qrPng("a")).toBeNull();
  });

  it("reports a disconnected number as disconnected", async () => {
    const a = await fake({ status: "disconnected" });
    const poller = pollerFor([{ label: "a", baseUrl: a.url }]);

    await poller.pollOnce();

    expect(poller.views()[0].state).toBe("disconnected");
  });

  it("still reads the body of a wedged instance's 503", async () => {
    const a = await fake();
    a.setHealth({ status: "disconnected", phone_last4: "9876" }, 503);
    const poller = pollerFor([{ label: "a", baseUrl: a.url }]);

    await poller.pollOnce();

    expect(poller.views()[0]).toMatchObject({ state: "disconnected", phone_last4: "9876" });
  });

  it("rotates the QR: a new image changes the revision and the bytes served", async () => {
    const first = await qrPng("one");
    const second = await qrPng("two");
    const a = await fake({ status: "qr_pending" });
    a.setQr(first);
    const poller = pollerFor([{ label: "a", baseUrl: a.url }]);

    await poller.pollOnce();
    const before = poller.views()[0].qr_rev;
    a.setQr(second);
    await poller.pollOnce();

    expect(before).toBe(revOf(first));
    expect(poller.views()[0].qr_rev).toBe(revOf(second));
    expect(poller.qrPng("a")?.equals(second)).toBe(true);
  });

  it("drops the QR as soon as the instance leaves qr_pending (paired)", async () => {
    const a = await fake({ status: "qr_pending" });
    a.setQr(await qrPng("one"));
    const poller = pollerFor([{ label: "a", baseUrl: a.url }]);
    await poller.pollOnce();

    a.setHealth({ status: "connected" });
    await poller.pollOnce();

    expect(poller.views()[0]).toMatchObject({ state: "connected", qr_rev: null });
    expect(poller.qrPng("a")).toBeNull();
  });

  it("does not ask for the QR image of an instance that is not waiting for a scan", async () => {
    const a = await fake({ status: "connected" });
    const poller = pollerFor([{ label: "a", baseUrl: a.url }]);

    await poller.pollOnce();

    expect(a.hits).toEqual({ health: 1, qr: 0 });
  });

  it("answers with no QR for a label it does not know", async () => {
    const poller = pollerFor([]);

    expect(poller.qrPng("nobody")).toBeNull();
  });
});

describe("poller: what it copies", () => {
  it("copies only the state, description and last four digits of a health answer", async () => {
    const a = await fake({
      status: "connected",
      instance: { label: "a", description: "Line A", secret: "inst-secret" },
      phone_last4: "1234",
      user: "5500000001234@s.whatsapp.net",
      token: "tok-abc",
      contact: "Maria Silva",
    });
    const poller = pollerFor([{ label: "a", baseUrl: a.url }]);

    await poller.pollOnce();

    const text = JSON.stringify(poller.views());
    expect(Object.keys(poller.views()[0]).sort()).toEqual([
      "description",
      "down_for_s",
      "label",
      "phone_last4",
      "qr_rev",
      "state",
    ]);
    for (const leaked of ["5500000001234", "tok-abc", "Maria", "inst-secret"]) {
      expect(text).not.toContain(leaked);
    }
  });

  it.each([
    ["more than four digits", "5500000001234"],
    ["fewer than four digits", "123"],
    ["letters", "12ab"],
    ["a number", 1234],
    ["nothing", undefined],
  ])("treats a last-four value with %s as unknown", async (_name, value) => {
    const a = await fake({ status: "connected", phone_last4: value });
    const poller = pollerFor([{ label: "a", baseUrl: a.url }]);

    await poller.pollOnce();

    expect(poller.views()[0].phone_last4).toBeNull();
  });

  it.each([
    ["a number", 5],
    ["an empty string", ""],
    ["nothing", undefined],
  ])("treats a description that is %s as unknown", async (_name, value) => {
    const a = await fake({ status: "connected", instance: { label: "a", description: value } });
    const poller = pollerFor([{ label: "a", baseUrl: a.url }]);

    await poller.pollOnce();

    expect(poller.views()[0].description).toBeNull();
  });

  it("does not mind an instance that does not say who it is yet", async () => {
    const a = await fake({ status: "connected" });
    const poller = pollerFor([{ label: "a", baseUrl: a.url }]);

    await poller.pollOnce();

    expect(poller.views()[0]).toMatchObject({ state: "connected", description: null });
  });
});

describe("poller: an address that answers as another number", () => {
  it("reports mismatch, shows nothing of the other number and never fetches its QR", async () => {
    const a = await fake({
      status: "qr_pending",
      instance: { label: "personal", description: "Someone else" },
      phone_last4: "4321",
    });
    a.setQr(await qrPng("other"));
    const poller = pollerFor([{ label: "empresa", baseUrl: a.url }]);

    await poller.pollOnce();

    expect(poller.views()[0]).toEqual({
      label: "empresa",
      description: null,
      phone_last4: null,
      state: "mismatch",
      down_for_s: null,
      qr_rev: null,
    });
    expect(a.hits.qr).toBe(0);
    expect(poller.qrPng("empresa")).toBeNull();
  });

  it("accepts an instance whose label is the configured one", async () => {
    const a = await fake({ status: "connected", instance: { label: "empresa" } });
    const poller = pollerFor([{ label: "empresa", baseUrl: a.url }]);

    await poller.pollOnce();

    expect(poller.views()[0].state).toBe("connected");
  });
});

describe("poller: an instance that does not answer", () => {
  it("reports down for a refused connection, counted from hub start when it never answered", async () => {
    clock = 5_000_000;
    const poller = pollerFor([{ label: "a", baseUrl: await deadAddress() }]);

    clock += 10_000;
    await poller.pollOnce();
    clock += 5_000;

    expect(poller.views()[0]).toMatchObject({ state: "down", down_for_s: 15, qr_rev: null });
  });

  it("counts down time from the first failed poll, not from the last good one", async () => {
    clock = 6_000_000;
    const a = await fake({ status: "connected" });
    const poller = pollerFor([{ label: "a", baseUrl: a.url }]);
    await poller.pollOnce();

    clock += 60_000;
    await a.close();
    await poller.pollOnce(); // first failure
    clock += 2_000;
    await poller.pollOnce(); // second failure must not restart the count
    clock += 3_000;

    expect(poller.views()[0]).toMatchObject({ state: "down", down_for_s: 5 });
  });

  it("restarts the count after the instance has been back", async () => {
    clock = 7_000_000;
    const a = await fake({ status: "connected" });
    const poller = pollerFor([{ label: "a", baseUrl: a.url }]);
    const view = () => poller.views()[0];

    a.setHealth("bad gateway");
    await poller.pollOnce();
    expect(view().state).toBe("down");

    a.setHealth({ status: "connected" });
    clock += 30_000;
    await poller.pollOnce();
    expect(view()).toMatchObject({ state: "connected", down_for_s: null });

    a.setHealth("bad gateway");
    clock += 100_000;
    await poller.pollOnce();
    clock += 7_000;
    expect(view()).toMatchObject({ state: "down", down_for_s: 7 });
  });

  it("reports down when a hung instance does not answer within the timeout", async () => {
    clock = 8_000_000;
    const a = await fake({ status: "connected" });
    a.setHang(true);
    const poller = pollerFor([{ label: "a", baseUrl: a.url }], { timeoutMs: 150 });

    const started = performance.now();
    await poller.pollOnce();

    expect(performance.now() - started).toBeLessThan(1000);
    expect(poller.views()[0].state).toBe("down");
  });

  it.each([
    ["a body that is not JSON", "<html>bad gateway</html>"],
    ["JSON that is not an object", "[1,2]"],
    ["a status it does not know", { status: "exploded" }],
    ["no status at all", { instance: { label: "a" } }],
  ])("reports down for %s", async (_name, body) => {
    const a = await fake();
    a.setHealth(body);
    const poller = pollerFor([{ label: "a", baseUrl: a.url }]);

    await poller.pollOnce();

    expect(poller.views()[0].state).toBe("down");
  });

  it("keeps the description and last digits it learned while the number is down", async () => {
    const a = await fake({
      status: "connected",
      instance: { label: "a", description: "Line A" },
      phone_last4: "1234",
    });
    const poller = pollerFor([{ label: "a", baseUrl: a.url }]);
    await poller.pollOnce();

    await a.close();
    await poller.pollOnce();

    expect(poller.views()[0]).toMatchObject({
      state: "down",
      description: "Line A",
      phone_last4: "1234",
    });
  });

  it("drops the QR when the instance goes down", async () => {
    const a = await fake({ status: "qr_pending" });
    a.setQr(await qrPng("one"));
    const poller = pollerFor([{ label: "a", baseUrl: a.url }]);
    await poller.pollOnce();

    await a.close();
    await poller.pollOnce();

    expect(poller.views()[0].qr_rev).toBeNull();
    expect(poller.qrPng("a")).toBeNull();
  });

  it("does not let one hung instance delay another's update", async () => {
    const hung = await fake({ status: "connected" });
    hung.setHang(true);
    const healthy = await fake({ status: "connected", phone_last4: "5555" });
    const poller = pollerFor(
      [
        { label: "hung", baseUrl: hung.url },
        { label: "healthy", baseUrl: healthy.url },
      ],
      { timeoutMs: 600 },
    );

    const cycle = poller.pollOnce();
    await vi.waitFor(() => expect(poller.views()[1].phone_last4).toBe("5555"), { timeout: 400 });

    expect(poller.views()[1].state).toBe("connected");
    expect(poller.views()[0].state).toBe("starting"); // still waiting on the hung one
    await cycle;
    expect(poller.views()[0].state).toBe("down");
  });
});

describe("poller: the background loop", () => {
  it("polls on its own, in the order of the configured instances, until stopped", async () => {
    const a = await fake({ status: "connected" });
    const b = await fake({ status: "disconnected" });
    const poller = pollerFor(
      [
        { label: "a", baseUrl: a.url },
        { label: "b", baseUrl: b.url },
      ],
      { intervalMs: 20 },
    );

    poller.start();
    await vi.waitFor(() =>
      expect(poller.views().map((v) => v.state)).toEqual(["connected", "disconnected"]),
    );
    a.setHealth({ status: "qr_pending" });
    a.setQr(await qrPng("x"));
    await vi.waitFor(() => expect(poller.views()[0].state).toBe("waiting_qr"));

    poller.stop();
    await new Promise((resolve) => setTimeout(resolve, 100)); // a poll already in flight lands
    const seen = a.hits.health;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(a.hits.health).toBe(seen);
  });

  it("runs one loop per instance however many times it is started", async () => {
    const a = await fake({ status: "connected" });
    const poller = pollerFor([{ label: "a", baseUrl: a.url }], { intervalMs: 60_000 });

    poller.start();
    poller.start();
    await vi.waitFor(() => expect(a.hits.health).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 200));
    poller.stop();

    expect(a.hits.health).toBe(1);
  });

  it("can be started again after it was stopped", async () => {
    const a = await fake({ status: "connected" });
    const poller = pollerFor([{ label: "a", baseUrl: a.url }], { intervalMs: 20 });
    poller.start();
    await vi.waitFor(() => expect(a.hits.health).toBeGreaterThan(0));
    poller.stop();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const seen = a.hits.health;

    poller.start();
    await vi.waitFor(() => expect(a.hits.health).toBeGreaterThan(seen + 1));
    poller.stop();
  });
});
