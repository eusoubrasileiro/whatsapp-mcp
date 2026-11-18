import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type * as Minio from "minio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureBucketReady, resetStorageClient, setStorageClient } from "../src/storage.ts";
import { appServerEnv, only } from "./support/app-env.ts";
import { type RenderedCompose, type RenderedService, renderCompose } from "./support/compose.ts";
import { type E2eServer, NO_EGRESS, startServer } from "./support/server.ts";
import { dumpRows, registerWebhook, sha256File, uploadPng, webhookUrls } from "./support/state.ts";
import {
  createStoreVolume,
  type E2eStore,
  removeStoreVolume,
  startStore,
} from "./support/store.ts";
import {
  dynamicConfigFromLabels,
  type RoutedService,
  startTraefik,
  type TraefikProxy,
} from "./support/traefik.ts";

/**
 * Rehearsal of deploy day for the one-store-per-number layout, in the order of the runbook:
 * `empresa` first (its objects are copied to a store of its own), then `pessoal` (its store is
 * recreated on the same data with a new pair), then the later removal of the old copies, and the
 * way back. Real RustFS stores, the real proxy and real servers that never connect to WhatsApp;
 * the copy tool runs as a child process with the environment the runbook builds.
 *
 * What the layout at 66c793c looked like is kept as fixtures: one shared store and two numbers
 * pointed at it. What it becomes is the deploy files themselves. Data directories and stores are
 * throwaway stand-ins for /storage/whatsapp-mcp and /storage/whatsapp-mcp-empresa; no step
 * touches the dev store.
 *
 * Needs Docker with the images `traefik:v3.6.6` and `rustfs/rustfs:latest` (nothing is pulled);
 * it fails, never skips, without them.
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const INSTANCE_FILE = path.join(ROOT, "deploy", "docker-compose.instance.yaml");
const FIXTURES = path.join(import.meta.dirname, "fixtures");
const SHARED_66C793C = path.join(FIXTURES, "compose-66c793c-shared.yaml");
const INSTANCE_66C793C = path.join(FIXTURES, "compose-66c793c-instance.yaml");
const CLI = path.join(ROOT, "src", "store-copy-cli.ts");
const HOST = "wa.e2e.test";
const BUCKET = "amiticia-media";
const LABELS = ["pessoal", "empresa"] as const;
type Label = (typeof LABELS)[number];
/** Made-up numbers; the contacts' chats are made up too. */
const FAKE_NUMBER: Record<Label, string> = { pessoal: "5500000001234", empresa: "5500000005678" };
const CHAT: Record<Label, string> = {
  pessoal: "5500000008888@s.whatsapp.net",
  empresa: "5500000009999@s.whatsapp.net",
};
const PREFIX = "t/empresa/";
const CEILING = "157286400";
const REFUSED = [403, 404];
const MIB = 1024 * 1024;

const secret = () => randomBytes(16).toString("hex");
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

interface Pair {
  user: string;
  password: string;
}
const pair = (): Pair => ({ user: secret(), password: secret() });

/** An object as a spec writes it and expects to read it back. */
interface Stored {
  key: string;
  bytes: Buffer;
  type: string;
}
/** An object a server stored through its own `/upload`, with the URL it returned. */
interface Upload extends Stored {
  url: string;
}
const stored = (key: string, type: string, size: number): Stored => ({
  key,
  type,
  bytes: randomBytes(size),
});

const putObject = (client: Minio.Client, one: Stored) =>
  client.putObject(BUCKET, one.key, one.bytes, one.bytes.length, { "Content-Type": one.type });

interface Entry {
  sha: string;
  type: string;
  size: number;
}
type Snapshot = Record<string, Entry>;

const entryOf = (one: Stored): Entry => ({
  sha: sha(one.bytes),
  type: one.type,
  size: one.bytes.length,
});

/** Every object of a store under a prefix, read back: checksum, content type, size. */
async function snapshot(client: Minio.Client, prefix = ""): Promise<Snapshot> {
  const found: Snapshot = {};
  if (!(await client.bucketExists(BUCKET))) return found;
  const names: string[] = [];
  for await (const object of client.listObjectsV2(BUCKET, prefix, true)) {
    if (object.name) names.push(object.name);
  }
  for (const name of names.sort()) {
    const stat = await client.statObject(BUCKET, name);
    const hash = createHash("sha256");
    for await (const chunk of await client.getObject(BUCKET, name)) hash.update(chunk);
    found[name] = {
      sha: hash.digest("hex"),
      type: stat.metaData["content-type"],
      size: stat.size,
    };
  }
  return found;
}

/** Last-modified time of every object: a rewritten object changes it, a left alone one does not. */
async function modifiedTimes(client: Minio.Client): Promise<Record<string, number>> {
  const found: Record<string, number> = {};
  for await (const object of client.listObjectsV2(BUCKET, "", true)) {
    if (object.name) found[object.name] = object.lastModified?.getTime() ?? 0;
  }
  return found;
}

