import pino, { type Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNtfy, type NtfyConfig, type NtfyMessage, resolveNtfyConfig } from "../ntfy.ts";

function makeSilentLogger(): Logger {
  return pino({ level: "silent" });
}

describe("createNtfy", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("is a no-op when config is null", async () => {
    const send = createNtfy(makeSilentLogger(), null);
    await send({ title: "x", message: "y" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("POSTs to topicUrl with message body and Title header", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response("", { status: 200 }));

    const send = createNtfy(makeSilentLogger(), {
      topicUrl: "https://ntfy.sh/test-topic",
    });
    await send({ title: "Hello", message: "World" });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(url).toBe("https://ntfy.sh/test-topic");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe("World");

    const headers = new Headers(init?.headers);
    expect(headers.get("Title")).toBe("Hello");
  });

  it("includes Priority, Tags, Click headers when provided", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response("", { status: 200 }));

    const send = createNtfy(makeSilentLogger(), {
      topicUrl: "https://ntfy.sh/t",
    });
    await send({
      title: "T",
      message: "M",
      priority: 5,
      tags: ["warning", "wa"],
      click: "https://wa.example.com/",
    });

    const init = vi.mocked(globalThis.fetch).mock.calls[0][1];
    const headers = new Headers(init?.headers);
    expect(headers.get("Priority")).toBe("5");
    expect(headers.get("Tags")).toBe("warning,wa");
    expect(headers.get("Click")).toBe("https://wa.example.com/");
  });

  it("sends Authorization: Bearer when token is set", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response("", { status: 200 }));

    const send = createNtfy(makeSilentLogger(), {
      topicUrl: "https://ntfy.sh/t",
      token: "tk_abc",
    });
    await send({ title: "T", message: "M" });

    const init = vi.mocked(globalThis.fetch).mock.calls[0][1];
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer tk_abc");
  });

  it("never throws when fetch rejects", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("network down"));

    const send = createNtfy(makeSilentLogger(), {
      topicUrl: "https://ntfy.sh/t",
    });

    await expect(send({ title: "T", message: "M" })).resolves.toBeUndefined();
  });

  it("never throws on non-2xx response", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response("rate limited", { status: 429 }));

    const send = createNtfy(makeSilentLogger(), {
      topicUrl: "https://ntfy.sh/t",
    });

    await expect(send({ title: "T", message: "M" })).resolves.toBeUndefined();
  });

  it("strips non-Latin-1 characters from header values (em-dash etc.)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response("", { status: 200 }));

    const send = createNtfy(makeSilentLogger(), {
      topicUrl: "https://ntfy.sh/t",
    });
    await send({
      title: "WhatsApp \u2014 Escaneie",
      message: "body \u00e9 utf-8",
      tags: ["\u2014tag"],
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const init = vi.mocked(globalThis.fetch).mock.calls[0][1];
    const headers = new Headers(init?.headers);
    expect(headers.get("Title")).toBe("WhatsApp  Escaneie");
    expect(headers.get("Tags")).toBe("tag");
    expect(init?.body).toBe("body \u00e9 utf-8");
  });

  it("logs a delivered push at info, so an incident log can show it was sent", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response("", { status: 200 }));
    const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn() } as unknown as Logger;

    const send = createNtfy(logger, { topicUrl: "https://ntfy.sh/t" });
    await send({ title: "WhatsApp - fora do ar", message: "M" });

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ title: "WhatsApp - fora do ar" }),
      "ntfy push sent",
    );
    expect(logger.debug).not.toHaveBeenCalled();
  });

  describe("the topic stays out of the log", () => {
    const topicUrl = "https://ntfy.sh/wa-alerts-k3x9q";

    function warnings() {
      const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn() } as unknown as Logger & {
        warn: ReturnType<typeof vi.fn>;
      };
      return logger;
    }

    it("logs only the host when ntfy answers with an error", async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(new Response("", { status: 429 }));
      const logger = warnings();

      await createNtfy(logger, { topicUrl })({ title: "T", message: "M" });

      expect(logger.warn).toHaveBeenCalledWith(
        { status: 429, host: "ntfy.sh" },
        "ntfy returned non-2xx status",
      );
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("k3x9q");
    });

    it("logs only the host when the push cannot be sent", async () => {
      const err = new Error("getaddrinfo ENOTFOUND");
      vi.mocked(globalThis.fetch).mockRejectedValue(err);
      const logger = warnings();

      await createNtfy(logger, { topicUrl })({ title: "T", message: "M" });

      expect(logger.warn).toHaveBeenCalledWith({ err, host: "ntfy.sh" }, "ntfy fetch failed");
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("k3x9q");
    });

    it("says the setting is invalid instead of echoing it", async () => {
      const err = new TypeError("Failed to parse URL");
      vi.mocked(globalThis.fetch).mockRejectedValue(err);
      const logger = warnings();

      await createNtfy(logger, { topicUrl: "ntfy.sh/k3x9q" })({ title: "T", message: "M" });

      expect(logger.warn).toHaveBeenCalledWith(
        { err, host: "(invalid NTFY_TOPIC_URL)" },
        "ntfy fetch failed",
      );
    });
  });

  /** Sends one push through a fresh sender and returns what fetch received for it. */
  async function pushed(
    config: Partial<NtfyConfig>,
    msg: NtfyMessage,
    logger: Logger = makeSilentLogger(),
  ) {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response("", { status: 200 }));
    await createNtfy(logger, { topicUrl: "https://ntfy.sh/t", ...config })(msg);
    const init = vi.mocked(globalThis.fetch).mock.lastCall?.[1];
    return { body: init?.body, headers: new Headers(init?.headers) };
  }

  it("prefixes every title with the config's titlePrefix", async () => {
    const config = { titlePrefix: "[empresa] " };

    const down = await pushed(config, { title: "WhatsApp - desconectado", message: "M" });
    const up = await pushed(config, { title: "WhatsApp - reconectado", message: "M" });

    expect(down.headers.get("Title")).toBe("[empresa] WhatsApp - desconectado");
    expect(up.headers.get("Title")).toBe("[empresa] WhatsApp - reconectado");
  });

  it("leaves the body and the other headers alone when it prefixes the title", async () => {
    const { body, headers } = await pushed(
      { titlePrefix: "[empresa] " },
      { title: "T", message: "the body", tags: ["warning"], click: "https://wa.example.com/" },
    );

    expect(body).toBe("the body");
    expect(headers.get("Tags")).toBe("warning");
    expect(headers.get("Click")).toBe("https://wa.example.com/");
  });

  it("still strips non-Latin-1 characters from a prefixed title", async () => {
    const { headers } = await pushed(
      { titlePrefix: "[empresa] " },
      { title: "WhatsApp \u2014 Escaneie", message: "M" },
    );

    expect(headers.get("Title")).toBe("[empresa] WhatsApp  Escaneie");
  });

  it("logs the title that was actually sent, prefix included", async () => {
    const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn() } as unknown as Logger;

    await pushed(
      { titlePrefix: "[empresa] " },
      { title: "WhatsApp - fora do ar", message: "M" },
      logger,
    );

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ title: "[empresa] WhatsApp - fora do ar" }),
      "ntfy push sent",
    );
  });

  it("omits optional headers when not provided", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response("", { status: 200 }));

    const send = createNtfy(makeSilentLogger(), {
      topicUrl: "https://ntfy.sh/t",
    });
    await send({ title: "T", message: "M" });

    const init = vi.mocked(globalThis.fetch).mock.calls[0][1];
    const headers = new Headers(init?.headers);
    expect(headers.get("Priority")).toBeNull();
    expect(headers.get("Tags")).toBeNull();
    expect(headers.get("Click")).toBeNull();
    expect(headers.get("Authorization")).toBeNull();
  });
});

