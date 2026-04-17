import * as Minio from "minio";

export interface MediaStorageClient {
  putObject(bucket: string, key: string, data: Buffer, size?: number, metadata?: Record<string, string>): Promise<unknown>;
  bucketExists(bucket: string): Promise<boolean>;
  makeBucket(bucket: string, region?: string): Promise<void>;
  setBucketPolicy(bucket: string, policy: string): Promise<void>;
}

let _client: MediaStorageClient | null = null;

export function setStorageClient(client: MediaStorageClient): void {
  _client = client;
}

export function resetStorageClient(): void {
  _client = null;
}

function getClient(): MediaStorageClient {
  if (_client) return _client;
  _client = new Minio.Client({
    endPoint: process.env.S3_ENDPOINT ?? "localhost",
    port: Number(process.env.S3_PORT ?? 9000),
    useSSL: (process.env.S3_USE_SSL ?? "false").toLowerCase() === "true",
    accessKey: process.env.S3_ACCESS_KEY ?? "minioadmin",
    secretKey: process.env.S3_SECRET_KEY ?? "minioadmin",
  });
  return _client;
}

export function publicUrlFor(key: string): string {
  const bucket = process.env.S3_BUCKET ?? "amiticia-media";
  const base = (process.env.MEDIA_PUBLIC_BASE_URL ?? `http://localhost:9000/${bucket}`).replace(/\/$/, "");
  return `${base}/${key}`;
}

export async function putMedia(params: {
  tenantId?: string;
  chatJid: string;
  messageId: string;
  ext: string;
  mimetype: string;
  buffer: Buffer;
}): Promise<{ key: string; url: string }> {
  const { chatJid, messageId, ext, mimetype, buffer } = params;
  const tenantId = params.tenantId ?? (process.env.TENANT_ID ?? "default");
  const bucket = process.env.S3_BUCKET ?? "amiticia-media";
  const sanitizedJid = chatJid.replace(/[^a-zA-Z0-9@._-]/g, "_");
  const key = `t/${tenantId}/${sanitizedJid}/${messageId}.${ext}`;

  await getClient().putObject(bucket, key, buffer, buffer.length, { "Content-Type": mimetype });

  return { key, url: publicUrlFor(key) };
}

export async function ensureBucketReady(): Promise<void> {
  const client = getClient();
  const bucket = process.env.S3_BUCKET ?? "amiticia-media";
  const region = process.env.S3_REGION ?? "us-east-1";
  const skipPolicy = (process.env.S3_SKIP_POLICY ?? "false").toLowerCase() === "true";

  const exists = await client.bucketExists(bucket);
  if (!exists) {
    await client.makeBucket(bucket, region);
  }

  if (!skipPolicy) {
    const policy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: "*",
          Action: "s3:GetObject",
          Resource: `arn:aws:s3:::${bucket}/*`,
        },
      ],
    });
    await client.setBucketPolicy(bucket, policy);
  }
}
