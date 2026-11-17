import { randomBytes } from "node:crypto";
import type { Client } from "minio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bucketEnv, DEV_S3_URL, devS3, dropBucket, uniqueBucket } from "./support/s3.ts";
import { type E2eServer, startServer } from "./support/server.ts";

/**
 * Regression for removing the `minio-init` job (`rc anonymous set download`): that policy let
 * anyone LIST the media bucket, and a RustFS that kept it would carry it forever. The app now
 * owns the bucket policy, and it must overwrite a permissive one at every start, so objects
 * are readable one by one but the bucket cannot be enumerated.
 *
 * Runs against the real dev RustFS (`pnpm test:e2e:deps`), in a bucket of its own.
 */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const bucket = uniqueBucket("policy-e2e");
const listing = () => fetch(`${DEV_S3_URL}/${bucket}/?list-type=2`);

let s3: Client;
let server: E2eServer | undefined;

beforeAll(async () => {
  s3 = devS3();
  await s3.makeBucket(bucket, "us-east-1");
  // What `rc anonymous set download` grants: read every object AND list the bucket.
  await s3.setBucketPolicy(
    bucket,
    JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: "*",
          Action: ["s3:ListBucket", "s3:GetObject"],
          Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`],
        },
      ],
    }),
  );
});

afterAll(async () => {
  await server?.stop();
  await dropBucket(s3, bucket);
});

describe("the bucket policy the app sets at start", () => {
  it("starts from a bucket that anyone can list", async () => {
    expect((await listing()).status).toBe(200);
  });

  it("replaces it with one that forbids listing but still serves each object", async () => {
    server = await startServer({ s3: true, env: bucketEnv(bucket) });

    expect((await listing()).status).toBe(403);

    const bytes = Buffer.concat([PNG_MAGIC, randomBytes(512)]);
    const uploaded = await fetch(`${server.uploadUrl}/upload`, {
      method: "POST",
      body: bytes,
      headers: { authorization: `Bearer ${server.token}` },
    });
    const { url } = await uploaded.json();
    expect(uploaded.status).toBe(200);
    expect(url).toContain(`/${bucket}/t/`);

    const object = await fetch(url);
    expect(object.status).toBe(200);
    expect(Buffer.from(await object.arrayBuffer()).equals(bytes)).toBe(true);
    expect((await listing()).status).toBe(403);
  });
});
