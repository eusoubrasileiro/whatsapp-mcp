/**
 * Moves one tenant's media objects from one S3 store to another, over the S3 API only (never
 * by copying a store's files), and says in counts whether the move is complete.
 *
 *   copy                      writes what the destination lacks or holds differently
 *   verify                    reads both sides, changes neither
 *   remove-source --confirm P removes from the source the objects `verify` found identical
 *
 * Standalone on purpose: it imports `minio` and `node:` modules and nothing of this
 * application, so running it opens no database and no WhatsApp connection (a test pins that).
 * The entry point is `store-copy-cli.ts`; everything with a decision in it lives here.
 *
 * Output is counts. An object key can hold a phone number, so keys are printed only with
 * `--show-keys`; credentials are never printed, and an unexpected error is reduced to its name
 * and code. At most one object is in flight at a time, and it is streamed, never held.
 */
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import * as Minio from "minio";

const DEFAULT_BUCKET = "amiticia-media";
const DEFAULT_PORT = 9000;
const REGION = "us-east-1";
const MAX_PORT = 65535;
/** One tenant's prefix, as the app writes it: never a whole bucket, never a sibling tenant. */
const PREFIX_PATTERN = /^t\/[a-z0-9][a-z0-9-]*\/$/;
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
const COMMANDS = ["copy", "verify", "remove-source"];
const USAGE =
  "usage: store-copy-cli (copy | verify | remove-source --confirm <prefix>) [--show-keys]";

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

export interface Endpoint {
  host: string;
  port: number;
  accessKey: string;
  secretKey: string;
}

export interface CopyConfig {
  src: Endpoint;
  dst: Endpoint;
  bucket: string;
  prefix: string;
}

/** The few things the tool asks of a store, so a test can stand in for one. */
export interface Side {
  bucketExists(bucket: string): Promise<boolean>;
  makeBucket(bucket: string): Promise<void>;
  /** Every key under `prefix`, however deep. */
  list(bucket: string, prefix: string): AsyncIterable<string>;
  stat(bucket: string, key: string): Promise<{ size: number; contentType: string }>;
  read(bucket: string, key: string): AsyncIterable<Buffer>;
  write(
    bucket: string,
    key: string,
    body: AsyncIterable<Buffer>,
    size: number,
    contentType: string,
  ): Promise<void>;
  remove(bucket: string, key: string): Promise<void>;
}

/** What a run says, line by line. */
export interface Io {
  out(line: string): void;
  err(line: string): void;
}

/** How a side is reached: `label` ("source" or "destination") names it in an error. */
export type Connect = (endpoint: Endpoint, label: string) => Side;

/** A mistake in how the tool was called: nothing was touched. */
export class UsageError extends Error {}

/** A failure on one side of the move, already reduced to a message that is safe to print. */
export class SideError extends Error {}

/** The name and code of an error, never its message: that may hold a key or an address. */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return "unknown error";
  return "code" in err && typeof err.code === "string" ? `${err.name} (${err.code})` : err.name;
}

// ── configuration ───────────────────────────────────────────────────────────

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new UsageError(`${key} is required`);
  return value;
}

function endpointFrom(env: NodeJS.ProcessEnv, side: "SRC" | "DST"): Endpoint {
  const name = (key: string) => `STORE_COPY_${side}_${key}`;
  const host = required(env, name("ENDPOINT"));
  if (!HOST_PATTERN.test(host)) {
    throw new UsageError(`${name("ENDPOINT")} must be a bare host name or address`);
  }
  const port = Number(env[name("PORT")] || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw new UsageError(`${name("PORT")} must be a port number`);
  }
  return {
    host,
    port,
    accessKey: required(env, name("ACCESS_KEY")),
    secretKey: required(env, name("SECRET_KEY")),
  };
}

export function parseConfig(env: NodeJS.ProcessEnv): CopyConfig {
  const src = endpointFrom(env, "SRC");
  const dst = endpointFrom(env, "DST");
  const bucket = env.STORE_COPY_BUCKET || DEFAULT_BUCKET;
  const prefix = required(env, "STORE_COPY_PREFIX");
  if (!BUCKET_PATTERN.test(bucket)) throw new UsageError("STORE_COPY_BUCKET is not a bucket name");
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new UsageError("STORE_COPY_PREFIX must be one tenant's prefix, such as t/<tenant>/");
  }
  if (src.host.toLowerCase() === dst.host.toLowerCase() && src.port === dst.port) {
    throw new UsageError("the source and the destination are the same endpoint");
  }
  return { src, dst, bucket, prefix };
}

// ── the move ────────────────────────────────────────────────────────────────

async function keysUnder(side: Side, bucket: string, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  for await (const key of side.list(bucket, prefix)) {
    // A store that ignored the prefix must not widen what this tool touches.
    if (key.startsWith(prefix)) keys.push(key);
  }
  return keys;
}

