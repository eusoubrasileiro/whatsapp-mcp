import { describe, expect, it } from "vitest";
import {
  type CopyConfig,
  copy,
  describeError,
  type Io,
  parseConfig,
  removeSource,
  runCli,
  type Side,
  SideError,
  UsageError,
  verify,
} from "../store-copy.ts";

/** One object in the fake store: its bytes and its content type. */
interface Obj {
  bytes: Buffer;
  type: string;
}

const BUCKET = "amiticia-media";
const PREFIX = "t/empresa/";
const FAKE_NUMBER = "5500000001234";
const KEY_A = `${PREFIX}${FAKE_NUMBER}@s.whatsapp.net/MSG1.jpg`;
const KEY_B = `${PREFIX}${FAKE_NUMBER}@s.whatsapp.net/MSG2.ogg`;
const KEY_C = `${PREFIX}uploads/0f0f0f0f-aaaa.png`;
const SECRETS = ["src-ak-SECRET", "src-sk-SECRET", "dst-ak-SECRET", "dst-sk-SECRET"];

const obj = (text: string, type = "image/jpeg"): Obj => ({ bytes: Buffer.from(text), type });

/** A store that remembers what was done to it, and behaves like S3 where the tool depends on it. */
class FakeStore implements Side {
  /** Every call that changes the store, in order. */
  readonly mutations: string[] = [];
  readonly buckets = new Map<string, Map<string, Obj>>();
  /** Answer a listing with every key, as a store that ignored the prefix would. */
  ignorePrefix = false;
  /** Store these keys with their first byte changed, as a store that corrupts a write would. */
  corrupt = new Set<string>();
  /** Throw this when `op` is asked about `key`. */
  fail = new Map<string, Error>();
  openReads = 0;
  maxOpenReads = 0;
  streamedWrites = 0;

  constructor(objects?: Record<string, Obj>) {
    if (objects) this.buckets.set(BUCKET, new Map(Object.entries(objects)));
  }

  get objects(): Map<string, Obj> {
    return this.buckets.get(BUCKET) ?? new Map();
  }

  private maybeFail(op: string, key: string) {
    const error = this.fail.get(`${op}:${key}`);
    if (error) throw error;
  }

  private bucket(name: string): Map<string, Obj> {
    const found = this.buckets.get(name);
    if (!found) throw Object.assign(new Error("no such bucket"), { code: "NoSuchBucket" });
    return found;
  }

  async bucketExists(bucket: string) {
    return this.buckets.has(bucket);
  }

  async makeBucket(bucket: string) {
    this.mutations.push("makeBucket");
    this.buckets.set(bucket, new Map());
  }

  async *list(bucket: string, prefix: string) {
    for (const key of [...this.bucket(bucket).keys()].sort()) {
      if (this.ignorePrefix || key.startsWith(prefix)) yield key;
    }
  }

  private get(bucket: string, key: string): Obj {
    const found = this.bucket(bucket).get(key);
    if (!found) throw Object.assign(new Error(`not found: ${key}`), { code: "NotFound" });
    return found;
  }

  async stat(bucket: string, key: string) {
    this.maybeFail("stat", key);
    const found = this.get(bucket, key);
    return { size: found.bytes.length, contentType: found.type };
  }

  async *read(bucket: string, key: string) {
    this.maybeFail("read", key);
    const { bytes } = this.get(bucket, key);
    this.openReads += 1;
    this.maxOpenReads = Math.max(this.maxOpenReads, this.openReads);
    try {
      for (let at = 0; at < bytes.length; at += 5) yield bytes.subarray(at, at + 5);
    } finally {
      this.openReads -= 1;
    }
  }

  async write(
    bucket: string,
    key: string,
    body: AsyncIterable<Buffer>,
    size: number,
    contentType: string,
  ) {
    this.maybeFail("write", key);
    if (Symbol.asyncIterator in body) this.streamedWrites += 1;
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    expect(bytes.length).toBe(size);
    if (this.corrupt.has(key)) bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    this.mutations.push(`write:${key}`);
    this.bucket(bucket).set(key, { bytes, type: contentType });
  }

