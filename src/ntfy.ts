import type { Logger } from "pino";

export type NtfyConfig = {
  topicUrl: string;
  token?: string;
};

export type NtfyMessage = {
  title: string;
  message: string;
  priority?: 1 | 2 | 3 | 4 | 5;
  tags?: string[];
  click?: string;
};

export type SendNtfy = (msg: NtfyMessage) => Promise<void>;

export function createNtfy(logger: Logger, config: NtfyConfig | null): SendNtfy {
  if (!config) {
    return async () => {};
  }

  const { topicUrl, token } = config;

  // HTTP header values must be Latin-1 (bytes 0-255). Strip anything above
  // so em-dashes and other Unicode glyphs don't crash fetch on Title/Tags/Click.
  // Body (POST data) is UTF-8 so accented text still works there.
  const toLatin1 = (s: string): string =>
    s.replace(/[^\x00-\xff]/g, "");

  return async (msg) => {
    const headers: Record<string, string> = { Title: toLatin1(msg.title) };
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
        logger.warn(
          { status: res.status, topicUrl },
          "ntfy returned non-2xx status",
        );
        return;
      }
      logger.debug({ title: msg.title }, "ntfy push sent");
    } catch (err) {
      logger.warn({ err, topicUrl }, "ntfy fetch failed");
    }
  };
}
