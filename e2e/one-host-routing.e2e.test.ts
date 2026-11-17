import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http, { type IncomingHttpHeaders } from "node:http";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { identityParagraph } from "../src/instance-identity.ts";
import { type RenderedCompose, type RenderedService, renderCompose } from "./support/compose.ts";
import { type E2eHub, startHub } from "./support/hub.ts";
import { type Fetcher, initializeRequest, openSession, post } from "./support/mcp-client.ts";
import { type E2eServer, startServer } from "./support/server.ts";
import { type E2eStore, startStore } from "./support/store.ts";
import {
  type DynamicConfig,
  dynamicConfigFromLabels,
  type RoutedService,
  startTraefik,
  TRAEFIK_VERSION,
  type TraefikProxy,
} from "./support/traefik.ts";

/**
 * Two WhatsApp numbers, each with its OWN media store, and the hub page behind ONE hostname,
 * on the real proxy.
 *
 * Production routes everything by the Traefik labels in `deploy/docker-compose.yaml` (the hub)
 * and `deploy/docker-compose.instance.yaml` (a number and its store). This spec renders those
 * files with the real `docker compose config`, converts the rendered labels mechanically into a
 * configuration for the same Traefik version production runs (`support/traefik.ts`; no rule,
 * priority or name is written here), starts two real stores from the rendered `minio` service
 * (`support/store.ts`, each with its own pair), two real servers and the real hub behind it, and
 * checks what a client of https://wa.e2e.test sees. WhatsApp is never connected, and no spec
 * calls `get_connection_status`.
 *
 * Needs Docker with the images `traefik:v3.6.6` and `rustfs/rustfs:latest` (nothing is pulled);
 * it fails, never skips, without them.
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const SHARED_FILE = path.join(ROOT, "deploy", "docker-compose.yaml");
const INSTANCE_FILE = path.join(ROOT, "deploy", "docker-compose.instance.yaml");
const HOST = "wa.e2e.test";
const LABELS = ["pessoal", "empresa"] as const;
type Label = (typeof LABELS)[number];
const OTHER: Record<Label, Label> = { pessoal: "empresa", empresa: "pessoal" };
/** Made-up numbers: of one, only the last four digits may ever reach the hub's pages. */
const FAKE_NUMBER: Record<Label, string> = { pessoal: "5500000001234", empresa: "5500000005678" };
const DESCRIPTION: Record<Label, string> = {
  pessoal: "the personal line",
  empresa: "the company line",
};
/** The personal number keeps its old media prefix; the new one is named after its label. */
const TENANT: Record<Label, string> = { pessoal: "default", empresa: "empresa" };
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PIN_FORM = 'action="/_hub/login"';
/** A bucket of its own in a store, readable by anyone: the target a path traversal would aim at. */
const NEIGHBOUR_BUCKET = "neighbour-e2e";
const MIB = 1024 * 1024;
const REFUSED = [403, 404];

const secret = (bytes = 16) => randomBytes(bytes).toString("hex");
const url = (pathAndQuery: string) => `https://${HOST}${pathAndQuery}`;
const only = (services: Record<string, RenderedService>, key: string): RenderedService => {
  const service = services[key];
  if (!service) throw new Error(`no service ${key} in ${Object.keys(services)}`);
  return service;
};

/** The settings the app reads that the compose file gives a number's container. */
const APP_SETTINGS = [
  "INSTANCE_LABEL",
  "INSTANCE_DESCRIPTION",
  "TENANT_ID",
  "UPLOAD_PUBLIC_URL",
  "MEDIA_PUBLIC_BASE_URL",
  "STREAM_PUBLIC_URL",
  "PUBLIC_QR_URL",
  "EXPECTED_WA_NUMBER",
  "S3_BUCKET",
];
/** The same for the hub (its address book and PIN are the harness's own). */
const HUB_SETTINGS = [
  "HUB_COOKIE_KEY",
  "HUB_PUBLIC_URL",
  "HUB_LANG",
  "HUB_INSTANCE_SECRET",
  "NTFY_TOPIC_URL",
  "NTFY_TOKEN",
];

function pick(service: RenderedService, keys: string[]): Record<string, string> {
  const env = service.environment ?? {};
  return Object.fromEntries(
    keys.map((key) => {
      const value = env[key];
      if (value === undefined) throw new Error(`the rendered service has no ${key}`);
      return [key, value];
    }),
  );
}