  async remove(bucket: string, key: string) {
    this.maybeFail("remove", key);
    this.mutations.push(`remove:${key}`);
    this.bucket(bucket).delete(key);
  }
}

const config = (): CopyConfig => ({
  src: { host: "old-store", port: 9000, accessKey: "src-ak-SECRET", secretKey: "src-sk-SECRET" },
  dst: { host: "new-store", port: 9000, accessKey: "dst-ak-SECRET", secretKey: "dst-sk-SECRET" },
  bucket: BUCKET,
  prefix: PREFIX,
});

/** Source holding three objects, a sibling tenant's and an unrelated one. */
const seeded = () =>
  new FakeStore({
    [KEY_A]: obj("picture one"),
    [KEY_B]: obj("voice note", "audio/ogg"),
    [KEY_C]: obj("an upload", "image/png"),
    "t/empresa-2/other.jpg": obj("a sibling tenant"),
    "t/default/mine.jpg": obj("another tenant"),
  });

const copyOfSource = (src: FakeStore) =>
  new FakeStore(
    Object.fromEntries(
      [...src.objects].filter(([key]) => key.startsWith(PREFIX)).map(([key, one]) => [key, one]),
    ),
  );

describe("describeError", () => {
  it("is the name and the code of an error, never its message", () => {
    const error = Object.assign(new Error("secret message"), { code: "AccessDenied" });
    expect(describeError(error)).toBe("Error (AccessDenied)");
  });

  it("is the name alone when there is no usable code", () => {
    expect(describeError(new TypeError("x"))).toBe("TypeError");
    expect(describeError(Object.assign(new Error("x"), { code: 403 }))).toBe("Error");
  });

  it("is generic for anything that is not an error", () => {
    expect(describeError("a string with a secret")).toBe("unknown error");
    expect(describeError(null)).toBe("unknown error");
  });
});

