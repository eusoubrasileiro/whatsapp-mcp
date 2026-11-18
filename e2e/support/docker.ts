/**
 * The two things every Docker-backed harness in this directory needs: a synchronous `docker`
 * call that reports instead of throwing on a non-zero exit, and a way to make sure a spec that
 * dies before its `afterAll` does not leave a container, network or volume behind.
 */
import { spawnSync } from "node:child_process";

export interface DockerResult {
  status: number | null;
  out: string;
  err: string;
}

/** Runs `docker <args>`; throws only when the binary cannot be started at all. */
export function docker(args: string[], env?: Record<string, string>): DockerResult {
  const run = spawnSync("docker", args, { encoding: "utf8", ...(env ? { env } : {}) });
  if (run.error) throw run.error;
  return { status: run.status, out: run.stdout.trim(), err: run.stderr.trim() };
}

const pending = new Map<string, () => void>();
let exitHookInstalled = false;

/**
 * Registers `cleanup` under `name` to run when the process exits, unless `forget(name)` ran
 * first. Cleanups run in the order they were registered, so register containers before the
 * network and volume they use only if you want them removed in that order.
 */
export function cleanupOnExit(name: string, cleanup: () => void): void {
  pending.set(name, cleanup);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const left of pending.values()) left();
  });
}

/** The thing `name` stands for is already gone. */
export function forget(name: string): void {
  pending.delete(name);
}
