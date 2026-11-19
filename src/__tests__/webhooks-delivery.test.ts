import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeDatabase, resetDatabase } from "../database.ts";
import { type OutboundResponse, outboundRequest } from "../outbound-http.ts";
import { deliverEvent, dispatchInbound, isSelfChatJid, signPayload } from "../webhooks/delivery.ts";
import { addSubscription, loadRegistry, resetRegistry } from "../webhooks/registry.ts";
import { markSentByUs, resetSentTracker } from "../webhooks/sent-tracker.ts";
import type { InboundMessageInput, Subscription } from "../webhooks/types.ts";

vi.mock("../outbound-http.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../outbound-http.ts")>()),
  outboundRequest: vi.fn(),
}));

/** What the guarded client returns for a response with this status. */
function answered(status: number): OutboundResponse {
  return { status, headers: {}, body: Buffer.alloc(0), url: "https://hook.example/in" };
}

function fakeLogger() {
  return { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger & {
    warn: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };
}

function makeSub(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: "sub-1",
    tenantId: "default",
    targetUrl: "https://hook.example/in",
    secret: "shh-secret",
    authMode: "hmac",
    allowedJids: ["5531@s.whatsapp.net"],
    transcribe: true,
    includeFromMe: false,
    label: null,
    active: true,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeMsg(overrides: Partial<InboundMessageInput> = {}): InboundMessageInput {
  return {
    id: "MSG1",
    chat_jid: "5531@s.whatsapp.net",
    sender: "5531@s.whatsapp.net",
    content: "oi",
    timestamp: new Date("2026-06-01T14:32:07.000Z"),
    is_from_me: false,
    media_type: null,
    mimetype: null,
    file_length: null,
    ...overrides,
  };
}

describe("deliverEvent", () => {
  beforeEach(() => {
    vi.mocked(outboundRequest).mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs JSON to the target with an HMAC signature over timestamp.body", async () => {
    vi.mocked(outboundRequest).mockResolvedValue(answered(200));

    await deliverEvent(makeSub(), makeMsg(), null, fakeLogger());

    const [url, init] = vi.mocked(outboundRequest).mock.calls[0];
    expect(url).toBe("https://hook.example/in");
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("Content-Type")).toBe("application/json");

    const body = init?.body as string;
    const ts = headers.get("X-Webhook-Timestamp")!;
    expect(ts).toMatch(/^\d+$/);
    expect(headers.get("X-Webhook-Signature")).toBe(
      `sha256=${signPayload(`${ts}.${body}`, "shh-secret")}`,
    );
    expect(headers.get("Authorization")).toBeNull();
    expect(JSON.parse(body).message_id).toBe("MSG1");
  });

  it("uses Authorization: Bearer when auth_mode is bearer", async () => {
    vi.mocked(outboundRequest).mockResolvedValue(answered(200));

    await deliverEvent(makeSub({ authMode: "bearer" }), makeMsg(), null, fakeLogger());

    const init = vi.mocked(outboundRequest).mock.calls[0][1];
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer shh-secret");
    expect(headers.get("X-Webhook-Signature")).toBeNull();
  });

  it("sends no auth headers when the subscription has no secret", async () => {
    vi.mocked(outboundRequest).mockResolvedValue(answered(200));

    await deliverEvent(makeSub({ secret: null }), makeMsg(), null, fakeLogger());

    const init = vi.mocked(outboundRequest).mock.calls[0][1];
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get("X-Webhook-Signature")).toBeNull();
  });

  it("inlines a transcript into the delivered body", async () => {
    vi.mocked(outboundRequest).mockResolvedValue(answered(200));

    await deliverEvent(
      makeSub(),
      makeMsg({ content: "", media_type: "ptt", mimetype: "audio/ogg" }),
      "olá tudo bem",
      fakeLogger(),
    );

    const body = vi.mocked(outboundRequest).mock.calls[0][1]?.body as string;
    expect(JSON.parse(body).transcript).toBe("olá tudo bem");
  });

  it("never follows a redirect, never reads the reply, and gives up after 10 s", async () => {
    vi.mocked(outboundRequest).mockResolvedValue(answered(200));

    await deliverEvent(makeSub(), makeMsg(), null, fakeLogger());

    expect(vi.mocked(outboundRequest).mock.calls[0][1]).toMatchObject({
      maxRedirects: 0,
      readBody: false,
      timeoutMs: 10_000,
    });
  });

  it("reaches only public addresses unless the host is listed in WEBHOOK_PRIVATE_HOSTS", async () => {
    vi.mocked(outboundRequest).mockResolvedValue(answered(200));
    vi.stubEnv("WEBHOOK_PRIVATE_HOSTS", "n8n, Hooks.Internal.");
    try {
      await deliverEvent(makeSub(), makeMsg(), null, fakeLogger());
      await deliverEvent(
        makeSub({ targetUrl: "http://n8n:5678/w" }),
        makeMsg(),
        null,
        fakeLogger(),
      );
      await deliverEvent(
        makeSub({ targetUrl: "http://hooks.internal/w" }),
        makeMsg(),
        null,
        fakeLogger(),
      );
    } finally {
      vi.unstubAllEnvs();
    }

    const [publicCall, listedCall, dottedCall] = vi.mocked(outboundRequest).mock.calls;
    expect(publicCall[1].isAllowed).toBeUndefined();
    expect(listedCall[1].isAllowed?.("172.18.0.5")).toBe(true);
    expect(dottedCall[1].isAllowed?.("10.0.0.9")).toBe(true);
  });

  it.each([
    [200, false],
    [204, false],
    [299, false],
    [199, true],
    [300, true],
    [302, true],
    [503, true],
  ])("treats HTTP %i as delivered unless it is outside 2xx (warns: %s)", async (status, warns) => {
    vi.mocked(outboundRequest).mockResolvedValue(answered(status));
    const logger = fakeLogger();

    await deliverEvent(makeSub(), makeMsg(), null, logger);

    expect(logger.warn).toHaveBeenCalledTimes(warns ? 1 : 0);
  });

  it("never throws when fetch rejects", async () => {
    vi.mocked(outboundRequest).mockRejectedValue(new Error("network down"));
    await expect(deliverEvent(makeSub(), makeMsg(), null, fakeLogger())).resolves.toBeUndefined();
  });

  it("never throws on a non-2xx response", async () => {
    vi.mocked(outboundRequest).mockResolvedValue(answered(503));
    await expect(deliverEvent(makeSub(), makeMsg(), null, fakeLogger())).resolves.toBeUndefined();
  });

  it("never leaks the secret into log output", async () => {
    vi.mocked(outboundRequest).mockRejectedValue(new Error("boom"));
    const logger = fakeLogger();

    await deliverEvent(makeSub({ secret: "TOP-SECRET-XYZ" }), makeMsg(), null, logger);

    const logged = [...logger.warn.mock.calls, ...logger.debug.mock.calls]
      .map((args) => JSON.stringify(args))
      .join(" ");
    expect(logged).not.toContain("TOP-SECRET-XYZ");
  });
});