describe("parseConfig", () => {
  const env = (extra: Record<string, string | undefined> = {}) => ({
    STORE_COPY_SRC_ENDPOINT: "old-store",
    STORE_COPY_SRC_ACCESS_KEY: "src-ak",
    STORE_COPY_SRC_SECRET_KEY: "src-sk",
    STORE_COPY_DST_ENDPOINT: "new-store",
    STORE_COPY_DST_ACCESS_KEY: "dst-ak",
    STORE_COPY_DST_SECRET_KEY: "dst-sk",
    STORE_COPY_PREFIX: PREFIX,
    ...extra,
  });

  it("reads the two endpoints, the bucket and the prefix, with the default port and bucket", () => {
    expect(parseConfig(env())).toEqual({
      src: { host: "old-store", port: 9000, accessKey: "src-ak", secretKey: "src-sk" },
      dst: { host: "new-store", port: 9000, accessKey: "dst-ak", secretKey: "dst-sk" },
      bucket: "amiticia-media",
      prefix: PREFIX,
    });
  });

  it("takes ports and a bucket when they are given", () => {
    const parsed = parseConfig(
      env({
        STORE_COPY_SRC_PORT: "9100",
        STORE_COPY_DST_PORT: "9200",
        STORE_COPY_BUCKET: "other-media",
      }),
    );

    expect([parsed.src.port, parsed.dst.port, parsed.bucket]).toEqual([9100, 9200, "other-media"]);
  });

  it.each([
    "STORE_COPY_SRC_ENDPOINT",
    "STORE_COPY_SRC_ACCESS_KEY",
    "STORE_COPY_SRC_SECRET_KEY",
    "STORE_COPY_DST_ENDPOINT",
    "STORE_COPY_DST_ACCESS_KEY",
    "STORE_COPY_DST_SECRET_KEY",
    "STORE_COPY_PREFIX",
  ])("refuses to run without %s, unset or empty", (name) => {
    for (const value of [undefined, ""]) {
      expect(() => parseConfig(env({ [name]: value }))).toThrow(
        new UsageError(`${name} is required`),
      );
    }
  });

  it.each(["http://old-store", "old-store/path", "old store", "old-store:9000", "-old"])(
    "refuses the endpoint %s, which is not a bare host",
    (host) => {
      expect(() => parseConfig(env({ STORE_COPY_SRC_ENDPOINT: host }))).toThrow(
        /STORE_COPY_SRC_ENDPOINT must be a bare host/,
      );
    },
  );

  it.each(["0", "65536", "abc", "1.5", "-1"])("refuses the port %s", (port) => {
    expect(() => parseConfig(env({ STORE_COPY_DST_PORT: port }))).toThrow(
      /STORE_COPY_DST_PORT must be a port number/,
    );
  });

  it.each(["1", "65535"])("accepts the port %s", (port) => {
    expect(parseConfig(env({ STORE_COPY_DST_PORT: port })).dst.port).toBe(Number(port));
  });

  it.each(["A", "a b", "-media", "media-", "ab_cd"])("refuses the bucket name %s", (bucket) => {
    expect(() => parseConfig(env({ STORE_COPY_BUCKET: bucket }))).toThrow(/not a bucket name/);
  });

  it.each(["t/empresa/", "t/a1-b/", "t/0/"])("accepts the prefix %s", (prefix) => {
    expect(parseConfig(env({ STORE_COPY_PREFIX: prefix })).prefix).toBe(prefix);
  });

  it.each([
    "t/",
    "t//",
    "t/Empresa/",
    "t/empresa",
    "t/empresa/uploads/",
    "empresa/",
    "/t/empresa/",
    "t/-x/",
    "t/empresa/../",
    "",
  ])("refuses the prefix %j, which is not one tenant's", (prefix) => {
    expect(() => parseConfig(env({ STORE_COPY_PREFIX: prefix }))).toThrow(UsageError);
  });

  it("refuses a destination that is the source: same host and port, whatever the case", () => {
    for (const host of ["old-store", "OLD-Store"]) {
      expect(() => parseConfig(env({ STORE_COPY_DST_ENDPOINT: host }))).toThrow(
        /the same endpoint/,
      );
    }
  });

  it("allows the same host on another port, and another host on the same port", () => {
    expect(
      parseConfig(env({ STORE_COPY_DST_ENDPOINT: "old-store", STORE_COPY_DST_PORT: "9001" })).dst
        .port,
    ).toBe(9001);
    expect(
      parseConfig(env({ STORE_COPY_SRC_PORT: "9100", STORE_COPY_DST_PORT: "9100" })).dst.host,
    ).toBe("new-store");
  });

  it("never puts a credential in a refusal", () => {
    const secret = env({
      STORE_COPY_SRC_ACCESS_KEY: "ak-VALUE",
      STORE_COPY_SRC_SECRET_KEY: "sk-VALUE",
    });
    for (const bad of [
      { STORE_COPY_PREFIX: "t/" },
      { STORE_COPY_DST_ENDPOINT: "old-store" },
      { STORE_COPY_SRC_PORT: "0" },
    ]) {
      const message = (() => {
        try {
          parseConfig({ ...secret, ...bad });
        } catch (err) {
          return (err as Error).message;
        }
        return "";
      })();
      expect(message).not.toBe("");
      expect(message).not.toMatch(/ak-VALUE|sk-VALUE/);
    }
  });
});

