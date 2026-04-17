import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as Minio from "minio";

// Contract test pinning the minio npm API surface consumed by src/storage.ts.
// Requires Docker — skipped unless RUN_INTEGRATION_TESTS=1.
//
// Run: RUN_INTEGRATION_TESTS=1 pnpm test src/__tests__/storage.contract.test.ts

const runIntegration = process.env.RUN_INTEGRATION_TESTS === "1";

describe.skipIf(!runIntegration)("minio client contract (testcontainers)", () => {
  let container: any;
  let client: Minio.Client;
  const TEST_BUCKET = "contract-test-bucket";

  beforeAll(async () => {
    const { MinioContainer } = await import("@testcontainers/minio");
    container = await new MinioContainer("minio/minio:latest").start();

    client = new Minio.Client({
      endPoint: container.getHost(),
      port: container.getMappedPort(9000),
      useSSL: false,
      accessKey: container.getUsername(),
      secretKey: container.getPassword(),
    });
  }, 120_000);

  afterAll(async () => {
    if (container) await container.stop();
  });

  it("new Minio.Client(...) constructs without error", () => {
    expect(client).toBeDefined();
  });

  it("makeBucket creates a bucket and bucketExists returns true", async () => {
    await client.makeBucket(TEST_BUCKET, "us-east-1");
    const exists = await client.bucketExists(TEST_BUCKET);
    expect(exists).toBe(true);
  });

  it("putObject stores an object retrievable via statObject", async () => {
    const buf = Buffer.from("hello-contract");
    const key = "t/default/jid/test.txt";
    await client.putObject(TEST_BUCKET, key, buf, buf.length, { "Content-Type": "text/plain" });
    const stat = await client.statObject(TEST_BUCKET, key);
    expect(stat.size).toBe(buf.length);
  });

  it("setBucketPolicy sets public-read policy without error", async () => {
    const policy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: "*",
          Action: "s3:GetObject",
          Resource: `arn:aws:s3:::${TEST_BUCKET}/*`,
        },
      ],
    });
    await expect(client.setBucketPolicy(TEST_BUCKET, policy)).resolves.not.toThrow();
  });
}, 120_000);
