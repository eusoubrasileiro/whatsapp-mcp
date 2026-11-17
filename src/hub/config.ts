import fs from "node:fs";
import { type NtfyConfig, resolveNtfyConfig } from "../ntfy.ts";
import { HUB_LANGS, type HubLang } from "./strings.ts";

/** One WhatsApp number the hub shows: its label and where its server answers. */
export interface HubInstance {
  label: string;
  baseUrl: string;
}

export interface HubConfig {
  pin: string;
  cookieKey: string;
  instances: HubInstance[];
  publicUrl: string;
  stateDir: string;
  host: string;
  port: number;
  ntfy: NtfyConfig | null;
  /** The language of every page. */
  lang: HubLang;
  /**
   * The secret the hub presents to an instance to unlink its number, shared with every
   * instance's `HUB_INSTANCE_SECRET`. `null` when unset: the unlink action does not exist.
   */
  instanceSecret: string | null;
}

/**
 * The environment is not usable. `problems` names each variable at fault and never quotes a
 * value, so the message is safe to print and to log.
 */
export class HubConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`The hub cannot start:\n${problems.map((p) => `- ${p}`).join("\n")}`);
    this.name = "HubConfigError";
    this.problems = problems;
  }
}

type Env = Record<string, string | undefined>;

const LABEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const INSTANCE_PORT = 39002;

function parseHttpUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** The address of one `HUB_INSTANCES` item: its explicit `=address`, or the compose service. */
function instanceBaseUrl(label: string, explicit: string | undefined): string | null {
  if (explicit === undefined) return `http://whatsapp-mcp-${label}:${INSTANCE_PORT}`;
  const url = parseHttpUrl(explicit);
  return url && url.pathname === "/" && !url.search && !url.hash ? url.origin : null;
}

function parseInstances(raw: string | undefined, problems: string[]): HubInstance[] {
  if (!raw || raw.trim() === "") {
    problems.push("HUB_INSTANCES is required: a comma list of `label` or `label=http://host:port`");
    return [];
  }
  const instances: HubInstance[] = [];
  const seen = new Set<string>();
  raw.split(",").forEach((item, index) => {
    const entry = item.trim();
    const eq = entry.indexOf("=");
    const label = (eq === -1 ? entry : entry.slice(0, eq)).trim();
    const explicit = eq === -1 ? undefined : entry.slice(eq + 1).trim();
    const where = `HUB_INSTANCES item ${index + 1}`;

    if (!LABEL_PATTERN.test(label)) {
      problems.push(`${where} has an invalid label (use a-z, 0-9 and dashes, at most 32)`);
    } else if (seen.has(label)) {
      problems.push(`${where} repeats an earlier label`);
    } else {
      const baseUrl = instanceBaseUrl(label, explicit);
      if (baseUrl === null) problems.push(`${where} has an invalid address (use http://host:port)`);
      else instances.push({ label, baseUrl });
    }
    seen.add(label);
  });
  return instances;
}

function parsePublicUrl(raw: string | undefined, problems: string[]): string {
  const url = parseHttpUrl(raw ?? "");
  const local = url?.hostname === "localhost" || url?.hostname === "127.0.0.1";
  const secure = url?.protocol === "https:" || local;
  if (!url || !secure || url.origin !== raw) {
    problems.push(
      "HUB_PUBLIC_URL is required: the public origin without a trailing slash (https, or http for localhost only)",
    );
    return "";
  }
  return url.origin;
}

function parsePort(raw: string | undefined, problems: string[]): number {
  if (!raw) return INSTANCE_PORT;
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port < 1 || port > 65535) {
    problems.push("HUB_PORT must be a whole number from 1 to 65535");
  }
  return port;
}

/** `HUB_LANG`: `en` when unset or empty, otherwise exactly one of the languages the hub has. */
function parseLang(raw: string | undefined, problems: string[]): HubLang {
  if (!raw) return HUB_LANGS[0];
  const lang = HUB_LANGS.find((candidate) => candidate === raw);
  if (lang) return lang;
  problems.push(`HUB_LANG must be one of: ${HUB_LANGS.join(", ")}`);
  return HUB_LANGS[0];
}

/** The shortest unlink secret the hub accepts. An instance ignores a shorter one. */
const MIN_INSTANCE_SECRET_LENGTH = 32;

/** `HUB_INSTANCE_SECRET`: unset or empty turns unlinking off, anything else must be long enough. */
function parseInstanceSecret(raw: string | undefined, problems: string[]): string | null {
  if (!raw) return null;
  if (raw.length < MIN_INSTANCE_SECRET_LENGTH) {
    problems.push(
      `HUB_INSTANCE_SECRET must be at least ${MIN_INSTANCE_SECRET_LENGTH} characters (leave it unset to turn unlinking off)`,
    );
    return null;
  }
  return raw;
}

function checkStateDir(dir: string | undefined, problems: string[]): void {
  let usable = false;
  try {
    if (dir) {
      fs.accessSync(dir, fs.constants.W_OK);
      usable = fs.statSync(dir).isDirectory();
    }
  } catch {
    usable = false;
  }
  if (!usable)
    problems.push("HUB_STATE_DIR is required and must be an existing, writable directory");
}

/**
 * Reads the hub's environment. Throws {@link HubConfigError} listing everything wrong: the
 * hub must never start with a missing PIN, a weak signing key or nowhere to keep its counters.
 */
export function loadHubConfig(env: Env): HubConfig {
  const problems: string[] = [];
  const pin = env.HUB_PIN ?? "";
  const cookieKey = env.HUB_COOKIE_KEY ?? "";

  if (pin.length < 4) problems.push("HUB_PIN is required and must be at least 4 characters");
  if (cookieKey.length < 32) {
    problems.push("HUB_COOKIE_KEY is required and must be at least 32 characters");
  }
  const instances = parseInstances(env.HUB_INSTANCES, problems);
  const publicUrl = parsePublicUrl(env.HUB_PUBLIC_URL, problems);
  const port = parsePort(env.HUB_PORT, problems);
  const lang = parseLang(env.HUB_LANG, problems);
  const instanceSecret = parseInstanceSecret(env.HUB_INSTANCE_SECRET, problems);
  checkStateDir(env.HUB_STATE_DIR, problems);

  if (problems.length > 0) throw new HubConfigError(problems);

  return {
    pin,
    cookieKey,
    instances,
    publicUrl,
    stateDir: env.HUB_STATE_DIR ?? "",
    host: env.HUB_HOST || "0.0.0.0",
    port,
    ntfy: resolveNtfyConfig(env),
    lang,
    instanceSecret,
  };
}
