import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type RenderedCompose, type RenderedService, renderCompose } from "./support/compose.ts";

/**
 * The one-host deploy shape, rendered by the real `docker compose config` (nothing is ever
 * started): a shared stack that is the hub alone, and one compose project per WhatsApp number
 * holding the number's app and its own media store, every number routed at
 * https://<host>/<label>/. Two older layouts are kept as fixtures, byte for byte, so "what
 * production ran before" is something these specs can compare against: the single-instance
 * file, and the one-host layout at 66c793c (one shared store for every number).
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const DEPLOY = path.join(ROOT, "deploy");
const SHARED_FILE = path.join(DEPLOY, "docker-compose.yaml");
const INSTANCE_FILE = path.join(DEPLOY, "docker-compose.instance.yaml");
const FIXTURES = path.join(import.meta.dirname, "fixtures");
const TODAY_FILE = path.join(FIXTURES, "compose-single-instance.yaml");
const SHARED_66C793C = path.join(FIXTURES, "compose-66c793c-shared.yaml");
const INSTANCE_66C793C = path.join(FIXTURES, "compose-66c793c-instance.yaml");

const HOST = "wa.e2e.test";

/** What the owner puts in deploy/.env for the shared stack. */
const SHARED_ENV: Record<string, string> = {
  PUBLIC_DOMAIN: HOST,
  HUB_PIN: "0000",
  HUB_COOKIE_KEY: "cookie-key",
  HUB_INSTANCES: "pessoal,empresa",
};

/** What deploy/.env held at 66c793c: the same, plus the one pair of the shared store. */
const SHARED_ENV_66C793C = {
  ...SHARED_ENV,
  MINIO_ROOT_USER: "root-user",
  MINIO_ROOT_PASSWORD: "root-secret",
};

/** What the owner puts in deploy/.env.<label> for one number: its own store pair, never shared. */
function instanceEnv(instance: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    COMPOSE_FILE: "docker-compose.instance.yaml",
    INSTANCE: instance,
    PUBLIC_DOMAIN: HOST,
    MCP_AUTH_TOKEN: `token-${instance}`,
    MINIO_ROOT_USER: `user-${instance}`,
    MINIO_ROOT_PASSWORD: `secret-${instance}`,
    ...extra,
  };
}

/** The personal number, which keeps its pairing and archive where the single-instance layout put them. */
const PESSOAL_ENV = instanceEnv("pessoal", {
  INSTANCE_DATA_DIR: "/storage/whatsapp-mcp",
  TENANT_ID: "default",
});

const shared = () => renderCompose({ file: SHARED_FILE, env: SHARED_ENV });
const instance = (env: Record<string, string>) => renderCompose({ file: INSTANCE_FILE, env });
const APP = "whatsapp-mcp-instance";
const app = (env: Record<string, string>) => only(instance(env), APP);
const store = (env: Record<string, string>) => only(instance(env), "minio");

function only(cfg: RenderedCompose, key: string): RenderedService {
  const service = cfg.services[key];
  if (!service) throw new Error(`no service ${key} in ${Object.keys(cfg.services)}`);
  return service;
}

const volumesOf = (service: RenderedService) =>
  (service.volumes ?? []).map(({ source, target }) => ({ source, target }));

/** The three kinds of Traefik object a service's labels define, with their settings. */
function traefikObjects(service: RenderedService) {
  const routers: Record<string, Record<string, string>> = {};
  const services: Record<string, Record<string, string>> = {};
  const middlewares: Record<string, Record<string, string>> = {};
  for (const [label, value] of Object.entries(service.labels ?? {})) {
    const match = /^traefik\.http\.(routers|services|middlewares)\.([^.]+)\.(.+)$/.exec(label);
    if (!match) continue;
    const [, kind, name, setting] = match as unknown as [string, string, string, string];
    const bucket = kind === "routers" ? routers : kind === "services" ? services : middlewares;
    bucket[name] = { ...bucket[name], [setting]: value };
  }
  return { routers, services, middlewares };
}

/** Every name a rendered config claims on the host, tagged by what kind of name it is. */
function claimedNames(cfg: RenderedCompose): string[] {
  const names = [`project:${cfg.name}`];
  for (const net of Object.values(cfg.networks)) names.push(`network:${net.name}`);
  for (const [key, service] of Object.entries(cfg.services)) {
    names.push(`service-key:${key}`);
    if (service.container_name) names.push(`container:${service.container_name}`);
    for (const { source } of volumesOf(service)) names.push(`host-path:${source}`);
    const traefik = traefikObjects(service);
    for (const name of Object.keys(traefik.routers)) names.push(`router:${name}`);
    for (const name of Object.keys(traefik.services)) names.push(`traefik-service:${name}`);
    for (const name of Object.keys(traefik.middlewares)) names.push(`middleware:${name}`);
  }
  return names;
}

