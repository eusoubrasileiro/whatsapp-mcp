import { describe, expect, it } from "vitest";

import { buildInboundEvent } from "../webhooks/event.ts";
import type { InboundMessageInput, Subscription } from "../webhooks/types.ts";

const sub: Pick<Subscription, "id" | "tenantId"> = {
  id: "sub-1",
  tenantId: "default",
};

function makeMessage(overrides: Partial<InboundMessageInput> = {}): InboundMessageInput {
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

describe("buildInboundEvent", () => {
  it("maps a text message to a flat event with ISO timestamp", () => {
    const event = buildInboundEvent(sub, makeMessage({ content: "lê o arquivo X" }));

    expect(event).toEqual({
      event: "inbound_message",
      tenant_id: "default",
      subscription_id: "sub-1",
      message_id: "MSG1",
      chat_jid: "5531@s.whatsapp.net",
      sender_jid: "5531@s.whatsapp.net",
      timestamp: "2026-06-01T14:32:07.000Z",
      is_from_me: false,
      content: "lê o arquivo X",
      transcript: null,
      media: null,
    });
  });

  it("includes a typed media indicator for media messages", () => {
    const event = buildInboundEvent(
      sub,
      makeMessage({
        content: "",
        media_type: "ptt",
        mimetype: "audio/ogg; codecs=opus",
        file_length: 4821,
      }),
    );

    expect(event.content).toBe("");
    expect(event.media).toEqual({
      type: "ptt",
      mimetype: "audio/ogg; codecs=opus",
      file_size: 4821,
    });
  });

  it("inlines a transcript when provided", () => {
    const event = buildInboundEvent(
      sub,
      makeMessage({ content: "", media_type: "ptt", mimetype: "audio/ogg" }),
      "olá, queria saber se entregam",
    );

    expect(event.transcript).toBe("olá, queria saber se entregam");
    expect(event.media?.type).toBe("ptt");
  });

  it("defaults transcript to null and sender to null when absent", () => {
    const event = buildInboundEvent(sub, makeMessage({ sender: null }));
    expect(event.sender_jid).toBeNull();
    expect(event.transcript).toBeNull();
  });
});
