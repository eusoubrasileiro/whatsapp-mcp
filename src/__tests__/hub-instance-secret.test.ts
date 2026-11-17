import { describe, expect, it } from "vitest";
import {
  isBearerOf,
  MIN_HUB_SECRET_LENGTH,
  readHubInstanceSecret,
} from "../hub-instance-secret.ts";
import { recordingLogger } from "./helpers/recording-logger.ts";

const SECRET = "s".repeat(MIN_HUB_SECRET_LENGTH);

describe("readHubInstanceSecret", () => {
  it("is 32 characters at the least", () => {
    expect(MIN_HUB_SECRET_LENGTH).toBe(32);
  });

  it.each([
    ["unset", {}],
    ["empty", { HUB_INSTANCE_SECRET: "" }],
  ])("returns nothing, quietly, when the secret is %s", (_name, env) => {
    const { logger, lines } = recordingLogger();

    expect(readHubInstanceSecret(env, logger)).toBeNull();
    expect(lines).toEqual([]);
  });

  it("returns a secret of exactly 32 characters, and a longer one", () => {
    const { logger, lines } = recordingLogger();

    expect(readHubInstanceSecret({ HUB_INSTANCE_SECRET: SECRET }, logger)).toBe(SECRET);
    expect(readHubInstanceSecret({ HUB_INSTANCE_SECRET: `${SECRET}x` }, logger)).toBe(`${SECRET}x`);
    expect(lines).toEqual([]);
  });

  it("returns nothing and warns once, without the value, for 31 characters", () => {
    const { logger, lines } = recordingLogger();
    const short = "z".repeat(MIN_HUB_SECRET_LENGTH - 1);

    expect(readHubInstanceSecret({ HUB_INSTANCE_SECRET: short }, logger)).toBeNull();

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ level: 40 });
    expect(lines[0]).toContain("HUB_INSTANCE_SECRET");
    expect(lines[0]).not.toContain(short);
    expect(lines[0]).not.toContain("zzzz");
  });
});

describe("isBearerOf", () => {
  it("accepts exactly Bearer and the secret", () => {
    expect(isBearerOf(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it.each([
    ["no header", undefined],
    ["an empty header", ""],
    ["the scheme alone", "Bearer "],
    ["no scheme", SECRET],
    ["another scheme", `Basic ${SECRET}`],
    ["a lower-case scheme", `bearer ${SECRET}`],
    ["a wrong secret of the same length", `Bearer ${"t".repeat(MIN_HUB_SECRET_LENGTH)}`],
    ["the start of the secret", `Bearer ${SECRET.slice(0, -1)}`],
    ["the secret and more", `Bearer ${SECRET}x`],
    ["the secret and a space", `Bearer ${SECRET} `],
  ])("refuses %s", (_name, header) => {
    expect(isBearerOf(header, SECRET)).toBe(false);
  });
});
