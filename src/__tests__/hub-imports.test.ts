import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(import.meta.dirname, "..");
const ENTRY = path.join(SRC, "hub", "main.ts");

/** What the hub must never be able to reach: WhatsApp, the database, storage, the MCP server. */
const FORBIDDEN_FILES = [
  "whatsapp.ts",
  "mcp.ts",
  "database.ts",
  "storage.ts",
  "actions.ts",
  "env-config.ts",
];
const FORBIDDEN_PACKAGES = [
  "@whiskeysockets/baileys",
  "@amiticia/baileys-client",
  "better-sqlite3",
  "minio",
  "fastmcp",
  "drizzle-orm",
  "@aws-sdk/client-s3",
];

const IMPORT_SPECIFIER =
  /(?:^|[\s;])(?:import|export)\s*(?:[^'";]*?\sfrom\s*)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;

interface Graph {
  files: Set<string>;
  packages: Set<string>;
}

/** Every file and package reachable from `entry` by any import, export-from, dynamic import or require. */
function walk(entry: string): Graph {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(IMPORT_SPECIFIER)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (specifier.startsWith(".")) queue.push(path.resolve(path.dirname(file), specifier));
      else packages.add(specifier);
    }
  }
  return { files, packages };
}

describe("the hub's import graph", () => {
  const graph = walk(ENTRY);
  const relative = [...graph.files].map((file) => path.relative(SRC, file)).sort();

  it("finds the entry point and the modules it is built from", () => {
    expect(relative).toEqual(
      expect.arrayContaining([
        "hub/main.ts",
        "hub/start.ts",
        "hub/server.ts",
        "hub/poller.ts",
        "hub/auth.ts",
        "hub/config.ts",
        "hub/page.ts",
        "ntfy.ts",
        "instance-identity.ts",
      ]),
    );
  });

  it("reaches nothing in src/ but the hub itself, the push-notification helper and its identity reader", () => {
    const allowed = ["ntfy.ts", "instance-identity.ts"];
    const outside = relative.filter(
      (file) => !file.startsWith(`hub${path.sep}`) && !allowed.includes(file),
    );

    expect(outside).toEqual([]);
  });

  it.each(FORBIDDEN_FILES)("cannot reach %s", (name) => {
    expect(relative.map((file) => path.basename(file))).not.toContain(name);
  });

  it.each(FORBIDDEN_PACKAGES)("cannot reach the package %s", (name) => {
    expect([...graph.packages].filter((pkg) => pkg === name || pkg.startsWith(`${name}/`))).toEqual(
      [],
    );
  });

  it("depends on node's own modules and pino, and on no other package", () => {
    const others = [...graph.packages].filter((pkg) => !pkg.startsWith("node:") && pkg !== "pino");

    expect(others).toEqual([]);
  });

  it("sees an import written any way the rest of the code writes one", () => {
    const sample = [
      'import a from "./a.ts";',
      'import type { B } from "./b.ts";',
      'export { c } from "./c.ts";',
      'const d = await import("./d.ts");',
      'import "./e.ts";',
    ].join("\n");

    const found = [...sample.matchAll(IMPORT_SPECIFIER)].map((m) => m[1] ?? m[2] ?? m[3]);

    expect(found).toEqual(["./a.ts", "./b.ts", "./c.ts", "./d.ts", "./e.ts"]);
  });
});
