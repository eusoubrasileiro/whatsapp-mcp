/**
 * Renders a compose file with the real `docker compose config`, so the deploy files are tested
 * as Docker reads them: interpolation, required variables, defaults. It never creates anything:
 * no `up`, no network, no container.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface RenderedService {
  image: string;
  container_name?: string;
  restart?: string;
  command?: string[] | null;
  entrypoint?: string[] | null;
  depends_on?: Record<string, unknown>;
  environment?: Record<string, string>;
  healthcheck?: unknown;
  labels?: Record<string, string>;
  networks?: Record<string, unknown>;
  volumes?: { type: string; source: string; target: string }[];
}

export interface RenderedCompose {
  name: string;
  services: Record<string, RenderedService>;
  networks: Record<string, { name: string; external?: boolean }>;
}

/**
 * Runs `docker compose --env-file <tmp> [-f file] config --format json` and returns the parsed
 * result, or throws with Docker's stderr (a missing required variable fails here).
 *
 * The child sees only PATH and HOME, so nothing from the developer's shell can leak into the
 * render. Without `file`, compose picks the file from `COMPOSE_FILE` in `env`, resolved from
 * `cwd`. Note that `config` prints a literal `$` in a label as `$$`.
 */
export function renderCompose(options: {
  file?: string;
  env: Record<string, string>;
  cwd?: string;
}): RenderedCompose {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-mcp-compose-"));
  try {
    const envFile = path.join(dir, "env");
    const lines = Object.entries(options.env).map(([key, value]) => `${key}='${value}'`);
    fs.writeFileSync(envFile, `${lines.join("\n")}\n`);
    const args = ["compose", "--env-file", envFile];
    if (options.file) args.push("-f", options.file);
    args.push("config", "--format", "json");
    const run = spawnSync("docker", args, {
      cwd: options.cwd,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      encoding: "utf8",
    });
    if (run.error) throw run.error;
    if (run.status !== 0) {
      throw new Error(`docker compose config failed (${run.status}):\n${run.stderr}`);
    }
    return JSON.parse(run.stdout) as RenderedCompose;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
