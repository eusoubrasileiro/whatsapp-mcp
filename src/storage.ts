import * as Minio from "minio";
import { randomUUID } from "node:crypto";

export interface MediaStorageClient {
  putObject(bucket: string, key: string, data: Buffer, size?: number, metadata?: Record<string, string>): Promise<unknown>;
  bucketExists(bucket: string): Promise<boolean>;
  makeBucket(bucket: string, region?: string): Promise<void>;
  setBucketPolicy(bucket: string, policy: string): Promise<void>;
  getObject(bucket: string, key: string): Promise<NodeJS.ReadableStream>;
}

/** Returns true when the env var is set to the string "true" (case-insensitive). */
function parseBoolEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === "true";
}

let _client: MediaStorageClient | null = null;

export function setStorageClient(client: MediaStorageClient): void {
  _client = client;
}

export function resetStorageClient(): void {
  _client = null;
}

function getBucket(): string {
  return process.env.S3_BUCKET ?? "amiticia-media";
}

function getClient(): MediaStorageClient {
  if (_client) return _client;
  _client = new Minio.Client({
    endPoint: process.env.S3_ENDPOINT ?? "localhost",
    port: Number(process.env.S3_PORT ?? 9000),
    useSSL: parseBoolEnv(process.env.S3_USE_SSL, false),
    accessKey: process.env.S3_ACCESS_KEY ?? "minioadmin",
    secretKey: process.env.S3_SECRET_KEY ?? "minioadmin",
  });
  return _client;
}

export function publicUrlFor(key: string): string {
  const bucket = getBucket();
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
  const bucket = getBucket();
  const sanitizedJid = chatJid.replace(/[^a-zA-Z0-9@._-]/g, "_");
  const key = `t/${tenantId}/${sanitizedJid}/${messageId}.${ext}`;

  await getClient().putObject(bucket, key, buffer, buffer.length, { "Content-Type": mimetype });

  return { key, url: publicUrlFor(key) };
}

/**
 * Stores agent-supplied bytes under `t/{tenantId}/uploads/{uuid}.{ext}` so they
 * can be referenced by `send_file` as a public URL. Used by the upload HTTP
 * endpoint to bridge the host-disk → remote-MCP gap: the MCP container can't
 * read the agent's filesystem, and base64 data URLs blow up the context window
 * for any non-tiny file.
 */
export async function putUpload(params: {
  tenantId?: string;
  buffer: Buffer;
  mimetype: string;
  ext: string;
}): Promise<{ key: string; url: string }> {
  const { buffer, mimetype, ext } = params;
  const tenantId = params.tenantId ?? (process.env.TENANT_ID ?? "default");
  const bucket = getBucket();
  const key = `t/${tenantId}/uploads/${randomUUID()}.${ext}`;

  await getClient().putObject(bucket, key, buffer, buffer.length, { "Content-Type": mimetype });

  return { key, url: publicUrlFor(key) };
}

/**
 * Fetch raw bytes for an existing media object. Used by transcribe/describe
 * paths that need to feed the bytes to an external API; we already uploaded
 * the file when first downloading from WhatsApp.
 */
export async function getMediaBytes(key: string): Promise<Buffer> {
  const bucket = getBucket();
  const stream = await getClient().getObject(bucket, key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export async function ensureBucketReady(): Promise<void> {
  const client = getClient();
  const bucket = getBucket();
  const region = process.env.S3_REGION ?? "us-east-1";
  const skipPolicy = parseBoolEnv(process.env.S3_SKIP_POLICY, false);

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
