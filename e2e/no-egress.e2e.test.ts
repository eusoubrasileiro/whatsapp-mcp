import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { EGRESS_BLOCKED_EXIT_CODE } from "./support/no-egress.ts";
import { NO_EGRESS } from "./support/server.ts";

/**
 * The guard that makes "this suite never opens a WhatsApp connection" mechanical rather
 * than a promise. These scripts only ever name addresses that cannot resolve or route
 * (RFC 5737 TEST-NET-1, the reserved `.invalid` TLD): the guard must stop them first.
 */
function runGuarded(script: string) {
  return spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--no-warnings",
      "--import",
      pathToFileURL(NO_EGRESS).href,
      "--input-type=module",
      "-e",
      script,
    ],
    { encoding: "utf8", timeout: 20_000 },
  );
}

describe("no-egress guard", () => {
  it("ends the process when something connects to a non-loopback IP", () => {
    const run = runGuarded(`import net from "node:net"; net.connect(443, "192.0.2.1");`);

    expect(run.status).toBe(EGRESS_BLOCKED_EXIT_CODE);
    expect(run.stderr).toContain("E2E_EGRESS_BLOCKED 192.0.2.1:443");
  });

  it("ends the process when something connects to a named host", () => {
    const run = runGuarded(
      `import net from "node:net"; net.connect({ host: "chat.example.invalid", port: 443 });`,
    );

    expect(run.status).toBe(EGRESS_BLOCKED_EXIT_CODE);
    expect(run.stderr).toContain("E2E_EGRESS_BLOCKED chat.example.invalid:443");
  });

  it("stops fetch() to a remote host", () => {
    const run = runGuarded(`await fetch("https://example.invalid/");`);

    expect(run.status).toBe(EGRESS_BLOCKED_EXIT_CODE);
    expect(run.stderr).toContain("E2E_EGRESS_BLOCKED example.invalid:443");
  });

  it("stops a WebSocket to a remote host", () => {
    const run = runGuarded(`
      import { WebSocket } from "ws";
      new WebSocket("wss://chat.example.invalid/ws").on("error", () => {});
    `);

    expect(run.status).toBe(EGRESS_BLOCKED_EXIT_CODE);
    expect(run.stderr).toContain("E2E_EGRESS_BLOCKED chat.example.invalid:443");
  });

  it("lets loopback through, by name and by address", () => {
    const run = runGuarded(`
      import net from "node:net";
      const server = net.createServer((s) => s.end("pong")).listen(0, "127.0.0.1", async () => {
        const { port } = server.address();
        const get = (...args) => new Promise((resolve, reject) => {
          const s = net.connect(...args).once("data", (d) => resolve(String(d))).once("error", reject);
        });
        const out = [await get(port, "127.0.0.1"), await get({ host: "localhost", port }), await get(port)];
        console.log(out.join(","));
        server.close();
      });
    `);

    expect(run.stderr).not.toContain("E2E_EGRESS_BLOCKED");
    expect(run.stdout.trim()).toBe("pong,pong,pong");
    expect(run.status).toBe(0);
  });

  it("lets unix sockets through", () => {
    const run = runGuarded(`
      import net from "node:net";
      net.connect("/nonexistent/e2e.sock").on("error", (e) => { console.log(e.code); });
    `);

    expect(run.stdout.trim()).toBe("ENOENT");
    expect(run.status).toBe(0);
  });
});