/** The layout at 66c793c, rendered with the env it was given then. */
const shared66 = () => renderCompose({ file: SHARED_66C793C, env: SHARED_ENV_66C793C });
const instance66 = (env: Record<string, string>) => renderCompose({ file: INSTANCE_66C793C, env });

/** What `shared()` prints for the hub, and what production ran before: they must be equal. */
const HUB_OPTIONAL = {
  HUB_LANG: "pt",
  HUB_INSTANCE_SECRET: "shared-secret",
  NTFY_TOPIC_URL: "https://ntfy.e2e.test/topic",
  NTFY_TOKEN: "ntfy-token",
};

describe("the shared stack (deploy/docker-compose.yaml) is the hub alone", () => {
  it("is project whatsapp-mcp with exactly the hub: no store, no bucket-init job", () => {
    const cfg = shared();

    expect(cfg.name).toBe("whatsapp-mcp");
    expect(Object.keys(cfg.services)).toEqual(["hub"]);
    // `rc anonymous set download` would also let anyone LIST the bucket. The app sets a
    // GetObject-only policy on every start (e2e/media-policy.e2e.test.ts proves it).
    expect(JSON.stringify(cfg)).not.toContain("rc anonymous");
    expect(JSON.stringify(cfg)).not.toContain("rustfs");
  });

  it("reads no store credential and routes no media path", () => {
    const text = fs.readFileSync(SHARED_FILE, "utf8");
    const hub = traefikObjects(only(shared(), "hub"));

    expect(/MINIO_|RUSTFS_|S3_/.test(text.replace(/^\s*#.*$/gm, ""))).toBe(false);
    expect(Object.keys(hub.routers)).toEqual(["wa-hub"]);
    expect(JSON.stringify(hub)).not.toContain("media");
  });

  it("renders without any store variable in its env", () => {
    expect(Object.keys(SHARED_ENV).filter((key) => /MINIO_|RUSTFS_/.test(key))).toEqual([]);
    expect(only(shared(), "hub").image).toBeTruthy();
  });

  it.each([
    ["every optional setting left at its default", {}],
    ["every optional setting set", HUB_OPTIONAL],
  ])("renders the hub exactly as the layout at 66c793c did (%s)", (_name, optional) => {
    const now = renderCompose({ file: SHARED_FILE, env: { ...SHARED_ENV, ...optional } });
    const then = renderCompose({
      file: SHARED_66C793C,
      env: { ...SHARED_ENV_66C793C, ...optional },
    });

    // Identical, so the cutover does not recreate the hub.
    expect(only(now, "hub")).toEqual(only(then, "hub"));
    expect(now.name).toBe(then.name);
    expect(now.networks).toEqual(then.networks);
  });

  it("runs the hub with exactly the contract env, no number's token and no storage credentials", () => {
    const hub = only(shared(), "hub");

    expect(Object.keys(hub.environment ?? {}).sort()).toEqual(
      [
        "HUB_COOKIE_KEY",
        "HUB_INSTANCES",
        "HUB_INSTANCE_SECRET",
        "HUB_LANG",
        "HUB_PIN",
        "HUB_PUBLIC_URL",
        "HUB_STATE_DIR",
        "NTFY_TOKEN",
        "NTFY_TOPIC_URL",
      ].sort(),
    );
    expect(hub.environment).toMatchObject({
      HUB_PIN: "0000",
      HUB_COOKIE_KEY: "cookie-key",
      HUB_INSTANCES: "pessoal,empresa",
      HUB_INSTANCE_SECRET: "",
      HUB_PUBLIC_URL: `https://${HOST}`,
      HUB_LANG: "en",
      HUB_STATE_DIR: "/data",
      NTFY_TOPIC_URL: "",
      NTFY_TOKEN: "",
    });
    const keys = Object.keys(hub.environment ?? {});
    expect(keys).not.toContain("MCP_AUTH_TOKEN");
    expect(keys.filter((key) => /^(S3_|MINIO_|RUSTFS_)/.test(key))).toEqual([]);
    expect(volumesOf(hub)).toEqual([{ source: "/storage/whatsapp-mcp-hub", target: "/data" }]);
    expect(hub.container_name).toBe("whatsapp-mcp-hub");
    expect(hub.restart).toBe("unless-stopped");
    expect(hub.command).toEqual(["node", "--experimental-strip-types", "src/hub/main.ts"]);
    expect(Object.keys(hub.networks ?? {})).toEqual(["network_public"]);
    // The image's own HEALTHCHECK (/live on 39002) applies: no override here.
    expect(hub.healthcheck).toBeUndefined();
  });

  it("uses the same image for the hub and for a number", () => {
    expect(only(shared(), "hub").image).toBe(app(instanceEnv("empresa")).image);
  });

  it("routes every path no number claims to the hub", () => {
    const hub = traefikObjects(only(shared(), "hub"));

    expect(hub.routers).toEqual({
      "wa-hub": {
        rule: `Host(\`${HOST}\`)`,
        priority: "1",
        entrypoints: "websecure",
        "tls.certresolver": "myresolver",
        service: "wa-hub-svc",
      },
    });
    expect(hub.services).toEqual({ "wa-hub-svc": { "loadbalancer.server.port": "39002" } });
    expect(hub.middlewares).toEqual({});
  });
});

describe("a number's compose project: the app and its own store", () => {
  it.each([PESSOAL_ENV, instanceEnv("empresa")])(
    "holds exactly the app and the store (%#)",
    (env) => {
      const cfg = instance(env);

      expect(Object.keys(cfg.services).sort()).toEqual(["minio", APP]);
      expect(cfg.name).toBe(`whatsapp-mcp-${env.INSTANCE}`);
    },
  );

  it("runs the store the way the shared one ran at 66c793c: image, command, healthcheck, restart", () => {
    const then = only(shared66(), "minio");
    const now = store(instanceEnv("empresa"));

    expect(now.image).toBe(then.image);
    expect(now.command).toEqual(then.command);
    expect(now.healthcheck).toEqual(then.healthcheck);
    expect(now.restart).toBe(then.restart);
    expect(now.networks).toEqual(then.networks);
    expect(now.entrypoint).toEqual(then.entrypoint);
  });

  it.each(["pessoal", "empresa", "casa-2"])("names the store container after %s", (label) => {
    const env = label === "pessoal" ? PESSOAL_ENV : instanceEnv(label);

    expect(store(env).container_name).toBe(`whatsapp-mcp-${label}-minio`);
  });

  it("wires the number's own pair into the store, and the same pair into its app", () => {
    const env = instanceEnv("empresa", {
      MINIO_ROOT_USER: "own-user",
      MINIO_ROOT_PASSWORD: "own-pw",
    });

    expect(store(env).environment).toEqual({
      RUSTFS_ROOT_USER: "own-user",
      RUSTFS_ROOT_PASSWORD: "own-pw",
    });
    expect(app(env).environment).toMatchObject({
      S3_ACCESS_KEY: "own-user",
      S3_SECRET_KEY: "own-pw",
    });
  });

  it("caps the store at 150 MiB, publishes no port of it, and sets no swap limit", () => {
    const cfg = store(instanceEnv("empresa"));

    expect(cfg.mem_limit).toBe("157286400");
    expect(cfg.mem_limit).toBe(String(150 * 1024 * 1024));
    // No memswap_limit: Docker then lets a burst spill into swap instead of killing the store.
    expect(Object.keys(cfg)).not.toContain("memswap_limit");
    expect(cfg.ports).toBeUndefined();
  });

  it("passes STORE_MEM_LIMIT through", () => {
    expect(store(instanceEnv("empresa", { STORE_MEM_LIMIT: "300m" })).mem_limit).toBe(
      String(300 * 1024 * 1024),
    );
  });

  it("keeps a number's data in its own directory, the store's under it", () => {
    expect(volumesOf(store(PESSOAL_ENV))).toEqual([
      { source: "/storage/whatsapp-mcp/minio", target: "/data" },
    ]);
    expect(volumesOf(store(instanceEnv("empresa")))).toEqual([
      { source: "/storage/whatsapp-mcp-empresa/minio", target: "/data" },
    ]);
    expect(volumesOf(app(instanceEnv("empresa")))).toEqual([
      { source: "/storage/whatsapp-mcp-empresa", target: "/data" },
    ]);
  });

  it("changes the app in two places only: it points at its own store and waits for it", () => {
    for (const env of [PESSOAL_ENV, instanceEnv("empresa")]) {
      const then = only(instance66(env), APP);
      const now = app(env);
      const was = then.environment ?? {};
      const is = now.environment ?? {};

      expect(Object.keys(is).sort()).toEqual(Object.keys(was).sort());
      expect(Object.keys(is).filter((key) => is[key] !== was[key])).toEqual(["S3_ENDPOINT"]);
      expect(is.S3_ENDPOINT).toBe(`whatsapp-mcp-${env.INSTANCE}-minio`);
      expect(is.S3_ENDPOINT).toBe(store(env).container_name);
      expect(now.image).toBe(then.image);
      expect(now.container_name).toBe(then.container_name);
      expect(now.restart).toBe(then.restart);
      expect(now.healthcheck).toEqual(then.healthcheck);
      expect(now.networks).toEqual(then.networks);
      expect(now.labels).toEqual(then.labels);
      expect(volumesOf(now)).toEqual(volumesOf(then));
      expect(then.depends_on).toBeUndefined();
      expect(now.depends_on).toEqual({ minio: { condition: "service_healthy", required: true } });
    }
  });

  it("never lets the app reach its store by the service key every number shares", () => {
    for (const env of [PESSOAL_ENV, instanceEnv("empresa")]) {
      expect(app(env).environment?.S3_ENDPOINT).not.toBe("minio");
    }
  });
});

describe("a number's store fails closed", () => {
  it.each(["MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD"])("cannot render without %s", (missing) => {
    const { [missing]: _removed, ...env } = instanceEnv("empresa");

    expect(() => instance(env)).toThrow(new RegExp(missing));
  });

  it.each(["MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD"])("cannot render with %s empty", (blank) => {
    expect(() => instance(instanceEnv("empresa", { [blank]: "" }))).toThrow(new RegExp(blank));
  });
});

describe("the personal number moving from the single-instance layout: data stays put", () => {
  const today = () =>
    renderCompose({
      file: TODAY_FILE,
      env: {
        MCP_DOMAIN: "mcp.e2e.test",
        QR_DOMAIN: "qr.e2e.test",
        MCP_AUTH_TOKEN: "token",
        NTFY_TOPIC_URL: "https://ntfy.e2e.test/topic",
        EXPECTED_WA_NUMBER: "5500",
        MINIO_ROOT_USER: "root-user",
        MINIO_ROOT_PASSWORD: "root-secret",
      },
    });

  const REQUIRED_SETTINGS = {
    MCP_AUTH_TOKEN: "token",
    NTFY_TOPIC_URL: "https://ntfy.e2e.test/topic",
    EXPECTED_WA_NUMBER: "5500",
    MINIO_ROOT_USER: "root-user",
    MINIO_ROOT_PASSWORD: "root-secret",
  };

  it("mounts the same host directories for the app and for its store, in the same bucket and tenant", () => {
    const before = today();
    const cfg = instance({ ...PESSOAL_ENV, ...REQUIRED_SETTINGS });
    const now = only(cfg, APP);
    const kept = only(cfg, "minio");

    expect(volumesOf(now)).toEqual(volumesOf(only(before, "whatsapp-mcp")));
    expect(volumesOf(kept)).toEqual(volumesOf(only(before, "minio")));
    expect(kept.image).toBe(only(before, "minio").image);
    expect(kept.environment).toEqual(only(before, "minio").environment);
    expect(kept.healthcheck).toEqual(only(before, "minio").healthcheck);
    for (const key of ["S3_BUCKET", "TENANT_ID"]) {
      expect(now.environment?.[key]).toBe(only(before, "whatsapp-mcp").environment?.[key]);
    }
    expect(now.environment?.S3_ENDPOINT).toBe(kept.container_name);
  });

  // Every setting of today's app service, including the anti-ban send policy (risk-owner
  // settings), must reach the new service with the same value, except the rows below.
  const OPTIONAL_SETTINGS = {
    NTFY_TOKEN: "ntfy-token",
    SEND_COLD_OVERRIDE: "allow",
    SEND_COLD_ALLOWED_JIDS: "5500111,5500222",
    OPENROUTER_API_KEY: "openrouter-key",
    AUDIO_PROVIDER: "groq",
    GROQ_API_KEY: "groq-key",
    OPENAI_API_KEY: "openai-key",
    VISION_MODEL: "vision-model",
    WATCHDOG_RESTART_AFTER_S: "123",
    WATCHDOG_MAX_RESTARTS: "4",
  };
  /** The exception table of the plan: the only keys allowed to differ from today's service. */
  const CHANGED = ["MEDIA_PUBLIC_BASE_URL", "PUBLIC_QR_URL", "S3_ENDPOINT", "STREAM_PUBLIC_URL"];
  const ADDED = [
    "HUB_INSTANCE_SECRET",
    "INSTANCE_DESCRIPTION",
    "INSTANCE_LABEL",
    "UPLOAD_PUBLIC_URL",
  ];
  const PLAN_TABLE = [...CHANGED, ...ADDED, "MCP_AUTH_TOKEN", "TENANT_ID"].sort();

  it.each([
    ["every optional setting left at its default", {}],
    ["every optional setting set", OPTIONAL_SETTINGS],
  ])("drops no setting of today's app service (%s)", (_name, optional) => {
    const before = only(
      renderCompose({
        file: TODAY_FILE,
        env: {
          MCP_DOMAIN: "mcp.e2e.test",
          QR_DOMAIN: "qr.e2e.test",
          ...REQUIRED_SETTINGS,
          ...optional,
        },
      }),
      "whatsapp-mcp",
    );
    const after = app({ ...PESSOAL_ENV, ...REQUIRED_SETTINGS, ...optional });
    const was = before.environment ?? {};
    const now = after.environment ?? {};

    const changed = Object.keys(was).filter((key) => now[key] !== was[key]);
    const added = Object.keys(now).filter((key) => !(key in was));

    expect(changed.sort()).toEqual(CHANGED);
    expect(added.sort()).toEqual(ADDED);
    // The two rows of the table that keep their value when set: the token is required, and the
    // tenant defaults to the label instead of "default".
    expect([...changed, ...added, "MCP_AUTH_TOKEN", "TENANT_ID"].sort()).toEqual(PLAN_TABLE);
    expect(now.MCP_AUTH_TOKEN).toBe(was.MCP_AUTH_TOKEN);
    expect(now.TENANT_ID).toBe(was.TENANT_ID);
    // Non-environment settings the plan keeps as they are.
    expect(after.restart).toBe(before.restart);
    expect(after.healthcheck).toEqual(before.healthcheck);
    expect(after.networks).toEqual(before.networks);
    expect(after.image).toBe(before.image);
  });

  it("gives every changed key its new value", () => {
    const env = app(PESSOAL_ENV).environment;

    expect(env).toMatchObject({
      STREAM_PUBLIC_URL: `wss://${HOST}/pessoal/stream`,
      PUBLIC_QR_URL: `https://${HOST}/pessoal`,
      MEDIA_PUBLIC_BASE_URL: `https://${HOST}/pessoal/media`,
      UPLOAD_PUBLIC_URL: `https://${HOST}/pessoal/upload`,
      S3_ENDPOINT: "whatsapp-mcp-pessoal-minio",
      MCP_ENDPOINT: "/mcp",
      MCP_AUTH_TOKEN: "token-pessoal",
      INSTANCE_LABEL: "pessoal",
      INSTANCE_DESCRIPTION: "",
      HUB_INSTANCE_SECRET: "",
      TENANT_ID: "default",
    });
  });

  it("keeps the safe defaults of the send policy when nothing is set", () => {
    const env = app(PESSOAL_ENV).environment;

    expect(env?.SEND_COLD_OVERRIDE).toBe("deny");
    expect(env?.SEND_COLD_ALLOWED_JIDS).toBe("");
  });

  it("names the tenant after the label when no override is given", () => {
    expect(app(instanceEnv("empresa")).environment?.TENANT_ID).toBe("empresa");
  });

  it("puts a number's data in /storage/whatsapp-mcp-<label> unless told otherwise", () => {
    expect(volumesOf(app(instanceEnv("empresa")))).toEqual([
      { source: "/storage/whatsapp-mcp-empresa", target: "/data" },
    ]);
  });
});

describe("two numbers and the shared stack side by side: nothing collides", () => {
  const configs = () => [
    shared(),
    instance(PESSOAL_ENV),
    instance(instanceEnv("empresa", { INSTANCE_DESCRIPTION: "the company number" })),
  ];

  it("shares no name but the network and the two service keys", () => {
    const claims = configs().map(claimedNames);
    const doubled = new Set<string>();
    for (const [i, mine] of claims.entries()) {
      for (const other of claims.slice(i + 1)) {
        for (const name of mine) if (other.includes(name)) doubled.add(name);
      }
    }

    // No container name, router, middleware, Traefik service or data directory is in the list.
    expect([...doubled].sort()).toEqual([
      "network:network_public",
      "service-key:minio",
      "service-key:whatsapp-mcp-instance",
    ]);
    // And no config claims one of its own names twice.
    for (const mine of claims) expect(new Set(mine).size).toBe(mine.length);
  });

  it("shares no credential, and neither app names the other's store", () => {
    const [pessoal, empresa] = [PESSOAL_ENV, instanceEnv("empresa")];

    expect(store(pessoal).environment?.RUSTFS_ROOT_USER).not.toBe(
      store(empresa).environment?.RUSTFS_ROOT_USER,
    );
    expect(store(pessoal).environment?.RUSTFS_ROOT_PASSWORD).not.toBe(
      store(empresa).environment?.RUSTFS_ROOT_PASSWORD,
    );
    expect(app(pessoal).environment?.S3_ENDPOINT).toBe(store(pessoal).container_name);
    expect(app(empresa).environment?.S3_ENDPOINT).toBe(store(empresa).container_name);
    expect(app(pessoal).environment?.S3_ENDPOINT).not.toBe(store(empresa).container_name);
    expect(app(empresa).environment?.S3_ENDPOINT).not.toBe(store(pessoal).container_name);
  });

  it("keeps each store's data directory inside its own number's directory", () => {
    const sources = (env: Record<string, string>) => ({
      app: volumesOf(app(env))[0]?.source ?? "",
      store: volumesOf(store(env))[0]?.source ?? "",
    });
    const [pessoal, empresa] = [sources(PESSOAL_ENV), sources(instanceEnv("empresa"))];

    expect(pessoal.store.startsWith(`${pessoal.app}/`)).toBe(true);
    expect(empresa.store.startsWith(`${empresa.app}/`)).toBe(true);
    expect(pessoal.store.startsWith(`${empresa.app}/`)).toBe(false);
    expect(empresa.store.startsWith(`${pessoal.app}/`)).toBe(false);
  });

  it("names the project, the container and the data directory after the label", () => {
    const empresa = instance(instanceEnv("empresa"));

    expect(empresa.name).toBe("whatsapp-mcp-empresa");
    expect(only(empresa, APP).container_name).toBe("whatsapp-mcp-empresa");
  });
});

describe("routes", () => {
  const PORTS = { mcp: "39001", upload: "39003", stream: "39004" };

  it.each(["pessoal", "empresa"])(
    "gives the %s app exactly three routers, each on its own path",
    (label) => {
      const env = label === "pessoal" ? PESSOAL_ENV : instanceEnv(label);
      const traefik = traefikObjects(app(env));

      expect(Object.keys(traefik.routers).sort()).toEqual([
        `wa-${label}-mcp`,
        `wa-${label}-stream`,
        `wa-${label}-upload`,
      ]);
      for (const kind of ["mcp", "upload", "stream"] as const) {
        expect(traefik.routers[`wa-${label}-${kind}`]).toEqual({
          rule: `Host(\`${HOST}\`) && Path(\`/${label}/${kind}\`)`,
          priority: "100",
          entrypoints: "websecure",
          "tls.certresolver": "myresolver",
          middlewares: `wa-${label}-strip`,
          service: `wa-${label}-${kind}-svc`,
        });
        expect(traefik.services[`wa-${label}-${kind}-svc`]).toEqual({
          "loadbalancer.server.port": PORTS[kind],
        });
      }
      expect(Object.keys(traefik.services)).toHaveLength(3);
      expect(traefik.middlewares).toEqual({
        [`wa-${label}-strip`]: { "stripprefix.prefixes": `/${label}` },
      });
    },
  );

  it("never routes to an instance's status port 39002, which only the hub reads", () => {
    for (const env of [PESSOAL_ENV, instanceEnv("empresa")]) {
      const labels = app(env).labels ?? {};
      expect(Object.entries(labels).filter(([, value]) => value.includes("39002"))).toEqual([]);
    }
  });

  it.each(["pessoal", "empresa"])(
    "gives the %s store one media router on its own label, above the shared one of 66c793c",
    (label) => {
      const env = label === "pessoal" ? PESSOAL_ENV : instanceEnv(label);
      const media = traefikObjects(store(env));
      const legacy = traefikObjects(only(shared66(), "minio")).routers["wa-media"];

      expect(media.routers).toEqual({
        [`wa-${label}-media`]: {
          rule: `Host(\`${HOST}\`) && PathPrefix(\`/${label}/media/t/\`)`,
          priority: "110",
          entrypoints: "websecure",
          "tls.certresolver": "myresolver",
          middlewares: `wa-${label}-media-rewrite`,
          service: `wa-${label}-media-svc`,
        },
      });
      expect(media.middlewares).toEqual({
        [`wa-${label}-media-rewrite`]: {
          "replacepathregex.regex": `^/${label}/media/(.*)`,
          "replacepathregex.replacement": "/amiticia-media/$$1",
        },
      });
      expect(media.services).toEqual({
        [`wa-${label}-media-svc`]: { "loadbalancer.server.port": "9000" },
      });
      // While a host is moved off the shared store, the number's own route must win.
      expect(Number(media.routers[`wa-${label}-media`]?.priority)).toBeGreaterThan(
        Number(legacy?.priority),
      );
    },
  );

  it("rewrites a number's media path into the bucket, and only its own", () => {
    const media = traefikObjects(store(instanceEnv("empresa")));
    const rewrite = media.middlewares["wa-empresa-media-rewrite"] ?? {};
    const regex = new RegExp(rewrite["replacepathregex.regex"] ?? "");
    const replacement = (rewrite["replacepathregex.replacement"] ?? "").replace("$$1", "$1");

    expect("/empresa/media/t/default/uploads/a.png".replace(regex, replacement)).toBe(
      "/amiticia-media/t/default/uploads/a.png",
    );
    expect(regex.test("/pessoal/media/t/default/uploads/a.png")).toBe(false);
  });

  it("keeps each container's routers pointing only at services and middlewares of its own", () => {
    for (const cfg of [shared(), instance(PESSOAL_ENV), instance(instanceEnv("empresa"))]) {
      for (const service of Object.values(cfg.services)) {
        const traefik = traefikObjects(service);
        for (const router of Object.values(traefik.routers)) {
          expect(Object.keys(traefik.services)).toContain(router.service);
          for (const name of (router.middlewares ?? "").split(",").filter(Boolean)) {
            expect(Object.keys(traefik.middlewares)).toContain(name);
          }
        }
      }
    }
  });
});

describe("rendering fails closed", () => {
  it.each(["INSTANCE", "MCP_AUTH_TOKEN", "PUBLIC_DOMAIN"])(
    "a number cannot render without %s",
    (missing) => {
      const { [missing]: _removed, ...env } = instanceEnv("empresa");

      expect(() => instance(env)).toThrow(new RegExp(missing));
    },
  );

  it.each(["PUBLIC_DOMAIN", "HUB_PIN", "HUB_COOKIE_KEY", "HUB_INSTANCES"])(
    "the shared stack cannot render without %s",
    (missing) => {
      const { [missing]: _removed, ...env } = SHARED_ENV;

      expect(() => renderCompose({ file: SHARED_FILE, env })).toThrow(new RegExp(missing));
    },
  );

  it("treats an empty HUB_PIN as missing", () => {
    expect(() => renderCompose({ file: SHARED_FILE, env: { ...SHARED_ENV, HUB_PIN: "" } })).toThrow(
      /HUB_PIN/,
    );
  });

  it("does not let one number inherit another's variables: the env file is the whole input", () => {
    // `docker compose --env-file .env.empresa up -d` in deploy/ must be self-contained, and
    // COMPOSE_FILE in that file must be enough to select the file.
    const cfg = renderCompose({ env: instanceEnv("empresa"), cwd: DEPLOY });

    expect(cfg.name).toBe("whatsapp-mcp-empresa");
    expect(Object.keys(cfg.services).sort()).toEqual(["minio", APP]);
  });
});

describe("the old single-instance settings are gone", () => {
  it("names MCP_DOMAIN and QR_DOMAIN in no file under deploy/ but the docs", () => {
    const files = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "deploy"],
      { cwd: ROOT, encoding: "utf8" },
    )
      .split("\n")
      .filter((file) => file && !file.endsWith(".md"));

    expect(files).toEqual(
      expect.arrayContaining([
        "deploy/.env.example",
        "deploy/docker-compose.yaml",
        "deploy/docker-compose.instance.yaml",
        "deploy/instance.env.example",
      ]),
    );
    for (const file of files) {
      const text = fs.readFileSync(path.join(ROOT, file), "utf8");
      expect({ file, hit: /MCP_DOMAIN|QR_DOMAIN/.test(text) }).toEqual({ file, hit: false });
    }
  });
});

describe("the env templates", () => {
  /** `KEY=value` lines, set or commented out. */
  function entries(file: string) {
    return fs
      .readFileSync(path.join(DEPLOY, file), "utf8")
      .split("\n")
      .flatMap((line) => {
        const match = /^(#\s?)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
        return match
          ? [{ key: match[2] as string, value: match[3] as string, commented: Boolean(match[1]) }]
          : [];
      });
  }
  const keysOf = (file: string) => [...new Set(entries(file).map((entry) => entry.key))].sort();
  const liveValues = (file: string): Record<string, string> =>
    Object.fromEntries(
      entries(file)
        .filter((entry) => !entry.commented)
        .map((entry) => [entry.key, entry.value]),
    );

  /** The variables a compose file reads, outside its comments. */
  const referencedBy = (file: string) =>
    new Set(
      [
        ...fs
          .readFileSync(path.join(DEPLOY, file), "utf8")
          .replace(/^\s*#.*$/gm, "")
          .matchAll(/\$\{([A-Z][A-Z0-9_]*)/g),
      ].map((match) => match[1] as string),
    );

  const SECRET_LIKE = /(TOKEN|SECRET|PASSWORD|PIN|_KEY|USER)/;
  /** Read by `docker compose` itself, to choose the file, not by the file. */
  const READ_BY_COMPOSE = ["COMPOSE_FILE"];

  it.each([
    ["docker-compose.yaml", ".env.example"],
    ["docker-compose.instance.yaml", "instance.env.example"],
  ])("%s and %s: each lists exactly what the other reads", (compose, template) => {
    const listed = new Set(keysOf(template));
    const read = referencedBy(compose);

    for (const variable of read) {
      expect({ variable, listed: listed.has(variable) }).toEqual({ variable, listed: true });
    }
    for (const variable of listed) {
      const used = read.has(variable) || READ_BY_COMPOSE.includes(variable);
      expect({ variable, read: used }).toEqual({ variable, read: true });
    }
  });

  it.each([".env.example", "instance.env.example"])(
    "%s: every secret-like key is empty",
    (template) => {
      const secrets = entries(template).filter((entry) => SECRET_LIKE.test(entry.key));

      expect(secrets.length).toBeGreaterThan(0);
      expect(secrets.filter((entry) => entry.value !== "")).toEqual([]);
    },
  );

  it("lists exactly the keys of the shared stack, and no store credential", () => {
    expect(keysOf(".env.example")).toEqual(
      [
        "PUBLIC_DOMAIN",
        "HUB_PIN",
        "HUB_COOKIE_KEY",
        "HUB_INSTANCE_SECRET",
        "HUB_INSTANCES",
        "HUB_LANG",
        "NTFY_TOPIC_URL",
        "NTFY_TOKEN",
      ].sort(),
    );
    expect(keysOf(".env.example").filter((key) => key.startsWith("MINIO_"))).toEqual([]);
  });

  it("asks a number for its own pair, and offers the store's ceiling only as a comment", () => {
    const live = liveValues("instance.env.example");

    expect(live).toMatchObject({ MINIO_ROOT_USER: "", MINIO_ROOT_PASSWORD: "" });
    expect(Object.keys(live)).not.toContain("STORE_MEM_LIMIT");
    expect(entries("instance.env.example")).toContainEqual({
      key: "STORE_MEM_LIMIT",
      value: "150m",
      commented: true,
    });
  });

  it("keeps the migration-only settings commented out, so a new number never gets them", () => {
    const live = liveValues("instance.env.example");

    expect(Object.keys(live)).not.toContain("INSTANCE_DATA_DIR");
    expect(Object.keys(live)).not.toContain("TENANT_ID");
    expect(keysOf("instance.env.example")).toEqual(
      expect.arrayContaining(["INSTANCE_DATA_DIR", "TENANT_ID"]),
    );
  });

  it("renders as a number only once the blanks, the pair included, are filled in", () => {
    const live = liveValues("instance.env.example");
    const filled = { ...live, INSTANCE: "empresa", MCP_AUTH_TOKEN: "t" };

    expect(live.COMPOSE_FILE).toBe("docker-compose.instance.yaml");
    expect(() => renderCompose({ file: INSTANCE_FILE, env: live })).toThrow(/INSTANCE/);
    expect(() =>
      renderCompose({ file: INSTANCE_FILE, env: { ...filled, MINIO_ROOT_USER: "u" } }),
    ).toThrow(/MINIO_ROOT_PASSWORD/);
    const cfg = renderCompose({
      file: INSTANCE_FILE,
      env: { ...filled, MINIO_ROOT_USER: "u", MINIO_ROOT_PASSWORD: "p" },
    });
    expect(cfg.name).toBe("whatsapp-mcp-empresa");
    expect(Object.keys(cfg.services).sort()).toEqual(["minio", APP]);
  });
});
