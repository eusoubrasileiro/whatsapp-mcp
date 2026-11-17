/**
 * Harness: runs the REAL reverse proxy (Traefik, the version production runs) in a throwaway
 * container, in front of real servers started with `startServer` / `startHub`, and turns the
 * rendered `traefik.http.*` labels of the compose files into the configuration it runs on.
 *
 * Nothing about a route is written here or in a spec: the rules, priorities, middlewares and
 * service names are the label values `docker compose config` printed. Labels are read by the
 * Docker provider in production and by the file provider here, so the two paths differ in
 * exactly the places this file names (entrypoint, TLS, container ports to local URLs) and in
 * nothing else. A label this converter does not know is an error, never a silent skip.
 *
 * The container is started with `--rm`, on the host network, with a random name starting with
 * `whatsapp-mcp-e2e-traefik-`, and is removed by `stop()` and again when the process exits.
 * Nothing is pulled: a missing image fails with the command that fetches it.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { RenderedService } from "./compose.ts";
import type { Fetcher } from "./mcp-client.ts";
import { freePort } from "./server.ts";

/** What production runs: `traefik:v3` is not enough, the spec must prove the labels on this one. */
export const TRAEFIK_VERSION = "3.6.6";
const IMAGE = `traefik:v${TRAEFIK_VERSION}`;
const CONTAINER_PREFIX = "whatsapp-mcp-e2e-traefik-";
const ENTRYPOINT = "e2e";
const MOUNT = "/etc/traefik-e2e";
const READY_TIMEOUT_MS = 20_000;
const LAUNCH_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 15_000;

interface RouterConfig {
  rule: string;
  service: string;
  entryPoints: string[];
  priority?: number;
  middlewares?: string[];
}

type MiddlewareConfig =
  | { stripPrefix: { prefixes: string[] } }
  | { replacePathRegex: { regex: string; replacement: string } };

/** The file provider's `http` section: what the Docker provider would build from the labels. */
export interface DynamicConfig {
  http: {
    routers: Record<string, RouterConfig>;
    middlewares: Record<string, MiddlewareConfig>;
    services: Record<string, { loadBalancer: { servers: { url: string }[] } }>;
  };
}

/** One compose service with Traefik labels, and where each of its container ports runs here. */
export interface RoutedService {
  service: RenderedService;
  /** Container port (as in the label) to the local base URL of the process standing in for it. */
  ports: Record<string, string>;
}

type Settings = Record<string, string>;
type Section = Record<string, Settings>;

/** Hands out the settings of one object, and refuses what nobody asked for. */
function reader(what: string, settings: Settings) {
  const rest = new Map(Object.entries(settings));
  const take = (key: string): string | undefined => {
    const value = rest.get(key);
    rest.delete(key);
    return value;
  };
  return {
    take,
    need(key: string): string {
      const value = take(key);
      if (value === undefined || value === "")
        throw new Error(`${what}: label "${key}" is missing`);
      return value;
    },
    done() {
      if (rest.size > 0) {
        throw new Error(
          `${what}: the converter does not understand ${[...rest.keys()].map((k) => `"${k}"`).join(", ")}`,
        );
      }
    },
  };
}

function convertRouter(name: string, settings: Settings): RouterConfig {
  const labels = reader(`router ${name}`, settings);
  const router: RouterConfig = {
    rule: labels.need("rule"),
    service: labels.need("service"),
    entryPoints: [ENTRYPOINT],
  };
  const priority = labels.take("priority");
  if (priority !== undefined) router.priority = Number(priority);
  const middlewares = labels.take("middlewares");
  if (middlewares) router.middlewares = middlewares.split(",");
  // The test entrypoint stands in for `websecure`, and there is no TLS here: these two labels
  // are the only ones that are replaced instead of copied.
  labels.take("entrypoints");
  labels.take("tls.certresolver");
  labels.done();
  return router;
}

function convertMiddleware(name: string, settings: Settings): MiddlewareConfig {
  const labels = reader(`middleware ${name}`, settings);
  const prefixes = labels.take("stripprefix.prefixes");
  const regex = labels.take("replacepathregex.regex");
  const replacement = labels.take("replacepathregex.replacement");
  labels.done();
  if (prefixes !== undefined && regex === undefined && replacement === undefined) {
    return { stripPrefix: { prefixes: prefixes.split(",") } };
  }
  if (regex !== undefined && replacement !== undefined && prefixes === undefined) {
    return { replacePathRegex: { regex, replacement } };
  }
  throw new Error(
    `middleware ${name}: the labels are not one complete stripprefix or replacepathregex`,
  );
}

function convertService(name: string, settings: Settings, ports: Record<string, string>) {
  const labels = reader(`service ${name}`, settings);
  const port = labels.need("loadbalancer.server.port");
  labels.done();
  const url = ports[port];
  if (!url) {
    throw new Error(
      `service ${name}: nothing is mapped to container port ${port} (known: ${Object.keys(ports).join(", ")})`,
    );
  }
  return { loadBalancer: { servers: [{ url }] } };
}

