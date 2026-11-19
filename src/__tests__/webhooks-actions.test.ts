import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
      label: "agent",
    });

    const list = executeListWebhooks();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      target_url: "https://hook.example/in",
      label: "agent",
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

  describe("internal targets", () => {
    const register = (target_url: string) => () =>
      executeRegisterWebhook({ target_url, allowed_jids: ["*"] });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it.each([
      ["a loopback address", "http://127.0.0.1:8080/hook", "127.0.0.1"],
      ["a private address", "http://10.1.2.3/hook", "10.1.2.3"],
      ["a Docker network address", "http://172.18.0.4:3000/hook", "172.18.0.4"],
      ["the cloud metadata address", "http://169.254.169.254/latest", "169.254.169.254"],
      ["IPv6 loopback", "http://[::1]:9000/hook", "::1"],
      ["an IPv4-mapped IPv6 loopback", "http://[::ffff:127.0.0.1]/hook", "::ffff:7f00:1"],
      ["a unique-local IPv6 address", "http://[fd00::5]/hook", "fd00::5"],
      ["localhost", "http://localhost:5678/hook", "localhost"],
      ["localhost with a trailing dot", "http://localhost.:5678/hook", "localhost"],
      ["a .localhost name", "http://api.localhost/hook", "api.localhost"],
      ["a single-label name such as a Docker service", "http://n8n:5678/hook", "n8n"],
      ["an integer-encoded loopback", "http://2130706433/hook", "127.0.0.1"],
    ])("refuses %s, naming the host and the operator setting", (_kind, url, host) => {
      expect(register(url)).toThrow(
        `target_url host "${host}" is private or internal; webhooks go only to public hosts unless the operator lists the host in WEBHOOK_PRIVATE_HOSTS.`,
      );
    });

    it.each([
      "https://hook.example/in",
      "https://hooks.example.invalid/whatsapp",
      "http://8.8.8.8/hook",
      "http://[2606:4700:4700::1111]/hook",
    ])("accepts the public target %s", (url) => {
      expect(register(url)).not.toThrow();
    });

    it("accepts an internal host the operator listed, matched without case or trailing dot", () => {
      vi.stubEnv("WEBHOOK_PRIVATE_HOSTS", " N8N ,10.1.2.3,hooks.lan.");
      expect(register("http://n8n:5678/hook")).not.toThrow();
      expect(register("http://10.1.2.3/hook")).not.toThrow();
      expect(register("http://hooks.lan/hook")).not.toThrow();
      expect(register("http://hooks.lan./hook")).not.toThrow();
      expect(register("http://redis:6379/")).toThrow(/"redis" is private or internal/);
    });

    it("ignores empty entries in WEBHOOK_PRIVATE_HOSTS", () => {
      vi.stubEnv("WEBHOOK_PRIVATE_HOSTS", ",, ,");
      expect(register("http://n8n:5678/hook")).toThrow(/private or internal/);
    });
  });

  it("rejects an empty allow-list", () => {
    expect(() =>
      executeRegisterWebhook({ target_url: "https://hook.example/in", allowed_jids: [] }),
    ).toThrow(/allowed_jids/);
  });
});