/** The identity of one object as the tool compares it: its bytes, its size and its content type. */
async function fingerprint(side: Side, bucket: string, key: string): Promise<string> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of side.read(bucket, key)) {
    hash.update(chunk);
    size += chunk.length;
  }
  const { contentType } = await side.stat(bucket, key);
  return `${hash.digest("hex")}:${size}:${contentType}`;
}

export interface Verdict {
  source: number;
  destination: number;
  /** Keys whose destination object is identical: exactly what `remove-source` may remove. */
  identical: string[];
  missing: string[];
  different: string[];
  /** Destination objects the source does not have: counted, never a failure. */
  extra: number;
  ok: boolean;
}

export async function verify(config: CopyConfig, src: Side, dst: Side): Promise<Verdict> {
  const { bucket, prefix } = config;
  const keys = await keysUnder(src, bucket, prefix);
  const held = (await dst.bucketExists(bucket)) ? await keysUnder(dst, bucket, prefix) : [];
  const have = new Set(held);
  const identical: string[] = [];
  const missing: string[] = [];
  const different: string[] = [];
  for (const key of keys) {
    if (!have.has(key)) {
      missing.push(key);
    } else if ((await fingerprint(src, bucket, key)) === (await fingerprint(dst, bucket, key))) {
      identical.push(key);
    } else {
      different.push(key);
    }
  }
  const wanted = new Set(keys);
  const extra = held.filter((key) => !wanted.has(key)).length;
  const ok = missing.length === 0 && different.length === 0;
  return {
    source: keys.length,
    destination: held.length,
    identical,
    missing,
    different,
    extra,
    ok,
  };
}

export interface CopyResult {
  source: number;
  copied: number;
  unchanged: number;
  failed: string[];
  /** The first error, reduced to a name and code. */
  firstError: string | null;
}

async function copyOne(config: CopyConfig, src: Side, dst: Side, key: string, held: boolean) {
  const { bucket } = config;
  const want = await fingerprint(src, bucket, key);
  if (held && (await fingerprint(dst, bucket, key)) === want) return "unchanged";
  const { size, contentType } = await src.stat(bucket, key);
  await dst.write(bucket, key, src.read(bucket, key), size, contentType);
  return (await fingerprint(dst, bucket, key)) === want ? "copied" : "mismatch";
}

export async function copy(config: CopyConfig, src: Side, dst: Side): Promise<CopyResult> {
  const { bucket, prefix } = config;
  if (!(await src.bucketExists(bucket))) throw new SideError("source: the bucket does not exist");
  // No policy here: the app sets it when it starts against this store.
  if (!(await dst.bucketExists(bucket))) await dst.makeBucket(bucket);
  const keys = await keysUnder(src, bucket, prefix);
  const have = new Set(await keysUnder(dst, bucket, prefix));
  const result: CopyResult = {
    source: keys.length,
    copied: 0,
    unchanged: 0,
    failed: [],
    firstError: null,
  };
  for (const key of keys) {
    try {
      const outcome = await copyOne(config, src, dst, key, have.has(key));
      if (outcome === "mismatch") result.failed.push(key);
      else result[outcome] += 1;
    } catch (err) {
      result.failed.push(key);
      result.firstError = result.firstError ?? describeError(err);
    }
  }
  return result;
}

export interface RemoveResult {
  verdict: Verdict;
  removed: number;
  failed: string[];
}

/** Removes from the source the objects `verify` found identical, and nothing when it did not pass. */
export async function removeSource(
  config: CopyConfig,
  src: Side,
  dst: Side,
): Promise<RemoveResult> {
  const verdict = await verify(config, src, dst);
  const result: RemoveResult = { verdict, removed: 0, failed: [] };
  if (!verdict.ok) return result;
  for (const key of verdict.identical) {
    try {
      await src.remove(config.bucket, key);
      result.removed += 1;
    } catch {
      result.failed.push(key);
    }
  }
  return result;
}

// ── S3 ──────────────────────────────────────────────────────────────────────

/** The part of the minio client the tool uses; the real client satisfies it. */
export interface S3Client {
  bucketExists(bucket: string): Promise<boolean>;
  makeBucket(bucket: string, region: string): Promise<void>;
  listObjectsV2(
    bucket: string,
    prefix: string,
    recursive: boolean,
  ): AsyncIterable<{ name?: string }>;
  statObject(
    bucket: string,
    key: string,
  ): Promise<{ size: number; metaData: Record<string, unknown> }>;
  getObject(bucket: string, key: string): Promise<AsyncIterable<Buffer>>;
  putObject(
    bucket: string,
    key: string,
    body: Readable,
    size: number,
    metaData: Record<string, string>,
  ): Promise<unknown>;
  removeObject(bucket: string, key: string): Promise<void>;
}

async function tagged<T>(label: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw new SideError(`${label}: ${describeError(err)}`);
  }
}