const HTTP_LABEL = /^traefik\.http\.(routers|services|middlewares)\.([^.]+)\.(.+)$/;
/** Labels about the Docker provider itself; they say nothing about a route. */
const PROVIDER_LABELS = new Set(["traefik.docker.network"]);

/** Groups `traefik.http.<kind>.<name>.<setting>` labels, and refuses any other `traefik.*`. */
function groupLabels(labels: Settings) {
  const groups: Record<"routers" | "services" | "middlewares", Section> = {
    routers: {},
    services: {},
    middlewares: {},
  };
  for (const [key, raw] of Object.entries(labels)) {
    if (!key.startsWith("traefik.") || PROVIDER_LABELS.has(key) || key === "traefik.enable")
      continue;
    const match = HTTP_LABEL.exec(key);
    if (!match) throw new Error(`label "${key}" is not one the converter understands`);
    const [, kind, name, setting] = match as unknown as [
      string,
      keyof typeof groups,
      string,
      string,
    ];
    // `docker compose config` prints a literal `$` (a regex replacement's `$1`) as `$$`.
    const value = raw.split("$$").join("$");
    groups[kind][name] = { ...groups[kind][name], [setting]: value };
  }
  return groups;
}

function addEach<T>(target: Record<string, T>, additions: Record<string, T>, kind: string) {
  for (const [name, value] of Object.entries(additions)) {
    if (name in target) throw new Error(`${kind} ${name} is defined by two labelled services`);
    target[name] = value;
  }
}

function checkReferences(http: DynamicConfig["http"]) {
  for (const [name, router] of Object.entries(http.routers)) {
    if (!(router.service in http.services)) {
      throw new Error(`router ${name} names the service ${router.service}, which no label defines`);
    }
    for (const middleware of router.middlewares ?? []) {
      if (!(middleware in http.middlewares)) {
        throw new Error(
          `router ${name} names the middleware ${middleware}, which no label defines`,
        );
      }
    }
  }
}

/**
 * The file-provider configuration equivalent to the labels of `routed`, every router on the
 * test entrypoint. Throws on any label it cannot convert faithfully.
 */
export function dynamicConfigFromLabels(routed: RoutedService[]): DynamicConfig {
  const http: DynamicConfig["http"] = { routers: {}, middlewares: {}, services: {} };
  for (const { service, ports } of routed) {
    const labels = service.labels ?? {};
    if (labels["traefik.enable"] !== "true") {
      throw new Error(
        `a labelled service is not exposed: traefik.enable is ${labels["traefik.enable"]}`,
      );
    }
    const groups = groupLabels(labels);
    const entries = <T>(section: Section, convert: (name: string, settings: Settings) => T) =>
      Object.fromEntries(Object.entries(section).map(([name, s]) => [name, convert(name, s)]));
    addEach(http.routers, entries(groups.routers, convertRouter), "router");
    addEach(http.middlewares, entries(groups.middlewares, convertMiddleware), "middleware");
    addEach(
      http.services,
      entries(groups.services, (name, settings) => convertService(name, settings, ports)),
      "service",
    );
  }
  checkReferences(http);
  return { http };
}

/** One router as Traefik's own API reports it (`GET /api/http/routers`). */
interface LoadedRouter {
  name: string;
  status: string;
  error?: string[];
  rule: string;
  priority: number;
  service: string;
  middlewares?: string[];
  provider: string;
}

export interface TraefikProxy {
  /** The loopback port of the test entrypoint. */
  port: number;
  /** The version the running proxy reports about itself. */
  version: string;
  /**
   * `fetch` for the proxy: connects to the entrypoint whatever the URL's host, and sends that
   * host (`https://wa.e2e.test/...` in, `Host: wa.e2e.test` out). Never follows a redirect.
   */
  fetch: Fetcher;
  /** The routers the proxy loaded from the file, with the status it gave each. */
  routers(): Promise<LoadedRouter[]>;
  /** Removes the container and the config directory; safe to call twice. */
  stop(): Promise<void>;
}

function docker(args: string[]) {
  const run = spawnSync("docker", args, { encoding: "utf8" });
  if (run.error) throw run.error;
  return { status: run.status, out: run.stdout.trim(), err: run.stderr.trim() };
}

const running = new Set<string>();
let exitHookInstalled = false;

/** A spec that dies before `afterAll` must not leave a container behind. */
function removeOnExit(name: string) {
  running.add(name);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const left of running) spawnSync("docker", ["rm", "-f", left], { stdio: "ignore" });
  });
}

function requireImage() {
  let said = "";
  try {
    const probe = docker(["image", "inspect", IMAGE, "--format", "{{.Id}}"]);
    if (probe.status === 0) return;
    said = probe.err;
  } catch (err) {
    said = (err as Error).message;
  }
  throw new Error(
    `The routing spec needs Docker and the Traefik image ${IMAGE}, and does not pull it.\n` +
      `Run once: docker pull ${IMAGE}\n(docker said: ${said})`,
  );
}

