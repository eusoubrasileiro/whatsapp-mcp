// Ported from wahub (its #312): a dispatched worktree came out with no
// `.husky/_/pre-commit`, so git (core.hooksPath=.husky/_, resolved per worktree)
// silently ran no commit/push gate. `ensure-worktree-hooks.sh` is the step
// dispatch runs last; it must generate the hooks or fail loudly.
//
// `pnpm` is a stub on PATH so no real install happens: the "good" stub makes
// `pnpm exec husky` create the hook, the "broken" one does nothing.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts/ensure-worktree-hooks.sh");

function run(stubBody, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hooks-"));
  const wt = join(dir, "wt");
  const bin = join(dir, "bin");
  mkdirSync(wt);
  mkdirSync(bin);
  writeFileSync(join(bin, "pnpm"), `#!/bin/sh\n${stubBody}\n`);
  chmodSync(join(bin, "pnpm"), 0o755);
  const r = spawnSync("bash", [SCRIPT, wt], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...extraEnv },
  });
  return { ...r, wt };
}

const MAKE_HOOK = 'mkdir -p .husky/_ && echo "#!/bin/sh" > .husky/_/pre-commit';

test("generates the hooks when the worktree has none", () => {
  const r = run(MAKE_HOOK);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(r.wt, ".husky/_/pre-commit")));
});

test("fails loudly when husky leaves no pre-commit hook", () => {
  const r = run("exit 0");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /\.husky\/_\/pre-commit/);
});

test("HUSKY=0 in the caller's environment cannot make husky skip generation", () => {
  const r = run(`[ "\${HUSKY-}" = "0" ] && exit 0; ${MAKE_HOOK}`, { HUSKY: "0" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(r.wt, ".husky/_/pre-commit")));
});

test("does not rerun husky when the hook is already there", () => {
  const r = run(`echo called >> "$PWD/calls"; ${MAKE_HOOK}`);
  assert.equal(r.status, 0);
  const again = spawnSync("bash", [SCRIPT, r.wt], {
    encoding: "utf8",
    env: { ...process.env, PATH: "/usr/bin:/bin" },
  });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(readFileSync(join(r.wt, "calls"), "utf8"), "called\n");
});

test("dispatch runs the check on every path, including --no-install", () => {
  const src = readFileSync(join(ROOT, "scripts/dispatch-worktree.sh"), "utf8");
  const call = src.indexOf("ensure-worktree-hooks.sh");
  const fi = src.indexOf('echo "[dispatch] --no-install: skipping');
  assert.ok(call > fi, "the hooks check must come after the install if/else, not inside it");
});
