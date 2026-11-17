import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { Client } from "minio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderCompose } from "./support/compose.ts";
import { openSession } from "./support/mcp-client.ts";
import { bucketEnv, devS3, dropBucket, uniqueBucket } from "./support/s3.ts";
import { type E2eServer, startServer } from "./support/server.ts";

/**
 * Rehearsal of deploy day for the personal number: it moves from the single-instance layout to
 * an instance of docker-compose.instance.yaml, and its data must not move. A temp directory
 * stands in for /storage/whatsapp-mcp; real servers (never connected to WhatsApp) run on it
 * before and after, against the real dev RustFS (`pnpm test:e2e:deps`) in a bucket of its own.
 *
 * The migration's data step is "nothing moves": the new compose file mounts the old directory,
 * so what this proves is that a server in the new shape finds the old pairing, the old
 * database and the old media exactly as they were, and leaves them untouched.
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const INSTANCE_FILE = path.join(ROOT, "deploy", "docker-compose.instance.yaml");
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const bucket = uniqueBucket("rehearsal-e2e");
const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** Rendering exactly what the owner's env file for the personal number would say. */
const renderPessoal = (extra: Record<string, string> = {}) => {
  const cfg = renderCompose({
    file: INSTANCE_FILE,
    env: {
      INSTANCE: "pessoal",
      PUBLIC_DOMAIN: "wa.e2e.test",
      MCP_AUTH_TOKEN: "token-pessoal",
      MINIO_ROOT_USER: "u",
      MINIO_ROOT_PASSWORD: "p",
      INSTANCE_DESCRIPTION: "personal number",
      ...extra,
    },
  });
  const service = cfg.services["whatsapp-mcp-instance"];
  if (!service) throw new Error("no instance service rendered");
  return service;
};

/** The settings a number's container gets that the app reads, taken from the rendered service. */
const appEnvFrom = (service: ReturnType<typeof renderPessoal>) => {
  const env = service.environment ?? {};
  return {
    TENANT_ID: env.TENANT_ID as string,
    INSTANCE_LABEL: env.INSTANCE_LABEL as string,
    INSTANCE_DESCRIPTION: env.INSTANCE_DESCRIPTION as string,
    ...bucketEnv(bucket),
  };
};

/** Every row of every table, in a stable order, as plain JSON. */
function dumpRows(dbFile: string): Record<string, unknown[]> {
  const db = new Database(dbFile, { readonly: true });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => (row as { name: string }).name)
      .sort();
    return Object.fromEntries(
      tables.map((table) => {
        const rows = db.prepare(`SELECT * FROM "${table}"`).all();
        return [table, rows.map((row) => JSON.stringify(row)).sort()];
      }),
    );
  } finally {
    db.close();
  }
}

