import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pino, { type Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRouter, type Route } from "../http-router.ts";

function makeSilentLogger(): Logger {
  return pino({ level: "silent" });
}

async function start(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

async function stop(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

describe("createRouter", () => {
  let server: Server;
  let baseUrl: string;
  const logger = makeSilentLogger();

  afterEach(async () => {
    if (server) await stop(server);
  });

  it("dispatches GET path match to handler", async () => {
    const routes: Route[] = [
      {
        method: "GET",
        path: "/hello",
        handler: async (_req, res) => {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("hi");
        },
      },
    ];
    server = http.createServer(createRouter(routes, { logger }));
    baseUrl = await start(server);

    const res = await fetch(`${baseUrl}/hello`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hi");
  });

  it("returns 404 with plain text when no route matches", async () => {
    server = http.createServer(createRouter([], { logger }));
    baseUrl = await start(server);

    const res = await fetch(`${baseUrl}/nowhere`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("not found");
  });

  it("returns 405 with allow header when path matches but method does not", async () => {
    const routes: Route[] = [
      {
        method: "POST",
        path: "/thing",
        handler: async (_req, res) => {
          res.writeHead(200);
          res.end();
        },
      },
    ];
    server = http.createServer(createRouter(routes, { logger }));
    baseUrl = await start(server);

    const res = await fetch(`${baseUrl}/thing`);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(await res.text()).toBe("method not allowed");
  });

  it("combines allowed methods for the same path in the Allow header", async () => {
    const routes: Route[] = [
      {
        method: "POST",
        path: "/thing",
        handler: async (_req, res) => {
          res.writeHead(200);
          res.end();
        },
      },
      {
        method: "PUT",
        path: "/thing",
        handler: async (_req, res) => {
          res.writeHead(200);
          res.end();
        },
      },
    ];
    server = http.createServer(createRouter(routes, { logger }));
    baseUrl = await start(server);

    const res = await fetch(`${baseUrl}/thing`, { method: "DELETE" });
    expect(res.status).toBe(405);
    const allow = res.headers.get("allow") ?? "";
    expect(allow).toContain("POST");
    expect(allow).toContain("PUT");
  });

  it("returns 401 plain text when auth='bearer' and no token is provided", async () => {
    const routes: Route[] = [
      {
        method: "POST",
        path: "/secure",
        auth: "bearer",
        handler: async (_req, res) => {
          res.writeHead(200);
          res.end();
        },
      },
    ];
    server = http.createServer(createRouter(routes, { logger, bearerToken: "shh" }));
    baseUrl = await start(server);

    const res = await fetch(`${baseUrl}/secure`, { method: "POST" });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("unauthorized");
  });

  it("returns 401 when bearer token mismatches", async () => {
    const routes: Route[] = [
      {
        method: "POST",
        path: "/secure",
        auth: "bearer",
        handler: async (_req, res) => {
          res.writeHead(200);
          res.end();
        },
      },
    ];
    server = http.createServer(createRouter(routes, { logger, bearerToken: "shh" }));
    baseUrl = await start(server);

    const res = await fetch(`${baseUrl}/secure`, {
      method: "POST",
      headers: { Authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(401);
  });

  it("allows request when bearer token matches", async () => {
    const routes: Route[] = [
      {
        method: "POST",
        path: "/secure",
        auth: "bearer",
        handler: async (_req, res) => {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("ok");
        },
      },
    ];
    server = http.createServer(createRouter(routes, { logger, bearerToken: "shh" }));
    baseUrl = await start(server);

    const res = await fetch(`${baseUrl}/secure`, {
      method: "POST",
      headers: { Authorization: "Bearer shh" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("treats auth='bearer' as pass-through when bearerToken is not configured", async () => {
    const routes: Route[] = [
      {
        method: "POST",
        path: "/secure",
        auth: "bearer",
        handler: async (_req, res) => {
          res.writeHead(200);
          res.end("yes");
        },
      },
    ];
    server = http.createServer(createRouter(routes, { logger }));
    baseUrl = await start(server);

    const res = await fetch(`${baseUrl}/secure`, { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("does not enforce auth on routes without auth='bearer'", async () => {
    const routes: Route[] = [
      {
        method: "GET",
        path: "/public",
        handler: async (_req, res) => {
          res.writeHead(200);
          res.end("free");
        },
      },
    ];
    server = http.createServer(createRouter(routes, { logger, bearerToken: "shh" }));
    baseUrl = await start(server);

    const res = await fetch(`${baseUrl}/public`);
    expect(res.status).toBe(200);
  });

  it("wraps handler exceptions as 500 plain text 'internal error'", async () => {
    const routes: Route[] = [
      {
        method: "GET",
        path: "/boom",
        handler: async () => {
          throw new Error("kaboom");
        },
      },
    ];
    server = http.createServer(createRouter(routes, { logger }));
    baseUrl = await start(server);

    const res = await fetch(`${baseUrl}/boom`);
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("internal error");
  });

  it("does not write 500 when handler already sent headers, but still closes response", async () => {
    const routes: Route[] = [
      {
        method: "GET",
        path: "/half",
        handler: async (_req, res) => {
          res.writeHead(200, { "content-type": "text/plain" });
          res.write("partial");
          throw new Error("oops after headers");
        },
      },
    ];
    server = http.createServer(createRouter(routes, { logger }));
    baseUrl = await start(server);

    const res = await fetch(`${baseUrl}/half`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("partial");
  });
});
