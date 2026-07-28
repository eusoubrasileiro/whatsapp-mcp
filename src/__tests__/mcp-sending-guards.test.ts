import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendWhatsAppMessage = vi.fn();
const sendWhatsAppMedia = vi.fn();
const onWhatsApp = vi.fn();
const sendPresenceUpdate = vi.fn();
/** The connected account's own JIDs, as Baileys reports them on `socket.user`. */
const socketUser: { id?: string; lid?: string } = {};

vi.mock("../whatsapp.ts", () => ({
  sendWhatsAppMessage: (...args: unknown[]) => sendWhatsAppMessage(...args),
  sendWhatsAppMedia: (...args: unknown[]) => sendWhatsAppMedia(...args),
}));

vi.mock("../actions.ts", () => ({
  assertSocketActive: () => ({
    onWhatsApp: (...a: unknown[]) => onWhatsApp(...a),
    sendPresenceUpdate: (...a: unknown[]) => sendPresenceUpdate(...a),
    user: socketUser,
  }),
}));

const { registerSendingTools } = await import("../mcp/tools/sending.ts");
const { emitAckError, resetAckBus } = await import("../ack-bus.ts");
const { resetRecipientCache } = await import("../recipient.ts");
const { resetSendPacer } = await import("../send-pacer.ts");
const { initializeDatabase, resetDatabase, storeMessage } = await import("../database.ts");
const { makeMessage } = await import("./helpers/make-message.ts");

/** Every env knob these tests touch, cleared between tests. */
const SEND_ENV = [
  "SEND_ACK_WAIT_MS",
  "SEND_PRESEND_CHECK",
  "SEND_COLD_CONTACT_GUARD",
  "SEND_RATE_LIMIT_ENABLED",
  "SEND_RATE_LIMIT_MIN_INTERVAL_MS",
  "SEND_RATE_LIMIT_PER_HOUR",
  "SEND_SIMULATE_TYPING",
  "SEND_TYPING_MAX_MS",
];

beforeEach(() => {
  resetSendPacer();
  resetDatabase();
  sendPresenceUpdate.mockReset().mockResolvedValue(undefined);
  socketUser.id = undefined;
  socketUser.lid = undefined;
  // The anti-ban guards ship ON. Most tests here are about the ack/recipient
  // guards, so they opt out; the "anti-ban guards" block below opts back in.
  process.env.SEND_COLD_CONTACT_GUARD = "false";
  process.env.SEND_RATE_LIMIT_ENABLED = "false";
  process.env.SEND_SIMULATE_TYPING = "false";
});

afterEach(() => {
  for (const key of SEND_ENV) delete process.env[key];
});

type Tool = { name: string; execute: (args: never) => Promise<string> };

function tools() {
  const registered: Record<string, Tool> = {};
  const logger = pino({ level: "silent" });
  registerSendingTools(
    { addTool: ((t: Tool) => (registered[t.name] = t)) as never },
    { mcpLogger: logger, waLogger: logger },
  );
  return registered;
}

const GOOD = { jid: "553191234567@s.whatsapp.net", exists: true, lid: "22233344455566@lid" };