describe("the label converter", () => {
  const GOOD: Record<string, string> = {
    "traefik.enable": "true",
    "traefik.docker.network": "network_public",
    "traefik.http.routers.r.rule": "Host(`a.e2e.test`)",
    "traefik.http.routers.r.priority": "7",
    "traefik.http.routers.r.entrypoints": "websecure",
    "traefik.http.routers.r.tls.certresolver": "myresolver",
    "traefik.http.routers.r.middlewares": "m1,m2",
    "traefik.http.routers.r.service": "s",
    "traefik.http.middlewares.m1.stripprefix.prefixes": "/a,/b",
    "traefik.http.middlewares.m2.replacepathregex.regex": "^/x/(.*)",
    "traefik.http.middlewares.m2.replacepathregex.replacement": "/y/$$1",
    "traefik.http.services.s.loadbalancer.server.port": "9000",
  };
  const convert = (labels: Record<string, string>, ports = { "9000": "http://127.0.0.1:1" }) =>
    dynamicConfigFromLabels([{ service: { image: "x", labels }, ports }]);
  const without = (key: string) => {
    const { [key]: _gone, ...rest } = GOOD;
    return rest;
  };

  it("copies rules, priorities and middlewares as they are, and unescapes compose's $$", () => {
    const { http } = convert(GOOD);

    expect(http.routers).toEqual({
      r: {
        rule: "Host(`a.e2e.test`)",
        priority: 7,
        service: "s",
        middlewares: ["m1", "m2"],
        entryPoints: ["e2e"],
      },
    });
    expect(http.middlewares).toEqual({
      m1: { stripPrefix: { prefixes: ["/a", "/b"] } },
      m2: { replacePathRegex: { regex: "^/x/(.*)", replacement: "/y/$1" } },
    });
    expect(http.services).toEqual({
      s: { loadBalancer: { servers: [{ url: "http://127.0.0.1:1" }] } },
    });
  });

  it.each([
    [
      "a router setting it does not know",
      { ...GOOD, "traefik.http.routers.r.tls.options": "x" },
      /does not understand "tls.options"/,
    ],
    [
      "a service setting it does not know",
      { ...GOOD, "traefik.http.services.s.loadbalancer.sticky": "x" },
      /does not understand "loadbalancer.sticky"/,
    ],
    [
      "a middleware of a kind it does not know",
      { ...GOOD, "traefik.http.middlewares.m3.headers.x": "y" },
      /does not understand "headers.x"/,
    ],
    [
      "a label of another protocol",
      { ...GOOD, "traefik.tcp.routers.t.rule": "x" },
      /not one the converter understands/,
    ],
    ["a router without a rule", without("traefik.http.routers.r.rule"), /label "rule" is missing/],
    [
      "a service on a port nothing is mapped to",
      { ...GOOD, "traefik.http.services.s.loadbalancer.server.port": "9001" },
      /container port 9001/,
    ],
    ["a service that is not exposed", without("traefik.enable"), /not exposed/],
    [
      "a router that names a service nobody defines",
      { ...GOOD, "traefik.http.routers.r.service": "nope" },
      /service nope, which no label defines/,
    ],
    [
      "a router that names a middleware nobody defines",
      { ...GOOD, "traefik.http.routers.r.middlewares": "m1,nope" },
      /middleware nope, which no label defines/,
    ],
  ])("refuses %s", (_what, labels, message) => {
    expect(() => convert(labels)).toThrow(message);
  });

  it("refuses a router, a service or a middleware defined by two services", () => {
    const service: RoutedService = {
      service: { image: "x", labels: GOOD },
      ports: { "9000": "http://127.0.0.1:1" },
    };

    expect(() => dynamicConfigFromLabels([service, service])).toThrow(/router r is defined by two/);
  });
});

