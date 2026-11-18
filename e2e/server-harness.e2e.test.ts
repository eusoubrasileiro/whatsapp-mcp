/**
 * The server harness itself. FastMCP cannot report an ephemeral port back, so `startServer`
 * asks the system for a free one and hands it to the child, which binds it a second or two
 * later. Spec files run in parallel and each takes several ports (servers, stores, the proxy),
 * so now and then another process is on that port first. A start that loses that race is
 * repeated on a new port, as the store and the proxy harnesses already do; any other failure
 * is not.
 */
import net from "node:net";
import { describe, expect, it } from "vitest";
import { freePort, startServer } from "./support/server.ts";

/** Listens on a loopback port until released: what losing the race for it looks like. */
async function takenPort(): Promise<{ port: number; release(): Promise<void> }> {
  const holder = net.createServer();
  await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
  const { port } = holder.address() as net.AddressInfo;
  return { port, release: () => new Promise((resolve) => holder.close(() => resolve())) };
}

describe("a server start that loses the race for its port", () => {
  it("is repeated on a new port, and the server answers there", async () => {
    const taken = await takenPort();
    const offered: number[] = [];
    try {
      const server = await startServer({
        port: async () => {
          const port = offered.length === 0 ? taken.port : await freePort();
          offered.push(port);
          return port;
        },
      });
      try {
        expect(offered).toHaveLength(2);
        expect(server.mcpUrl).toBe(`http://127.0.0.1:${offered[1]}/mcp`);
        const live = await fetch(`${server.qrUrl}/live`);
        expect(live.status).toBe(200);
      } finally {
        await server.stop();
      }
    } finally {
      await taken.release();
    }
  });

  it("gives up after three starts, with the child's own words as evidence", async () => {
    const taken = await takenPort();
    let asked = 0;
    try {
      await expect(
        startServer({
          port: async () => {
            asked += 1;
            return taken.port;
          },
        }),
      ).rejects.toThrow(/EADDRINUSE/);
      expect(asked).toBe(3);
    } finally {
      await taken.release();
    }
  });
});
