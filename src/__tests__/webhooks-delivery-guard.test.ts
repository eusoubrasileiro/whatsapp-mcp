import type { Logger } from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deliverEvent, signPayload } from "../webhooks/delivery.ts";
import type { InboundMessageInput, Subscription } from "../webhooks/types.ts";
import { type LoopbackServer, startLoopbackServer } from "./helpers/loopback-server.ts";

/**
 * Delivery through the real guarded client (no mock): a live server on loopback stands for an
 * internal subscriber.
 */

const msg: InboundMessageInput = {
  id: "MSG1",
  chat_jid: "5531@s.whatsapp.net",
  sender: "5531@s.whatsapp.net",
  content: "oi",
  timestamp: new Date("2026-06-01T14:32:07.000Z"),
  is_from_me: false,
  media_type: null,
  mimetype: null,
  file_length: null,
};

describe("deliverEvent over real HTTP", () => {
  let server: LoopbackServer;
  let hookUrl: string;
  let warn: ReturnType<typeof vi.fn>;
  let logger: Logger;

  const subscription = (): Subscription => ({
    id: "sub-1",
    tenantId: "default",
    targetUrl: hookUrl,
    secret: "k3y",
    authMode: "hmac",
    allowedJids: ["*"],
    transcribe: false,
    includeFromMe: false,
    label: null,
    active: true,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  });

  beforeAll(async () => {
    server = await startLoopbackServer();
    hookUrl = `http://127.0.0.1:${server.port}/hook`;
  });

  afterAll(() => server.close());

  beforeEach(() => {
    server.reset();
    server.routes["/hook"] = (_req, res) => res.writeHead(200).end("ok");
    warn = vi.fn();
    logger = { warn, debug: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses an internal subscriber that the operator did not list, and says so", async () => {
    await deliverEvent(subscription(), msg, null, logger);

    expect(server.hits).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, text] = warn.mock.calls[0];
    expect(text).toBe("webhook delivery failed");
    expect(String(fields.err.message)).toContain("refused: 127.0.0.1");
  });

  it("delivers a verifiable signed POST to a listed internal subscriber", async () => {
    vi.stubEnv("WEBHOOK_PRIVATE_HOSTS", "127.0.0.1");

    await deliverEvent(subscription(), msg, null, logger);

    expect(server.hits).toHaveLength(1);
    const { headers, body } = server.hits[0];
    const ts = headers["x-webhook-timestamp"] as string;
    expect(headers["x-webhook-signature"]).toBe(`sha256=${signPayload(`${ts}.${body}`, "k3y")}`);
    expect(JSON.parse(body).event).toBe("inbound_message");
    expect(warn).not.toHaveBeenCalled();
  });
});
