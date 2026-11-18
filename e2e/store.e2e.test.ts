import { randomBytes } from "node:crypto";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RenderedCompose, renderCompose } from "./support/compose.ts";
import { docker } from "./support/docker.ts";
import {
  assertStoreOnly,
  createStoreVolume,
  type E2eStore,
  removeStoreVolume,
  startStore,
  storeCompose,
} from "./support/store.ts";

/**
 * The store harness itself (`support/store.ts`): it must start the `minio` service of a compose
 * file as rendered, change only what it declares, and refuse to start anything else. The files
 * it is shown here are the layout at 66c793c, kept as fixtures; the deploy files are shown to it
 * by the specs that use it.
 *
 * Needs Docker and the image `rustfs/rustfs:latest` (nothing is pulled); it fails, never skips,
 * without them.
 */

const FIXTURES = path.join(import.meta.dirname, "fixtures");
const SHARED_FIXTURE = path.join(FIXTURES, "compose-66c793c-shared.yaml");
const INSTANCE_FIXTURE = path.join(FIXTURES, "compose-66c793c-instance.yaml");
const PREFIX = "whatsapp-mcp-e2e-";

const secret = () => randomBytes(16).toString("hex");

/** The shared stack of the layout at 66c793c, with the store's root pair as given. */
function renderShared(pair: { user: string; password: string }): RenderedCompose {
  return renderCompose({
    file: SHARED_FIXTURE,
    env: {
      PUBLIC_DOMAIN: "wa.e2e.test",
      MINIO_ROOT_USER: pair.user,
      MINIO_ROOT_PASSWORD: pair.password,
      HUB_PIN: "0000",
      HUB_COOKIE_KEY: "cookie-key",
      HUB_INSTANCES: "pessoal",
    },
  });
}

const pairOf = () => ({ user: secret(), password: secret() });
const exists = (what: "container" | "volume", name: string) =>
  docker([what, "inspect", name]).status === 0;

describe("the compose file the harness writes", () => {
  const place = { container: `${PREFIX}store-0000`, port: 4321, volume: `${PREFIX}vol-0000` };
  const rendered = renderShared({ user: "root-user", password: "root-secret" });

  it("holds the minio service alone, even when the rendered file holds the app too", () => {
    const withApp: RenderedCompose = {
      ...rendered,
      services: {
        ...rendered.services,
        "whatsapp-mcp-instance": { image: "ghcr.io/example/app:latest" },
      },
    };

    const file = storeCompose(withApp, place);

    expect(Object.keys(file.services)).toEqual(["minio"]);
    expect(JSON.stringify(file)).not.toContain("ghcr.io");
  });

  it("keeps image, command, credential wiring, healthcheck, restart and ceiling as rendered", () => {
    const ceiling = { ...rendered.services.minio, mem_limit: "157286400" } as never;

    const service = storeCompose({ ...rendered, services: { minio: ceiling } }, place).services
      .minio;

    const was = rendered.services.minio;
    expect(service).toMatchObject({
      image: was?.image,
      command: was?.command,
      environment: was?.environment,
      healthcheck: was?.healthcheck,
      restart: was?.restart,
      mem_limit: "157286400",
    });
  });

  it("changes only the container name, the network, the port and the data", () => {
    const file = storeCompose(rendered, place);
    const was = rendered.services.minio ?? {};
    const now = file.services.minio ?? {};

    const changed = Object.keys({ ...was, ...now }).filter(
      (key) => JSON.stringify((was as never)[key]) !== JSON.stringify((now as never)[key]),
    );

    expect(changed.sort()).toEqual(["container_name", "networks", "ports", "volumes"]);
    expect(now.container_name).toBe(place.container);
    expect(now.ports).toEqual(["127.0.0.1:4321:9000"]);
    expect(now.volumes).toEqual([{ type: "volume", source: place.volume, target: "/data" }]);
    expect(file.volumes).toEqual({ [place.volume]: { name: place.volume, external: true } });
    expect(now.networks).toEqual({ store: null });
    expect(file.networks).toEqual({ store: {} });
    expect(JSON.stringify(file)).not.toContain("/storage/");
  });

  it("refuses a rendered file with no minio service, such as an instance's of the old layout", () => {
    const instance = renderCompose({
      file: INSTANCE_FIXTURE,
      env: {
        INSTANCE: "pessoal",
        PUBLIC_DOMAIN: "wa.e2e.test",
        MCP_AUTH_TOKEN: "token",
        MINIO_ROOT_USER: "u",
        MINIO_ROOT_PASSWORD: "p",
      },
    });

    expect(Object.keys(instance.services)).toEqual(["whatsapp-mcp-instance"]);
    expect(() => storeCompose(instance, place)).toThrow(/no service "minio"/);
    return expect(startStore(instance)).rejects.toThrow(/no service "minio"/);
  });

  it("refuses a rendered store that mounts anything but /data", () => {
    const odd = {
      ...rendered,
      services: {
        minio: {
          ...rendered.services.minio,
          volumes: [{ type: "bind", source: "/x", target: "/elsewhere" }],
        },
      },
    } as RenderedCompose;

    expect(() => storeCompose(odd, place)).toThrow(/mount \/data alone/);
  });
});