describe("send_message guards", () => {
  beforeEach(() => {
    resetAckBus();
    resetRecipientCache();
    sendWhatsAppMessage.mockReset().mockResolvedValue({ key: { id: "m1" } });
    sendWhatsAppMedia.mockReset().mockResolvedValue({ key: { id: "m1" } });
    onWhatsApp.mockReset().mockResolvedValue([GOOD]);
    delete process.env.SEND_ACK_WAIT_MS;
    delete process.env.SEND_PRESEND_CHECK;
  });

  afterEach(() => {
    delete process.env.SEND_ACK_WAIT_MS;
    delete process.env.SEND_PRESEND_CHECK;
  });

  // The 2026-07-22 regression, at the tool boundary.
  it("throws instead of reporting success when the server rejects the send", async () => {
    process.env.SEND_ACK_WAIT_MS = "50";
    sendWhatsAppMessage.mockImplementation(async () => {
      // The refusal lands right after the send resolves, as it does live.
      queueMicrotask(() =>
        emitAckError({
          msgId: "m1",
          chatJid: "x",
          code: "463",
          reason: "r",
          detail: null,
        }),
      );
      return { key: { id: "m1" } };
    });

    await expect(
      tools().send_message!.execute({
        recipient: "553191234567@s.whatsapp.net",
        message: "hi",
      } as never),
    ).rejects.toThrow(/REJECTED[\s\S]*DO NOT RETRY/);
  });

  it("reports success when the send is not rejected", async () => {
    process.env.SEND_ACK_WAIT_MS = "10";

    const result = await tools().send_message!.execute({
      recipient: "553191234567@s.whatsapp.net",
      message: "hi",
    } as never);

    expect(result).toMatch(/sent successfully/i);
  });

  it("refuses a number that is not on WhatsApp without sending anything", async () => {
    onWhatsApp.mockResolvedValue([{ exists: false }]);

    await expect(
      tools().send_message!.execute({
        recipient: "5531912344567@s.whatsapp.net",
        message: "hi",
      } as never),
    ).rejects.toThrow(/not on WhatsApp/i);

    // The decisive assertion: no reach-out was spent.
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it("addresses the send to the canonical LID", async () => {
    process.env.SEND_ACK_WAIT_MS = "10";

    await tools().send_message!.execute({
      recipient: "553191234567@s.whatsapp.net",
      message: "hi",
    } as never);

    expect(sendWhatsAppMessage).toHaveBeenCalledWith(expect.anything(), "22233344455566@lid", "hi");
  });

  it("leaves group sends untouched", async () => {
    process.env.SEND_ACK_WAIT_MS = "10";

    await tools().send_message!.execute({
      recipient: "120363421815522729@g.us",
      message: "hi",
    } as never);

    expect(onWhatsApp).not.toHaveBeenCalled();
    expect(sendWhatsAppMessage).toHaveBeenCalledWith(
      expect.anything(),
      "120363421815522729@g.us",
      "hi",
    );
  });

  it("restores fire-and-forget behavior when both guards are disabled", async () => {
    process.env.SEND_ACK_WAIT_MS = "0";
    process.env.SEND_PRESEND_CHECK = "false";
    onWhatsApp.mockResolvedValue([{ exists: false }]);
    emitAckError({ msgId: "m1", chatJid: "x", code: "463", reason: "r", detail: null });

    const result = await tools().send_message!.execute({
      recipient: "5531912344567@s.whatsapp.net",
      message: "hi",
    } as never);

    expect(result).toMatch(/sent successfully/i);
    expect(onWhatsApp).not.toHaveBeenCalled();
  });
});

describe("send_file guards", () => {
  beforeEach(() => {
    resetAckBus();
    resetRecipientCache();
    sendWhatsAppMedia.mockReset().mockResolvedValue({ key: { id: "f1" } });
    onWhatsApp.mockReset().mockResolvedValue([GOOD]);
    process.env.SEND_ACK_WAIT_MS = "50";
  });

  afterEach(() => {
    delete process.env.SEND_ACK_WAIT_MS;
  });

  it("throws when the server rejects the media send", async () => {
    sendWhatsAppMedia.mockImplementation(async () => {
      queueMicrotask(() =>
        emitAckError({ msgId: "f1", chatJid: "x", code: "463", reason: "r", detail: null }),
      );
      return { key: { id: "f1" } };
    });

    await expect(
      tools().send_file!.execute({
        recipient: "553191234567@s.whatsapp.net",
        file_path: "https://example.com/a.jpg",
        type: "image",
      } as never),
    ).rejects.toThrow(/REJECTED[\s\S]*DO NOT RETRY/);
  });

  it("refuses a non-WhatsApp number without uploading anything", async () => {
    onWhatsApp.mockResolvedValue([{ exists: false }]);

    await expect(
      tools().send_file!.execute({
        recipient: "5531912344567@s.whatsapp.net",
        file_path: "https://example.com/a.jpg",
        type: "image",
      } as never),
    ).rejects.toThrow(/not on WhatsApp/i);

    expect(sendWhatsAppMedia).not.toHaveBeenCalled();
  });
});

/**
 * The 2026-07-28 restriction, at the tool boundary: the account could still
 * reach saved contacts but not strangers, so the send path must refuse a cold
 * reach-out and pace what it does send.
 */
describe("anti-ban guards", () => {
  /** Warm the chat the resolved LID belongs to. */
  function seedInboundHistory() {
    initializeDatabase(":memory:");
    storeMessage(makeMessage({ id: "in1", chat_jid: GOOD.lid, content: "oi", is_from_me: false }));
  }

  beforeEach(() => {
    resetAckBus();
    resetRecipientCache();
    sendWhatsAppMessage.mockReset().mockResolvedValue({ key: { id: "m1" } });
    sendWhatsAppMedia.mockReset().mockResolvedValue({ key: { id: "f1" } });
    onWhatsApp.mockReset().mockResolvedValue([GOOD]);
    process.env.SEND_ACK_WAIT_MS = "0";
    // Opt back in to the cold-contact guard; keep pacing/typing off unless the
    // test is about them.
    delete process.env.SEND_COLD_CONTACT_GUARD;
  });

  it("refuses a cold first contact and sends nothing", async () => {
    await expect(
      tools().send_message!.execute({
        recipient: "553191234567@s.whatsapp.net",
        message: "olá",
      } as never),
    ).rejects.toThrow(/never messaged/i);

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it("sends to a contact that has already messaged us", async () => {
    seedInboundHistory();

    await expect(
      tools().send_message!.execute({
        recipient: "553191234567@s.whatsapp.net",
        message: "olá",
      } as never),
    ).resolves.toMatch(/sent successfully/i);
  });

  it("lets a deliberate first contact through with allow_cold_contact", async () => {
    await expect(
      tools().send_message!.execute({
        recipient: "553191234567@s.whatsapp.net",
        message: "olá",
        allow_cold_contact: true,
      } as never),
    ).resolves.toMatch(/sent successfully/i);
  });

  it("still replies into the account's own self-chat", async () => {
    // A self-chat has no inbound rows (everything is is_from_me), so without the
    // self-chat exemption the agent could no longer answer the user's own
    // messages — the documented talk-to-yourself flow.
    socketUser.lid = `${GOOD.lid.split("@")[0]}:7@lid`;

    await expect(
      tools().send_message!.execute({
        recipient: "553191234567@s.whatsapp.net",
        message: "pronto",
      } as never),
    ).resolves.toMatch(/sent successfully/i);
  });

  it("refuses a cold first contact for send_file too", async () => {
    await expect(
      tools().send_file!.execute({
        recipient: "553191234567@s.whatsapp.net",
        file_path: "https://example.com/a.jpg",
        type: "image",
      } as never),
    ).rejects.toThrow(/never messaged/i);

    expect(sendWhatsAppMedia).not.toHaveBeenCalled();
  });

  it("refuses the send once the rolling hourly cap is reached", async () => {
    seedInboundHistory();
    process.env.SEND_RATE_LIMIT_ENABLED = "true";
    process.env.SEND_RATE_LIMIT_MIN_INTERVAL_MS = "0";
    process.env.SEND_RATE_LIMIT_PER_HOUR = "1";

    await tools().send_message!.execute({
      recipient: "553191234567@s.whatsapp.net",
      message: "primeira",
    } as never);

    await expect(
      tools().send_message!.execute({
        recipient: "553191234567@s.whatsapp.net",
        message: "segunda",
      } as never),
    ).rejects.toThrow(/hour/i);

    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
  });

  it("shows a typing indicator before a text message", async () => {
    seedInboundHistory();
    process.env.SEND_SIMULATE_TYPING = "true";
    process.env.SEND_TYPING_MAX_MS = "1";

    await tools().send_message!.execute({
      recipient: "553191234567@s.whatsapp.net",
      message: "olá",
    } as never);

    expect(sendPresenceUpdate).toHaveBeenCalledWith("composing", GOOD.lid);
  });

  it("does not fake typing for a file send", async () => {
    seedInboundHistory();
    process.env.SEND_SIMULATE_TYPING = "true";
    process.env.SEND_TYPING_MAX_MS = "1";

    await tools().send_file!.execute({
      recipient: "553191234567@s.whatsapp.net",
      file_path: "https://example.com/a.jpg",
      type: "image",
    } as never);

    expect(sendPresenceUpdate).not.toHaveBeenCalled();
  });
});
