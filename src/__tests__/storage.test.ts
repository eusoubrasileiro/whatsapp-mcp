import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  putMedia,
  publicUrlFor,
  ensureBucketReady,
  setStorageClient,
  resetStorageClient,
  type MediaStorageClient,
} from "../storage.ts";

function makeMockClient(overrides: {
  putObject?: ReturnType<typeof vi.fn>;
  bucketExists?: ReturnType<typeof vi.fn>;
  makeBucket?: ReturnType<typeof vi.fn>;
  setBucketPolicy?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    putObject: overrides.putObject ?? vi.fn().mockResolvedValue({}),
    bucketExists: overrides.bucketExists ?? vi.fn().mockResolvedValue(false),
    makeBucket: overrides.makeBucket ?? vi.fn().mockResolvedValue(undefined),
    setBucketPolicy: overrides.setBucketPolicy ?? vi.fn().mockResolvedValue(undefined),
  };
}

const savedEnv: Record<string, string | undefined> = {};
const envKeys = [
  "S3_BUCKET", "S3_REGION", "S3_SKIP_POLICY",
  "S3_ENDPOINT", "S3_PORT",
  "MEDIA_PUBLIC_BASE_URL", "TENANT_ID",
];

describe("storage", () => {
  beforeEach(() => {
    for (const k of envKeys) savedEnv[k] = process.env[k];
    process.env.S3_BUCKET = "test-bucket";
    process.env.S3_REGION = "us-east-1";
    process.env.S3_SKIP_POLICY = "false";
    process.env.MEDIA_PUBLIC_BASE_URL = "http://localhost:9000/test-bucket";
    process.env.TENANT_ID = "default";
    process.env.S3_ENDPOINT = "localhost";
    process.env.S3_PORT = "9000";
  });

  afterEach(() => {
    resetStorageClient();
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  // ── putMedia ───────────────────────────────────────────────────────

  describe("putMedia", () => {
    it("computes key as t/{tenantId}/{sanitizedJid}/{msgId}.{ext}", async () => {
      const mock = makeMockClient();
      setStorageClient(mock as MediaStorageClient);

      const { key } = await putMedia({
        chatJid: "5511999999999@s.whatsapp.net",
        messageId: "msg123",
        ext: "jpg",
        mimetype: "image/jpeg",
        buffer: Buffer.from("fake"),
      });

      expect(key).toBe("t/default/5511999999999@s.whatsapp.net/msg123.jpg");
    });

    it("sanitizes special characters in JID", async () => {
      const mock = makeMockClient();
      setStorageClient(mock as MediaStorageClient);

      const { key } = await putMedia({
        chatJid: "group+abc!@g.us",
        messageId: "msg999",
        ext: "mp4",
        mimetype: "video/mp4",
        buffer: Buffer.from("fake"),
      });

      expect(key).toBe("t/default/group_abc_@g.us/msg999.mp4");
    });

    it("calls putObject with correct bucket, key, buffer, size, and content-type", async () => {
      const mock = makeMockClient();
      setStorageClient(mock as MediaStorageClient);

      const buffer = Buffer.from("hello");
      await putMedia({
        chatJid: "123@s.whatsapp.net",
        messageId: "abc",
        ext: "jpg",
        mimetype: "image/jpeg",
        buffer,
      });

      expect(mock.putObject).toHaveBeenCalledWith(
        "test-bucket",
        "t/default/123@s.whatsapp.net/abc.jpg",
        buffer,
        5,
        { "Content-Type": "image/jpeg" },
      );
    });

    it("uses tenantId from params when provided", async () => {
      const mock = makeMockClient();
      setStorageClient(mock as MediaStorageClient);

      const { key } = await putMedia({
        tenantId: "acme",
        chatJid: "123@s.whatsapp.net",
        messageId: "abc",
        ext: "pdf",
        mimetype: "application/pdf",
        buffer: Buffer.from("doc"),
      });

      expect(key).toMatch(/^t\/acme\//);
    });

    it("returns url via publicUrlFor", async () => {
      const mock = makeMockClient();
      setStorageClient(mock as MediaStorageClient);

      const { url } = await putMedia({
        chatJid: "123@s.whatsapp.net",
        messageId: "abc",
        ext: "jpg",
        mimetype: "image/jpeg",
        buffer: Buffer.from("x"),
      });

      expect(url).toBe(
        "http://localhost:9000/test-bucket/t/default/123@s.whatsapp.net/abc.jpg",
      );
    });
  });

  // ── publicUrlFor ───────────────────────────────────────────────────

  describe("publicUrlFor", () => {
    it("prefixes key with MEDIA_PUBLIC_BASE_URL", () => {
      process.env.MEDIA_PUBLIC_BASE_URL = "https://media.example.com";
      expect(publicUrlFor("t/default/jid/msg.jpg")).toBe(
        "https://media.example.com/t/default/jid/msg.jpg",
      );
    });

    it("strips trailing slash from base URL", () => {
      process.env.MEDIA_PUBLIC_BASE_URL = "https://media.example.com/";
      expect(publicUrlFor("t/default/jid/msg.jpg")).toBe(
        "https://media.example.com/t/default/jid/msg.jpg",
      );
    });

    it("is independent of S3_ENDPOINT", () => {
      process.env.S3_ENDPOINT = "internal.minio:9000";
      process.env.MEDIA_PUBLIC_BASE_URL = "https://media.amiticia.cc";
      expect(publicUrlFor("some/key.jpg")).toBe(
        "https://media.amiticia.cc/some/key.jpg",
      );
    });
  });

  // ── getBucket default (S3_BUCKET unset) ───────────────────────────

  describe("getBucket default", () => {
    it("uses 'amiticia-media' as default bucket name when S3_BUCKET is unset", async () => {
      delete process.env.S3_BUCKET;
      // Verify via publicUrlFor — it embeds the bucket in the URL default
      delete process.env.MEDIA_PUBLIC_BASE_URL;
      const url = publicUrlFor("t/default/jid/msg.jpg");
      expect(url).toBe("http://localhost:9000/amiticia-media/t/default/jid/msg.jpg");
    });

    it("uses S3_BUCKET env var over the default", async () => {
      process.env.S3_BUCKET = "custom-bucket";
      delete process.env.MEDIA_PUBLIC_BASE_URL;
      const url = publicUrlFor("t/default/jid/msg.jpg");
      expect(url).toBe("http://localhost:9000/custom-bucket/t/default/jid/msg.jpg");
    });
  });

  // ── parseBoolEnv edge cases (exercised via ensureBucketReady / getClient) ─

  describe("parseBoolEnv edge cases", () => {
    it("treats 'TRUE' (uppercase) as true (case-insensitive)", async () => {
      process.env.S3_SKIP_POLICY = "TRUE";
      const mock = makeMockClient();
      setStorageClient(mock as MediaStorageClient);

      await ensureBucketReady();

      expect(mock.setBucketPolicy).not.toHaveBeenCalled();
    });

    it("treats 'True' (mixed case) as true", async () => {
      process.env.S3_SKIP_POLICY = "True";
      const mock = makeMockClient();
      setStorageClient(mock as MediaStorageClient);

      await ensureBucketReady();

      expect(mock.setBucketPolicy).not.toHaveBeenCalled();
    });

    it("treats any value other than 'true' (case variants) as false", async () => {
      process.env.S3_SKIP_POLICY = "yes";
      const mock = makeMockClient();
      setStorageClient(mock as MediaStorageClient);

      await ensureBucketReady();

      // "yes" is not "true" — policy should be applied
      expect(mock.setBucketPolicy).toHaveBeenCalledOnce();
    });

    it("uses default false when S3_SKIP_POLICY is unset", async () => {
      delete process.env.S3_SKIP_POLICY;
      const mock = makeMockClient();
      setStorageClient(mock as MediaStorageClient);

      await ensureBucketReady();

      // defaultValue is false → policy applied
      expect(mock.setBucketPolicy).toHaveBeenCalledOnce();
    });
  });

  // ── ensureBucketReady ──────────────────────────────────────────────

  describe("ensureBucketReady", () => {
    it("creates bucket when it does not exist", async () => {
      const mock = makeMockClient({ bucketExists: vi.fn().mockResolvedValue(false) });
      setStorageClient(mock as MediaStorageClient);

      await ensureBucketReady();

      expect(mock.makeBucket).toHaveBeenCalledWith("test-bucket", "us-east-1");
    });

    it("does not create bucket when it already exists", async () => {
      const mock = makeMockClient({ bucketExists: vi.fn().mockResolvedValue(true) });
      setStorageClient(mock as MediaStorageClient);

      await ensureBucketReady();

      expect(mock.makeBucket).not.toHaveBeenCalled();
    });

    it("applies public-read policy when S3_SKIP_POLICY=false", async () => {
      process.env.S3_SKIP_POLICY = "false";
      const mock = makeMockClient();
      setStorageClient(mock as MediaStorageClient);

      await ensureBucketReady();

      expect(mock.setBucketPolicy).toHaveBeenCalledOnce();
      const policyStr = mock.setBucketPolicy.mock.calls[0][1] as string;
      const policy = JSON.parse(policyStr);
      expect(policy.Statement[0].Effect).toBe("Allow");
      expect(policy.Statement[0].Principal).toBe("*");
      expect(policy.Statement[0].Action).toBe("s3:GetObject");
      expect(policy.Statement[0].Resource).toContain("test-bucket");
    });

    it("skips policy when S3_SKIP_POLICY=true", async () => {
      process.env.S3_SKIP_POLICY = "true";
      const mock = makeMockClient();
      setStorageClient(mock as MediaStorageClient);

      await ensureBucketReady();

      expect(mock.setBucketPolicy).not.toHaveBeenCalled();
    });
  });
});
