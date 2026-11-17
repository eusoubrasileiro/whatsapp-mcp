import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HubConfigError, loadHubConfig } from "../hub/config.ts";

const PIN = "hunter2-test-pin";
const KEY = "k".repeat(40);

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-config-"));
});

afterEach(() => {
  fs.chmodSync(stateDir, 0o700);
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function env(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const merged: Record<string, string | undefined> = {
    HUB_PIN: PIN,
    HUB_COOKIE_KEY: KEY,
    HUB_INSTANCES: "personal,empresa",
    HUB_PUBLIC_URL: "https://wa.example.com",
    HUB_STATE_DIR: stateDir,
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function refusal(overrides: Record<string, string | undefined>): HubConfigError {
  try {
    loadHubConfig(env(overrides));
  } catch (err) {
    expect(err).toBeInstanceOf(HubConfigError);
    return err as HubConfigError;
  }
  throw new Error("expected the hub configuration to be refused");
}

describe("loadHubConfig: a valid environment", () => {
  it("reads every setting and applies the listener defaults", () => {
    const config = loadHubConfig(env());

    expect(config).toMatchObject({
      pin: PIN,
      cookieKey: KEY,
      publicUrl: "https://wa.example.com",
      stateDir,
      host: "0.0.0.0",
      port: 39002,
      ntfy: null,
    });
  });

  it("takes the listener address from HUB_HOST and HUB_PORT", () => {
    const config = loadHubConfig(env({ HUB_HOST: "127.0.0.1", HUB_PORT: "41234" }));

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(41234);
  });

  it("falls back to the defaults when HUB_HOST and HUB_PORT are empty", () => {
    const config = loadHubConfig(env({ HUB_HOST: "", HUB_PORT: "" }));

    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(39002);
  });

  it("accepts the shortest PIN and the shortest key the rules allow", () => {
    const config = loadHubConfig(env({ HUB_PIN: "1234", HUB_COOKIE_KEY: "k".repeat(32) }));

    expect(config.pin).toBe("1234");
    expect(config.cookieKey).toHaveLength(32);
  });

  it("passes the ntfy settings through when a topic is set", () => {
    const config = loadHubConfig(
      env({ NTFY_TOPIC_URL: "https://ntfy.example.com/topic", NTFY_TOKEN: "tk_test" }),
    );

    expect(config.ntfy).toEqual({ topicUrl: "https://ntfy.example.com/topic", token: "tk_test" });
  });
});

describe("loadHubConfig: HUB_LANG", () => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["en", "en"],
  ])("reads English when HUB_LANG is %s", (_name, value) => {
    expect(loadHubConfig(env({ HUB_LANG: value })).lang).toBe("en");
  });

  it("reads Brazilian Portuguese from pt-BR", () => {
    expect(loadHubConfig(env({ HUB_LANG: "pt-BR" })).lang).toBe("pt-BR");
  });

  it.each(["xx", "pt", "pt-br", "PT-BR", "EN", " en", "en "])(
    "refuses the language %j and says which ones it accepts",
    (value) => {
      const error = refusal({ HUB_LANG: value });

      expect(error.problems).toHaveLength(1);
      expect(error.problems[0]).toContain("HUB_LANG");
      expect(error.problems[0]).toContain("en");
      expect(error.problems[0]).toContain("pt-BR");
    },
  );

  it("never quotes the refused value", () => {
    expect(refusal({ HUB_LANG: "klingon-zz9" }).message).not.toContain("klingon-zz9");
  });
});

describe("loadHubConfig: HUB_INSTANCE_SECRET", () => {
  const SECRET = "s".repeat(32);

  it.each([
    ["unset", undefined],
    ["empty", ""],
  ])("has no unlink secret when HUB_INSTANCE_SECRET is %s", (_name, value) => {
    expect(loadHubConfig(env({ HUB_INSTANCE_SECRET: value })).instanceSecret).toBeNull();
  });

  it("reads a secret of 32 characters, and a longer one", () => {
    expect(loadHubConfig(env({ HUB_INSTANCE_SECRET: SECRET })).instanceSecret).toBe(SECRET);
    expect(loadHubConfig(env({ HUB_INSTANCE_SECRET: `${SECRET}x` })).instanceSecret).toBe(
      `${SECRET}x`,
    );
  });

  it("refuses 31 characters, names the variable and never quotes the value", () => {
    const short = "w".repeat(31);

    const error = refusal({ HUB_INSTANCE_SECRET: short });

    expect(error.problems).toHaveLength(1);
    expect(error.problems[0]).toContain("HUB_INSTANCE_SECRET");
    expect(error.problems[0]).toContain("32");
    expect(error.message).not.toContain("wwww");
  });
});

describe("loadHubConfig: HUB_INSTANCES", () => {
  it("expands a bare label to the compose service address, in order", () => {
    const config = loadHubConfig(env({ HUB_INSTANCES: "personal, empresa" }));

    expect(config.instances).toEqual([
      { label: "personal", baseUrl: "http://whatsapp-mcp-personal:39002" },
      { label: "empresa", baseUrl: "http://whatsapp-mcp-empresa:39002" },
    ]);
  });

  it("keeps an explicit address and drops a trailing slash", () => {
    const config = loadHubConfig(
      env({ HUB_INSTANCES: "a=http://127.0.0.1:4001, b=https://b.example.com/" }),
    );

    expect(config.instances).toEqual([
      { label: "a", baseUrl: "http://127.0.0.1:4001" },
      { label: "b", baseUrl: "https://b.example.com" },
    ]);
  });

  it("accepts a label of one and of 32 characters", () => {
    const long = `a${"b".repeat(31)}`;

    const config = loadHubConfig(env({ HUB_INSTANCES: `x,${long}` }));

    expect(config.instances.map((i) => i.label)).toEqual(["x", long]);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["blank", "   "],
  ])("refuses a %s list", (_name, value) => {
    expect(refusal({ HUB_INSTANCES: value }).problems.join("\n")).toContain("HUB_INSTANCES");
  });

  it.each([
    ["an upper-case label", "Empresa"],
    ["a label starting with a dash", "-empresa"],
    ["a label with an underscore", "_hub"],
    ["a label with a dot", "a.b"],
    ["a 33-character label", `a${"b".repeat(32)}`],
    ["an empty label before the address", "=http://x:1"],
    ["an empty item", "a,,b"],
    ["a trailing comma", "a,"],
  ])("refuses %s", (_name, value) => {
    expect(refusal({ HUB_INSTANCES: value }).problems.join("\n")).toContain("HUB_INSTANCES");
  });

  it("says which item of the list is wrong", () => {
    const problems = refusal({ HUB_INSTANCES: "a,B,a" }).problems;

    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("item 2");
    expect(problems[1]).toContain("item 3");
  });

  it("refuses a duplicated label", () => {
    expect(refusal({ HUB_INSTANCES: "a,b,a" }).problems.join("\n")).toContain("HUB_INSTANCES");
  });

  it.each([
    ["not a URL", "a=not a url"],
    ["a non-http scheme", "a=ftp://host:1"],
    ["an address with a path", "a=http://host:1/health"],
    ["an address with a query", "a=http://host:1/?x=1"],
    ["an address with a fragment", "a=http://host:1/#x"],
    ["an empty address", "a="],
  ])("refuses an explicit address that is %s", (_name, value) => {
    expect(refusal({ HUB_INSTANCES: value }).problems.join("\n")).toContain("HUB_INSTANCES");
  });
});

describe("loadHubConfig: refuses to start", () => {
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["three characters", "123"],
  ])("when HUB_PIN is %s", (_name, value) => {
    expect(refusal({ HUB_PIN: value }).problems.join("\n")).toContain("HUB_PIN");
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["31 characters", "k".repeat(31)],
  ])("when HUB_COOKIE_KEY is %s", (_name, value) => {
    expect(refusal({ HUB_COOKIE_KEY: value }).problems.join("\n")).toContain("HUB_COOKIE_KEY");
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["with a trailing slash", "https://wa.example.com/"],
    ["with a path", "https://wa.example.com/hub"],
    ["not a URL", "wa.example.com"],
    ["plain http on a real host", "http://wa.example.com"],
    ["a non-http scheme", "ftp://wa.example.com"],
  ])("when HUB_PUBLIC_URL is %s", (_name, value) => {
    expect(refusal({ HUB_PUBLIC_URL: value }).problems.join("\n")).toContain("HUB_PUBLIC_URL");
  });

  it.each(["http://localhost:8080", "http://127.0.0.1:8080", "https://localhost"])(
    "accepts the public URL %s",
    (url) => {
      expect(loadHubConfig(env({ HUB_PUBLIC_URL: url })).publicUrl).toBe(url);
    },
  );

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["a directory that does not exist", "/nonexistent/hub-state-dir"],
  ])("when HUB_STATE_DIR is %s", (_name, value) => {
    expect(refusal({ HUB_STATE_DIR: value }).problems.join("\n")).toContain("HUB_STATE_DIR");
  });

  it("when HUB_STATE_DIR is a file", () => {
    const file = path.join(stateDir, "a-file");
    fs.writeFileSync(file, "x");

    expect(refusal({ HUB_STATE_DIR: file }).problems.join("\n")).toContain("HUB_STATE_DIR");
  });

  it.skipIf(process.getuid?.() === 0)("when HUB_STATE_DIR is not writable", () => {
    fs.chmodSync(stateDir, 0o500);

    expect(refusal({}).problems.join("\n")).toContain("HUB_STATE_DIR");
  });

  it.each([
    ["not a number", "abc"],
    ["zero", "0"],
    ["above 65535", "65536"],
    ["a fraction", "80.5"],
  ])("when HUB_PORT is %s", (_name, value) => {
    expect(refusal({ HUB_PORT: value }).problems.join("\n")).toContain("HUB_PORT");
  });

  it("accepts the lowest and the highest port", () => {
    expect(loadHubConfig(env({ HUB_PORT: "1" })).port).toBe(1);
    expect(loadHubConfig(env({ HUB_PORT: "65535" })).port).toBe(65535);
  });

  it("reports every problem at once", () => {
    const error = refusal({ HUB_PIN: "1", HUB_COOKIE_KEY: "short", HUB_INSTANCES: undefined });

    expect(error.problems).toHaveLength(3);
  });

  it("never puts the PIN or the key into any message, even when both are rejected", () => {
    const error = refusal({
      HUB_PIN: "pw1",
      HUB_COOKIE_KEY: "sekrit-key-too-short",
      HUB_PORT: "x",
    });

    for (const text of [error.message, ...error.problems]) {
      expect(text).not.toContain("pw1");
      expect(text).not.toContain("sekrit-key-too-short");
    }
    expect(error.message).toContain("HUB_PIN");
  });

  it("never puts a valid PIN or key into the message of an unrelated refusal", () => {
    const error = refusal({ HUB_INSTANCES: undefined });

    expect(error.message).not.toContain(PIN);
    expect(error.message).not.toContain(KEY);
  });
});