async function upload(server: E2eServer): Promise<{ key: string; url: string; bytes: Buffer }> {
  const bytes = Buffer.concat([PNG_MAGIC, randomBytes(1024)]);
  const res = await fetch(`${server.uploadUrl}/upload`, {
    method: "POST",
    body: bytes,
    headers: { authorization: `Bearer ${server.token}` },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  return { key: body.key, url: body.url, bytes };
}

async function webhookUrls(server: E2eServer): Promise<string[]> {
  const session = await openSession(server.mcpUrl, server.token);
  try {
    const listed = JSON.parse((await session.callTool("list_webhooks")).text);
    return listed.map((hook: { target_url: string }) => hook.target_url);
  } finally {
    await session.close();
  }
}

let s3: Client;
let dataDir: string; // stands in for /storage/whatsapp-mcp
let authDir: string;
let dbFile: string;
let oldObject: { key: string; url: string; bytes: Buffer };
const pairingBefore: Record<string, string> = {};
let dbBytesBefore: string;
let rowsBefore: Record<string, unknown[]>;

const pairingHashes = () =>
  Object.fromEntries(
    fs.readdirSync(authDir).map((name) => [name, sha256(path.join(authDir, name))]),
  );

beforeAll(async () => {
  s3 = devS3();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-mcp-rehearsal-"));
  authDir = path.join(dataDir, "auth_info");
  dbFile = path.join(dataDir, "data", "whatsapp.db");

  // 1. Today's shape: one server on that directory, tenant "default".
  const today = await startServer({
    s3: true,
    dataDir,
    env: { TENANT_ID: "default", ...bucketEnv(bucket) },
  });
  try {
    const session = await openSession(today.mcpUrl, today.token);
    const registered = await session.callTool("register_webhook", {
      target_url: "https://hooks.example.invalid/rehearsal",
      allowed_jids: ["*"],
      label: "rehearsal",
    });
    expect(registered.isError).toBe(false);
    await session.close();
    oldObject = await upload(today);
    expect(oldObject.key).toMatch(/^t\/default\/uploads\/[0-9a-f-]{36}\.png$/);
  } finally {
    await today.stop();
  }

  // The pairing the number would have on disk (the server never connects, so it writes none).
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(path.join(authDir, "creds.json"), randomBytes(2048));
  fs.writeFileSync(path.join(authDir, "app-state-sync-key-1.json"), randomBytes(512));
  fs.writeFileSync(path.join(authDir, "pre-key-1.json"), randomBytes(512));

  // 2. What must survive, recorded.
  Object.assign(pairingBefore, pairingHashes());
  dbBytesBefore = sha256(dbFile);
  rowsBefore = dumpRows(dbFile);
});

afterAll(async () => {
  await dropBucket(s3, bucket);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("the personal number moves to an instance with its data in place", () => {
  it("starts from a pairing of three files and a database holding the webhook", () => {
    expect(Object.keys(pairingBefore).sort()).toEqual([
      "app-state-sync-key-1.json",
      "creds.json",
      "pre-key-1.json",
    ]);
    expect(rowsBefore.webhook_subscriptions).toHaveLength(1);
  });

  it("renders the instance file onto the same directory, with the tenant kept as default", () => {
    const service = renderPessoal({ INSTANCE_DATA_DIR: dataDir, TENANT_ID: "default" });

    expect(service.volumes).toEqual([
      expect.objectContaining({ type: "bind", source: dataDir, target: "/data" }),
    ]);
    expect(service.environment?.TENANT_ID).toBe("default");
    // The data step of the migration is "nothing moves": rendering touched nothing.
    expect(pairingHashes()).toEqual(pairingBefore);
    expect(sha256(dbFile)).toBe(dbBytesBefore);
  });

  it("serves the old webhook and the old object from a server in the new shape, and writes new uploads under t/default/", async () => {
    const service = renderPessoal({ INSTANCE_DATA_DIR: dataDir, TENANT_ID: "default" });
    const server = await startServer({ s3: true, dataDir, env: appEnvFrom(service) });
    try {
      expect(await webhookUrls(server)).toEqual(["https://hooks.example.invalid/rehearsal"]);

      const old = await fetch(oldObject.url);
      expect(old.status).toBe(200);
      expect(Buffer.from(await old.arrayBuffer()).equals(oldObject.bytes)).toBe(true);

      const fresh = await upload(server);
      expect(fresh.key).toMatch(/^t\/default\/uploads\/[0-9a-f-]{36}\.png$/);
      const served = await fetch(fresh.url);
      expect(Buffer.from(await served.arrayBuffer()).equals(fresh.bytes)).toBe(true);
    } finally {
      await server.stop();
    }
    // stop() must have kept the directory: it is not the harness's to delete.
    expect(fs.existsSync(authDir)).toBe(true);
  }, 60_000);

  it("leaves the pairing files byte-identical", () => {
    expect(pairingHashes()).toEqual(pairingBefore);
  });

  it("leaves the database byte-identical, with every table holding the same rows", () => {
    expect(sha256(dbFile)).toBe(dbBytesBefore);
    expect(dumpRows(dbFile)).toEqual(rowsBefore);
  });

  it("negative control: without TENANT_ID=default the same start writes under t/pessoal/", async () => {
    const service = renderPessoal({ INSTANCE_DATA_DIR: dataDir });
    expect(service.environment?.TENANT_ID).toBe("pessoal");
    const server = await startServer({ s3: true, dataDir, env: appEnvFrom(service) });
    try {
      const fresh = await upload(server);

      expect(fresh.key).toMatch(/^t\/pessoal\/uploads\/[0-9a-f-]{36}\.png$/);
      // The override is the only thing that keeps new media beside the old.
      expect(fresh.key.startsWith("t/default/")).toBe(false);
    } finally {
      await server.stop();
    }
  }, 60_000);
});
