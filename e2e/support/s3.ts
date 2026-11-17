/**
 * The dev RustFS (docker-compose.dev.yaml, service `minio`, `pnpm test:e2e:deps`) as a spec sees
 * it. Specs that write objects use a bucket of their own, so they never race the other specs
 * (the upload spec shares `amiticia-media`) and leave nothing behind.
 */
import { randomBytes } from "node:crypto";
import * as Minio from "minio";

export const DEV_S3_URL = "http://127.0.0.1:9000";

/** Env for `startServer({ env })` that points the server at `bucket` instead of the default. */
export function bucketEnv(bucket: string): Record<string, string> {
  return { S3_BUCKET: bucket, MEDIA_PUBLIC_BASE_URL: `http://localhost:9000/${bucket}` };
}

export const uniqueBucket = (prefix: string) => `${prefix}-${randomBytes(4).toString("hex")}`;

export function devS3(): Minio.Client {
  return new Minio.Client({
    endPoint: "127.0.0.1",
    port: 9000,
    useSSL: false,
    accessKey: "minioadmin",
    secretKey: "minioadmin",
  });
}

/** Empties and removes a bucket; a bucket that was never created is not an error. */
export async function dropBucket(client: Minio.Client, bucket: string): Promise<void> {
  if (!(await client.bucketExists(bucket))) return;
  const keys: string[] = [];
  for await (const object of client.listObjectsV2(bucket, "", true)) {
    if (object.name) keys.push(object.name);
  }
  if (keys.length > 0) await client.removeObjects(bucket, keys);
  await client.removeBucket(bucket);
}
