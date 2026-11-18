import { createServer } from "node:net";
import type { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { connectMinio, minioClient, type S3Client, SideError, s3Side } from "../store-copy.ts";

const SECRET = "ak-SECRET-value";

/** A minio client that records how it is called and answers from a script. */
function fakeClient(overrides: Partial<S3Client> = {}) {
  const calls: unknown[][] = [];
  const note =
    <T>(name: string, answer: T) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return answer;
    };
  const client: S3Client = {
    bucketExists: note("bucketExists", true),
    makeBucket: note("makeBucket", undefined),
    listObjectsV2: (...args) => {
      calls.push(["listObjectsV2", ...args]);
      return (async function* () {
        yield { name: "t/a/1.jpg" };
        yield { prefix: "t/a/sub/" };
        yield { name: "t/a/2.jpg" };
      })();
    },
    statObject: note("statObject", { size: 7, metaData: { "content-type": "image/png" } }),
    getObject: async (...args) => {
      calls.push(["getObject", ...args]);
      return (async function* () {
        yield Buffer.from("ab");
        yield Buffer.from("cde");
      })();
    },
    putObject: note("putObject", {}),
    removeObject: note("removeObject", undefined),
    ...overrides,
  };
  return { client, calls };
}

const broken = (code: string) => async () => {
  throw Object.assign(new Error(`${SECRET} t/a/1.jpg`), { code });
};

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const found: T[] = [];
  for await (const item of items) found.push(item);
  return found;
}

describe("s3Side: the tool's questions, put to a minio client", () => {
  it("asks whether a bucket exists, and creates one in the default region", async () => {
    const { client, calls } = fakeClient();
    const side = s3Side("source", client);

    expect(await side.bucketExists("media")).toBe(true);
    await side.makeBucket("media");

    expect(calls).toEqual([
      ["bucketExists", "media"],
      ["makeBucket", "media", "us-east-1"],
    ]);
  });

  it("lists every key under a prefix, recursively, and only keys", async () => {
    const { client, calls } = fakeClient();

    const keys = await collect(s3Side("source", client).list("media", "t/a/"));

    expect(keys).toEqual(["t/a/1.jpg", "t/a/2.jpg"]);
    expect(calls).toEqual([["listObjectsV2", "media", "t/a/", true]]);
  });

  it("takes the size and the content type from the object's stat", async () => {
    const { client, calls } = fakeClient();

    expect(await s3Side("source", client).stat("media", "t/a/1.jpg")).toEqual({
      size: 7,
      contentType: "image/png",
    });
    expect(calls).toEqual([["statObject", "media", "t/a/1.jpg"]]);
  });

  it.each([
    ["has none", {}],
    ["is not text", { "content-type": 5 }],
  ])("reads the content type as empty when the object %s", async (_what, metaData) => {
    const { client } = fakeClient({ statObject: async () => ({ size: 1, metaData }) });

    expect(await s3Side("source", client).stat("media", "k")).toEqual({
      size: 1,
      contentType: "",
    });
  });

  it("reads an object as the chunks the client gives", async () => {
    const { client, calls } = fakeClient();

    const chunks = await collect(s3Side("source", client).read("media", "t/a/1.jpg"));

    expect(Buffer.concat(chunks).toString()).toBe("abcde");
    expect(calls).toEqual([["getObject", "media", "t/a/1.jpg"]]);
  });

  it("writes a stream with its size and its content type", async () => {
    const written: { body: string; args: unknown[] }[] = [];
    const { client } = fakeClient({
      putObject: async (bucket, key, body: Readable, size, metaData) => {
        const chunks: Buffer[] = [];
        for await (const chunk of body) chunks.push(chunk);
        written.push({
          body: Buffer.concat(chunks).toString(),
          args: [bucket, key, size, metaData],
        });
      },
    });
    const body = (async function* () {
      yield Buffer.from("ab");
      yield Buffer.from("cde");
    })();

    await s3Side("destination", client).write("media", "t/a/1.jpg", body, 5, "image/png");

    expect(written).toEqual([
      { body: "abcde", args: ["media", "t/a/1.jpg", 5, { "Content-Type": "image/png" }] },
    ]);
  });

  it("removes an object", async () => {
    const { client, calls } = fakeClient();

    await s3Side("source", client).remove("media", "t/a/1.jpg");

    expect(calls).toEqual([["removeObject", "media", "t/a/1.jpg"]]);
  });
});

describe("s3Side: a failure says which side, by class and code, and nothing else", () => {
  const failing = (label: string) =>
    s3Side(
      label,
      fakeClient({
        bucketExists: broken("InvalidAccessKeyId"),
        makeBucket: broken("AccessDenied"),
        statObject: broken("NotFound"),
        putObject: broken("EntityTooLarge"),
        removeObject: broken("AccessDenied"),
        getObject: broken("NoSuchKey"),
        listObjectsV2: () => {
          throw Object.assign(new Error(`${SECRET} t/a/1.jpg`), { code: "NoSuchBucket" });
        },
      }).client,
    );
  const empty = (async function* () {})();

  it.each([
    [
      "bucketExists",
      (side: ReturnType<typeof failing>) => side.bucketExists("m"),
      "InvalidAccessKeyId",
    ],
    ["makeBucket", (side: ReturnType<typeof failing>) => side.makeBucket("m"), "AccessDenied"],
    ["stat", (side: ReturnType<typeof failing>) => side.stat("m", "k"), "NotFound"],
    [
      "write",
      (side: ReturnType<typeof failing>) => side.write("m", "k", empty, 0, "x"),
      "EntityTooLarge",
    ],
    ["remove", (side: ReturnType<typeof failing>) => side.remove("m", "k"), "AccessDenied"],
    ["read", (side: ReturnType<typeof failing>) => collect(side.read("m", "k")), "NoSuchKey"],
    ["list", (side: ReturnType<typeof failing>) => collect(side.list("m", "p")), "NoSuchBucket"],
  ])("%s", async (_name, call, code) => {
    const outcome = await call(failing("destination")).then(
      () => null,
      (err: unknown) => err,
    );

    expect(outcome).toBeInstanceOf(SideError);
    expect((outcome as SideError).message).toBe(`destination: Error (${code})`);
  });
});

describe("the real client", () => {
  it("is built for plain HTTP on the endpoint's host and port", () => {
    const client = minioClient({ host: "new-store", port: 9100, accessKey: "a", secretKey: "b" });

    expect(Reflect.get(client, "host")).toBe("new-store");
    expect(Reflect.get(client, "port")).toBe(9100);
    expect(Reflect.get(client, "protocol")).toBe("http:");
  });

  it("names the side in an error when the store cannot be reached", async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const side = connectMinio(
      { host: "127.0.0.1", port, accessKey: "a", secretKey: SECRET },
      "source",
    );

    await expect(side.bucketExists("media")).rejects.toThrow(/^source: Error \(ECONNREFUSED\)$/);
  });
});