/** `client` as a `Side`; an error from it says which side it came from, and nothing else. */
export function s3Side(label: string, client: S3Client): Side {
  return {
    bucketExists: (bucket) => tagged(label, () => client.bucketExists(bucket)),
    makeBucket: (bucket) => tagged(label, () => client.makeBucket(bucket, REGION)),
    async *list(bucket, prefix) {
      try {
        for await (const item of client.listObjectsV2(bucket, prefix, true)) {
          if (item.name) yield item.name;
        }
      } catch (err) {
        throw new SideError(`${label}: ${describeError(err)}`);
      }
    },
    stat: (bucket, key) =>
      tagged(label, async () => {
        const stat = await client.statObject(bucket, key);
        const contentType = stat.metaData["content-type"];
        return { size: stat.size, contentType: typeof contentType === "string" ? contentType : "" };
      }),
    async *read(bucket, key) {
      try {
        yield* await client.getObject(bucket, key);
      } catch (err) {
        throw new SideError(`${label}: ${describeError(err)}`);
      }
    },
    write: (bucket, key, body, size, contentType) =>
      tagged(label, async () => {
        await client.putObject(bucket, key, Readable.from(body), size, {
          "Content-Type": contentType,
        });
      }),
    remove: (bucket, key) => tagged(label, () => client.removeObject(bucket, key)),
  };
}

/** A client for a store on the private network: plain HTTP, the endpoint's own pair. */
export function minioClient(endpoint: Endpoint): Minio.Client {
  return new Minio.Client({
    endPoint: endpoint.host,
    port: endpoint.port,
    useSSL: false,
    accessKey: endpoint.accessKey,
    secretKey: endpoint.secretKey,
  });
}

export function connectMinio(endpoint: Endpoint, label: string): Side {
  return s3Side(label, minioClient(endpoint));
}

// ── the command line ────────────────────────────────────────────────────────

interface Args {
  command: string;
  showKeys: boolean;
  confirm: string | undefined;
}

function parseArgs(argv: string[]): Args {
  const [command = "", ...rest] = argv;
  if (!COMMANDS.includes(command)) throw new UsageError(USAGE);
  const args: Args = { command, showKeys: false, confirm: undefined };
  for (let at = 0; at < rest.length; at += 1) {
    const arg = rest[at];
    if (arg === "--show-keys") {
      args.showKeys = true;
    } else if (arg === "--confirm" && command === "remove-source" && at + 1 < rest.length) {
      args.confirm = rest[++at];
    } else {
      throw new UsageError(USAGE);
    }
  }
  return args;
}

const counts = (pairs: [string, number][]) =>
  pairs.map(([name, count]) => `${name} ${count}`).join(", ");

function listKeys(io: Io, args: Args, what: string, keys: string[]) {
  if (args.showKeys) for (const key of keys) io.out(`${what}: ${key}`);
}

function reportVerdict(io: Io, args: Args, verdict: Verdict) {
  io.out(
    counts([
      ["source", verdict.source],
      ["destination", verdict.destination],
      ["identical", verdict.identical.length],
      ["missing", verdict.missing.length],
      ["different", verdict.different.length],
      ["extra", verdict.extra],
    ]),
  );
  listKeys(io, args, "missing", verdict.missing);
  listKeys(io, args, "different", verdict.different);
}

async function run(args: Args, config: CopyConfig, src: Side, dst: Side, io: Io): Promise<number> {
  if (args.command === "copy") {
    const result = await copy(config, src, dst);
    io.out(
      counts([
        ["source", result.source],
        ["copied", result.copied],
        ["unchanged", result.unchanged],
        ["failed", result.failed.length],
      ]),
    );
    listKeys(io, args, "failed", result.failed);
    if (result.firstError) io.err(`first error: ${result.firstError}`);
    return result.failed.length === 0 ? EXIT_OK : EXIT_FAILED;
  }
  if (args.command === "verify") {
    const verdict = await verify(config, src, dst);
    reportVerdict(io, args, verdict);
    return verdict.ok ? EXIT_OK : EXIT_FAILED;
  }
  const result = await removeSource(config, src, dst);
  reportVerdict(io, args, result.verdict);
  if (!result.verdict.ok) {
    io.err("nothing removed: the destination does not hold every source object, identical");
    return EXIT_FAILED;
  }
  io.out(
    counts([
      ["removed", result.removed],
      ["failed", result.failed.length],
    ]),
  );
  listKeys(io, args, "failed", result.failed);
  return result.failed.length === 0 ? EXIT_OK : EXIT_FAILED;
}

/**
 * The whole command line: arguments and environment in, lines out, an exit code back. `connect`
 * is how a side is reached; the entry point passes the real one.
 */
export async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: Io,
  connect: Connect = connectMinio,
): Promise<number> {
  try {
    const args = parseArgs(argv);
    const config = parseConfig(env);
    if (args.command === "remove-source" && args.confirm !== config.prefix) {
      throw new UsageError(
        "remove-source needs --confirm with the same prefix as STORE_COPY_PREFIX",
      );
    }
    return await run(
      args,
      config,
      connect(config.src, "source"),
      connect(config.dst, "destination"),
      io,
    );
  } catch (err) {
    io.err(
      `error: ${err instanceof UsageError || err instanceof SideError ? err.message : describeError(err)}`,
    );
    return err instanceof UsageError ? EXIT_USAGE : EXIT_FAILED;
  }
}
