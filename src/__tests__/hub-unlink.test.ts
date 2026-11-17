import { afterEach, describe, expect, it } from "vitest";
import { createUnlinker, UNLINK_TIMEOUT_MS } from "../hub/unlink.ts";
import { deadAddress, type FakeInstance, startFakeInstance } from "./helpers/fake-instance.ts";

const SECRET = "shared-instance-secret-0123456789-abcdef";

const open: FakeInstance[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((fake) => fake.close()));
});

async function fake(): Promise<FakeInstance> {
  const instance = await startFakeInstance();
  open.push(instance);
  return instance;
}

describe("createUnlinker", () => {
  it("posts to the named instance only, with the bearer secret, and reports a number unlinked", async () => {
    const a = await fake();
    const b = await fake();
    const unlinker = createUnlinker({
      secret: SECRET,
      instances: [
        { label: "a", baseUrl: a.url },
        { label: "b", baseUrl: b.url },
      ],
    });

    expect(await unlinker.run("b")).toBe("unlinked");

    expect(b.unlinkRequests).toEqual([{ method: "POST", authorization: `Bearer ${SECRET}` }]);
    expect(a.unlinkRequests).toEqual([]);
  });

  it("reports a number that was not connected", async () => {
    const a = await fake();
    a.setUnlinkAnswer(200, { unlinked: false });

    const unlinker = createUnlinker({
      secret: SECRET,
      instances: [{ label: "a", baseUrl: a.url }],
    });

    expect(await unlinker.run("a")).toBe("not_connected");
  });

  it.each([
    ["a 401", 401, ""],
    ["a 404", 404, "not found"],
    ["a 502", 502, { unlinked: false }],
    ["a 500", 500, { unlinked: true }],
    ["a 200 that is not JSON", 200, "<html>hello</html>"],
    ["a 200 without the key", 200, { ok: true }],
    ["a 200 with a string for the key", 200, { unlinked: "true" }],
    ["a 200 with a null body", 200, "null"],
    ["a redirect", 302, ""],
  ])("reports failure for %s", async (_name, status, body) => {
    const a = await fake();
    a.setUnlinkAnswer(status, body);

    const unlinker = createUnlinker({
      secret: SECRET,
      instances: [{ label: "a", baseUrl: a.url }],
    });

    expect(await unlinker.run("a")).toBe("failed");
  });

  it("reports failure when nothing answers, and when the answer is too slow", async () => {
    const dead = await deadAddress();
    const slow = await fake();
    slow.setHang(true);
    const unlinker = createUnlinker({
      secret: SECRET,
      timeoutMs: 100,
      instances: [
        { label: "dead", baseUrl: dead },
        { label: "slow", baseUrl: slow.url },
      ],
    });

    expect(await unlinker.run("dead")).toBe("failed");
    const started = Date.now();
    expect(await unlinker.run("slow")).toBe("failed");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("waits ten seconds for an instance by default", () => {
    expect(UNLINK_TIMEOUT_MS).toBe(10_000);
  });

  it("never calls anything for a label it does not know", async () => {
    const a = await fake();
    const unlinker = createUnlinker({
      secret: SECRET,
      instances: [{ label: "a", baseUrl: a.url }],
    });

    expect(await unlinker.run("nope")).toBe("failed");
    expect(await unlinker.run("")).toBe("failed");
    expect(a.unlinkRequests).toEqual([]);
  });
});