const under = (from: Snapshot, prefix: string): Snapshot =>
  Object.fromEntries(Object.entries(from).filter(([key]) => key.startsWith(prefix)));
const outside = (from: Snapshot, prefix: string): Snapshot =>
  Object.fromEntries(Object.entries(from).filter(([key]) => !key.startsWith(prefix)));
const expected = (...objects: Stored[]): Snapshot =>
  Object.fromEntries(objects.map((one) => [one.key, entryOf(one)]));

/** One number's pairing and database as they sit on disk. */
interface OnDisk {
  pairing: Record<string, string>;
  database: string;
  rows: Record<string, unknown[]>;
}

describe("one store per number: the cutover, rehearsed", () => {
  const oldPair = pair();
  const pairs: Record<Label, Pair> = { pessoal: pair(), empresa: pair() };
  const dirs = {} as Record<Label, string>;
  const servers: Partial<Record<Label, E2eServer>> = {};
  /** The numbers' stores as the deploy files define them. */
  const stores = {} as Record<Label, E2eStore>;
  const composes = {} as Record<Label, RenderedCompose>;
  /** What each number holds from before the cutover. */
  const seeded = {} as Record<Label, { upload: Upload; direct: Stored[] }>;
  /** What each number wrote after its own cutover. */
  const after = {} as Record<Label, Upload>;
  const before = {} as Record<Label, OnDisk>;
  /** The sibling tenant `t/empresa-2/`, which a prefix of `t/empresa/` must never reach. */
  const sibling = stored("t/empresa-2/note.png", "image/png", 512);
  const cliOutput: string[] = [];
  let deployDir: string;
  let oldVolume: string;
  let oldStore: E2eStore;
  let rolledBack: E2eStore | undefined;
  let proxy: TraefikProxy | undefined;
  /** Everything the old shared store held when the shared stack still ran it. */
  let oldObjects: Snapshot;

  const oldEmpresaObjects = (): Stored[] => [seeded.empresa.upload, ...seeded.empresa.direct];
  const hookOf = (label: Label) => `https://hooks.e2e.test/${label}`;

  // --- rendering: what the owner's env files would say ------------------------------------

  const sharedEnv = (p: Pair) => ({
    PUBLIC_DOMAIN: HOST,
    MINIO_ROOT_USER: p.user,
    MINIO_ROOT_PASSWORD: p.password,
    HUB_PIN: "0000",
    HUB_COOKIE_KEY: "cookie-key",
    HUB_INSTANCES: LABELS.join(","),
  });

  /** The personal number keeps its old directory and media prefix; the company line has defaults. */
  function instanceEnv(label: Label, p: Pair): Record<string, string> {
    return {
      COMPOSE_FILE: "docker-compose.instance.yaml",
      INSTANCE: label,
      PUBLIC_DOMAIN: HOST,
      MCP_AUTH_TOKEN: secret(),
      MINIO_ROOT_USER: p.user,
      MINIO_ROOT_PASSWORD: p.password,
      EXPECTED_WA_NUMBER: FAKE_NUMBER[label],
      INSTANCE_DESCRIPTION: `the ${label} line`,
      ...(label === "pessoal" ? { TENANT_ID: "default", INSTANCE_DATA_DIR: dirs.pessoal } : {}),
    };
  }

  const renderShared66 = () => renderCompose({ file: SHARED_66C793C, env: sharedEnv(oldPair) });
  const renderNew = (label: Label) =>
    renderCompose({ file: INSTANCE_FILE, env: instanceEnv(label, pairs[label]) });
  const app = (label: Label): RenderedService =>
    only(composes[label].services, "whatsapp-mcp-instance");

  /** A server in the layout at 66c793c: the app as that file rendered it, on the shared store. */
  async function startOldShape(label: Label): Promise<E2eServer> {
    const rendered = renderCompose({ file: INSTANCE_66C793C, env: instanceEnv(label, oldPair) });
    return startServer({
      s3: true,
      dataDir: dirs[label],
      env: appServerEnv(only(rendered.services, "whatsapp-mcp-instance"), oldStore),
    });
  }

  /** The same data directory, with the app as the deploy file now renders it. */
  const startNewShape = (label: Label) =>
    startServer({ s3: true, dataDir: dirs[label], env: appServerEnv(app(label), stores[label]) });

  // --- what must survive: pairing and database -------------------------------------------

  function writePairing(dir: string) {
    const auth = path.join(dir, "auth_info");
    fs.mkdirSync(auth, { recursive: true });
    fs.writeFileSync(path.join(auth, "creds.json"), randomBytes(2048));
    fs.writeFileSync(path.join(auth, "app-state-sync-key-1.json"), randomBytes(512));
    fs.writeFileSync(path.join(auth, "pre-key-1.json"), randomBytes(512));
  }

  function onDisk(label: Label): OnDisk {
    const auth = path.join(dirs[label], "auth_info");
    const database = path.join(dirs[label], "data", "whatsapp.db");
    return {
      pairing: Object.fromEntries(
        fs.readdirSync(auth).map((name) => [name, sha256File(path.join(auth, name))]),
      ),
      database: sha256File(database),
      rows: dumpRows(database),
    };
  }

  // --- the copy tool, as the runbook runs it ----------------------------------------------

  /** Step 13 of the runbook, word for word: values come out of the env files and are never shown. */
  const PICK = String.raw`pick() { sed -n "s/^$1=[\"']\{0,1\}\([^\"']*\)[\"']\{0,1\}\$/$2=\1/p" "$3"; }`;

  interface End {
    file: string;
    port: number;
  }
  const envFileOf = (label: Label | "pre-store") =>
    label === "pre-store" ? ".env.pre-store" : `.env.${label}`;
  const end = (label: Label | "pre-store", port: number): End => ({ file: envFileOf(label), port });

  /** The copy's env file, built by the runbook's snippet; the rehearsal adds the two port lines. */
  function copyEnv(src: End, dst: End, prefix = PREFIX): Record<string, string> {
    const script = [
      "set -e",
      "umask 077",
      PICK,
      "{",
      "  echo STORE_COPY_SRC_ENDPOINT=127.0.0.1",
      `  echo STORE_COPY_SRC_PORT=${src.port}`,
      `  pick MINIO_ROOT_USER STORE_COPY_SRC_ACCESS_KEY ${src.file}`,
      `  pick MINIO_ROOT_PASSWORD STORE_COPY_SRC_SECRET_KEY ${src.file}`,
      "  echo STORE_COPY_DST_ENDPOINT=127.0.0.1",
      `  echo STORE_COPY_DST_PORT=${dst.port}`,
      `  pick MINIO_ROOT_USER STORE_COPY_DST_ACCESS_KEY ${dst.file}`,
      `  pick MINIO_ROOT_PASSWORD STORE_COPY_DST_SECRET_KEY ${dst.file}`,
      `  echo STORE_COPY_PREFIX=${prefix}`,
      "} > store-copy.env",
    ].join("\n");
    const run = spawnSync("bash", ["-c", script], {
      cwd: deployDir,
      env: { PATH: process.env.PATH ?? "" },
      encoding: "utf8",
    });
    expect(run.status).toBe(0);
    const lines = fs
      .readFileSync(path.join(deployDir, "store-copy.env"), "utf8")
      .split("\n")
      .filter(Boolean);
    expect(lines).toHaveLength(9);
    return Object.fromEntries(
      lines.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
  }

  interface CliRun {
    code: number;
    lines: string[];
    err: string;
  }

  /** `node src/store-copy-cli.ts <args>` with only the copy's environment, loopback only. */
  function cli(args: string[], env: Record<string, string>): CliRun {
    const run = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        "--import",
        pathToFileURL(NO_EGRESS).href,
        CLI,
        ...args,
      ],
      { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8", timeout: 120_000 },
    );
    cliOutput.push(run.stdout, run.stderr);
    return {
      code: run.status ?? -1,
      lines: run.stdout.split("\n").filter(Boolean),
      err: run.stderr.trim(),
    };
  }

  // --- the proxy, from the labels of the files in play ------------------------------------

  async function startProxy(routed: RoutedService[]) {
    await proxy?.stop();
    proxy = await startTraefik(dynamicConfigFromLabels(routed));
    return proxy;
  }

  const mediaUrl = (label: Label, key: string) => `https://${HOST}/${label}/media/${key}`;
  const via = () => {
    if (!proxy) throw new Error("no proxy is running");
    return proxy;
  };

  async function expectServed(label: Label, one: Stored) {
    const res = await via().fetch(mediaUrl(label, one.key));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(one.type);
    expect(Buffer.from(await res.arrayBuffer()).equals(one.bytes)).toBe(true);
  }

  async function expectRefused(label: Label, one: Stored) {
    const res = await via().fetch(mediaUrl(label, one.key));

    expect(REFUSED).toContain(res.status);
    expect(Buffer.from(await res.arrayBuffer()).equals(one.bytes)).toBe(false);
  }

  const routedStore = (service: RenderedService, store: E2eStore): RoutedService => ({
    service,
    ports: { "9000": store.url },
  });
  const storeOf = (label: Label) => only(composes[label].services, "minio");

  // --- step 1: the layout at 66c793c -------------------------------------------------------

  beforeAll(async () => {
    for (const label of LABELS) {
      dirs[label] = fs.mkdtempSync(path.join(os.tmpdir(), `whatsapp-mcp-cutover-${label}-`));
      writePairing(dirs[label]);
    }
    // The env files of the deploy directory: the old shared pair, then one new pair per number.
    deployDir = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-mcp-cutover-deploy-"));
    const envFiles: [string, string][] = [
      [
        ".env.pre-store",
        `INSTANCE=shared\nMINIO_ROOT_USER=${oldPair.user}\nMINIO_ROOT_PASSWORD="${oldPair.password}"\n`,
      ],
      [
        ".env.pessoal",
        `INSTANCE=pessoal\nMINIO_ROOT_USER=${pairs.pessoal.user}\nMINIO_ROOT_PASSWORD=${pairs.pessoal.password}\n`,
      ],
      [
        ".env.empresa",
        `INSTANCE=empresa\nMINIO_ROOT_USER=${pairs.empresa.user}\nMINIO_ROOT_PASSWORD='${pairs.empresa.password}'\n`,
      ],
    ];
    for (const [name, text] of envFiles) {
      fs.writeFileSync(path.join(deployDir, name), text, { mode: 0o600 });
    }

    oldVolume = createStoreVolume();
    oldStore = await startStore(renderShared66(), { volume: oldVolume });

    const started = await Promise.allSettled(
      LABELS.map(async (label) => {
        servers[label] = await startOldShape(label);
      }),
    );
    for (const result of started) if (result.status === "rejected") throw result.reason;

    // Each number holds a webhook and an upload, and the archive holds chat media of several kinds.
    for (const label of LABELS) {
      const server = servers[label] as E2eServer;
      await registerWebhook(server, hookOf(label));
      const uploaded = await uploadPng(server);
      seeded[label] = { upload: { ...uploaded, type: "image/png" }, direct: [] };
    }
    seeded.empresa.direct = [
      stored(`t/empresa/${CHAT.empresa}/3EB0E0001.jpg`, "image/jpeg", 4096),
      stored(`t/empresa/${CHAT.empresa}/3EB0E0002.ogg`, "audio/ogg", 2048),
      stored(`t/empresa/${CHAT.empresa}/3EB0E0003.pdf`, "application/pdf", MIB + 3),
    ];
    seeded.pessoal.direct = [
      stored(`t/default/${CHAT.pessoal}/3EB0A0001.mp4`, "video/mp4", 3072),
      stored(`t/default/${CHAT.pessoal}/3EB0A0002.webp`, "image/webp", 2048),
    ];
    for (const one of [...seeded.empresa.direct, ...seeded.pessoal.direct, sibling]) {
      await putObject(oldStore.client(), one);
    }
  }, 180_000);

  afterAll(async () => {
    const everything = [
      proxy?.stop(),
      ...Object.values(servers).map((server) => server?.stop()),
      ...Object.values(stores).map((store) => store.stop()),
      rolledBack?.stop(),
      oldStore?.stop(),
    ];
    const results = await Promise.allSettled(everything);
    if (oldVolume) removeStoreVolume(oldVolume);
    for (const dir of [...Object.values(dirs), deployDir]) {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  }, 120_000);

  describe("1. the layout at 66c793c", () => {
    it("has one shared store holding both numbers' objects, of several content types", async () => {
      const everything = await snapshot(oldStore.client());

      expect(everything).toEqual(
        expected(
          seeded.empresa.upload,
          ...seeded.empresa.direct,
          seeded.pessoal.upload,
          ...seeded.pessoal.direct,
          sibling,
        ),
      );
      expect(Object.keys(under(everything, PREFIX))).toHaveLength(4);
      expect(Object.keys(under(everything, "t/default/"))).toHaveLength(3);
      expect(seeded.empresa.upload.key).toMatch(/^t\/empresa\/uploads\/[0-9a-f-]{36}\.png$/);
      expect(seeded.pessoal.upload.key).toMatch(/^t\/default\/uploads\/[0-9a-f-]{36}\.png$/);
      expect(new Set(Object.values(everything).map((one) => one.type)).size).toBeGreaterThan(4);
    });

    it("has two servers on data directories holding a pairing of three files and a database", async () => {
      for (const label of LABELS) {
        expect(fs.readdirSync(path.join(dirs[label], "auth_info")).sort()).toEqual([
          "app-state-sync-key-1.json",
          "creds.json",
          "pre-key-1.json",
        ]);
        expect(await webhookUrls(servers[label] as E2eServer)).toEqual([hookOf(label)]);
      }
    });
  });

  // --- step 2: empresa's store, the copy and its verification --------------------------------

  describe("2. empresa: its own store, then the copy", () => {
    it("stops the server and records its pairing and database", async () => {
      await servers.empresa?.stop();
      servers.empresa = undefined;

      before.empresa = onDisk("empresa");

      expect(Object.keys(before.empresa.pairing)).toHaveLength(3);
      expect(before.empresa.rows.webhook_subscriptions).toHaveLength(1);
    });

    it("creates its store from the real instance file with a pair of its own, capped and healthy", async () => {
      composes.empresa = renderNew("empresa");

      stores.empresa = await startStore(composes.empresa);

      expect(stores.empresa.inspect()).toMatchObject({
        health: "healthy",
        running: true,
        memory: Number(CEILING),
      });
      // The shared store's pair opens nothing here, and this pair opens nothing there.
      await expect(
        stores.empresa
          .client({ accessKey: oldPair.user, secretKey: oldPair.password })
          .bucketExists(BUCKET),
      ).rejects.toMatchObject({ code: "InvalidAccessKeyId" });
      await expect(
        oldStore
          .client({ accessKey: pairs.empresa.user, secretKey: pairs.empresa.password })
          .bucketExists(BUCKET),
      ).rejects.toMatchObject({ code: "InvalidAccessKeyId" });
    }, 120_000);

    it("builds the copy's environment from the env files with the runbook's snippet", () => {
      const env = copyEnv(end("pre-store", oldStore.port), end("empresa", stores.empresa.port));

      expect(env).toEqual({
        STORE_COPY_SRC_ENDPOINT: "127.0.0.1",
        STORE_COPY_SRC_PORT: String(oldStore.port),
        STORE_COPY_SRC_ACCESS_KEY: oldPair.user,
        STORE_COPY_SRC_SECRET_KEY: oldPair.password,
        STORE_COPY_DST_ENDPOINT: "127.0.0.1",
        STORE_COPY_DST_PORT: String(stores.empresa.port),
        STORE_COPY_DST_ACCESS_KEY: pairs.empresa.user,
        STORE_COPY_DST_SECRET_KEY: pairs.empresa.password,
        STORE_COPY_PREFIX: PREFIX,
      });
    });

    it("a copy with the wrong source pair exits non-zero and creates nothing in the new store", async () => {
      const env = copyEnv(end("pre-store", oldStore.port), end("empresa", stores.empresa.port));

      const run = cli(["copy"], { ...env, STORE_COPY_SRC_SECRET_KEY: secret() });

      expect(run.code).toBe(1);
      expect(run.lines).toEqual([]);
      expect(await stores.empresa.client().bucketExists(BUCKET)).toBe(false);
    });

    it("copies every object under t/empresa/ and reports the same count on both sides", async () => {
      oldObjects = await snapshot(oldStore.client());
      const env = copyEnv(end("pre-store", oldStore.port), end("empresa", stores.empresa.port));

      const copied = cli(["copy"], env);
      const verified = cli(["verify"], env);

      expect(copied).toMatchObject({
        code: 0,
        lines: ["source 4, copied 4, unchanged 0, failed 0"],
      });
      expect(verified).toMatchObject({
        code: 0,
        lines: ["source 4, destination 4, identical 4, missing 0, different 0, extra 0"],
      });
    }, 120_000);

    it("leaves in the new store those objects, byte for byte and with their content types, and no other", async () => {
      const now = await snapshot(stores.empresa.client());

      expect(now).toEqual(expected(seeded.empresa.upload, ...seeded.empresa.direct));
      expect(Object.keys(now).every((key) => key.startsWith(PREFIX))).toBe(true);
      expect(Object.keys(now)).not.toContain(sibling.key);
    });

    it("leaves the old copies where they are, until remove-source is run", async () => {
      expect(await snapshot(oldStore.client())).toEqual(oldObjects);
    });

    it("changes nothing the second time", async () => {
      const env = copyEnv(end("pre-store", oldStore.port), end("empresa", stores.empresa.port));

      const again = cli(["copy"], env);

      expect(again).toMatchObject({
        code: 0,
        lines: ["source 4, copied 0, unchanged 4, failed 0"],
      });
      expect(await snapshot(stores.empresa.client())).toEqual(
        expected(seeded.empresa.upload, ...seeded.empresa.direct),
      );
    }, 120_000);
  });

  // --- step 3: the proxy while empresa is on its own store and pessoal is not -----------------

  describe("3. routing in the transitional state: the shared store's route and empresa's own", () => {
    const onlyNew = stored("t/empresa/probe-only-new.png", "image/png", 256);
    const onlyOld = stored("t/empresa/probe-only-old.png", "image/png", 256);

    it("starts the proxy from the shared stack's labels at 66c793c and the real empresa store's", async () => {
      const running = await startProxy([
        routedStore(only(renderShared66().services, "minio"), oldStore),
        routedStore(storeOf("empresa"), stores.empresa),
      ]);

      const loaded = (await running.routers()).filter((router) => router.provider === "file");

      expect(
        loaded.map((router) => `${router.name} ${router.priority} ${router.status}`).sort(),
      ).toEqual(["wa-empresa-media@file 110 enabled", "wa-media@file 100 enabled"]);
    }, 60_000);

    it("a new store whose app has not started serves nothing, and says so as itself", async () => {
      const probe = stored("t/empresa/probe-closed.png", "image/png", 128);
      await putObject(stores.empresa.client(), probe);
      try {
        const own = await via().fetch(mediaUrl("empresa", probe.key));
        // The shared store answers a key it lacks with 404: the 403 below is the new store's.
        const shared = await via().fetch(mediaUrl("pessoal", probe.key));

        expect(own.status).toBe(403);
        expect(shared.status).toBe(404);
      } finally {
        await stores.empresa.client().removeObject(BUCKET, probe.key);
      }
    });

    it("with the policy the app sets at start, empresa's label reaches the new store and no other", async () => {
      setStorageClient(stores.empresa.client());
      try {
        await ensureBucketReady();
      } finally {
        resetStorageClient();
      }
      await putObject(stores.empresa.client(), onlyNew);
      await putObject(oldStore.client(), onlyOld);
      try {
        // An object only the new store has is served; one only the old store has is not.
        await expectServed("empresa", onlyNew);
        await expectRefused("empresa", onlyOld);
        // The older shared route still answers the other label, from the old store.
        await expectServed("pessoal", onlyOld);
        await expectRefused("pessoal", onlyNew);
      } finally {
        await stores.empresa.client().removeObject(BUCKET, onlyNew.key);
        await oldStore.client().removeObject(BUCKET, onlyOld.key);
      }
    });

    it("serves the copied objects from the new store, and pessoal's own from the old", async () => {
      await expectServed("empresa", seeded.empresa.upload);
      await expectServed("pessoal", seeded.pessoal.upload);
      await expectRefused("empresa", seeded.pessoal.upload);
    });
  });

  // --- step 4: empresa's server in the new shape ------------------------------------------------

  describe("4. empresa: the server in the new shape, on the same data directory", () => {
    it("starts and finds its rows", async () => {
      servers.empresa = await startNewShape("empresa");

      expect(await webhookUrls(servers.empresa)).toEqual([hookOf("empresa")]);
    }, 90_000);

    it("serves its old link from its own store, with the same bytes and content type", async () => {
      const res = await via().fetch(seeded.empresa.upload.url);

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await res.arrayBuffer()).equals(seeded.empresa.upload.bytes)).toBe(true);
    });

    it("writes a new upload into its own store only, under t/empresa/", async () => {
      const uploaded = await uploadPng(servers.empresa as E2eServer);
      after.empresa = { ...uploaded, type: "image/png" };

      expect(after.empresa.key).toMatch(/^t\/empresa\/uploads\/[0-9a-f-]{36}\.png$/);
      expect(Object.keys(await snapshot(stores.empresa.client(), after.empresa.key))).toEqual([
        after.empresa.key,
      ]);
      expect(await snapshot(oldStore.client(), after.empresa.key)).toEqual({});
      await expectServed("empresa", after.empresa);
      await expectRefused("pessoal", after.empresa);
    });

    it("stops, leaving the pairing and the database for the final comparison", async () => {
      await servers.empresa?.stop();
      servers.empresa = undefined;
    });
  });

  // --- step 5: pessoal ----------------------------------------------------------------------

  describe("5. pessoal: its store on the same data, with a new pair", () => {
    it("stops the server, records its pairing and database, and stops the shared store", async () => {
      await servers.pessoal?.stop();
      servers.pessoal = undefined;
      before.pessoal = onDisk("pessoal");
      oldObjects = await snapshot(oldStore.client());
      const modified = await modifiedTimes(oldStore.client());
      Object.assign(oldObjects, { __modified: modified });

      await oldStore.stop({ keepVolume: true });

      expect(before.pessoal.rows.webhook_subscriptions).toHaveLength(1);
      expect(Object.keys(before.pessoal.pairing)).toHaveLength(3);
    });

    it("creates its store from the real instance file on the same volume, healthy and capped", async () => {
      composes.pessoal = renderNew("pessoal");

      stores.pessoal = await startStore(composes.pessoal, { volume: oldVolume });

      expect(stores.pessoal.inspect()).toMatchObject({
        health: "healthy",
        running: true,
        memory: Number(CEILING),
      });
    }, 120_000);

    it("refuses the old pair and accepts the new one", async () => {
      await expect(
        stores.pessoal
          .client({ accessKey: oldPair.user, secretKey: oldPair.password })
          .bucketExists(BUCKET),
      ).rejects.toMatchObject({ code: "InvalidAccessKeyId" });
      expect(await stores.pessoal.client().bucketExists(BUCKET)).toBe(true);
    });

    it("holds every old object as it was, with none copied or rewritten", async () => {
      const { __modified, ...objects } = oldObjects as Snapshot & {
        __modified: Record<string, number>;
      };

      expect(await snapshot(stores.pessoal.client())).toEqual(objects);
      expect(await modifiedTimes(stores.pessoal.client())).toEqual(__modified);
    });

    it("keeps the bucket's policy: an object is served, a missing key is 404, the listing is closed", async () => {
      const base = `${stores.pessoal.url}/${BUCKET}`;

      const one = await fetch(`${base}/${seeded.pessoal.upload.key}`);
      const missing = await fetch(`${base}/t/default/none.png`);
      const listing = await fetch(`${base}/?list-type=2&prefix=t/`);

      expect(one.status).toBe(200);
      expect(Buffer.from(await one.arrayBuffer()).equals(seeded.pessoal.upload.bytes)).toBe(true);
      expect(missing.status).toBe(404);
      expect(REFUSED).toContain(listing.status);
    });

    it("starts the server in the new shape: its rows, its old link, its new upload under t/default/", async () => {
      await startProxy(LABELS.map((label) => routedStore(storeOf(label), stores[label])));
      servers.pessoal = await startNewShape("pessoal");

      expect(await webhookUrls(servers.pessoal)).toEqual([hookOf("pessoal")]);
      const old = await via().fetch(seeded.pessoal.upload.url);
      expect(old.status).toBe(200);
      expect(Buffer.from(await old.arrayBuffer()).equals(seeded.pessoal.upload.bytes)).toBe(true);

      const uploaded = await uploadPng(servers.pessoal);
      after.pessoal = { ...uploaded, type: "image/png" };
      expect(after.pessoal.key).toMatch(/^t\/default\/uploads\/[0-9a-f-]{36}\.png$/);
      expect(Object.keys(await snapshot(stores.pessoal.client(), after.pessoal.key))).toEqual([
        after.pessoal.key,
      ]);
      expect(await snapshot(stores.empresa.client(), after.pessoal.key)).toEqual({});
      await expectServed("pessoal", after.pessoal);

      await servers.pessoal.stop();
      servers.pessoal = undefined;
    }, 120_000);
  });

  // --- step 6: routing once both numbers have their own store -------------------------------

  describe("6. routing with a store per number", () => {
    it("serves each number's keys on its own label", async () => {
      await expectServed("empresa", seeded.empresa.upload);
      await expectServed("empresa", after.empresa);
      await expectServed("pessoal", seeded.pessoal.upload);
      await expectServed("pessoal", after.pessoal);
    });

    it("refuses a pessoal key under /empresa/media/, and the reverse, for keys written after the cutover", async () => {
      await expectRefused("empresa", after.pessoal);
      await expectRefused("pessoal", after.empresa);
    });

    it("refuses pessoal's keys of before the cutover under /empresa/media/ too", async () => {
      await expectRefused("empresa", seeded.pessoal.upload);
      for (const one of seeded.pessoal.direct) await expectRefused("empresa", one);
    });

    it("known remainder: every old copy of empresa's objects is still served at /pessoal/media/t/empresa/<old key>", async () => {
      // Step 14 left the old objects in the store pessoal now runs; until remove-source runs
      // (step F of the runbook), whoever holds the full key can still read them there.
      for (const one of oldEmpresaObjects()) await expectServed("pessoal", one);
    });
  });

  // --- step 7: the removal, on Andre's word, later ----------------------------------------------

  describe("7. remove-source", () => {
    /** The runbook's step F: source pessoal's store with its pair, destination empresa's store. */
    const removal = () =>
      copyEnv(end("pessoal", stores.pessoal.port), end("empresa", stores.empresa.port));
    const victim = () => seeded.empresa.direct[1] as Stored;

    it("verifies first: every source object has an identical destination object, and extras are counted", () => {
      const run = cli(["verify"], removal());

      expect(run).toMatchObject({
        code: 0,
        lines: ["source 4, destination 5, identical 4, missing 0, different 0, extra 1"],
      });
    });

    it.each([
      [
        "an object missing",
        (client: Minio.Client, one: Stored) => client.removeObject(BUCKET, one.key),
      ],
      [
        "an object with other bytes",
        (client: Minio.Client, one: Stored) =>
          putObject(client, { ...one, bytes: randomBytes(one.bytes.length) }),
      ],
      [
        "an object with another content type",
        (client: Minio.Client, one: Stored) => putObject(client, { ...one, type: "audio/mpeg" }),
      ],
    ])(
      "with %s in the destination it exits non-zero and removes nothing",
      async (_what, damage) => {
        await damage(stores.empresa.client(), victim());
        const heldBefore = await snapshot(stores.pessoal.client());

        const run = cli(["remove-source", "--confirm", PREFIX], removal());

        expect(run.code).toBe(1);
        expect(await snapshot(stores.pessoal.client())).toEqual(heldBefore);
        // The copy that mends the destination rewrites that one object and no other.
        const mended = cli(["copy"], removal());
        expect(mended).toMatchObject({
          code: 0,
          lines: ["source 4, copied 1, unchanged 3, failed 0"],
        });
        expect(await snapshot(stores.empresa.client(), victim().key)).toEqual(expected(victim()));
      },
      120_000,
    );

    it("without --confirm, or with another prefix, exits 2 and removes nothing", async () => {
      const heldBefore = await snapshot(stores.pessoal.client());

      expect(cli(["remove-source"], removal()).code).toBe(2);
      expect(cli(["remove-source", "--confirm", "t/default/"], removal()).code).toBe(2);
      expect(await snapshot(stores.pessoal.client())).toEqual(heldBefore);
    });

    it("a copy with the wrong source pair exits non-zero and leaves the destination as it was", async () => {
      const heldBefore = await snapshot(stores.empresa.client());

      const run = cli(["copy"], { ...removal(), STORE_COPY_SRC_SECRET_KEY: secret() });

      expect(run.code).toBe(1);
      expect(await snapshot(stores.empresa.client())).toEqual(heldBefore);
    });

    it("removes the old copies, and only those: t/default/ and the sibling tenant keep every checksum", async () => {
      const everything = await snapshot(stores.pessoal.client());
      const destinationBefore = await snapshot(stores.empresa.client());
      expect(Object.keys(under(everything, PREFIX))).toHaveLength(4);

      const run = cli(["remove-source", "--confirm", PREFIX], removal());

      expect(run).toMatchObject({
        code: 0,
        lines: [
          "source 4, destination 5, identical 4, missing 0, different 0, extra 1",
          "removed 4, failed 0",
        ],
      });
      const left = await snapshot(stores.pessoal.client());
      expect(under(left, PREFIX)).toEqual({});
      expect(left).toEqual(outside(everything, PREFIX));
      expect(Object.keys(under(left, "t/default/"))).toHaveLength(4);
      expect(left[sibling.key]).toEqual(entryOf(sibling));
      // Nothing was written to or removed from the destination.
      expect(await snapshot(stores.empresa.client())).toEqual(destinationBefore);
    }, 120_000);

    it("closes the remainder: the paths of step 6 are now refused, and empresa's own still serve", async () => {
      for (const one of oldEmpresaObjects()) {
        await expectRefused("pessoal", one);
        await expectServed("empresa", one);
      }
    });

    it("verifies again with nothing left at the source, and the env file is shredded as the runbook says", () => {
      const run = cli(["verify"], removal());
      const file = path.join(deployDir, "store-copy.env");

      expect(run).toMatchObject({
        code: 0,
        lines: ["source 0, destination 5, identical 0, missing 0, different 0, extra 5"],
      });
      expect(spawnSync("shred", ["-u", file]).status).toBe(0);
      expect(fs.existsSync(file)).toBe(false);
    });
  });

  // --- step 8: the way back --------------------------------------------------------------------

  describe("8. rollback", () => {
    it("copies what empresa wrote after the cutover back into the data pessoal's store runs on", async () => {
      const env = copyEnv(end("empresa", stores.empresa.port), end("pessoal", stores.pessoal.port));

      const run = cli(["copy"], env);

      expect(run).toMatchObject({ code: 0, lines: ["source 5, copied 5, unchanged 0, failed 0"] });
      expect(await snapshot(stores.pessoal.client(), PREFIX)).toEqual(
        await snapshot(stores.empresa.client(), PREFIX),
      );
    }, 120_000);

    it("serves it from a store on that volume with the old pair, and refuses the pair of the number", async () => {
      await stores.pessoal.stop();

      rolledBack = await startStore(renderShared66(), { volume: oldVolume });

      expect(rolledBack.inspect()).toMatchObject({ health: "healthy", running: true });
      const held = await snapshot(rolledBack.client());
      expect(held[after.empresa.key]).toEqual(entryOf(after.empresa));
      expect(held[seeded.pessoal.upload.key]).toEqual(entryOf(seeded.pessoal.upload));
      expect(held[after.pessoal.key]).toEqual(entryOf(after.pessoal));
      await expect(
        rolledBack
          .client({ accessKey: pairs.pessoal.user, secretKey: pairs.pessoal.password })
          .bucketExists(BUCKET),
      ).rejects.toMatchObject({ code: "InvalidAccessKeyId" });
      const link = await fetch(`${rolledBack.url}/${BUCKET}/${after.empresa.key}`);
      expect(link.status).toBe(200);
      expect(Buffer.from(await link.arrayBuffer()).equals(after.empresa.bytes)).toBe(true);
    }, 120_000);
  });

  // --- step 9: what must not have moved ---------------------------------------------------------

  describe("9. what the cutover must not touch", () => {
    it.each(LABELS)(
      "%s: the pairing files and the database are byte-identical, every row the same",
      (label) => {
        expect(onDisk(label)).toEqual(before[label]);
      },
    );

    it("the copy tool printed no credential and no key on any run", () => {
      const printed = cliOutput.join("\n");

      expect(printed.length).toBeGreaterThan(0);
      for (const value of [oldPair, ...Object.values(pairs)].flatMap((one) => [
        one.user,
        one.password,
      ])) {
        expect(printed).not.toContain(value);
      }
      expect(printed).not.toMatch(/uploads|3EB0|@s\.whatsapp\.net|5500000|\.png|\.jpg|\.pdf/);
    });
  });
});
