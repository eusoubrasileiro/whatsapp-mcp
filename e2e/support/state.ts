/**
 * What a rehearsal records about a number before and after a move, and the few things it does to a
 * running server to give it state worth keeping: a database that holds a webhook, an uploaded file.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import Database from "better-sqlite3";
import { openSession } from "./mcp-client.ts";
import type { E2eServer } from "./server.ts";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const sha256File = (file: string) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** Every row of every table, in a stable order, as plain JSON. */
export function dumpRows(dbFile: string): Record<string, unknown[]> {
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

/** Uploads a small PNG through the server's own `/upload`, as a client with its token would. */
export async function uploadPng(
  server: E2eServer,
): Promise<{ key: string; url: string; bytes: Buffer }> {
  const bytes = Buffer.concat([PNG_MAGIC, randomBytes(1024)]);
  const res = await fetch(`${server.uploadUrl}/upload`, {
    method: "POST",
    body: new Uint8Array(bytes),
    headers: { authorization: `Bearer ${server.token}` },
  });
  if (res.status !== 200) throw new Error(`upload answered ${res.status}`);
  const body = await res.json();
  return { key: body.key, url: body.url, bytes };
}

export async function registerWebhook(server: E2eServer, targetUrl: string): Promise<void> {
  const session = await openSession(server.mcpUrl, server.token);
  try {
    const done = await session.callTool("register_webhook", {
      target_url: targetUrl,
      allowed_jids: ["*"],
      label: "rehearsal",
    });
    if (done.isError) throw new Error(`register_webhook failed: ${done.text}`);
  } finally {
    await session.close();
  }
}

export async function webhookUrls(server: E2eServer): Promise<string[]> {
  const session = await openSession(server.mcpUrl, server.token);
  try {
    const listed = JSON.parse((await session.callTool("list_webhooks")).text);
    return listed.map((hook: { target_url: string }) => hook.target_url);
  } finally {
    await session.close();
  }
}
