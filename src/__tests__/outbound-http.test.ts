import type dns from "node:dns";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  guardLookup,
  isPublicAddress,
  type LookupAll,
  OutboundError,
  outboundRequest,
} from "../outbound-http.ts";
import {
  type Hit,
  type LoopbackServer,
  type Route,
  startLoopbackServer,
} from "./helpers/loopback-server.ts";

describe("isPublicAddress", () => {
  it.each([
    // first and last address of every non-public IPv4 range
    "0.0.0.0",
    "0.255.255.255",
    "10.0.0.0",
    "10.255.255.255",
    "100.64.0.0",
    "100.127.255.255",
    "127.0.0.1",
    "127.255.255.255",
    "169.254.0.0",
    "169.254.169.254",
    "169.254.255.255",
    "172.16.0.0",
    "172.31.255.255",
    "192.0.0.0",
    "192.0.0.255",
    "192.0.2.0",
    "192.0.2.255",
    "192.88.99.0",
    "192.88.99.255",
    "192.168.0.0",
    "192.168.255.255",
    "198.18.0.0",
    "198.19.255.255",
    "198.51.100.0",
    "198.51.100.255",
    "203.0.113.0",
    "203.0.113.255",
    "224.0.0.0",
    "239.255.255.255",
    "240.0.0.0",
    "255.255.255.255",
  ])("refuses IPv4 %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each([
    "1.1.1.1",
    "8.8.8.8",
    "9.255.255.255",
    "11.0.0.0",
    "100.63.255.255",
    "100.128.0.0",
    "126.255.255.255",
    "128.0.0.0",
    "169.253.255.255",
    "169.255.0.0",
    "172.15.255.255",
    "172.32.0.0",
    "192.0.1.0",
    "192.0.3.0",
    "192.167.255.255",
    "192.169.0.0",
    "198.17.255.255",
    "198.20.0.0",
    "223.255.255.255",
  ])("allows public IPv4 %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });

  it.each([
    "::",
    "::1",
    "::127.0.0.1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:172.17.0.2",
    "64:ff9b::a00:1",
    "64:ff9b:1::1",
    "100::1",
    "2001::1",
    "2001:0:ffff:ffff:ffff:ffff:ffff:ffff",
    "2001:db8::1",
    "2002:a00:1::1",
    "fc00::1",
    "fd12:3456:789a::1",
    "fe80::1",
    "febf:ffff::1",
    "fec0::1",
    "ff02::1",
  ])("refuses IPv6 %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each([
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "2a00:1450:4001::1",
    "::ffff:8.8.8.8",
    "2001:1::1",
  ])("allows public IPv6 %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });

  it.each(["", "localhost", "example.com", "10.0.0", "[::1]"])(
    "treats %j, which is not an IP address, as not public",
    (value) => {
      expect(isPublicAddress(value)).toBe(false);
    },
  );
});

/** A lookup that answers from a fixed table and records what it was asked. */
function fakeDns(table: Record<string, string[]>): LookupAll & { asked: string[] } {
  const asked: string[] = [];
  const lookup = ((hostname, _options, callback) => {
    asked.push(hostname);
    const addresses = table[hostname];
    if (!addresses) {
      const err = Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
        code: "ENOTFOUND",
      });
      callback(err, []);
      return;
    }
    callback(
      null,
      addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
    );
  }) as LookupAll & { asked: string[] };
  lookup.asked = asked;
  return lookup;
}

