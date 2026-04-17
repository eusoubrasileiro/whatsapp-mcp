import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pino, { type Logger } from "pino";
import { createNtfy } from "../ntfy.ts";

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
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response("", { status: 200 }),
    );

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
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response("", { status: 200 }),
    );

    const send = createNtfy(makeSilentLogger(), {
      topicUrl: "https://ntfy.sh/t",
    });
    await send({
      title: "T",
      message: "M",
      priority: 5,
      tags: ["warning", "wa"],
      click: "https://wa.amiticia.cc/",
    });

    const init = vi.mocked(globalThis.fetch).mock.calls[0][1];
    const headers = new Headers(init?.headers);
    expect(headers.get("Priority")).toBe("5");
    expect(headers.get("Tags")).toBe("warning,wa");
    expect(headers.get("Click")).toBe("https://wa.amiticia.cc/");
  });

  it("sends Authorization: Bearer when token is set", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response("", { status: 200 }),
    );

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
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response("rate limited", { status: 429 }),
    );

    const send = createNtfy(makeSilentLogger(), {
      topicUrl: "https://ntfy.sh/t",
    });

    await expect(send({ title: "T", message: "M" })).resolves.toBeUndefined();
  });

  it("omits optional headers when not provided", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response("", { status: 200 }),
    );

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
