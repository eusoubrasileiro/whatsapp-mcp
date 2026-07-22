import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import pino from "pino";

const sendWhatsAppMessage = vi.fn();
const sendWhatsAppMedia = vi.fn();
const onWhatsApp = vi.fn();

vi.mock("../whatsapp.ts", () => ({
  sendWhatsAppMessage: (...args: unknown[]) => sendWhatsAppMessage(...args),
  sendWhatsAppMedia: (...args: unknown[]) => sendWhatsAppMedia(...args),
}));

vi.mock("../actions.ts", () => ({
  assertSocketActive: () => ({ onWhatsApp: (...a: unknown[]) => onWhatsApp(...a) }),
}));

const { registerSendingTools } = await import("../mcp/tools/sending.ts");
const { emitAckError, resetAckBus } = await import("../ack-bus.ts");
const { resetRecipientCache } = await import("../recipient.ts");

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

    expect(sendWhatsAppMessage).toHaveBeenCalledWith(
      expect.anything(),
      "22233344455566@lid",
      "hi",
    );
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
