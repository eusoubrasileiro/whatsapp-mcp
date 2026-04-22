import { describe, it, expect } from "vitest";
import {
  transformChat,
  transformMessage,
  transformContact,
} from "../scripts/migrate-transforms.ts";

describe("migrate-transforms", () => {
  describe("transformChat", () => {
    it("maps SQLite chat row to Prisma create shape", () => {
      const result = transformChat("t-1", {
        jid: "5531@s.whatsapp.net",
        name: "Carlos",
        last_message_time: "2026-04-01T12:00:00.000Z",
      });
      expect(result).toEqual({
        tenantId: "t-1",
        jid: "5531@s.whatsapp.net",
        name: "Carlos",
        lastMessageTime: new Date("2026-04-01T12:00:00.000Z"),
      });
    });

    it("handles null name and null last_message_time", () => {
      const result = transformChat("t-1", {
        jid: "5531@s.whatsapp.net",
        name: null,
        last_message_time: null,
      });
      expect(result.name).toBeNull();
      expect(result.lastMessageTime).toBeNull();
    });
  });

  describe("transformMessage", () => {
    it("maps SQLite message row to Prisma create shape", () => {
      const result = transformMessage("t-1", {
        id: "m1",
        chat_jid: "5531@s.whatsapp.net",
        sender: "5531@s.whatsapp.net",
        content: "Hello!",
        timestamp: "2026-04-01T12:00:00.000Z",
        is_from_me: 0,
        media_type: null,
        mimetype: null,
        media_key: null,
        direct_path: null,
        media_url: null,
        file_length: null,
        file_sha256: null,
        file_enc_sha256: null,
        media_object_key: null,
      });
      expect(result.tenantId).toBe("t-1");
      expect(result.chatJid).toBe("5531@s.whatsapp.net");
      expect(result.isFromMe).toBe(false);
      expect(result.timestamp).toEqual(new Date("2026-04-01T12:00:00.000Z"));
    });

    it("converts is_from_me=1 to boolean true", () => {
      const result = transformMessage("t-1", {
        id: "m2",
        chat_jid: "5531@s.whatsapp.net",
        sender: null,
        content: "Reply",
        timestamp: "2026-04-01T12:01:00.000Z",
        is_from_me: 1,
        media_type: null,
        mimetype: null,
        media_key: null,
        direct_path: null,
        media_url: null,
        file_length: null,
        file_sha256: null,
        file_enc_sha256: null,
        media_object_key: null,
      });
      expect(result.isFromMe).toBe(true);
    });

    it("preserves media fields", () => {
      const result = transformMessage("t-1", {
        id: "m3",
        chat_jid: "c@s.whatsapp.net",
        sender: "s@s.whatsapp.net",
        content: "Photo",
        timestamp: "2026-04-01T12:02:00.000Z",
        is_from_me: 0,
        media_type: "image",
        mimetype: "image/jpeg",
        media_key: "abc123",
        direct_path: "/media/enc",
        media_url: "https://cdn.whatsapp.net/img",
        file_length: 4096,
        file_sha256: "sha256hash",
        file_enc_sha256: "encsha256",
        media_object_key: "t/default/5531/m3.jpg",
      });
      expect(result.mediaType).toBe("image");
      expect(result.mimetype).toBe("image/jpeg");
      expect(result.mediaKey).toBe("abc123");
      expect(result.fileLength).toBe(4096);
      expect(result.mediaObjectKey).toBe("t/default/5531/m3.jpg");
    });
  });

  describe("transformContact", () => {
    it("maps SQLite contact row to Prisma create shape", () => {
      const result = transformContact("t-1", {
        jid: "5531@s.whatsapp.net",
        name: "Carlos Silva",
        notify: "Carlinho",
        phone_number: "5531999999999",
      });
      expect(result).toEqual({
        tenantId: "t-1",
        jid: "5531@s.whatsapp.net",
        name: "Carlos Silva",
        notify: "Carlinho",
        phoneNumber: "5531999999999",
      });
    });

    it("handles all-null optional fields", () => {
      const result = transformContact("t-1", {
        jid: "5511@s.whatsapp.net",
        name: null,
        notify: null,
        phone_number: null,
      });
      expect(result.name).toBeNull();
      expect(result.notify).toBeNull();
      expect(result.phoneNumber).toBeNull();
    });
  });
});
