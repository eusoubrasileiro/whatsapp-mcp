/**
 * Harness: runs a REAL media store (RustFS) in a throwaway container, created from the `minio`
 * service of a compose file exactly as `docker compose config` renders it, so a spec exercises
 * the store the deploy files describe and not a copy of it.
 *
 * Only that one service is ever started. The deploy files also hold the app (an image that
 * would contact WhatsApp), so the harness writes a compose file of its own that holds the
 * `minio` service alone, refuses to write any other, and never runs `docker compose up` on the
 * deploy file itself. The declared differences from the rendered service are the only edits:
 *
 *   - the container name: random, prefix `whatsapp-mcp-e2e-`
 *   - the network: a throwaway one instead of the external `network_public`, plus one loopback
 *     port for the S3 API
 *   - the data: a named volume instead of the host directory (kept when the caller owns it, so
 *     a second store can be started on the same data)
 *
 * Image, command, credential wiring, healthcheck, restart policy and memory ceiling are the
 * rendered ones. Nothing is pulled. Containers, networks and volumes are removed by `stop()`
 * and again when the process exits.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as Minio from "minio";
import type { RenderedCompose, RenderedService } from "./compose.ts";
import { cleanupOnExit, docker, forget } from "./docker.ts";
import { freePort } from "./server.ts";

const PREFIX = "whatsapp-mcp-e2e-";
/** The only service this harness will start. */
const SERVICE = "minio";
const IMAGE_FAMILY = "rustfs/rustfs";
const DATA = "/data";
const S3_PORT = 9000;
const WAIT_TIMEOUT_S = 90;
const LAUNCH_ATTEMPTS = 3;
const PORT_TAKEN = /port is already allocated|address already in use/i;

/** A compose file as the harness writes it. */
export interface StoreComposeFile {
  services: Record<string, Record<string, unknown> & { image?: string }>;
  networks: Record<string, Record<string, never>>;
  volumes: Record<string, { name: string; external: true }>;
}

interface Placement {
  container: string;
  port: number;
  volume: string;
}

/** Throws unless `file` holds the RustFS `minio` service and nothing else. */
export function assertStoreOnly(file: Pick<StoreComposeFile, "services">): void {
  const names = Object.keys(file.services);
  if (names.length !== 1 || names[0] !== SERVICE) {
    throw new Error(
      `the store harness starts the service "${SERVICE}" alone and refuses a file holding ${names.join(", ") || "nothing"}`,
    );
  }
  const image = file.services[SERVICE]?.image ?? "";
  if (!image.startsWith(IMAGE_FAMILY)) {
    throw new Error(
      `the store harness refuses the image "${image}": it starts ${IMAGE_FAMILY} only`,
    );
  }
}

/** The compose file for one store: the rendered service with the declared differences applied. */
export function storeCompose(rendered: RenderedCompose, place: Placement): StoreComposeFile {
  const service = rendered.services[SERVICE];
  if (!service) {
    throw new Error(
      `no service "${SERVICE}" in the rendered file (it has ${Object.keys(rendered.services).join(", ")})`,
    );
  }
  const mounts = (service.volumes ?? []).map((mount) => mount.target);
  if (mounts.length !== 1 || mounts[0] !== DATA) {
    throw new Error(`the store is expected to mount ${DATA} alone, it mounts ${mounts.join(", ")}`);
  }
  const { container_name: _name, networks: _networks, volumes: _volumes, ...kept } = service;
  const file: StoreComposeFile = {
    services: {
      [SERVICE]: {
        ...kept,
        container_name: place.container,
        networks: { store: null },
        ports: [`127.0.0.1:${place.port}:${S3_PORT}`],
        volumes: [{ type: "volume", source: place.volume, target: DATA }],
      },
    },
    networks: { store: {} },
    volumes: { [place.volume]: { name: place.volume, external: true } },
  };
  assertStoreOnly(file);
  return file;
}

/** What a spec may ask of a running store's container. */
interface StoreState {
  /** The memory ceiling in bytes; 0 when there is none. */
  memory: number;
  health: string;
  running: boolean;
  oomKilled: boolean;
  restarts: number;
  /** The id of the image the container runs. */
  image: string;
}

export interface E2eStore {
  container: string;
  /** The loopback port of the S3 API. */
  port: number;
  /** `http://127.0.0.1:<port>` */
  url: string;
  /** The root pair the rendered service wires in. */
  accessKey: string;
  secretKey: string;
  /** The named volume holding its data. */
  volume: string;
  /** An S3 client for the store: the root pair unless another is given. */
  client(credentials?: { accessKey: string; secretKey: string }): Minio.Client;
  inspect(): StoreState;
  /** Removes the container and its network. Returns the volume, which is removed only if this store created it and `keepVolume` is not set. */
  stop(options?: { keepVolume?: boolean }): Promise<string>;
}

/** A named volume of the harness's own, to start several stores on the same data. */
export function createStoreVolume(): string {
  const name = `${PREFIX}vol-${randomBytes(4).toString("hex")}`;
  const made = docker(["volume", "create", name]);
  if (made.status !== 0) throw new Error(`docker volume create failed: ${made.err}`);
  cleanupOnExit(`volume ${name}`, () => {
    docker(["volume", "rm", "-f", name]);
  });
  return name;
}

