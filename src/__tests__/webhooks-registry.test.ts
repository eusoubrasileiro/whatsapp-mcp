import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initializeDatabase, recordJidMapping, resetDatabase } from "../database.ts";
import {
  addSubscription,
  listSubscriptions,
  loadRegistry,
  matchSubscriptions,
  removeSubscription,
  resetRegistry,
} from "../webhooks/registry.ts";

beforeEach(() => {
  initializeDatabase(":memory:");
  resetRegistry();
  loadRegistry();
});

afterEach(() => {
  resetRegistry();
  resetDatabase();
});

describe("subscription registry", () => {
  it("adds a subscription and lists it for its tenant", () => {
    const sub = addSubscription({
      tenantId: "default",
      targetUrl: "https://hook.example/in",
      allowedJids: ["5531@s.whatsapp.net"],
    });

    expect(sub.id).toBeTruthy();
    expect(listSubscriptions("default")).toHaveLength(1);
    expect(listSubscriptions("other")).toHaveLength(0);
  });

  it("persists across a cache reload (DB is source of truth)", () => {
    addSubscription({
      tenantId: "default",
      targetUrl: "https://hook.example/in",
      allowedJids: ["5531@s.whatsapp.net"],
      secret: "shh",
      label: "agent",
    });

    resetRegistry();
    loadRegistry();

    const subs = listSubscriptions("default");
    expect(subs).toHaveLength(1);
    expect(subs[0].targetUrl).toBe("https://hook.example/in");
    expect(subs[0].secret).toBe("shh");
    expect(subs[0].allowedJids).toEqual(["5531@s.whatsapp.net"]);
  });

  it("matches a message from an allow-listed chat and skips others", () => {
    addSubscription({
      tenantId: "default",
      targetUrl: "https://hook.example/in",
      allowedJids: ["5531@s.whatsapp.net"],
    });

    expect(matchSubscriptions("5531@s.whatsapp.net")).toHaveLength(1);
    expect(matchSubscriptions("9999@s.whatsapp.net")).toHaveLength(0);
  });

  it("matches any chat when the allow-list is the wildcard", () => {
    addSubscription({
      tenantId: "default",
      targetUrl: "https://hook.example/all",
      allowedJids: ["*"],
    });

    expect(matchSubscriptions("anyone@s.whatsapp.net")).toHaveLength(1);
    expect(matchSubscriptions("12345@g.us")).toHaveLength(1);
  });

  it("matches across LID<->PN forms via canonical resolution", () => {
    // Record a phone-number <-> LID identity; canonical direction is LID.
    recordJidMapping("5531@s.whatsapp.net", "111@lid");
    addSubscription({
      tenantId: "default",
      targetUrl: "https://hook.example/in",
      allowedJids: ["5531@s.whatsapp.net"], // stored canonicalized to the LID
    });

    expect(matchSubscriptions("5531@s.whatsapp.net")).toHaveLength(1);
    expect(matchSubscriptions("111@lid")).toHaveLength(1);
  });

  it("removes a subscription only for the right tenant", () => {
    const sub = addSubscription({
      tenantId: "default",
      targetUrl: "https://hook.example/in",
      allowedJids: ["5531@s.whatsapp.net"],
    });

    expect(removeSubscription(sub.id, "other")).toBe(false);
    expect(matchSubscriptions("5531@s.whatsapp.net")).toHaveLength(1);

    expect(removeSubscription(sub.id, "default")).toBe(true);
    expect(matchSubscriptions("5531@s.whatsapp.net")).toHaveLength(0);
    expect(listSubscriptions("default")).toHaveLength(0);
  });
});