describe("verify", () => {
  it("passes when every source object has an identical destination object", async () => {
    const src = seeded();
    const dst = copyOfSource(src);

    const verdict = await verify(config(), src, dst);

    expect(verdict).toMatchObject({
      source: 3,
      destination: 3,
      missing: [],
      different: [],
      extra: 0,
      ok: true,
    });
    expect(verdict.identical).toEqual([KEY_C, KEY_A, KEY_B].sort());
  });

  it("fails on a missing object", async () => {
    const src = seeded();
    const dst = copyOfSource(src);
    dst.objects.delete(KEY_B);

    const verdict = await verify(config(), src, dst);

    expect(verdict).toMatchObject({ destination: 2, missing: [KEY_B], different: [], ok: false });
    expect(verdict.identical).toHaveLength(2);
  });

  it.each([
    ["other bytes of another length", obj("picture one!!")],
    ["other bytes of the same length", obj("picture two")],
    ["the same bytes with another content type", obj("picture one", "image/png")],
  ])("fails on an object with %s", async (_what, replacement) => {
    const src = seeded();
    const dst = copyOfSource(src);
    dst.objects.set(KEY_A, replacement);

    const verdict = await verify(config(), src, dst);

    expect(verdict).toMatchObject({ missing: [], different: [KEY_A], ok: false });
    expect(verdict.identical).not.toContain(KEY_A);
  });

  it("counts destination objects the source lacks, and still passes", async () => {
    const src = seeded();
    const dst = copyOfSource(src);
    dst.objects.set(`${PREFIX}written-after.jpg`, obj("new"));
    dst.objects.set(`${PREFIX}written-after-2.jpg`, obj("newer"));

    expect(await verify(config(), src, dst)).toMatchObject({ destination: 5, extra: 2, ok: true });
  });

  it("reports everything missing, and does not fail, when the destination bucket does not exist", async () => {
    const src = seeded();

    const verdict = await verify(config(), src, new FakeStore());

    expect(verdict).toMatchObject({ source: 3, destination: 0, identical: [], ok: false });
    expect(verdict.missing).toHaveLength(3);
  });

  it("passes on a source with nothing under the prefix", async () => {
    expect(await verify(config(), new FakeStore({}), new FakeStore({}))).toMatchObject({
      source: 0,
      ok: true,
    });
  });

  it("looks only under the prefix, even when a store answers with every key", async () => {
    const src = seeded();
    const dst = copyOfSource(src);
    src.ignorePrefix = true;
    dst.ignorePrefix = true;
    dst.objects.set("t/default/not-copied.jpg", obj("x"));

    const verdict = await verify(config(), src, dst);

    expect(verdict).toMatchObject({ source: 3, destination: 3, extra: 0, ok: true });
  });

  it("changes neither store", async () => {
    const src = seeded();
    const dst = copyOfSource(src);
    dst.objects.delete(KEY_A);

    await verify(config(), src, dst);

    expect([src.mutations, dst.mutations]).toEqual([[], []]);
  });
});