describe("guardLookup", () => {
  const call = (lookup: LookupAll, all: boolean) =>
    new Promise<{ err: NodeJS.ErrnoException | null; address: unknown; family?: number }>(
      (resolve) => {
        guardLookup(isPublicAddress, lookup)(
          "host.test",
          { all } as dns.LookupOptions,
          (err, address, family) => resolve({ err, address, family }),
        );
      },
    );

  it("answers the first address and its family when the socket asked for one", async () => {
    const result = await call(fakeDns({ "host.test": ["2606:4700::1", "1.1.1.1"] }), false);
    expect(result).toEqual({ err: null, address: "2606:4700::1", family: 6 });
  });

  it("answers every address when the socket asked for all", async () => {
    const result = await call(fakeDns({ "host.test": ["1.1.1.1", "8.8.8.8"] }), true);
    expect(result.err).toBeNull();
    expect(result.address).toEqual([
      { address: "1.1.1.1", family: 4 },
      { address: "8.8.8.8", family: 4 },
    ]);
  });

  it("refuses when any one of the addresses is private", async () => {
    const result = await call(fakeDns({ "host.test": ["1.1.1.1", "10.0.0.1"] }), true);
    expect(result.err).toBeInstanceOf(OutboundError);
    expect((result.err as OutboundError).kind).toBe("blocked");
    expect(result.err?.message).toBe(
      "refused: host.test resolves to 10.0.0.1, a private, loopback or link-local address",
    );
  });

  it("passes a DNS failure through unchanged", async () => {
    const result = await call(fakeDns({}), false);
    expect(result.err?.code).toBe("ENOTFOUND");
  });

  it("fails a name with no address at all", async () => {
    const result = await call(fakeDns({ "host.test": [] }), false);
    expect((result.err as OutboundError).kind).toBe("network");
  });
});