export function removeStoreVolume(name: string): void {
  docker(["volume", "rm", "-f", name]);
  forget(`volume ${name}`);
}

function requireImage(image: string): void {
  let said = "";
  try {
    const probe = docker(["image", "inspect", image, "--format", "{{.Id}}"]);
    if (probe.status === 0) return;
    said = probe.err;
  } catch (err) {
    said = (err as Error).message;
  }
  throw new Error(
    `The store harness needs Docker and the image ${image}, and does not pull it.\n` +
      `Run once: docker pull ${image}\n(docker said: ${said})`,
  );
}

function credentialsOf(service: RenderedService): { accessKey: string; secretKey: string } {
  const env = service.environment ?? {};
  const accessKey = env.RUSTFS_ROOT_USER;
  const secretKey = env.RUSTFS_ROOT_PASSWORD;
  if (!accessKey || !secretKey) {
    throw new Error("the rendered store has no RUSTFS_ROOT_USER / RUSTFS_ROOT_PASSWORD");
  }
  return { accessKey, secretKey };
}

function inspectContainer(container: string): StoreState {
  const run = docker(["inspect", container]);
  if (run.status !== 0) throw new Error(`docker inspect ${container} failed: ${run.err}`);
  const [info] = JSON.parse(run.out) as {
    Image: string;
    RestartCount: number;
    HostConfig: { Memory: number };
    State: { Running: boolean; OOMKilled: boolean; Health?: { Status: string } };
  }[];
  if (!info) throw new Error(`docker inspect ${container} printed nothing`);
  return {
    memory: info.HostConfig.Memory,
    health: info.State.Health?.Status ?? "none",
    running: info.State.Running,
    oomKilled: info.State.OOMKilled,
    restarts: info.RestartCount,
    image: info.Image,
  };
}

async function launch(
  rendered: RenderedCompose,
  volume: string,
  ownsVolume: boolean,
): Promise<E2eStore> {
  const { accessKey, secretKey } = credentialsOf(rendered.services[SERVICE] as RenderedService);
  const suffix = randomBytes(4).toString("hex");
  const container = `${PREFIX}store-${suffix}`;
  const project = `${PREFIX}${suffix}`;
  const network = `${project}_store`;
  const port = await freePort();
  const file = storeCompose(rendered, { container, port, volume });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-mcp-e2e-store-"));
  const composeFile = path.join(dir, "compose.json"); // JSON is valid YAML
  // The file holds the store's root pair: private, and gone with the store.
  fs.writeFileSync(composeFile, JSON.stringify(file, null, 2), { mode: 0o600 });

  const remove = () => {
    docker(["rm", "-f", "-v", container]);
    docker(["network", "rm", network]);
    fs.rmSync(dir, { recursive: true, force: true });
  };
  cleanupOnExit(`store ${container}`, remove);

  const started = docker(
    [
      "compose",
      "-p",
      project,
      "-f",
      composeFile,
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      String(WAIT_TIMEOUT_S),
      "--pull",
      "never",
      SERVICE,
    ],
    { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
  );
  if (started.status !== 0) {
    const logs = docker(["logs", "--tail", "40", container]);
    remove();
    forget(`store ${container}`);
    throw new Error(
      `the store ${container} did not start (${started.status}):\n${started.err}\n${logs.out}\n${logs.err}`,
    );
  }

  const client = (credentials = { accessKey, secretKey }) =>
    new Minio.Client({ endPoint: "127.0.0.1", port, useSSL: false, ...credentials });
  return {
    container,
    port,
    url: `http://127.0.0.1:${port}`,
    accessKey,
    secretKey,
    volume,
    client,
    inspect: () => inspectContainer(container),
    async stop(options = {}) {
      remove();
      forget(`store ${container}`);
      if (ownsVolume && !options.keepVolume) removeStoreVolume(volume);
      return volume;
    },
  };
}

/**
 * Starts the `minio` service of `rendered` and resolves once its own healthcheck passes. Fails,
 * never skips, when Docker or the image is missing. With `volume` the store runs on data a
 * caller owns (see `createStoreVolume`); without it, on a new volume that `stop()` removes. A
 * start that loses the race for its loopback port is repeated with a new one.
 */
export async function startStore(
  rendered: RenderedCompose,
  options: { volume?: string } = {},
): Promise<E2eStore> {
  const service = rendered.services[SERVICE];
  if (!service) {
    throw new Error(
      `no service "${SERVICE}" in the rendered file (it has ${Object.keys(rendered.services).join(", ")})`,
    );
  }
  requireImage(service.image);
  const ownsVolume = options.volume === undefined;
  const volume = options.volume ?? createStoreVolume();
  for (let attempt = 1; ; attempt++) {
    try {
      return await launch(rendered, volume, ownsVolume);
    } catch (err) {
      const again = PORT_TAKEN.test((err as Error).message) && attempt < LAUNCH_ATTEMPTS;
      if (!again) {
        if (ownsVolume) removeStoreVolume(volume);
        throw err;
      }
    }
  }
}