describe("copy", () => {
  it("creates the destination bucket and copies every object under the prefix, with its content type", async () => {
    const src = seeded();
    const dst = new FakeStore();

    const result = await copy(config(), src, dst);

    expect(result).toEqual({ source: 3, copied: 3, unchanged: 0, failed: [], firstError: null });
    expect(dst.mutations.filter((one) => one === "makeBucket")).toHaveLength(1);
    expect([...dst.objects.keys()].sort()).toEqual([KEY_C, KEY_A, KEY_B].sort());
    for (const key of [KEY_A, KEY_B, KEY_C])
      expect(dst.objects.get(key)).toEqual(src.objects.get(key));
  });

  it("leaves the source exactly as it was", async () => {
    const src = seeded();
    const before = new Map(src.objects);

    await copy(config(), src, new FakeStore());

    expect(src.mutations).toEqual([]);
    expect(src.objects).toEqual(before);
  });

  it("changes nothing the second time, and creates no bucket that exists", async () => {
    const src = seeded();
    const dst = new FakeStore();
    await copy(config(), src, dst);
    dst.mutations.length = 0;

    const again = await copy(config(), src, dst);

    expect(again).toMatchObject({ source: 3, copied: 0, unchanged: 3, failed: [] });
    expect(dst.mutations).toEqual([]);
  });

  it("rewrites an object the destination holds differently, and one with another content type", async () => {
    const src = seeded();
    const dst = copyOfSource(src);
    dst.objects.set(KEY_A, obj("a half-written picture"));
    dst.objects.set(KEY_B, obj("voice note", "application/octet-stream"));
    dst.mutations.length = 0;

    const result = await copy(config(), src, dst);

    expect(result).toMatchObject({ copied: 2, unchanged: 1, failed: [] });
    expect(dst.mutations.sort()).toEqual([`write:${KEY_A}`, `write:${KEY_B}`].sort());
    expect(dst.objects.get(KEY_A)).toEqual(src.objects.get(KEY_A));
    expect(dst.objects.get(KEY_B)?.type).toBe("audio/ogg");
  });

  it("never removes from the destination: what the source lacks stays", async () => {
    const src = seeded();
    const dst = copyOfSource(src);
    dst.objects.set(`${PREFIX}written-after.jpg`, obj("new"));
    dst.mutations.length = 0;

    await copy(config(), src, dst);

    expect(dst.mutations.filter((one) => one.startsWith("remove"))).toEqual([]);
    expect(dst.objects.has(`${PREFIX}written-after.jpg`)).toBe(true);
  });

  it("copies nothing outside the prefix, not a sibling tenant's, even from a store that ignores it", async () => {
    const src = seeded();
    src.ignorePrefix = true;
    const dst = new FakeStore();

    await copy(config(), src, dst);

    expect([...dst.objects.keys()].every((key) => key.startsWith(PREFIX))).toBe(true);
    expect(dst.objects.size).toBe(3);
  });

  it("counts an object that does not read back identical as failed, and goes on", async () => {
    const src = seeded();
    const dst = new FakeStore();
    dst.corrupt.add(KEY_B);

    const result = await copy(config(), src, dst);

    expect(result).toMatchObject({ source: 3, copied: 2, unchanged: 0, failed: [KEY_B] });
    expect(result.firstError).toBeNull();
  });

  it("counts an object it could not read as failed, names the error without its message, and goes on", async () => {
    const src = seeded();
    src.fail.set(
      `read:${KEY_A}`,
      Object.assign(new Error(`cannot read ${KEY_A}`), { code: "EIO" }),
    );

    const result = await copy(config(), src, new FakeStore());

    expect(result).toMatchObject({ copied: 2, failed: [KEY_A], firstError: "Error (EIO)" });
  });

  it("keeps the first error when several keys fail", async () => {
    const src = seeded();
    src.fail.set(`read:${KEY_A}`, Object.assign(new Error("a"), { code: "FIRST" }));
    src.fail.set(`read:${KEY_B}`, Object.assign(new Error("b"), { code: "SECOND" }));

    const result = await copy(config(), src, new FakeStore());

    expect(result.firstError).toBe("Error (FIRST)");
    expect(result.failed).toHaveLength(2);
  });

  it("stops before touching the destination when the source bucket does not exist", async () => {
    const dst = new FakeStore();

    await expect(copy(config(), new FakeStore(), dst)).rejects.toThrow(
      new SideError("source: the bucket does not exist"),
    );
    expect(dst.mutations).toEqual([]);
  });

  it("streams: one object is read at a time, and a write gets a stream, never a buffer", async () => {
    const src = seeded();
    const dst = new FakeStore();

    await copy(config(), src, dst);

    expect(src.maxOpenReads).toBe(1);
    expect(dst.maxOpenReads).toBe(1);
    expect(dst.streamedWrites).toBe(3);
  });
});

