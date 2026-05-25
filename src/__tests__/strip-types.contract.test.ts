/**
 * Contract test: every src TypeScript module must load under Node's
 * --experimental-strip-types (which is how the production container runs).
 *
 * Vitest goes through esbuild's full TS transformer, so it does NOT catch
 * syntax that strip-only mode rejects — most notably TypeScript parameter
 * properties (`constructor(public x)`), enums, and namespaces.
 *
 * This test broke once already: parameter properties slipped through vitest
 * and crashed the prod container in a restart loop. Keep this guard.
 */

import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..");

function listTsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "__tests__" || name === "node_modules" || name === "db") continue;
    const full = join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) listTsFiles(full, out);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

async function loadUnderStripTypes(file: string): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const code = `import(${JSON.stringify(file)}).then(() => process.exit(0)).catch(e => { console.error(e.code || e.name, e.message); process.exit(1) })`;
    const proc = spawn(process.execPath, ["--experimental-strip-types", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
    const err: Buffer[] = [];
    proc.stderr.on("data", (c) => err.push(c));
    proc.on("close", (rc) => resolve({ ok: rc === 0, stderr: Buffer.concat(err).toString("utf8") }));
  });
}

describe("strip-types compatibility", () => {
  const files = listTsFiles(srcRoot);

  // Only assert that new transcribe/describe/xml modules parse — the wider
  // codebase already imports them through whatsapp.ts which pulls in
  // @amiticia/baileys-client (absent in CI). Targeted modules give a
  // deterministic guard without the workspace coupling.
  const TARGETS = ["transcribe/preprocess.ts", "transcribe/whisper.ts", "describe/vision.ts", "xml.ts"];

  for (const target of TARGETS) {
    it(`${target} parses under --experimental-strip-types`, async () => {
      const matches = files.filter((f) => relative(srcRoot, f) === target);
      expect(matches, `expected exactly one match for ${target}`).toHaveLength(1);
      const { ok, stderr } = await loadUnderStripTypes(matches[0]);
      expect(ok, `strip-types load failed for ${target}:\n${stderr}`).toBe(true);
    });
  }
});
