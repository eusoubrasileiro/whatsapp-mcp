import type { Logger } from "pino";
import { readInstanceIdentity } from "./instance-identity.ts";

export type NtfyConfig = {
  topicUrl: string;
  token?: string;
  /** Put in front of every push title, e.g. `[empresa] ` — which WhatsApp line is calling. */
  titlePrefix?: string;
};

export type NtfyMessage = {
  title: string;
  message: string;
  priority?: 1 | 2 | 3 | 4 | 5;
  tags?: string[];
  click?: string;
};

export type SendNtfy = (msg: NtfyMessage) => Promise<void>;

/**
 * ntfy settings from the environment, or `null` (pushes become no-ops) when no topic is set.
 * With an instance identity, every title gets `[<label>] ` in front — here, in the config, so
 * no call site has to remember it.
 */
export function resolveNtfyConfig(
  env: Record<string, string | undefined> = process.env,
): NtfyConfig | null {
  if (!env.NTFY_TOPIC_URL) return null;
  const identity = readInstanceIdentity(env);
  return {
    topicUrl: env.NTFY_TOPIC_URL,
    token: env.NTFY_TOKEN,
    ...(identity ? { titlePrefix: `[${identity.label}] ` } : {}),
  };
}

export function createNtfy(logger: Logger, config: NtfyConfig | null): SendNtfy {
  if (!config) {
    return async () => {};
  }

  const { topicUrl, token, titlePrefix = "" } = config;
  // On ntfy.sh the topic name is the secret: whoever knows it reads every push. Logs get the host.
  const host = hostOf(topicUrl);

  // HTTP header values must be Latin-1 (bytes 0-255). Strip anything above
  // so em-dashes and other Unicode glyphs don't crash fetch on Title/Tags/Click.
  // Body (POST data) is UTF-8 so accented text still works there. The \x00-\xff
  // range IS the Latin-1 byte range we match against — the control chars in it
  // are deliberate, hence the suppression.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: \x00-\xff is the intended Latin-1 range
  const toLatin1 = (s: string): string => s.replace(/[^\x00-\xff]/g, "");

  return async (msg) => {
    const title = `${titlePrefix}${msg.title}`;
    const headers: Record<string, string> = { Title: toLatin1(title) };
    if (msg.priority !== undefined) headers.Priority = String(msg.priority);
    if (msg.tags && msg.tags.length > 0) headers.Tags = toLatin1(msg.tags.join(","));
    if (msg.click) headers.Click = toLatin1(msg.click);
    if (token) headers.Authorization = `Bearer ${token}`;

    try {
      const res = await fetch(topicUrl, {
        method: "POST",
        headers,
        body: msg.message,
      });
      if (!res.ok) {
        logger.warn({ status: res.status, host }, "ntfy returned non-2xx status");
        return;
      }
      logger.info({ title }, "ntfy push sent");
    } catch (err) {
      logger.warn({ err, host }, "ntfy fetch failed");
    }
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(invalid NTFY_TOPIC_URL)";
  }
}