describe("removeSource", () => {
  it("removes from the source exactly the objects it verified, and writes nothing to the destination", async () => {
    const src = seeded();
    const dst = copyOfSource(src);
    dst.objects.set(`${PREFIX}written-after.jpg`, obj("new"));
    const result = await removeSource(config(), src, dst);

    expect(result).toMatchObject({ removed: 3, failed: [] });
    expect(src.mutations.sort()).toEqual(
      [KEY_A, KEY_B, KEY_C].map((key) => `remove:${key}`).sort(),
    );
    expect([...src.objects.keys()].sort()).toEqual(["t/default/mine.jpg", "t/empresa-2/other.jpg"]);
    expect(dst.mutations).toEqual([]);
  });

  it("removes nothing outside the prefix, even from a store that lists everything", async () => {
    const src = seeded();
    const dst = copyOfSource(src);
    src.ignorePrefix = true;

    await removeSource(config(), src, dst);

    expect(src.mutations.every((one) => one.startsWith(`remove:${PREFIX}`))).toBe(true);
    expect(src.objects.has("t/default/mine.jpg")).toBe(true);
    expect(src.objects.has("t/empresa-2/other.jpg")).toBe(true);
  });

  it.each([
    ["an object missing", (dst: FakeStore) => dst.objects.delete(KEY_B)],
    [
      "an object with other bytes",
      (dst: FakeStore) => dst.objects.set(KEY_B, obj("voice  note", "audio/ogg")),
    ],
    [
      "an object with another content type",
      (dst: FakeStore) => dst.objects.set(KEY_B, obj("voice note", "audio/mpeg")),
    ],
    ["no bucket at all", (dst: FakeStore) => dst.buckets.clear()],
  ])("removes nothing at all when the destination has %s", async (_what, damage) => {
    const src = seeded();
    const dst = copyOfSource(src);
    damage(dst);

    const result = await removeSource(config(), src, dst);

    expect(result).toMatchObject({ removed: 0, failed: [] });
    expect(result.verdict.ok).toBe(false);
    expect(src.mutations).toEqual([]);
    expect(src.objects.size).toBe(5);
  });

  it("reports a removal that failed and still removes the others", async () => {
    const src = seeded();
    const dst = copyOfSource(src);
    src.fail.set(`remove:${KEY_B}`, new Error("denied"));

    const result = await removeSource(config(), src, dst);

    expect(result).toMatchObject({ removed: 2, failed: [KEY_B] });
    expect(src.objects.has(KEY_B)).toBe(true);
  });
});

