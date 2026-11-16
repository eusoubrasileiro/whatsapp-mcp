// heavy-lock.sh queues heavy commands on the machine-wide lock every git hook on
// the workstation takes (standards/workstation/husky/init.sh). Each test points the
// helper at its own lock dir, so it never touches — or waits on — the real one.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HELPER = join(dirname(fileURLToPath(import.meta.url)), "heavy-lock.sh");

/**
 * The environment a caller outside any lock would have. pre-push runs this suite
 * while HOLDING the lock, so an inherited AMITICIA_HEAVY_LOCK=held (or a CI flag)
 * would make every "does it wait" assertion pass for the wrong reason.
 */
function envFor(lockDir, extra = {}) {
  const env = { ...process.env, AMITICIA_HEAVY_LOCK_DIR: lockDir, ...extra };
  if (!("AMITICIA_HEAVY_LOCK" in extra)) delete env.AMITICIA_HEAVY_LOCK;
  if (!("CI" in extra)) delete env.CI;
  return env;
}

function waitFor(path) {
  for (let i = 0; i < 100 && !existsSync(path); i++) spawnSync("sleep", ["0.05"]);
  assert.ok(existsSync(path), `${path} never appeared`);
}

/**
 * Hold the lock from another process until `release` exists (or the test dir is
 * gone, so a failing test cannot orphan it); resolves on its exit.
 */
function holdLock(dir) {
  const started = join(dir, "holder-started");
  const release = join(dir, "release");
  const child = spawn(
    "sh",
    [
      HELPER,
      "sh",
      "-c",
      `touch "${started}"; while [ ! -e "${release}" ] && [ -d "${dir}" ]; do sleep 0.05; done; touch "${dir}/holder-done"`,
    ],
    { env: envFor(dir), stdio: "ignore" },
  );
  const exited = new Promise((resolve) => child.on("exit", resolve));
  waitFor(started);
  return { exited, release: () => spawnSync("touch", [release]) };
}

function withLockDir(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "heavy-lock-"));
    try {
      await fn(dir);
    } finally {
      spawnSync("touch", [join(dir, "release")]);
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test(
  "a second caller waits while the lock is held, then runs",
  withLockDir(async (dir) => {
    const holder = holdLock(dir);
    // release the holder 1 s from now, from a process the blocking spawnSync can't stall
    spawn("sh", ["-c", `sleep 1; touch "${dir}/release"`], { stdio: "ignore" }).unref();
    const waiter = spawnSync(
      "sh",
      [HELPER, "sh", "-c", `[ -e "${dir}/holder-done" ] && echo after-holder || echo overlapped`],
      { env: envFor(dir), encoding: "utf8", timeout: 20_000 },
    );
    await holder.exited;
    assert.equal(waiter.status, 0, waiter.stderr);
    assert.match(waiter.stderr, /waiting for heavy job/);
    assert.equal(waiter.stdout.trim(), "after-holder");
  }),
);

test(
  "the waiting message names the holder",
  withLockDir(async (dir) => {
    const holder = holdLock(dir);
    const owner = readFileSync(join(dir, "amiticia-heavy.lock.owner"), "utf8");
    assert.match(owner, /holder-started/, "owner line should carry the holder's command");
    assert.match(owner, new RegExp(process.cwd().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    holder.release();
    await holder.exited;
  }),
);

test(
  "a nested call under a held lock runs at once instead of deadlocking",
  withLockDir(async (dir) => {
    const holder = holdLock(dir);
    const nested = spawnSync("sh", [HELPER, "echo", "nested-ran"], {
      env: envFor(dir, { AMITICIA_HEAVY_LOCK: "held" }),
      encoding: "utf8",
      timeout: 5_000,
    });
    holder.release();
    await holder.exited;
    assert.equal(nested.status, 0, nested.stderr);
    assert.equal(nested.stdout.trim(), "nested-ran");
    assert.doesNotMatch(nested.stderr, /waiting/);
  }),
);

test(
  "under CI the command runs at once",
  withLockDir(async (dir) => {
    const holder = holdLock(dir);
    const ci = spawnSync("sh", [HELPER, "echo", "ci-ran"], {
      env: envFor(dir, { CI: "1" }),
      encoding: "utf8",
      timeout: 5_000,
    });
    holder.release();
    await holder.exited;
    assert.equal(ci.stdout.trim(), "ci-ran");
  }),
);

test(
  "without a lock directory the command still runs",
  withLockDir(async (dir) => {
    const r = spawnSync("sh", [HELPER, "echo", "ran"], {
      env: envFor(join(dir, "missing")),
      encoding: "utf8",
      timeout: 5_000,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "ran");
  }),
);

test(
  "the wrapped command's exit status and arguments pass through",
  withLockDir(async (dir) => {
    const r = spawnSync("sh", [HELPER, "sh", "-c", 'echo "$1"; exit 7', "sh", "--since main"], {
      env: envFor(dir),
      encoding: "utf8",
      timeout: 5_000,
    });
    assert.equal(r.status, 7);
    assert.equal(r.stdout.trim(), "--since main");
  }),
);