function toBuffer(body: RequestInit["body"]): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof Uint8Array) return Buffer.from(body);
  throw new Error("the proxy fetch sends a string, URLSearchParams or bytes only");
}

/** `fetch`-shaped, over `node:http`, because `fetch` drops a caller's `Host` header. */
function fetchVia(port: number): Fetcher {
  return (input, init = {}) =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(input);
      const headers = new Headers(init.headers);
      const body = toBuffer(init.body);
      if (init.body instanceof URLSearchParams && !headers.has("content-type")) {
        headers.set("content-type", "application/x-www-form-urlencoded");
      }
      if (!headers.has("host")) headers.set("host", url.host);
      if (body) headers.set("content-length", String(body.length));
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          agent: false,
          method: init.method ?? "GET",
          path: `${url.pathname}${url.search}`,
          headers: Object.fromEntries(headers),
          timeout: REQUEST_TIMEOUT_MS,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () => {
            const answered = new Headers();
            for (const [name, values] of Object.entries(res.headersDistinct)) {
              for (const value of values ?? []) answered.append(name, value);
            }
            const status = res.statusCode ?? 0;
            const bodiless = status === 204 || status === 205 || status === 304;
            resolve(
              new Response(bodiless ? null : Buffer.concat(chunks), {
                status,
                statusText: res.statusMessage,
                headers: answered,
              }),
            );
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error(`no answer from the proxy for ${input}`)));
      req.on("error", reject);
      req.end(body);
    });
}

async function apiRouters(apiPort: number): Promise<LoadedRouter[]> {
  const res = await fetch(`http://127.0.0.1:${apiPort}/api/http/routers`);
  return (await res.json()) as LoadedRouter[];
}

class ContainerGone extends Error {}

async function waitUntilLoaded(name: string, apiPort: number, expected: string[]) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const state = docker(["inspect", "--format", "{{.State.Running}}", name]);
    if (state.status !== 0 || state.out !== "true") {
      throw new ContainerGone(`Traefik exited before it was ready (${state.err || state.out})`);
    }
    try {
      const loaded = new Set((await apiRouters(apiPort)).map((router) => router.name));
      if (expected.every((router) => loaded.has(`${router}@file`))) return;
    } catch {
      // the API is not listening yet
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Traefik did not load ${expected.length} routers within ${READY_TIMEOUT_MS / 1000}s\n` +
          docker(["logs", "--tail", "40", name]).err,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function launch(config: DynamicConfig): Promise<TraefikProxy> {
  const name = `${CONTAINER_PREFIX}${randomBytes(4).toString("hex")}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-mcp-e2e-traefik-"));
  // The proxy runs as another user inside the container; the config holds no secret.
  fs.chmodSync(dir, 0o755);
  const file = path.join(dir, "routes.yml"); // JSON is valid YAML
  fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o644 });
  const [port, apiPort] = [await freePort(), await freePort()];

  const stop = async () => {
    docker(["rm", "-f", name]);
    running.delete(name);
    fs.rmSync(dir, { recursive: true, force: true });
  };
  removeOnExit(name);
  try {
    const started = docker([
      "run",
      "--rm",
      "-d",
      "--network",
      "host",
      "--name",
      name,
      "-v",
      `${dir}:${MOUNT}:ro`,
      IMAGE,
      "--global.checknewversion=false",
      "--global.sendanonymoususage=false",
      `--entrypoints.${ENTRYPOINT}.address=127.0.0.1:${port}`,
      `--entrypoints.traefik.address=127.0.0.1:${apiPort}`,
      "--api.insecure=true",
      `--providers.file.directory=${MOUNT}`,
      "--providers.file.watch=true",
      "--log.level=INFO",
    ]);
    if (started.status !== 0) throw new Error(`docker run failed: ${started.err}`);
    await waitUntilLoaded(name, apiPort, Object.keys(config.http.routers));
    const version = (await (await fetch(`http://127.0.0.1:${apiPort}/api/version`)).json()) as {
      Version: string;
    };
    return {
      port,
      version: version.Version,
      fetch: fetchVia(port),
      routers: () => apiRouters(apiPort),
      stop,
    };
  } catch (err) {
    await stop();
    throw err;
  }
}

/**
 * Starts the proxy on `config` and resolves once it has loaded every router in it. Fails, never
 * skips, when Docker or the image is missing. A start that loses the race for its two free ports
 * is repeated with new ones.
 */
export async function startTraefik(config: DynamicConfig): Promise<TraefikProxy> {
  requireImage();
  for (let attempt = 1; ; attempt++) {
    try {
      return await launch(config);
    } catch (err) {
      if (!(err instanceof ContainerGone) || attempt === LAUNCH_ATTEMPTS) throw err;
    }
  }
}