describe("resolveNtfyConfig", () => {
  it("is null when NTFY_TOPIC_URL is unset or empty", () => {
    expect(resolveNtfyConfig({})).toBeNull();
    expect(resolveNtfyConfig({ NTFY_TOPIC_URL: "" })).toBeNull();
  });

  it("carries the topic URL and the optional token", () => {
    expect(
      resolveNtfyConfig({ NTFY_TOPIC_URL: "https://ntfy.sh/t", NTFY_TOKEN: "tk_abc" }),
    ).toEqual({ topicUrl: "https://ntfy.sh/t", token: "tk_abc" });
    expect(resolveNtfyConfig({ NTFY_TOPIC_URL: "https://ntfy.sh/t" })).toEqual({
      topicUrl: "https://ntfy.sh/t",
      token: undefined,
    });
  });

  it("adds no titlePrefix key without an identity, even when INSTANCE_DESCRIPTION is set", () => {
    expect(
      resolveNtfyConfig({ NTFY_TOPIC_URL: "https://ntfy.sh/t", INSTANCE_DESCRIPTION: "orphan" }),
    ).toStrictEqual({ topicUrl: "https://ntfy.sh/t", token: undefined });
    expect(
      resolveNtfyConfig({ NTFY_TOPIC_URL: "https://ntfy.sh/t", INSTANCE_LABEL: "!!!" }),
    ).toStrictEqual({ topicUrl: "https://ntfy.sh/t", token: undefined });
  });

  it("prefixes titles with the normalised label when an identity is set", () => {
    expect(
      resolveNtfyConfig({
        NTFY_TOPIC_URL: "https://ntfy.sh/t",
        NTFY_TOKEN: "tk_abc",
        INSTANCE_LABEL: " Empresa ",
      }),
    ).toStrictEqual({ topicUrl: "https://ntfy.sh/t", token: "tk_abc", titlePrefix: "[empresa] " });
  });

  it("stays null without a topic, whatever the identity", () => {
    expect(resolveNtfyConfig({ INSTANCE_LABEL: "empresa" })).toBeNull();
  });
});
