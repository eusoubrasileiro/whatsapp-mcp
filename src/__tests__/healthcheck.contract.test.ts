/**
 * Contract test: the Docker healthcheck must probe /live, never /health.
 *
 * 2026-11-13: /health went 503 on a wedged socket, Docker marked the container
 * unhealthy (7,544 failures), plain Docker never restarted it, and Traefik —
 * which drops unhealthy containers — turned the MCP and QR URLs into 404s for
 * 63 h. /live answers 200 whenever the process serves HTTP; restarting a wedged
 * socket is the in-process watchdog's job, not the healthcheck's.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The `healthcheck:` block of the number's service in the per-number deploy compose file. */
function composeHealthcheck(): string {
  const text = readFileSync(join(repoRoot, "deploy", "docker-compose.instance.yaml"), "utf8");
  const service = text.split(/^ {2}whatsapp-mcp-instance:\n/m)[1]?.split(/^ {2}\S/m)[0];
  if (!service) {
    throw new Error("deploy/docker-compose.instance.yaml has no whatsapp-mcp-instance service");
  }
  const block = service.match(/^ {4}healthcheck:\n((?: {6,}.*\n?)+)/m);
  if (!block) throw new Error("whatsapp-mcp-instance service has no healthcheck: override");
  return block[1];
}

/** The Dockerfile HEALTHCHECK instruction, with backslash continuations joined. */
function dockerfileHealthcheck(): string {
  const text = readFileSync(join(repoRoot, "Dockerfile"), "utf8").replace(/\\\r?\n/g, " ");
  const line = text.split("\n").find((l) => l.startsWith("HEALTHCHECK "));
  if (!line) throw new Error("Dockerfile has no HEALTHCHECK instruction");
  return line;
}

describe("Docker healthcheck", () => {
  it("Dockerfile HEALTHCHECK probes /live", () => {
    const check = dockerfileHealthcheck();
    expect(check).toContain("39002/live");
    expect(check).not.toMatch(/\/health\b/);
  });

  it("deploy compose overrides the number's healthcheck to probe /live", () => {
    const check = composeHealthcheck();
    expect(check).toContain("39002/live");
    expect(check).not.toMatch(/\/health\b/);
  });
});