describe("runCli", () => {
  const env = (extra: Record<string, string | undefined> = {}) => ({
    STORE_COPY_SRC_ENDPOINT: "old-store",
    STORE_COPY_SRC_ACCESS_KEY: "src-ak-SECRET",
    STORE_COPY_SRC_SECRET_KEY: "src-sk-SECRET",
    STORE_COPY_DST_ENDPOINT: "new-store",
    STORE_COPY_DST_ACCESS_KEY: "dst-ak-SECRET",
    STORE_COPY_DST_SECRET_KEY: "dst-sk-SECRET",
    STORE_COPY_PREFIX: PREFIX,
    ...extra,
  });

  /** Runs the command line against two fake stores and returns what it said. */
  async function cli(argv: string[], src: FakeStore, dst: FakeStore, extra = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { out: (line) => out.push(line), err: (line) => err.push(line) };
    const reached: [string, string][] = [];
    const code = await runCli(argv, env(extra), io, (endpoint, label) => {
      reached.push([label, endpoint.host]);
      return label === "source" ? src : dst;
    });
    return { code, out, err, reached, all: [...out, ...err].join("\n") };
  }

  it("copy: reports counts, exits 0, and reaches each side by its label", async () => {
    const run = await cli(["copy"], seeded(), new FakeStore());

    expect(run).toMatchObject({
      code: 0,
      out: ["source 3, copied 3, unchanged 0, failed 0"],
      err: [],
      reached: [
        ["source", "old-store"],
        ["destination", "new-store"],
      ],
    });
  });

  it("copy: exits 1 and names the first error when an object failed", async () => {
    const src = seeded();
    src.fail.set(`read:${KEY_A}`, Object.assign(new Error(KEY_A), { code: "EIO" }));

    const run = await cli(["copy"], src, new FakeStore());

    expect(run.code).toBe(1);
    expect(run.out).toEqual(["source 3, copied 2, unchanged 0, failed 1"]);
    expect(run.err).toEqual(["first error: Error (EIO)"]);
  });

  it("verify: reports counts, exits 0 when identical and 1 when not", async () => {
    const src = seeded();
    const dst = copyOfSource(src);

    const ok = await cli(["verify"], src, dst);
    dst.objects.delete(KEY_A);
    const bad = await cli(["verify"], src, dst);

    expect(ok).toMatchObject({
      code: 0,
      out: ["source 3, destination 3, identical 3, missing 0, different 0, extra 0"],
    });
    expect(bad).toMatchObject({
      code: 1,
      out: ["source 3, destination 2, identical 2, missing 1, different 0, extra 0"],
    });
    expect([src.mutations, dst.mutations]).toEqual([[], []]);
  });

  it("remove-source: with the confirmed prefix, removes what verified and exits 0", async () => {
    const src = seeded();
    const dst = copyOfSource(src);

    const run = await cli(["remove-source", "--confirm", PREFIX], src, dst);

    expect(run).toMatchObject({
      code: 0,
      out: [
        "source 3, destination 3, identical 3, missing 0, different 0, extra 0",
        "removed 3, failed 0",
      ],
      err: [],
    });
    expect(src.objects.size).toBe(2);
  });

  it("remove-source: exits 1 and removes nothing when the destination does not match", async () => {
    const src = seeded();
    const dst = copyOfSource(src);
    dst.objects.delete(KEY_C);

    const run = await cli(["remove-source", "--confirm", PREFIX], src, dst);

    expect(run.code).toBe(1);
    expect(run.out).toEqual([
      "source 3, destination 2, identical 2, missing 1, different 0, extra 0",
    ]);
    expect(run.err[0]).toMatch(/^nothing removed/);
    expect(src.mutations).toEqual([]);
  });

  it("remove-source: exits 1 when a removal failed", async () => {
    const src = seeded();
    src.fail.set(`remove:${KEY_A}`, new Error("denied"));

    const run = await cli(["remove-source", "--confirm", PREFIX], src, copyOfSource(src));

    expect(run.code).toBe(1);
    expect(run.out[run.out.length - 1]).toBe("removed 2, failed 1");
  });

  it.each([
    ["no command", []],
    ["an unknown command", ["sync"]],
    ["an unknown flag", ["copy", "--force"]],
    ["a stray argument", ["verify", "extra"]],
    ["--confirm for a command that does not take it", ["copy", "--confirm", PREFIX]],
    ["--confirm without a value", ["remove-source", "--confirm"]],
  ])("exits 2 with the usage line for %s, and reaches no store", async (_what, argv) => {
    const run = await cli(argv, seeded(), new FakeStore());

    expect(run).toMatchObject({ code: 2, out: [], reached: [] });
    expect(run.err).toEqual([
      "error: usage: store-copy-cli (copy | verify | remove-source --confirm <prefix>) [--show-keys]",
    ]);
  });

  it.each([
    ["no --confirm", ["remove-source"]],
    ["another prefix", ["remove-source", "--confirm", "t/empresa-2/"]],
  ])("remove-source with %s exits 2 before it reaches a store", async (_what, argv) => {
    const src = seeded();

    const run = await cli(argv, src, copyOfSource(src));

    expect(run).toMatchObject({ code: 2, out: [], reached: [] });
    expect(run.err).toEqual([
      "error: remove-source needs --confirm with the same prefix as STORE_COPY_PREFIX",
    ]);
    expect(src.mutations).toEqual([]);
  });

  it("exits 2 on a bad environment, and reaches no store", async () => {
    const run = await cli(["copy"], seeded(), new FakeStore(), { STORE_COPY_PREFIX: "t/" });

    expect(run).toMatchObject({ code: 2, reached: [] });
    expect(run.err[0]).toMatch(/^error: STORE_COPY_PREFIX must be one tenant's prefix/);
  });

  it("exits 1 when a store fails, naming the error by class and code only", async () => {
    const src = seeded();
    const failing = new FakeStore();
    failing.bucketExists = async () => {
      throw Object.assign(new Error(`bad pair ${SECRETS.join(" ")}`), {
        code: "InvalidAccessKeyId",
      });
    };

    const run = await cli(["copy"], src, failing);

    expect(run.code).toBe(1);
    expect(run.err).toEqual(["error: Error (InvalidAccessKeyId)"]);
  });

  it("exits 1 for a SideError, and prints its (already safe) message", async () => {
    const run = await cli(["copy"], new FakeStore(), new FakeStore());

    expect(run).toMatchObject({ code: 1, err: ["error: source: the bucket does not exist"] });
  });

  it("prints no key without --show-keys, and the keys that need attention with it", async () => {
    const src = seeded();
    const dst = copyOfSource(src);
    dst.objects.delete(KEY_A);
    dst.objects.set(KEY_B, obj("different"));

    const quiet = await cli(["verify"], src, dst);
    const loud = await cli(["verify", "--show-keys"], src, dst);

    expect(quiet.all).not.toMatch(/MSG|whatsapp|5500|uploads/);
    expect(loud.out).toEqual([
      "source 3, destination 2, identical 1, missing 1, different 1, extra 0",
      `missing: ${KEY_A}`,
      `different: ${KEY_B}`,
    ]);
  });

  it("prints a failed key with --show-keys for copy and remove-source, and not without it", async () => {
    const src = seeded();
    src.fail.set(`read:${KEY_A}`, new Error("x"));
    const copying = await cli(["copy", "--show-keys"], src, new FakeStore());
    const silent = await cli(["copy"], src, new FakeStore());
    const plain = seeded();
    plain.fail.set(`remove:${KEY_B}`, new Error("x"));
    const removing = await cli(
      ["remove-source", "--show-keys", "--confirm", PREFIX],
      plain,
      copyOfSource(plain),
    );

    expect(copying.out).toContain(`failed: ${KEY_A}`);
    expect(silent.all).not.toContain(KEY_A);
    expect(removing.out).toContain(`failed: ${KEY_B}`);
  });

  it("never prints a credential or a key, in any outcome, without --show-keys", async () => {
    const failing = seeded();
    failing.fail.set(
      `read:${KEY_A}`,
      Object.assign(new Error(`${SECRETS.join(" ")} ${KEY_A}`), { code: "EIO" }),
    );
    const runs = [
      await cli(["copy"], seeded(), new FakeStore()),
      await cli(["copy"], failing, new FakeStore()),
      await cli(["verify"], seeded(), new FakeStore()),
      await cli(["remove-source", "--confirm", PREFIX], seeded(), new FakeStore()),
      await cli(["copy"], seeded(), new FakeStore(), { STORE_COPY_PREFIX: SECRETS[0] }),
    ];

    for (const run of runs) {
      expect(run.all).not.toMatch(/SECRET|MSG|whatsapp|5500|uploads/);
    }
  });

  it("exits 1 for a failure that is not the tool's own, naming it by class and code only", async () => {
    const io: Io = { out: () => {}, err: () => {} };
    const lines: string[] = [];
    const code = await runCli(["copy"], env(), { ...io, err: (line) => lines.push(line) }, () => {
      throw Object.assign(new TypeError(`secret ${SECRETS[0]}`), { code: "EBROKEN" });
    });

    expect([code, lines]).toEqual([1, ["error: TypeError (EBROKEN)"]]);
  });
});
