import path from "node:path";

/**
 * Where `send_file` may read a local path from.
 *
 * A local `file_path` is read on the server, so an unconfined one sends whatever the process can
 * read: the pairing credentials, the message database, `/proc/self/environ` with every secret.
 * The realistic caller is an agent steered by an inbound message, so the server reads only from
 * one directory the operator chose, and never from the directories that hold the pairing or the
 * database, whatever that directory contains.
 */
export interface LocalSendConfig {
  /** Absolute directory a local path must resolve inside. */
  root: string;
  /** Directories never read from, even when `root` contains them. */
  protectedDirs: string[];
}

/** The data dir the pairing store and the database use (`whatsapp.ts`, `database.ts`). */
function dataDirOf(env: NodeJS.ProcessEnv): string {
  return env.WHATSAPP_MCP_DATA_DIR ?? path.join(import.meta.dirname, "..");
}

/**
 * `SEND_FILE_LOCAL_DIR` when it is an absolute path, otherwise `<data dir>/outbox`. A relative or
 * blank value reads as the default, never as "anywhere".
 */
export function readLocalSendConfig(env: NodeJS.ProcessEnv = process.env): LocalSendConfig {
  const dataDir = dataDirOf(env);
  const configured = env.SEND_FILE_LOCAL_DIR?.trim() ?? "";
  return {
    root: path.isAbsolute(configured) ? configured : path.join(dataDir, "outbox"),
    protectedDirs: [path.join(dataDir, "auth_info"), path.join(dataDir, "data")],
  };
}

/** True when `child` is `parent` or lies below it. Both must already be real paths. */
export function isWithin(parent: string, child: string): boolean {
  return path.relative(parent, child).split(path.sep)[0] !== "..";
}
