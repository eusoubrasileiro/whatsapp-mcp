import { describe, it, expect } from "vitest";
import { parseMessage, extractMediaInfo } from "@amiticia/baileys-client";
import type { WAMessage } from "@amiticia/baileys-client";

function makeWAMsg(overrides: Partial<WAMessage> = {}): WAMessage {
  return {
    key: {
      remoteJid: "5511999999999@s.whatsapp.net",
      fromMe: false,
      id: "TEST_MSG_ID",
      ...overrides.key,
    },
    messageTimestamp: 1717200000, // 2024-06-01T00:00:00Z
    message: {
      conversation: "Hello world",
      ...(overrides.message ?? {}),
    },
    ...overrides,
  } as WAMessage;
}

describe("parseMessage", () => {
  it("parses a simple conversation message", () => {
    const result = parseMessage(makeWAMsg());
    expect(result).not.toBeNull();
    expect(result!.id).toBe("TEST_MSG_ID");
    expect(result!.content).toBe("Hello world");
    expect(result!.is_from_me).toBe(false);
    expect(result!.chat_jid).toBe("5511999999999@s.whatsapp.net");
  });

  it("parses extendedTextMessage", () => {
    const result = parseMessage(makeWAMsg({
      message: { extendedTextMessage: { text: "Extended text" } },
    }));
    expect(result!.content).toBe("Extended text");
  });

  it("parses image with caption", () => {
    const result = parseMessage(makeWAMsg({
      message: { imageMessage: { caption: "Nice photo", mimetype: "image/jpeg" } as any },
    }));
    expect(result!.content).toBe("[Image] Nice photo");
  });

  it("parses image without caption", () => {
    const result = parseMessage(makeWAMsg({
      message: { imageMessage: { mimetype: "image/jpeg" } as any },
    }));
    expect(result!.content).toBe("[Image]");
  });

  it("parses video with caption", () => {
    const result = parseMessage(makeWAMsg({
      message: { videoMessage: { caption: "Cool video", mimetype: "video/mp4" } as any },
    }));
    expect(result!.content).toBe("[Video] Cool video");
  });

  it("parses video without caption", () => {
    const result = parseMessage(makeWAMsg({
      message: { videoMessage: { mimetype: "video/mp4" } as any },
    }));
    expect(result!.content).toBe("[Video]");
  });

  it("parses document with caption", () => {
    const result = parseMessage(makeWAMsg({
      message: { documentMessage: { caption: "Report", fileName: "report.pdf" } as any },
    }));
    expect(result!.content).toBe("[Document] Report");
  });

  it("parses document with filename only", () => {
    const result = parseMessage(makeWAMsg({
      message: { documentMessage: { fileName: "report.pdf" } as any },
    }));
    expect(result!.content).toBe("[Document] report.pdf");
  });

  it("parses audio message", () => {
    const result = parseMessage(makeWAMsg({
      message: { audioMessage: { mimetype: "audio/ogg" } as any },
    }));
    expect(result!.content).toBe("[Audio]");
  });

  it("parses sticker message", () => {
    const result = parseMessage(makeWAMsg({
      message: { stickerMessage: {} as any },
    }));
    expect(result!.content).toBe("[Sticker]");
  });

  it("parses location message", () => {
    const result = parseMessage(makeWAMsg({
      message: { locationMessage: { address: "123 Main St" } as any },
    }));
    expect(result!.content).toBe("[Location] 123 Main St");
  });

  it("parses contact message", () => {
    const result = parseMessage(makeWAMsg({
      message: { contactMessage: { displayName: "John Doe" } as any },
    }));
    expect(result!.content).toBe("[Contact] John Doe");
  });

  it("parses poll message", () => {
    const result = parseMessage(makeWAMsg({
      message: { pollCreationMessage: { name: "Lunch poll" } as any },
    }));
    expect(result!.content).toBe("[Poll] Lunch poll");
  });

  it("returns null for empty message", () => {
    const result = parseMessage({ key: { remoteJid: "a@s.whatsapp.net", id: "1" } } as WAMessage);
    expect(result).toBeNull();
  });

  it("returns null for unsupported message type", () => {
    const result = parseMessage(makeWAMsg({
      message: { reactionMessage: { text: "👍" } as any },
    }));
    expect(result).toBeNull();
  });

  it("handles fromMe messages", () => {
    const result = parseMessage(makeWAMsg({
      key: {
        remoteJid: "5511999999999@s.whatsapp.net",
        fromMe: true,
        id: "MY_MSG",
      },
    }));
    expect(result!.is_from_me).toBe(true);
    expect(result!.sender).toBeNull();
  });

  it("uses messageTimestamp for timestamp", () => {
    const result = parseMessage(makeWAMsg({
      messageTimestamp: 1717200000,
    }));
    expect(result!.timestamp.getTime()).toBe(1717200000 * 1000);
  });

  it("falls back to Date.now() when no timestamp", () => {
    const before = Date.now();
    const result = parseMessage(makeWAMsg({
      messageTimestamp: undefined as any,
    }));
    const after = Date.now();
    expect(result!.timestamp.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(result!.timestamp.getTime()).toBeLessThanOrEqual(after + 1000);
  });

  it("extracts sender from group participant", () => {
    const result = parseMessage(makeWAMsg({
      key: {
        remoteJid: "group@g.us",
        fromMe: false,
        id: "GRP_MSG",
        participant: "5511888888888@s.whatsapp.net",
      },
    }));
    expect(result!.sender).toBe("5511888888888@s.whatsapp.net");
    expect(result!.chat_jid).toBe("group@g.us");
  });

  it("uses remoteJid as sender for 1:1 incoming", () => {
    const result = parseMessage(makeWAMsg({
      key: {
        remoteJid: "5511777777777@s.whatsapp.net",
        fromMe: false,
        id: "DM_MSG",
      },
    }));
    expect(result!.sender).toBe("5511777777777@s.whatsapp.net");
  });

  // ── Media metadata extraction ──────────────────────────────────

  it("extracts media metadata from image message", () => {
    const mediaKey = new Uint8Array([1, 2, 3, 4]);
    const result = parseMessage(makeWAMsg({
      message: {
        imageMessage: {
          caption: "Photo",
          mimetype: "image/jpeg",
          mediaKey: mediaKey,
          directPath: "/v/t62.1234/image.enc",
          url: "https://mmg.whatsapp.net/image.enc",
          fileLength: 54321 as any,
          fileSha256: new Uint8Array([10, 20, 30]),
          fileEncSha256: new Uint8Array([40, 50, 60]),
        } as any,
      },
    }));
    expect(result!.media_type).toBe("image");
    expect(result!.mimetype).toBe("image/jpeg");
    expect(result!.media_key).toBe(Buffer.from(mediaKey).toString('base64'));
    expect(result!.direct_path).toBe("/v/t62.1234/image.enc");
    expect(result!.media_url).toBe("https://mmg.whatsapp.net/image.enc");
    expect(result!.file_length).toBe(54321);
    expect(result!.content).toBe("[Image] Photo");
  });

  it("does not extract media info from text messages", () => {
    const result = parseMessage(makeWAMsg());
    expect(result!.media_type).toBeNull();
    expect(result!.media_key).toBeNull();
  });

  it("detects ptt (voice note) as ptt media type", () => {
    const result = parseMessage(makeWAMsg({
      message: {
        audioMessage: {
          mimetype: "audio/ogg; codecs=opus",
          ptt: true,
          mediaKey: new Uint8Array([5, 6, 7]),
          directPath: "/v/t62.1234/audio.enc",
          url: "https://mmg.whatsapp.net/audio.enc",
        } as any,
      },
    }));
    expect(result!.media_type).toBe("ptt");
    expect(result!.mimetype).toBe("audio/ogg; codecs=opus");
  });

  it("detects regular audio (non-ptt) as audio media type", () => {
    const result = parseMessage(makeWAMsg({
      message: {
        audioMessage: {
          mimetype: "audio/mpeg",
          ptt: false,
          mediaKey: new Uint8Array([8, 9]),
          directPath: "/v/t62.1234/audio2.enc",
        } as any,
      },
    }));
    expect(result!.media_type).toBe("audio");
  });

  it("extracts media metadata from sticker message", () => {
    const result = parseMessage(makeWAMsg({
      message: {
        stickerMessage: {
          mimetype: "image/webp",
          mediaKey: new Uint8Array([11, 12]),
          directPath: "/v/t62.1234/sticker.enc",
        } as any,
      },
    }));
    expect(result!.media_type).toBe("sticker");
    expect(result!.mimetype).toBe("image/webp");
  });
});

describe("extractMediaInfo", () => {
  it("returns null for null message", () => {
    expect(extractMediaInfo(null as any)).toBeNull();
  });

  it("returns null for text-only message", () => {
    expect(extractMediaInfo({ conversation: "hello" })).toBeNull();
  });

  it("extracts video media info", () => {
    const info = extractMediaInfo({
      videoMessage: {
        mimetype: "video/mp4",
        mediaKey: new Uint8Array([1, 2, 3]),
        directPath: "/v/video.enc",
        url: "https://cdn/video.enc",
        fileLength: 999999 as any,
      } as any,
    });
    expect(info).not.toBeNull();
    expect(info!.media_type).toBe("video");
    expect(info!.mimetype).toBe("video/mp4");
    expect(info!.file_length).toBe(999999);
  });

  it("extracts document media info", () => {
    const info = extractMediaInfo({
      documentMessage: {
        mimetype: "application/pdf",
        mediaKey: new Uint8Array([4, 5]),
        directPath: "/v/doc.enc",
        fileName: "report.pdf",
        fileLength: 12345 as any,
      } as any,
    });
    expect(info).not.toBeNull();
    expect(info!.media_type).toBe("document");
    expect(info!.mimetype).toBe("application/pdf");
  });
});
