import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initializeDatabase, resetDatabase } from "../database.ts";
import {
  executeDeregisterWebhook,
  executeListWebhooks,
  executeRegisterWebhook,
} from "../webhooks/actions.ts";
import { loadRegistry, matchSubscriptions, resetRegistry } from "../webhooks/registry.ts";

beforeEach(() => {
  initializeDatabase(":memory:");
  resetRegistry();
  loadRegistry();
});

afterEach(() => {
  resetRegistry();
  resetDatabase();
});

describe("webhook actions", () => {
  it("registers a subscription, persists it, and makes it matchable", () => {
    const { id } = executeRegisterWebhook({
      target_url: "https://hook.example/in",
      allowed_jids: ["5531@s.whatsapp.net"],
      secret: "shh",
    });

    expect(id).toBeTruthy();
    expect(matchSubscriptions("5531@s.whatsapp.net")).toHaveLength(1);
  });

  it("lists subscriptions with the secret redacted to has_secret", () => {
    executeRegisterWebhook({
      target_url: "https://hook.example/in",
      allowed_jids: ["5531@s.whatsapp.net"],
      secret: "shh",
      label: "hermes",
    });

    const list = executeListWebhooks();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      target_url: "https://hook.example/in",
      label: "hermes",
      has_secret: true,
      auth_mode: "hmac",
      transcribe: true,
    });
    expect(list[0]).not.toHaveProperty("secret");
  });

  it("deregisters by id", () => {
    const { id } = executeRegisterWebhook({
      target_url: "https://hook.example/in",
      allowed_jids: ["5531@s.whatsapp.net"],
    });

    expect(executeDeregisterWebhook(id)).toEqual({ removed: true });
    expect(executeDeregisterWebhook(id)).toEqual({ removed: false });
    expect(matchSubscriptions("5531@s.whatsapp.net")).toHaveLength(0);
  });

  it("rejects a non-http(s) target_url", () => {
    expect(() =>
      executeRegisterWebhook({ target_url: "ftp://x/y", allowed_jids: ["5531@s.whatsapp.net"] }),
    ).toThrow(/http/);
  });

  it("rejects an empty allow-list", () => {
    expect(() =>
      executeRegisterWebhook({ target_url: "https://hook.example/in", allowed_jids: [] }),
    ).toThrow(/allowed_jids/);
  });
});
