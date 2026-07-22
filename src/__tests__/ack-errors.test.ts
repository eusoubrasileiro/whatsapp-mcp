import { describe, expect, it, vi } from "vitest";
import { classifyAckError, logAckErrors } from "../ack-errors.ts";

// WhatsApp rejects a send *asynchronously*, in an ack that arrives long after
// socket.sendMessage() already resolved. Baileys surfaces it on `messages.update`
// as status=ERROR plus the numeric code in messageStubParameters[0].
//
// Before this module, whatsapp.ts never registered onMessagesUpdate, so those
// rejections were dropped: send_message reported success for a message that
// never landed.

function ackError(code: string, extra?: string) {
  return {
    key: { id: "3EB0DE3000E4B8E7FD1596", remoteJid: "5531991234567@s.whatsapp.net", fromMe: true },
    update: {
      status: 0, // WAMessageStatus.ERROR
      messageStubParameters: extra ? [code, extra] : [code],
    },
  } as never;
}

describe("classifyAckError", () => {
  it("classifies 463 as a restriction / missing privacy token", () => {
    const result = classifyAckError(ackError("463"));

    expect(result).not.toBeNull();
    expect(result?.code).toBe("463");
    expect(result?.msgId).toBe("3EB0DE3000E4B8E7FD1596");
    expect(result?.chatJid).toBe("5531991234567@s.whatsapp.net");
    expect(result?.reason).toMatch(/privacy token|tctoken/i);
  });

  it("classifies 479 as a stale-session stanza rejection", () => {
    const result = classifyAckError(ackError("479"));

    expect(result?.code).toBe("479");
    expect(result?.reason).toMatch(/session/i);
  });

  it("still reports an unknown code rather than swallowing it", () => {
    const result = classifyAckError(ackError("500"));

    expect(result?.code).toBe("500");
    expect(result?.reason).toBeTruthy();
  });

  it("carries the account-restricted text when the server sends it", () => {
    const result = classifyAckError(ackError("463", "Your account has been restricted"));

    expect(result?.detail).toBe("Your account has been restricted");
  });

  it("returns null for ordinary delivery-status updates", () => {
    // status 3 === DELIVERY_ACK — the overwhelmingly common case; must stay cheap.
    const delivered = {
      key: { id: "abc", remoteJid: "555@s.whatsapp.net", fromMe: true },
      update: { status: 3 },
    } as never;

    expect(classifyAckError(delivered)).toBeNull();
  });

  it("returns null when status is absent entirely", () => {
    const reaction = {
      key: { id: "abc", remoteJid: "555@s.whatsapp.net", fromMe: true },
      update: { reactions: [] },
    } as never;

    expect(classifyAckError(reaction)).toBeNull();
  });

  it("treats status ERROR with no stub parameters as an unspecified rejection", () => {
    const bare = {
      key: { id: "abc", remoteJid: "555@s.whatsapp.net", fromMe: true },
      update: { status: 0 },
    } as never;

    const result = classifyAckError(bare);
    expect(result).not.toBeNull();
    expect(result?.code).toBeNull();
  });
});

describe("logAckErrors", () => {
  function makeLogger() {
    return { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  }

  it("warns once per rejected message with the code and chat", () => {
    const logger = makeLogger();

    logAckErrors([ackError("463")], logger as never);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [bindings, msg] = logger.warn.mock.calls[0];
    expect(bindings.code).toBe("463");
    expect(bindings.msgId).toBe("3EB0DE3000E4B8E7FD1596");
    expect(bindings.chat_jid).toBe("5531991234567@s.whatsapp.net");
    expect(msg).toMatch(/send rejected/i);
  });

  it("stays silent for ordinary delivery updates", () => {
    const logger = makeLogger();

    logAckErrors(
      [{ key: { id: "a", remoteJid: "5@s.whatsapp.net" }, update: { status: 3 } } as never],
      logger as never,
    );

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("reports every rejection in a batch", () => {
    const logger = makeLogger();

    logAckErrors([ackError("463"), ackError("479")], logger as never);

    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});
