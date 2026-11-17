import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type RenderedCompose, type RenderedService, renderCompose } from "./support/compose.ts";

/**
 * The one-host deploy shape, rendered by the real `docker compose config` (nothing is ever
 * started): a shared stack (RustFS + hub) and one compose project per WhatsApp number, every
 * number routed at https://<host>/<label>/. The old single-instance file is kept as a fixture,
 * byte for byte, so "today's layout" is something these specs can compare against.
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const DEPLOY = path.join(ROOT, "deploy");
const SHARED_FILE = path.join(DEPLOY, "docker-compose.yaml");
const INSTANCE_FILE = path.join(DEPLOY, "docker-compose.instance.yaml");
const TODAY_FILE = path.join(import.meta.dirname, "fixtures", "compose-single-instance.yaml");

const HOST = "wa.e2e.test";

/** What the owner puts in deploy/.env for the shared stack. */
const SHARED_ENV = {
  PUBLIC_DOMAIN: HOST,
  MINIO_ROOT_USER: "root-user",
  MINIO_ROOT_PASSWORD: "root-secret",
  HUB_PIN: "0000",
  HUB_COOKIE_KEY: "cookie-key",
  HUB_INSTANCES: "pessoal,empresa",
};

/** What the owner puts in deploy/.env.<label> for one number. */
function instanceEnv(instance: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    COMPOSE_FILE: "docker-compose.instance.yaml",
    INSTANCE: instance,
    PUBLIC_DOMAIN: HOST,
    MCP_AUTH_TOKEN: `token-${instance}`,
    MINIO_ROOT_USER: "root-user",
    MINIO_ROOT_PASSWORD: "root-secret",
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

describe("the shared stack (deploy/docker-compose.yaml)", () => {
  it("is project whatsapp-mcp with exactly RustFS and the hub, and no bucket-init job", () => {
    const cfg = shared();

    expect(cfg.name).toBe("whatsapp-mcp");
    expect(Object.keys(cfg.services).sort()).toEqual(["hub", "minio"]);
    // `rc anonymous set download` would also let anyone LIST the bucket. The app sets a
    // GetObject-only policy on every start (e2e/media-policy.e2e.test.ts proves it).
    expect(JSON.stringify(cfg)).not.toContain("rc anonymous");
    expect(JSON.stringify(cfg)).not.toContain("rustfs/rc");
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
    expect(only(shared(), "hub").image).toBe(
      only(instance(instanceEnv("empresa")), "whatsapp-mcp-instance").image,
    );
  });

  it("defaults the hub language to en and passes the others through", () => {
    const hub = only(
      renderCompose({
        file: SHARED_FILE,
        env: {
          ...SHARED_ENV,
          HUB_LANG: "pt",
          HUB_INSTANCE_SECRET: "shared-secret",
          NTFY_TOPIC_URL: "https://ntfy.e2e.test/topic",
          NTFY_TOKEN: "ntfy-token",
        },
      }),
      "hub",
    );

    expect(hub.environment).toMatchObject({
      HUB_LANG: "pt",
      HUB_INSTANCE_SECRET: "shared-secret",
      NTFY_TOPIC_URL: "https://ntfy.e2e.test/topic",
      NTFY_TOKEN: "ntfy-token",
    });
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

  it("mounts the same host directory for the app and for RustFS, in the same bucket and tenant", () => {
    const before = today();
    const app = instance(PESSOAL_ENV);
    const storage = shared();

    expect(volumesOf(only(app, "whatsapp-mcp-instance"))).toEqual(
      volumesOf(only(before, "whatsapp-mcp")),
    );
    expect(volumesOf(only(storage, "minio"))).toEqual(volumesOf(only(before, "minio")));
    expect(only(storage, "minio").container_name).toBe(only(before, "minio").container_name);
    expect(only(storage, "minio").image).toBe(only(before, "minio").image);
    expect(only(storage, "minio").environment).toEqual(only(before, "minio").environment);
    expect(only(storage, "minio").healthcheck).toEqual(only(before, "minio").healthcheck);
    for (const key of ["S3_BUCKET", "TENANT_ID"]) {
      expect(only(app, "whatsapp-mcp-instance").environment?.[key]).toBe(
        only(before, "whatsapp-mcp").environment?.[key],
      );
    }
    expect(only(app, "whatsapp-mcp-instance").environment?.S3_ENDPOINT).toBe(
      only(storage, "minio").container_name,
    );
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
  const REQUIRED_SETTINGS = {
    MCP_AUTH_TOKEN: "token",
    NTFY_TOPIC_URL: "https://ntfy.e2e.test/topic",
    EXPECTED_WA_NUMBER: "5500",
    MINIO_ROOT_USER: "root-user",
    MINIO_ROOT_PASSWORD: "root-secret",
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
    const after = only(
      instance(
        instanceEnv("pessoal", {
          ...REQUIRED_SETTINGS,
          ...optional,
          INSTANCE_DATA_DIR: "/storage/whatsapp-mcp",
          TENANT_ID: "default",
        }),
      ),
      "whatsapp-mcp-instance",
    );
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
    expect(after.depends_on).toBeUndefined();
  });

  it("gives every changed key its new value", () => {
    const env = only(instance(PESSOAL_ENV), "whatsapp-mcp-instance").environment;

    expect(env).toMatchObject({
      STREAM_PUBLIC_URL: `wss://${HOST}/pessoal/stream`,
      PUBLIC_QR_URL: `https://${HOST}/pessoal`,
      MEDIA_PUBLIC_BASE_URL: `https://${HOST}/pessoal/media`,
      UPLOAD_PUBLIC_URL: `https://${HOST}/pessoal/upload`,
      S3_ENDPOINT: "whatsapp-mcp-minio",
      MCP_ENDPOINT: "/mcp",
      MCP_AUTH_TOKEN: "token-pessoal",
      INSTANCE_LABEL: "pessoal",
      INSTANCE_DESCRIPTION: "",
      HUB_INSTANCE_SECRET: "",
      TENANT_ID: "default",
    });
  });

  it("keeps the safe defaults of the send policy when nothing is set", () => {
    const env = only(instance(PESSOAL_ENV), "whatsapp-mcp-instance").environment;

    expect(env?.SEND_COLD_OVERRIDE).toBe("deny");
    expect(env?.SEND_COLD_ALLOWED_JIDS).toBe("");
  });

  it("names the tenant after the label when no override is given", () => {
    const env = only(instance(instanceEnv("empresa")), "whatsapp-mcp-instance").environment;

    expect(env?.TENANT_ID).toBe("empresa");
  });

  it("puts a number's data in /storage/whatsapp-mcp-<label> unless told otherwise", () => {
    const empresa = only(instance(instanceEnv("empresa")), "whatsapp-mcp-instance");

    expect(volumesOf(empresa)).toEqual([
      { source: "/storage/whatsapp-mcp-empresa", target: "/data" },
    ]);
  });
});

describe("two numbers and the shared stack side by side: nothing collides", () => {
  it("shares no name but the network and the service key", () => {
    const configs = [
      shared(),
      instance(PESSOAL_ENV),
      instance(instanceEnv("empresa", { INSTANCE_DESCRIPTION: "the company number" })),
    ];
    const claims = configs.map(claimedNames);
    const doubled = new Set<string>();
    for (const [i, mine] of claims.entries()) {
      for (const other of claims.slice(i + 1)) {
        for (const name of mine) if (other.includes(name)) doubled.add(name);
      }
    }

    expect([...doubled].sort()).toEqual([
      "network:network_public",
      "service-key:whatsapp-mcp-instance",
    ]);
    // And no config claims one of its own names twice.
    for (const mine of claims) expect(new Set(mine).size).toBe(mine.length);
  });

  it("names the project, the container and the data directory after the label", () => {
    const empresa = instance(instanceEnv("empresa"));

    expect(empresa.name).toBe("whatsapp-mcp-empresa");
    expect(only(empresa, "whatsapp-mcp-instance").container_name).toBe("whatsapp-mcp-empresa");
  });
});

describe("routes", () => {
  const PORTS = { mcp: "39001", upload: "39003", stream: "39004" };

  it.each(["pessoal", "empresa"])(
    "gives %s exactly three routers, each on its own path",
    (label) => {
      const env = label === "pessoal" ? PESSOAL_ENV : instanceEnv(label);
      const traefik = traefikObjects(only(instance(env), "whatsapp-mcp-instance"));

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
      const labels = only(instance(env), "whatsapp-mcp-instance").labels ?? {};
      expect(Object.entries(labels).filter(([, value]) => value.includes("39002"))).toEqual([]);
    }
  });

  it("routes the shared media path to RustFS and every other path to the hub", () => {
    const cfg = shared();
    const media = traefikObjects(only(cfg, "minio"));
    const hub = traefikObjects(only(cfg, "hub"));

    expect(media.routers).toEqual({
      "wa-media": {
        rule: `Host(\`${HOST}\`) && PathRegexp(\`^/[a-z0-9][a-z0-9-]*/media/t/\`)`,
        priority: "100",
        entrypoints: "websecure",
        "tls.certresolver": "myresolver",
        middlewares: "wa-media-rewrite",
        service: "wa-media-svc",
      },
    });
    expect(media.middlewares).toEqual({
      "wa-media-rewrite": {
        "replacepathregex.regex": "^/[a-z0-9][a-z0-9-]*/media/(.*)",
        "replacepathregex.replacement": "/amiticia-media/$$1",
      },
    });
    expect(media.services).toEqual({ "wa-media-svc": { "loadbalancer.server.port": "9000" } });
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

  it("matches a number's objects and never its bucket root, and rewrites into the bucket", () => {
    const media = traefikObjects(only(shared(), "minio"));
    const match = new RegExp(
      /PathRegexp\(`(.+)`\)/.exec(media.routers["wa-media"]?.rule ?? "")?.[1] ?? "",
    );
    const rewrite = media.middlewares["wa-media-rewrite"] ?? {};
    const regex = new RegExp(rewrite["replacepathregex.regex"] ?? "");
    const replacement = (rewrite["replacepathregex.replacement"] ?? "").replace("$$1", "$1");

    expect(match.test("/empresa/media/t/default/uploads/a.png")).toBe(true);
    expect(match.test("/pessoal-2/media/t/e2e/x.png")).toBe(true);
    // The bucket root and anything outside t/ fall through to the hub, not to RustFS.
    expect(match.test("/empresa/media/")).toBe(false);
    expect(match.test("/empresa/media")).toBe(false);
    expect(match.test("/empresa/media/uploads/a.png")).toBe(false);
    expect(match.test("/media/t/default/a.png")).toBe(false);
    expect(match.test("/empresa/mcp")).toBe(false);
    expect("/empresa/media/t/default/uploads/a.png".replace(regex, replacement)).toBe(
      "/amiticia-media/t/default/uploads/a.png",
    );
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
      const { [missing]: _removed, ...env } = SHARED_ENV as Record<string, string>;

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
    expect(Object.keys(cfg.services)).toEqual(["whatsapp-mcp-instance"]);
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

  const referencedBy = (file: string) =>
    new Set(
      [...fs.readFileSync(path.join(DEPLOY, file), "utf8").matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map(
        (match) => match[1] as string,
      ),
    );

  const SECRET_LIKE = /(TOKEN|SECRET|PASSWORD|PIN|_KEY|USER)/;

  it.each([
    ["docker-compose.yaml", ".env.example"],
    ["docker-compose.instance.yaml", "instance.env.example"],
  ])("%s: its template lists every variable it reads", (compose, template) => {
    const listed = new Set(keysOf(template));

    for (const variable of referencedBy(compose)) {
      expect({ variable, listed: listed.has(variable) }).toEqual({ variable, listed: true });
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

  it("lists exactly the keys of the shared stack", () => {
    expect(keysOf(".env.example")).toEqual(
      [
        "PUBLIC_DOMAIN",
        "MINIO_ROOT_USER",
        "MINIO_ROOT_PASSWORD",
        "HUB_PIN",
        "HUB_COOKIE_KEY",
        "HUB_INSTANCE_SECRET",
        "HUB_INSTANCES",
        "HUB_LANG",
        "NTFY_TOPIC_URL",
        "NTFY_TOKEN",
      ].sort(),
    );
  });

  it("keeps the migration-only settings commented out, so a new number never gets them", () => {
    const live = liveValues("instance.env.example");

    expect(Object.keys(live)).not.toContain("INSTANCE_DATA_DIR");
    expect(Object.keys(live)).not.toContain("TENANT_ID");
    expect(keysOf("instance.env.example")).toEqual(
      expect.arrayContaining(["INSTANCE_DATA_DIR", "TENANT_ID"]),
    );
  });

  it("renders as a number only once the blanks are filled in", () => {
    const live = liveValues("instance.env.example");

    expect(live.COMPOSE_FILE).toBe("docker-compose.instance.yaml");
    expect(() => renderCompose({ file: INSTANCE_FILE, env: live })).toThrow(/INSTANCE/);
    const cfg = renderCompose({
      file: INSTANCE_FILE,
      env: { ...live, INSTANCE: "empresa", MCP_AUTH_TOKEN: "t", MINIO_ROOT_USER: "u" },
    });
    expect(cfg.name).toBe("whatsapp-mcp-empresa");
  });
});