describe("dispatchInbound", () => {
  beforeEach(() => {
    initializeDatabase(":memory:");
    resetRegistry();
    loadRegistry();
    vi.mocked(outboundRequest).mockReset();
    vi.mocked(outboundRequest).mockResolvedValue(answered(200));
  });
  afterEach(() => {
    resetRegistry();
    resetDatabase();
    resetSentTracker();
    vi.restoreAllMocks();
  });

  it("does not deliver when no subscription matches", async () => {
    addSubscription({
      tenantId: "default",
      targetUrl: "https://h/x",
      allowedJids: ["9999@s.whatsapp.net"],
    });
    await dispatchInbound(makeMsg(), { logger: fakeLogger() });
    expect(outboundRequest).not.toHaveBeenCalled();
  });

  it("delivers a text message to each matching subscription", async () => {
    addSubscription({
      tenantId: "default",
      targetUrl: "https://h/a",
      allowedJids: ["5531@s.whatsapp.net"],
    });
    addSubscription({ tenantId: "default", targetUrl: "https://h/b", allowedJids: ["*"] });

    await dispatchInbound(makeMsg(), { logger: fakeLogger() });
    expect(outboundRequest).toHaveBeenCalledTimes(2);
  });

  it("transcribes an audio message once even with several subscribers", async () => {
    addSubscription({
      tenantId: "default",
      targetUrl: "https://h/a",
      allowedJids: ["5531@s.whatsapp.net"],
    });
    addSubscription({
      tenantId: "default",
      targetUrl: "https://h/b",
      allowedJids: ["5531@s.whatsapp.net"],
    });
    const transcribe = vi.fn(async () => "transcribed text");

    await dispatchInbound(makeMsg({ content: "", media_type: "ptt", mimetype: "audio/ogg" }), {
      logger: fakeLogger(),
      transcribe,
    });

    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(outboundRequest).toHaveBeenCalledTimes(2);
    const bodies = vi
      .mocked(outboundRequest)
      .mock.calls.map((c) => JSON.parse(c[1]?.body as string));
    expect(bodies.every((b) => b.transcript === "transcribed text")).toBe(true);
  });

  it("does not transcribe when the matching subscription opted out", async () => {
    addSubscription({
      tenantId: "default",
      targetUrl: "https://h/a",
      allowedJids: ["5531@s.whatsapp.net"],
      transcribe: false,
    });
    const transcribe = vi.fn(async () => "x");

    await dispatchInbound(makeMsg({ content: "", media_type: "ptt", mimetype: "audio/ogg" }), {
      logger: fakeLogger(),
      transcribe,
    });

    expect(transcribe).not.toHaveBeenCalled();
    const body = JSON.parse(vi.mocked(outboundRequest).mock.calls[0][1]?.body as string);
    expect(body.transcript).toBeNull();
  });

  it("forwards an is_from_me message only to subscriptions with include_from_me", async () => {
    addSubscription({
      tenantId: "default",
      targetUrl: "https://h/in-only",
      allowedJids: ["5531@s.whatsapp.net"],
    });
    addSubscription({
      tenantId: "default",
      targetUrl: "https://h/self-chat",
      allowedJids: ["5531@s.whatsapp.net"],
      includeFromMe: true,
    });

    await dispatchInbound(makeMsg({ is_from_me: true, content: "oi agente" }), {
      logger: fakeLogger(),
    });

    // Only the include_from_me subscription receives it; the inbound-only one is skipped.
    expect(outboundRequest).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(outboundRequest).mock.calls[0];
    expect(url).toBe("https://h/self-chat");
    const body = JSON.parse(init?.body as string);
    expect(body.is_from_me).toBe(true);
    expect(body.content).toBe("oi agente");
  });

  it("never forwards a message this MCP sent (loop guard), even with include_from_me", async () => {
    addSubscription({
      tenantId: "default",
      targetUrl: "https://h/self-chat",
      allowedJids: ["5531@s.whatsapp.net"],
      includeFromMe: true,
    });
    markSentByUs("REPLY1"); // the agent's own reply echoing back

    await dispatchInbound(makeMsg({ id: "REPLY1", is_from_me: true, content: "I am the agent" }), {
      logger: fakeLogger(),
    });

    expect(outboundRequest).not.toHaveBeenCalled();
  });

  it("auto-forwards your own messages in a self-chat without include_from_me", async () => {
    addSubscription({
      tenantId: "default",
      targetUrl: "https://h/self",
      allowedJids: ["5531@s.whatsapp.net"], // your own number — a self-chat
      // note: includeFromMe NOT set (defaults false)
    });

    await dispatchInbound(makeMsg({ is_from_me: true, content: "oi agente" }), {
      logger: fakeLogger(),
      ownJids: ["5531@s.whatsapp.net"],
    });

    expect(outboundRequest).toHaveBeenCalledTimes(1);
    const body = JSON.parse(vi.mocked(outboundRequest).mock.calls[0][1]?.body as string);
    expect(body.is_from_me).toBe(true);
    expect(body.content).toBe("oi agente");
  });

  it("delivers a non-from-me message in a self-chat (the unconditional branch)", async () => {
    addSubscription({
      tenantId: "default",
      targetUrl: "https://h/self",
      allowedJids: ["5531@s.whatsapp.net"],
    });

    await dispatchInbound(makeMsg({ is_from_me: false, content: "from someone else" }), {
      logger: fakeLogger(),
      ownJids: ["5531@s.whatsapp.net"],
    });

    expect(outboundRequest).toHaveBeenCalledTimes(1);
  });

  it("matches a self-chat (keyed under your LID) when you allow-listed your NUMBER", async () => {
    // You register with your phone number; WhatsApp delivers your self-chat under
    // your LID. Detection + own-jid match should bridge that with zero config.
    addSubscription({
      tenantId: "default",
      targetUrl: "https://h/self",
      allowedJids: ["5531@s.whatsapp.net"], // your number, not your LID
    });

    await dispatchInbound(makeMsg({ chat_jid: "111@lid", is_from_me: true, content: "oi" }), {
      logger: fakeLogger(),
      ownJids: ["5531@s.whatsapp.net", "111@lid"],
    });

    expect(outboundRequest).toHaveBeenCalledTimes(1);
  });

  it("still suppresses the agent's own reply in a self-chat (loop guard wins)", async () => {
    addSubscription({
      tenantId: "default",
      targetUrl: "https://h/self",
      allowedJids: ["5531@s.whatsapp.net"],
    });
    markSentByUs("REPLY9");

    await dispatchInbound(makeMsg({ id: "REPLY9", is_from_me: true }), {
      logger: fakeLogger(),
      ownJids: ["5531@s.whatsapp.net"],
    });

    expect(outboundRequest).not.toHaveBeenCalled();
  });
});

describe("isSelfChatJid", () => {
  it("matches your own number across @domain and :device suffixes", () => {
    expect(isSelfChatJid("551100000013@s.whatsapp.net", "551100000013")).toBe(true);
    expect(isSelfChatJid("551100000013@s.whatsapp.net", "551100000013:19@s.whatsapp.net")).toBe(
      true,
    );
  });

  it("matches a LID self-chat against the account's own LID", () => {
    expect(isSelfChatJid("100000000000006@lid", "100000000000006:22@lid")).toBe(true);
    expect(isSelfChatJid("100000000000006@lid", "100000000000006@lid")).toBe(true);
    expect(isSelfChatJid("100000000000006@lid", "5531@s.whatsapp.net")).toBe(false);
  });

  it("is false for other chats and when the user is unknown", () => {
    expect(isSelfChatJid("999@s.whatsapp.net", "551100000013")).toBe(false);
    expect(isSelfChatJid("120363@g.us", "551100000013")).toBe(false);
    expect(isSelfChatJid("551100000013@s.whatsapp.net", null)).toBe(false);
  });
});
