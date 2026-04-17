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

  return async (msg) => {
    const headers: Record<string, string> = { Title: msg.title };
    if (msg.priority !== undefined) headers.Priority = String(msg.priority);
    if (msg.tags && msg.tags.length > 0) headers.Tags = msg.tags.join(",");
    if (msg.click) headers.Click = msg.click;
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