describe("two numbers and the hub behind one host, on Traefik", () => {
  const pin = secret(6);
  const servers = {} as Record<Label, E2eServer>;
  const stores = {} as Record<Label, E2eStore>;
  const compose = {} as Record<Label, RenderedCompose>;
  const rendered = {} as Record<Label, RenderedService>;
  const uploads = {} as Record<Label, { key: string; url: string; bytes: Buffer }>;
  /** Everything the hub (or the proxy itself) answered, for the last test. */
  const hubSeen: string[] = [];
  let dataDirOfPessoal: string;
  let hub: E2eHub;
  let hubService: RenderedService;
  let config: DynamicConfig;
  let proxy: TraefikProxy;
  let bucket: string;

  const viaProxy: Fetcher = (target, init) => proxy.fetch(target, init);

  function renderInstance(label: Label, extra: Record<string, string> = {}): RenderedCompose {
    return renderCompose({
      file: INSTANCE_FILE,
      env: {
        COMPOSE_FILE: "docker-compose.instance.yaml",
        INSTANCE: label,
        PUBLIC_DOMAIN: HOST,
        MCP_AUTH_TOKEN: secret(),
        MINIO_ROOT_USER: secret(),
        MINIO_ROOT_PASSWORD: secret(),
        EXPECTED_WA_NUMBER: FAKE_NUMBER[label],
        INSTANCE_DESCRIPTION: DESCRIPTION[label],
        ...extra,
      },
    });
  }

  /** Where a server of this harness finds its own number's store: loopback, that store's pair. */
  function storeEnv(label: Label): Record<string, string> {
    const env = rendered[label].environment ?? {};
    return {
      S3_ENDPOINT: "127.0.0.1",
      S3_PORT: String(stores[label].port),
      S3_USE_SSL: "false",
      S3_ACCESS_KEY: env.S3_ACCESS_KEY as string,
      S3_SECRET_KEY: env.S3_SECRET_KEY as string,
    };
  }

  /** Container port (from the instance's own env) to the local process that stands in for it. */
  function portsOf(service: RenderedService, server: E2eServer): Record<string, string> {
    const env = service.environment ?? {};
    return {
      [env.MCP_PORT as string]: new URL(server.mcpUrl).origin,
      [env.QR_SERVER_PORT as string]: server.qrUrl,
      [env.UPLOAD_SERVER_PORT as string]: server.uploadUrl as string,
      [env.STREAM_SERVER_PORT as string]: server.streamUrl,
    };
  }

  beforeAll(async () => {
    dataDirOfPessoal = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-mcp-onehost-"));
    const shared = renderCompose({
      file: SHARED_FILE,
      env: {
        PUBLIC_DOMAIN: HOST,
        HUB_PIN: pin,
        HUB_COOKIE_KEY: secret(32),
        HUB_INSTANCES: LABELS.join(","),
      },
    });
    hubService = only(shared.services, "hub");
    // The personal number as it will be deployed: its old data directory and media prefix.
    compose.pessoal = renderInstance("pessoal", {
      INSTANCE_DATA_DIR: dataDirOfPessoal,
      TENANT_ID: "default",
    });
    compose.empresa = renderInstance("empresa");
    for (const label of LABELS)
      rendered[label] = only(compose[label].services, "whatsapp-mcp-instance");
    bucket = rendered.pessoal.environment?.S3_BUCKET as string;

    // Each number's store first (the server ensures its bucket at start), from the rendered
    // service and that number's own pair.
    const storesUp = await Promise.allSettled(
      LABELS.map(async (label) => {
        stores[label] = await startStore(compose[label]);
      }),
    );
    for (const result of storesUp) if (result.status === "rejected") throw result.reason;

    const started = await Promise.allSettled(
      LABELS.map(async (label) => {
        const dataDir = label === "pessoal" ? rendered.pessoal.volumes?.[0]?.source : undefined;
        servers[label] = await startServer({
          s3: true,
          dataDir,
          env: { ...pick(rendered[label], APP_SETTINGS), ...storeEnv(label) },
        });
      }),
    );
    for (const result of started) if (result.status === "rejected") throw result.reason;

    const labelsOfHub = (hubService.environment?.HUB_INSTANCES ?? "").split(",") as Label[];
    hub = await startHub({
      instances: labelsOfHub.map((label) => ({ label, url: servers[label].qrUrl })),
      pin: hubService.environment?.HUB_PIN,
      env: pick(hubService, HUB_SETTINGS),
    });

    const routed: RoutedService[] = [
      { service: hubService, ports: { "39002": hub.url } },
      ...LABELS.flatMap((label) => [
        { service: rendered[label], ports: portsOf(rendered[label], servers[label]) },
        { service: only(compose[label].services, "minio"), ports: { "9000": stores[label].url } },
      ]),
    ];
    config = dynamicConfigFromLabels(routed);
    proxy = await startTraefik(config);
  }, 180_000);

  afterAll(async () => {
    const results = await Promise.allSettled([
      proxy?.stop(),
      hub?.stop(),
      ...Object.values(servers).map((server) => server.stop()),
      ...Object.values(stores).map((store) => store.stop()),
    ]);
    fs.rmSync(dataDirOfPessoal, { recursive: true, force: true });
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  }, 90_000);

  /** A request the hub is expected to answer: recorded for the leak check. */
  async function hubAnswer(pathAndQuery: string, init?: RequestInit) {
    const res = await proxy.fetch(url(pathAndQuery), init);
    const body = await res.text();
    const headers = [...res.headers].map(([name, value]) => `${name}: ${value}`).join("\n");
    hubSeen.push(`${res.status}\n${headers}\n${body}`);
    return { status: res.status, body, headers: res.headers };
  }

  /** Logs in through the proxy; the cookie is `Secure`, so the client carries it by hand. */
  async function login(): Promise<string> {
    const res = await hubAnswer("/_hub/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ pin }),
    });
    expect(res.status).toBe(303);
    return (res.headers.get("set-cookie") ?? "").split(";")[0] as string;
  }

  describe("the proxy", () => {
    it("is Traefik v3.6.6 and loads every router the labels define, enabled and as written", async () => {
      expect(proxy.version).toBe(TRAEFIK_VERSION);
      const written = Object.entries(config.http.routers);
      const loaded = (await proxy.routers()).filter((router) => router.provider === "file");

      // Per number: mcp, upload, stream and its own media route; shared: the hub.
      expect(written).toHaveLength(LABELS.length * 4 + 1);
      expect(loaded.map((router) => router.name).sort()).toEqual(
        written.map(([name]) => `${name}@file`).sort(),
      );
      for (const [name, router] of written) {
        expect(loaded.find((one) => one.name === `${name}@file`)).toMatchObject({
          status: "enabled",
          rule: router.rule,
          priority: router.priority,
          service: router.service,
        });
      }
    });

    it("has no service that points at either number's status port", () => {
      const targets = Object.values(config.http.services).flatMap((service) =>
        service.loadBalancer.servers.map((one) => one.url),
      );

      for (const label of LABELS) expect(targets).not.toContain(servers[label].qrUrl);
      expect(targets).toContain(hub.url);
      // Each number's media route leads to that number's own store, and to no other.
      for (const label of LABELS) expect(targets).toContain(stores[label].url);
      expect(new Set(targets).size).toBe(targets.length);
    });
  });

  describe.each(LABELS)("1. %s answers at its own path to its own token", (label) => {
    const other = OTHER[label];

    it("opens a session with its own token and says which line it is", async () => {
      const env = rendered[label].environment ?? {};
      const session = await openSession(url(`/${label}/mcp`), servers[label].token, viaProxy);
      try {
        const opening = identityParagraph({
          label: env.INSTANCE_LABEL as string,
          description: env.INSTANCE_DESCRIPTION,
        });
        expect(env.INSTANCE_LABEL).toBe(label);
        expect(session.instructions.startsWith(opening)).toBe(true);
        expect(session.instructions).not.toContain(other);
      } finally {
        await session.close();
      }
    });

    it("refuses the other number's token, and no token", async () => {
      for (const authorization of [`Bearer ${servers[other].token}`, undefined]) {
        const res = await post(
          url(`/${label}/mcp`),
          initializeRequest,
          { authorization },
          viaProxy,
        );

        expect(res.status).toBe(401);
        expect(res.sessionId).toBeNull();
      }
    });
  });

  describe.each(LABELS)("2. %s takes uploads at its own path, under its own prefix", (label) => {
    const send = (token: string, bytes: Buffer) =>
      proxy.fetch(url(`/${label}/upload`), {
        method: "POST",
        body: new Uint8Array(bytes),
        headers: { authorization: `Bearer ${token}` },
      });

    it("stores an upload under t/<tenant>/ and returns its public URL on this host", async () => {
      const bytes = Buffer.concat([PNG_MAGIC, randomBytes(1024)]);

      const res = await send(servers[label].token, bytes);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.key).toMatch(new RegExp(`^t/${TENANT[label]}/uploads/[0-9a-f-]{36}\\.png$`));
      expect(body.url).toBe(url(`/${label}/media/${body.key}`));
      uploads[label] = { key: body.key, url: body.url, bytes };
    });

    it("refuses the other number's token", async () => {
      const res = await send(
        servers[OTHER[label]].token,
        Buffer.concat([PNG_MAGIC, randomBytes(64)]),
      );

      expect(res.status).toBe(401);
    });
  });

  describe("3. media: each label reaches its own store, and only that one", () => {
    /** One GET with the path exactly as written: `fetch` would fold `..` and `%2e%2e` away. */
    function rawGet(target: string): Promise<{ status: number; body: Buffer }> {
      return new Promise((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port: proxy.port, path: target, headers: { host: HOST } },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
    }

    const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

    it("serves the object a number uploaded through its own route, byte for byte", async () => {
      for (const label of LABELS) {
        const upload = uploads[label];
        expect(upload.url.startsWith(url(`/${label}/media/`))).toBe(true);

        const res = await proxy.fetch(upload.url);

        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("image/png");
        expect(Buffer.from(await res.arrayBuffer()).equals(upload.bytes)).toBe(true);
      }
    });

    it.each(LABELS)(
      "%s: the same path under the other label answers 403 or 404, never the bytes",
      async (label) => {
        const res = await proxy.fetch(url(`/${OTHER[label]}/media/${uploads[label].key}`));

        expect(REFUSED).toContain(res.status);
        expect(Buffer.from(await res.arrayBuffer()).equals(uploads[label].bytes)).toBe(false);
      },
    );

    it.each(LABELS)(
      "%s: an object written straight into its store is served on its label and on no other",
      async (label) => {
        const key = `t/${TENANT[label]}/direct-${label}.png`;
        const bytes = Buffer.concat([PNG_MAGIC, randomBytes(256)]);
        await stores[label].client().putObject(bucket, key, bytes, bytes.length, {
          "Content-Type": "image/png",
        });

        const own = await proxy.fetch(url(`/${label}/media/${key}`));
        const other = await proxy.fetch(url(`/${OTHER[label]}/media/${key}`));

        expect(own.status).toBe(200);
        expect(Buffer.from(await own.arrayBuffer()).equals(bytes)).toBe(true);
        expect(REFUSED).toContain(other.status);
        expect(Buffer.from(await other.arrayBuffer()).equals(bytes)).toBe(false);
      },
    );

    it("keeps one key's bytes apart when both stores hold that key", async () => {
      const key = "t/shared/same-key.bin";
      const written = {} as Record<Label, Buffer>;
      for (const label of LABELS) {
        written[label] = randomBytes(512);
        await stores[label].client().putObject(bucket, key, written[label], written[label].length);
      }

      for (const label of LABELS) {
        const res = await proxy.fetch(url(`/${label}/media/${key}`));
        const got = Buffer.from(await res.arrayBuffer());

        expect(res.status).toBe(200);
        expect(sha(got)).toBe(sha(written[label]));
        expect(sha(got)).not.toBe(sha(written[OTHER[label]]));
      }
    });

    it.each(LABELS)(
      "%s: its store refuses the other number's pair on a signed call, and takes its own",
      async (label) => {
        const theirs = stores[OTHER[label]];

        await expect(
          stores[label]
            .client({ accessKey: theirs.accessKey, secretKey: theirs.secretKey })
            .bucketExists(bucket),
        ).rejects.toMatchObject({ code: "InvalidAccessKeyId" });
        expect(await stores[label].client().bucketExists(bucket)).toBe(true);
      },
    );

    it("rewrites into the bucket the servers write to, one rule per label, with a single $", () => {
      const rewrites = Object.entries(config.http.middlewares).filter(
        ([, middleware]) => "replacePathRegex" in middleware,
      );

      expect(rewrites.map(([name]) => name).sort()).toEqual(
        LABELS.map((label) => `wa-${label}-media-rewrite`).sort(),
      );
      for (const label of LABELS) {
        expect(config.http.middlewares[`wa-${label}-media-rewrite`]).toEqual({
          replacePathRegex: { regex: `^/${label}/media/(.*)`, replacement: `/${bucket}/$1` },
        });
      }
    });

    describe.each(LABELS)("%s: listing stays closed", (label) => {
      it.each([`/${label}/media/`, `/${label}/media/?list-type=2`])(
        "answers %s with the hub's PIN form, never with the bucket",
        async (target) => {
          const res = await hubAnswer(target);

          expect(res.status).toBe(401);
          expect(res.body).toContain(PIN_FORM);
          expect(res.body).not.toContain(uploads[label].key);
          expect(res.body).not.toContain("ListBucketResult");
          expect(res.body).not.toContain(bucket);
        },
      );

      it.each([
        `/${label}/media/t/`,
        `/${label}/media/t/?list-type=2`,
        `/${label}/media/t/${TENANT[label]}/`,
      ])("lets %s reach the bucket, which refuses to list anything", async (target) => {
        const res = await proxy.fetch(url(target));
        const body = await res.text();

        expect(res.status).toBe(404);
        expect(body).toContain("<Error>");
        expect(body).not.toContain("ListBucketResult");
        expect(body).not.toContain("<Key>");
        expect(body).not.toContain(uploads[label].key);
      });
    });

    it.each(["/outro/media/t/default/a.png", "/outro/media/", "/media/t/default/a.png"])(
      "answers %s, a label no number has, with the hub's PIN form",
      async (target) => {
        const res = await hubAnswer(target);

        expect(res.status).toBe(401);
        expect(res.body).toContain(PIN_FORM);
      },
    );

    describe.each(LABELS)("%s: the path cannot be walked out of its bucket", (label) => {
      const hidden = randomBytes(24).toString("hex");

      beforeAll(async () => {
        const client = stores[label].client();
        await client.makeBucket(NEIGHBOUR_BUCKET, "us-east-1");
        await client.setBucketPolicy(
          NEIGHBOUR_BUCKET,
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: "*",
                Action: "s3:GetObject",
                Resource: `arn:aws:s3:::${NEIGHBOUR_BUCKET}/*`,
              },
            ],
          }),
        );
        await client.putObject(NEIGHBOUR_BUCKET, "public.txt", Buffer.from(hidden));
      });

      it("has a neighbour bucket that anyone can read straight from the store, as the control", async () => {
        const res = await fetch(`${stores[label].url}/${NEIGHBOUR_BUCKET}/public.txt`);

        expect(res.status).toBe(200);
        expect(await res.text()).toBe(hidden);
      });

      // The proxy folds `..` and `%2e%2e` away (the path then matches no media route and falls
      // through to the hub) and refuses an encoded slash with 400; whichever it does, the
      // neighbour's bytes must never come back.
      const walks = [
        `/${label}/media/t/../../${NEIGHBOUR_BUCKET}/public.txt`,
        `/${label}/media/t/%2e%2e/%2e%2e/${NEIGHBOUR_BUCKET}/public.txt`,
        `/${label}/media/t/..%2f..%2f${NEIGHBOUR_BUCKET}/public.txt`,
        `/${label}/media/t/%2e%2e%2f%2e%2e%2f${NEIGHBOUR_BUCKET}/public.txt`,
        `/${label}/media/t//../../${NEIGHBOUR_BUCKET}/public.txt`,
      ];

      it.each(walks)("never lets %s read it through the proxy", async (target) => {
        const res = await rawGet(target);

        expect(res.body.toString("utf8")).not.toContain(hidden);
        expect([400, 401, 403, 404]).toContain(res.status);
      });
    });
  });

  describe("4. stream", () => {
    type RefusedUpgrade = {
      accepted: false;
      status: number;
      headers: IncomingHttpHeaders;
      body: string;
    };
    type Upgrade = { accepted: true } | RefusedUpgrade;

    /** One WebSocket handshake through the proxy; closes whatever it opens. */
    function upgrade(pathAndQuery: string): Promise<Upgrade> {
      return new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${proxy.port}${pathAndQuery}`, {
          headers: { host: HOST },
          handshakeTimeout: 10_000,
        });
        socket.once("error", reject);
        socket.once("open", () => {
          socket.once("close", () => resolve({ accepted: true }));
          socket.close();
        });
        socket.once("unexpected-response", (_req, res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            resolve({
              accepted: false,
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            });
            socket.terminate();
          });
        });
      });
    }

    /** The path and query a stream token is good for, as the number itself announces them. */
    async function streamAddress(label: Label): Promise<{ path: string; query: string }> {
      const session = await openSession(url(`/${label}/mcp`), servers[label].token, viaProxy);
      try {
        const followed = JSON.parse((await session.callTool("follow_chat")).text);
        const announced = new URL(followed.ws_url);
        expect(announced.protocol).toBe("wss:");
        expect(announced.host).toBe(HOST);
        expect(announced.pathname).toBe(`/${label}/stream`);
        return { path: announced.pathname, query: announced.search };
      } finally {
        await session.close();
      }
    }

    /** What the app itself says when it turns a handshake away: no page, no hub headers. */
    function refusedByTheApp(result: Upgrade) {
      expect(result).toMatchObject({ accepted: false, status: 401, body: "" });
      expect((result as RefusedUpgrade).headers["content-security-policy"]).toBeUndefined();
    }

    it.each(LABELS)(
      "%s: its own token opens its stream, and the other number's stream refuses it",
      async (label) => {
        const own = await streamAddress(label);
        const theirs = await streamAddress(OTHER[label]);

        expect(await upgrade(`${own.path}${own.query}`)).toEqual({ accepted: true });
        // The same token at the other number's path: reached, and refused by that app.
        refusedByTheApp(await upgrade(`/${OTHER[label]}/stream${own.query}`));
        // And the other way round: this number refuses a token only the other one issued.
        refusedByTheApp(await upgrade(`${own.path}${theirs.query}`));
      },
    );

    it.each(LABELS)("%s: refuses a handshake with a bad token or none", async (label) => {
      refusedByTheApp(await upgrade(`/${label}/stream?token=not-a-token`));
      refusedByTheApp(await upgrade(`/${label}/stream`));
    });

    it("answers a stream path no router claims with the hub's page, which the check above tells apart", async () => {
      const result = (await upgrade("/pessoal/stream/")) as RefusedUpgrade;

      expect(result).toMatchObject({ accepted: false, status: 401 });
      expect(result.body).toContain(PIN_FORM);
      expect(result.headers["content-security-policy"]).toBeDefined();
    });
  });

  describe.each(LABELS)("5. %s's status port is not routed", (label) => {
    const paths = ["health", "qr.png", "live", "internal/unlink"].map(
      (leaf) => `/${label}/${leaf}`,
    );

    it("answers on the status port itself, which is what the proxy must not show", async () => {
      const health = await (await fetch(`${servers[label].qrUrl}/health`)).json();

      expect(health).toMatchObject({ instance: { label } });
      expect(await (await fetch(`${servers[label].qrUrl}/live`)).json()).toEqual({ live: true });
    });

    it.each(paths)(
      "answers GET %s with the hub's PIN form and nothing of the number",
      async (target) => {
        const res = await hubAnswer(target);

        expect(res.status).toBe(401);
        expect(res.headers.get("content-type")).toContain("text/html");
        expect(res.body).toContain(PIN_FORM);
        expect(res.body).not.toContain("disconnected_for_s");
        expect(res.body).not.toContain('"live"');
      },
    );

    it(`answers POST /${label}/internal/unlink with the hub's PIN form too`, async () => {
      const res = await hubAnswer(`/${label}/internal/unlink`, { method: "POST", body: "x" });

      expect(res.status).toBe(401);
      expect(res.body).toContain(PIN_FORM);
    });
  });

  describe("6. everything else is the hub, behind its PIN", () => {
    it.each([
      "/",
      "/pessoal",
      "/_hub/status.json",
      "/outro/mcp",
      "/pessoal/mcpx",
      "/pessoal/mcp/",
      "/live",
    ])(
      "answers GET %s without a session with the PIN form and nothing about the numbers",
      async (target) => {
        const res = await hubAnswer(target);

        expect(res.status).toBe(401);
        expect(res.body).toContain(PIN_FORM);
        for (const word of [...LABELS, ...Object.values(DESCRIPTION), "1234", "5678"]) {
          if (target.includes(word)) continue; // the path itself comes back as the `next` value
          expect(res.body).not.toContain(word);
        }
      },
    );

    it("shows both numbers, as themselves, after a login through the proxy", async () => {
      const cookie = await login();
      const home = await hubAnswer("/", { headers: { cookie } });
      const status = await hubAnswer("/_hub/status.json", { headers: { cookie } });
      const deepLink = await hubAnswer("/pessoal", { headers: { cookie } });

      expect(home.status).toBe(200);
      for (const label of LABELS) expect(home.body).toMatch(new RegExp(`data-label="${label}"`));
      expect(home.body.match(/<article\b/g)).toHaveLength(2);
      expect(status.status).toBe(200);
      expect(JSON.parse(status.body).instances).toEqual(
        LABELS.map((label) => ({
          label,
          description: DESCRIPTION[label],
          phone_last4: FAKE_NUMBER[label].slice(-4),
          state: "disconnected",
          down_for_s: null,
          qr_rev: null,
          mcp_url: `https://${HOST}/${label}/mcp`,
        })),
      );
      expect(deepLink.body).toMatch(/<article class="card is-target" id="card-pessoal"/);
    });

    it("gives a request for another host Traefik's own 404", async () => {
      const res = await proxy.fetch("https://other.e2e.test/");

      expect(res.status).toBe(404);
      expect(await res.text()).toBe("404 page not found\n");
    });
  });

  describe("7. each number writes only its own database", () => {
    const rowsOf = (server: E2eServer): string[] => {
      const db = new Database(path.join(server.dataDir, "data", "whatsapp.db"), { readonly: true });
      try {
        return db
          .prepare("SELECT target_url FROM webhook_subscriptions")
          .all()
          .map((row) => (row as { target_url: string }).target_url);
      } finally {
        db.close();
      }
    };

    async function webhooksOf(label: Label): Promise<string[]> {
      const session = await openSession(url(`/${label}/mcp`), servers[label].token, viaProxy);
      try {
        const listed = JSON.parse((await session.callTool("list_webhooks")).text);
        return listed.map((hook: { target_url: string }) => hook.target_url);
      } finally {
        await session.close();
      }
    }

    it("keeps the two numbers on two different data directories", () => {
      expect(servers.pessoal.dataDir).toBe(dataDirOfPessoal);
      expect(servers.empresa.dataDir).not.toBe(servers.pessoal.dataDir);
    });

    it.each(LABELS)(
      "%s: a write through its path is in its file and in nobody else's",
      async (label) => {
        const target = `https://hooks-${label}.e2e.test/inbound`;
        const session = await openSession(url(`/${label}/mcp`), servers[label].token, viaProxy);
        try {
          const registered = await session.callTool("register_webhook", {
            target_url: target,
            allowed_jids: ["*"],
            label: `e2e-${label}`,
          });
          expect(registered.isError).toBe(false);
        } finally {
          await session.close();
        }

        expect(await webhooksOf(label)).toEqual([target]);
        expect(await webhooksOf(OTHER[label])).not.toContain(target);
        expect(rowsOf(servers[label])).toContain(target);
        expect(rowsOf(servers[OTHER[label]])).not.toContain(target);
      },
    );
  });

  describe("8. nothing leaks through the proxy", () => {
    /** The longest stretch of `digits` that `text` contains, in digits. */
    function longestShared(text: string, digits: string): number {
      let longest = 0;
      for (let from = 0; from < digits.length; from++) {
        while (
          from + longest + 1 <= digits.length &&
          text.includes(digits.slice(from, from + longest + 1))
        ) {
          longest++;
        }
      }
      return longest;
    }

    it("shows no token, no PIN and no more than four digits of a number in anything the hub answered", () => {
      const everything = hubSeen.join("\n");

      // The hub does show the last four digits, so the check below is not looking at nothing.
      expect(hubSeen.length).toBeGreaterThanOrEqual(20);
      expect(everything).toContain("1234");
      for (const label of LABELS) {
        expect(everything).not.toContain(servers[label].token);
        expect(longestShared(everything, FAKE_NUMBER[label])).toBeLessThanOrEqual(4);
        expect(everything).not.toContain(stores[label].accessKey);
        expect(everything).not.toContain(stores[label].secretKey);
      }
      expect(everything).not.toContain(pin);
    });
  });

  describe("9. each store keeps to its 150 MiB ceiling", () => {
    const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

    it.each(LABELS)(
      "%s: the store the rendered service describes is capped and healthy",
      (label) => {
        expect(stores[label].inspect()).toMatchObject({
          memory: 157286400,
          health: "healthy",
          running: true,
          oomKilled: false,
          restarts: 0,
        });
      },
    );

    it("takes four 16 MiB objects in parallel on each store, hands them back identical, and survives", async () => {
      const objects = LABELS.flatMap((label) =>
        [0, 1, 2, 3].map((n) => ({
          label,
          key: `t/e2e-ceiling/${n}.bin`,
          bytes: randomBytes(16 * MIB),
        })),
      );

      await Promise.all(
        objects.map(({ label, key, bytes }) =>
          stores[label].client().putObject(bucket, key, bytes, bytes.length),
        ),
      );
      const back = await Promise.all(
        objects.map(async ({ label, key }) => {
          const chunks: Buffer[] = [];
          for await (const chunk of await stores[label].client().getObject(bucket, key)) {
            chunks.push(chunk);
          }
          return Buffer.concat(chunks);
        }),
      );

      expect(back.map(sha)).toEqual(objects.map(({ bytes }) => sha(bytes)));
      for (const label of LABELS) {
        expect(stores[label].inspect()).toMatchObject({
          memory: 157286400,
          health: "healthy",
          running: true,
          oomKilled: false,
          restarts: 0,
        });
      }
    }, 120_000);
  });
});