describe("what the harness refuses to write", () => {
  const store = { image: "rustfs/rustfs:latest" };

  it.each([
    ["the app next to the store", { minio: store, app: { image: "x" } }],
    ["the app alone", { "whatsapp-mcp-instance": { image: "ghcr.io/example/app:latest" } }],
    ["a service named otherwise", { hub: store }],
    ["nothing", {}],
  ])("%s", (_what, services) => {
    expect(() => assertStoreOnly({ services })).toThrow(/starts the service "minio" alone/);
  });

  it("a minio service that is not the store image", () => {
    expect(() =>
      assertStoreOnly({ services: { minio: { image: "ghcr.io/example/app:latest" } } }),
    ).toThrow(/starts rustfs\/rustfs only/);
  });

  it("accepts the store alone", () => {
    expect(() => assertStoreOnly({ services: { minio: store } })).not.toThrow();
  });
});

describe("a store started from the fixture's shared stack", () => {
  const pair = pairOf();
  let store: E2eStore;

  beforeAll(async () => {
    store = await startStore(renderShared(pair));
  });

  afterAll(async () => {
    await store?.stop();
  });

  it("is healthy through the rendered healthcheck, on a container named for the harness", () => {
    const state = store.inspect();

    expect(store.container.startsWith(PREFIX)).toBe(true);
    expect(state).toMatchObject({
      health: "healthy",
      running: true,
      oomKilled: false,
      restarts: 0,
    });
    // The layout at 66c793c sets no ceiling: 0 means none.
    expect(state.memory).toBe(0);
    expect(store.url).toBe(`http://127.0.0.1:${store.port}`);
  });

  it("wires the rendered root pair: it is accepted and any other is refused", async () => {
    await store.client().bucketExists("probe");

    const stranger = store.client({ accessKey: secret(), secretKey: secret() });

    await expect(stranger.bucketExists("probe")).rejects.toMatchObject({
      code: "InvalidAccessKeyId",
    });
  });

  it("keeps what is written to it", async () => {
    const client = store.client();
    const bytes = randomBytes(2048);
    await client.makeBucket("probe", "us-east-1");
    await client.putObject("probe", "a/b.bin", bytes, bytes.length, {
      "Content-Type": "application/x-probe",
    });

    const stat = await client.statObject("probe", "a/b.bin");
    const chunks: Buffer[] = [];
    for await (const chunk of await client.getObject("probe", "a/b.bin")) chunks.push(chunk);

    expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
    expect(stat.metaData["content-type"]).toBe("application/x-probe");
  });
});

describe("a store stopped and started again on the same data", () => {
  it("removes the container, keeps the data and serves it to a new root pair", async () => {
    const first = pairOf();
    const second = pairOf();
    const volume = createStoreVolume();
    const old = await startStore(renderShared(first), { volume });
    const bytes = randomBytes(512);
    try {
      await old.client().makeBucket("probe", "us-east-1");
      await old.client().putObject("probe", "kept.bin", bytes, bytes.length);
      await old.stop();

      expect(exists("container", old.container)).toBe(false);
      expect(exists("volume", volume)).toBe(true);

      const next = await startStore(renderShared(second), { volume });
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of await next.client().getObject("probe", "kept.bin")) {
          chunks.push(chunk);
        }
        expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
        await expect(
          next.client({ accessKey: first.user, secretKey: first.password }).bucketExists("probe"),
        ).rejects.toMatchObject({ code: "InvalidAccessKeyId" });
      } finally {
        await next.stop();
      }
      expect(exists("volume", volume)).toBe(true);
    } finally {
      await old.stop();
      removeStoreVolume(volume);
    }
    expect(exists("volume", volume)).toBe(false);
  }, 90_000);

  it("removes the volume it created itself, and the network", async () => {
    const own = await startStore(renderShared(pairOf()));
    const { container, volume } = own;
    const network = docker([
      "inspect",
      container,
      "--format",
      "{{json .NetworkSettings.Networks}}",
    ]);
    const networkName = Object.keys(JSON.parse(network.out))[0] as string;

    await own.stop();

    expect(networkName.startsWith(PREFIX)).toBe(true);
    expect(exists("container", container)).toBe(false);
    expect(exists("volume", volume)).toBe(false);
    expect(docker(["network", "inspect", networkName]).status).not.toBe(0);
  }, 60_000);
});
