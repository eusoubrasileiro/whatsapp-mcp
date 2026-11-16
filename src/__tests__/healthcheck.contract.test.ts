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

/** The `healthcheck:` block of the whatsapp-mcp service in the deploy compose file. */
function composeHealthcheck(): string {
  const text = readFileSync(join(repoRoot, "deploy", "docker-compose.yaml"), "utf8");
  const service = text.split(/^ {2}whatsapp-mcp:\n/m)[1]?.split(/^ {2}\S/m)[0];
  if (!service) throw new Error("deploy/docker-compose.yaml has no whatsapp-mcp service");
  const block = service.match(/^ {4}healthcheck:\n((?: {6,}.*\n?)+)/m);
  if (!block) throw new Error("whatsapp-mcp service has no healthcheck: override");
  return block[1];
}

// The Dockerfile's own HEALTHCHECK still probes /health until its change is
// human-approved (critical path); the compose override below is what the
// deployment actually runs, and it takes precedence over the image default.
describe("Docker healthcheck", () => {
  it("deploy compose overrides the whatsapp-mcp healthcheck to probe /live", () => {
    const check = composeHealthcheck();
    expect(check).toContain("39002/live");
    expect(check).not.toMatch(/\/health\b/);
  });
});