describe("outboundRequest", () => {
  let server: LoopbackServer;
  let port: number;
  let hits: Hit[];
  let routes: Record<string, Route>;

  beforeAll(async () => {
    server = await startLoopbackServer();
    ({ port, hits, routes } = server);
  });

  afterAll(() => server.close());

  beforeEach(() => {
    server.reset();
  });

  const base = { timeoutMs: 2_000, maxBytes: 1024, maxRedirects: 3 };
  /** "media.test" stands for a public host; this test policy lets it reach the loopback server. */
  const asIfPublic = {
    lookup: fakeDns({ "media.test": ["127.0.0.1"], "internal.test": ["10.0.0.7"] }),
    isAllowed: (ip: string) => ip === "127.0.0.1",
  };
  const kindOf = (p: Promise<unknown>) =>
    p.then(
      () => "resolved",
      (err) => (err instanceof OutboundError ? err.kind : `other: ${err}`),
    );

  describe("the default policy", () => {
    it("refuses a loopback address before any request reaches it", async () => {
      routes["/secret"] = (_req, res) => res.end("secret");
      expect(await kindOf(outboundRequest(`http://127.0.0.1:${port}/secret`, base))).toBe(
        "blocked",
      );
      expect(hits).toEqual([]);
    });

    it("refuses localhost, which resolves to loopback", async () => {
      routes["/secret"] = (_req, res) => res.end("secret");
      expect(await kindOf(outboundRequest(`http://localhost:${port}/secret`, base))).toBe(
        "blocked",
      );
      expect(hits).toEqual([]);
    });

    it.each([
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://10.0.0.1/",
      "http://2130706433/",
      "http://0x7f.1/",
    ])("refuses %s without connecting", async (url) => {
      await expect(outboundRequest(url, { ...base, timeoutMs: 300 })).rejects.toMatchObject({
        kind: "blocked",
      });
    });

    it("names a refused literal address once", async () => {
      await expect(
        outboundRequest("http://169.254.169.254/latest/meta-data/", base),
      ).rejects.toMatchObject({
        message: "refused: 169.254.169.254 is a private, loopback or link-local address",
      });
    });

    it("refuses a public-looking name that resolves to a private address", async () => {
      const lookup = fakeDns({ "evil.example": ["10.1.2.3"] });
      await expect(
        outboundRequest("http://evil.example/x", { ...base, lookup }),
      ).rejects.toMatchObject({
        kind: "blocked",
        message:
          "refused: evil.example resolves to 10.1.2.3, a private, loopback or link-local address",
      });
      expect(lookup.asked).toEqual(["evil.example"]);
    });
  });

  it("returns status, headers, body and the answering URL", async () => {
    routes["/photo.jpg"] = (_req, res) =>
      res.writeHead(200, { "content-type": "image/jpeg" }).end("jpeg-bytes");
    const res = await outboundRequest(`http://media.test:${port}/photo.jpg`, {
      ...base,
      ...asIfPublic,
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(res.body.toString()).toBe("jpeg-bytes");
    expect(res.url).toBe(`http://media.test:${port}/photo.jpg`);
  });

  it("returns a non-2xx response as it is", async () => {
    const res = await outboundRequest(`http://media.test:${port}/nothing`, {
      ...base,
      ...asIfPublic,
    });
    expect(res.status).toBe(404);
    expect(res.body.toString()).toBe("missing");
  });

  it("sends the method, headers and body it is given", async () => {
    routes["/hook"] = (_req, res) => res.writeHead(204).end();
    const res = await outboundRequest(`http://media.test:${port}/hook`, {
      ...base,
      ...asIfPublic,
      method: "POST",
      headers: { "content-type": "application/json", "x-webhook-signature": "sha256=abc" },
      body: '{"a":1}',
    });
    expect(res.status).toBe(204);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ method: "POST", url: "/hook", body: '{"a":1}' });
    expect(hits[0].headers["x-webhook-signature"]).toBe("sha256=abc");
  });

  it("drains the body unread when asked to", async () => {
    routes["/big"] = (_req, res) => res.end("x".repeat(4096));
    const res = await outboundRequest(`http://media.test:${port}/big`, {
      ...base,
      ...asIfPublic,
      readBody: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(0);
  });

  describe("redirects", () => {
    it("follows one to an allowed host, as a GET", async () => {
      routes["/start"] = (_req, res) => res.writeHead(302, { location: "/final" }).end();
      routes["/final"] = (_req, res) => res.end("arrived");
      const res = await outboundRequest(`http://media.test:${port}/start`, {
        ...base,
        ...asIfPublic,
        method: "POST",
        body: "payload",
      });
      expect(res.body.toString()).toBe("arrived");
      expect(res.url).toBe(`http://media.test:${port}/final`);
      expect(hits.map((h) => [h.method, h.url, h.body])).toEqual([
        ["POST", "/start", "payload"],
        ["GET", "/final", ""],
      ]);
    });

    it("refuses one to an internal IP literal", async () => {
      routes["/start"] = (_req, res) =>
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
      await expect(
        outboundRequest(`http://media.test:${port}/start`, { ...base, ...asIfPublic }),
      ).rejects.toMatchObject({ kind: "blocked" });
    });

    it("refuses one to a name that resolves to a private address", async () => {
      routes["/start"] = (_req, res) =>
        res.writeHead(307, { location: `http://internal.test:${port}/secret` }).end();
      await expect(
        outboundRequest(`http://media.test:${port}/start`, { ...base, ...asIfPublic }),
      ).rejects.toMatchObject({
        kind: "blocked",
        message:
          "refused: internal.test resolves to 10.0.0.7, a private, loopback or link-local address",
      });
    });

    it("refuses one to a non-http scheme", async () => {
      routes["/start"] = (_req, res) =>
        res.writeHead(301, { location: "file:///etc/passwd" }).end();
      await expect(
        outboundRequest(`http://media.test:${port}/start`, { ...base, ...asIfPublic }),
      ).rejects.toMatchObject({ kind: "blocked", message: "refused: file: URLs are not fetched" });
    });

    it("returns the redirect itself once the limit is reached", async () => {
      routes["/start"] = (_req, res) => res.writeHead(302, { location: "/final" }).end("moved");
      routes["/final"] = (_req, res) => res.end("arrived");
      const res = await outboundRequest(`http://media.test:${port}/start`, {
        ...base,
        ...asIfPublic,
        maxRedirects: 0,
      });
      expect(res.status).toBe(302);
      expect(hits.map((h) => h.url)).toEqual(["/start"]);
    });

    it("follows exactly as many as allowed", async () => {
      routes["/a"] = (_req, res) => res.writeHead(302, { location: "/b" }).end();
      routes["/b"] = (_req, res) => res.writeHead(302, { location: "/c" }).end();
      routes["/c"] = (_req, res) => res.end("c");
      const res = await outboundRequest(`http://media.test:${port}/a`, {
        ...base,
        ...asIfPublic,
        maxRedirects: 2,
      });
      expect(res.body.toString()).toBe("c");
    });

    it("returns a 3xx without a Location as it is", async () => {
      routes["/start"] = (_req, res) => res.writeHead(302).end("no location");
      const res = await outboundRequest(`http://media.test:${port}/start`, {
        ...base,
        ...asIfPublic,
      });
      expect(res.status).toBe(302);
      expect(res.body.toString()).toBe("no location");
    });
  });

  describe("limits", () => {
    it("refuses a declared length over the limit", async () => {
      routes["/big"] = (_req, res) =>
        res.writeHead(200, { "content-length": "1025" }).end("x".repeat(1025));
      await expect(
        outboundRequest(`http://media.test:${port}/big`, { ...base, ...asIfPublic }),
      ).rejects.toMatchObject({ kind: "too-large" });
    });

    it("accepts a declared length of exactly the limit", async () => {
      routes["/edge"] = (_req, res) =>
        res.writeHead(200, { "content-length": "1024" }).end("x".repeat(1024));
      const res = await outboundRequest(`http://media.test:${port}/edge`, {
        ...base,
        ...asIfPublic,
      });
      expect(res.body.length).toBe(1024);
    });

    it("refuses an undeclared body once it passes the limit", async () => {
      routes["/stream"] = (_req, res) => {
        res.writeHead(200);
        res.write("x".repeat(1000));
        res.end("x".repeat(25));
      };
      await expect(
        outboundRequest(`http://media.test:${port}/stream`, { ...base, ...asIfPublic }),
      ).rejects.toMatchObject({ kind: "too-large" });
    });

    it("accepts an undeclared body of exactly the limit", async () => {
      routes["/stream"] = (_req, res) => {
        res.writeHead(200);
        res.write("x".repeat(1000));
        res.end("x".repeat(24));
      };
      const res = await outboundRequest(`http://media.test:${port}/stream`, {
        ...base,
        ...asIfPublic,
      });
      expect(res.body.length).toBe(1024);
    });

    it("times out a server that never answers", async () => {
      routes["/hang"] = () => {};
      await expect(
        outboundRequest(`http://media.test:${port}/hang`, {
          ...base,
          ...asIfPublic,
          timeoutMs: 150,
        }),
      ).rejects.toMatchObject({ kind: "timeout", message: "timed out after 150ms" });
    });

    it("times out a body that stops halfway", async () => {
      routes["/stall"] = (_req, res) => {
        res.writeHead(200, { "content-length": "100" });
        res.write("partial");
      };
      await expect(
        outboundRequest(`http://media.test:${port}/stall`, {
          ...base,
          ...asIfPublic,
          timeoutMs: 150,
        }),
      ).rejects.toMatchObject({ kind: "timeout" });
    });

    it("reports a refused connection as a network failure", async () => {
      const closed = http.createServer();
      await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
      const deadPort = (closed.address() as AddressInfo).port;
      await new Promise((resolve) => closed.close(resolve));
      await expect(
        outboundRequest(`http://media.test:${deadPort}/`, { ...base, ...asIfPublic }),
      ).rejects.toMatchObject({ kind: "network" });
    });

    it("keeps the reason of a failure that is not an Error object", async () => {
      const failing = ((_hostname, _options, callback) => {
        callback("resolver unavailable" as unknown as NodeJS.ErrnoException, []);
      }) as LookupAll;
      await expect(
        outboundRequest(`http://media.test:${port}/`, {
          ...base,
          ...asIfPublic,
          lookup: failing,
        }),
      ).rejects.toMatchObject({ kind: "network", message: "resolver unavailable" });
    });
  });
});
