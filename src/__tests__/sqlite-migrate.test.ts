import { describe, it, expect, vi, beforeAll } from "vitest";

/**
 * Tests for the SQLite -> Postgres migration script logic.
 *
 * Since this is a migration utility, we test the core transform functions
 * in isolation (no live Postgres needed).
 */

import {
  transformChat,
  transformMessage,
  transformContact,
} from "../scripts/migrate-transforms.ts";

describe("SQLite -> Postgres migration transforms", () => {
  const TENANT_ID = "default";

  describe("transformChat", () => {
    it("maps SQLite chat row to Prisma create data", () => {
      const result = transformChat(TENANT_ID, {
        jid: "5531@s.whatsapp.net",
        name: "Carlos",
        last_message_time: "2026-04-01T12:00:00.000Z",
      });

      expect(result).toEqual({
        tenantId: TENANT_ID,
        jid: "5531@s.whatsapp.net",
        name: "Carlos",
        lastMessageTime: new Date("2026-04-01T12:00:00.000Z"),
      });
    });

    it("handles null name and last_message_time", () => {
      const result = transformChat(TENANT_ID, {
        jid: "5531@s.whatsapp.net",
        name: null,
        last_message_time: null,
      });

      expect(result.name).toBeNull();
      expect(result.lastMessageTime).toBeNull();
    });
  });

  describe("transformMessage", () => {
    it("maps SQLite message row to Prisma create data", () => {
      const result = transformMessage(TENANT_ID, {
        id: "msg1",
        chat_jid: "5531@s.whatsapp.net",
        sender: "5531@s.whatsapp.net",
        content: "Hello",
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

      expect(result).toEqual({
        tenantId: TENANT_ID,
        chatJid: "5531@s.whatsapp.net",
        id: "msg1",
        timestamp: new Date("2026-04-01T12:00:00.000Z"),
        sender: "5531@s.whatsapp.net",
        content: "Hello",
        isFromMe: false,
        mediaType: null,
        mimetype: null,
        mediaKey: null,
        directPath: null,
        mediaUrl: null,
        fileLength: null,
        fileSha256: null,
        fileEncSha256: null,
        mediaObjectKey: null,
      });
    });

    it("converts is_from_me=1 to true", () => {
      const result = transformMessage(TENANT_ID, {
        id: "m",
        chat_jid: "c",
        sender: null,
        content: null,
        timestamp: "2026-01-01T00:00:00Z",
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
  });

  describe("transformContact", () => {
    it("maps SQLite contact row to Prisma create data", () => {
      const result = transformContact(TENANT_ID, {
        jid: "5531@s.whatsapp.net",
        name: "Carlos",
        notify: "Carlinhos",
        phone_number: "+55319",
      });

      expect(result).toEqual({
        tenantId: TENANT_ID,
        jid: "5531@s.whatsapp.net",
        name: "Carlos",
        notify: "Carlinhos",
        phoneNumber: "+55319",
      });
    });

    it("handles all-null optional fields", () => {
      const result = transformContact(TENANT_ID, {
        jid: "x@s.whatsapp.net",
        name: null,
        notify: null,
        phone_number: null,
      });
      expect(result.name).toBeNull();
      expect(result.notify).toBeNull();
      expect(result.phoneNumber).toBeNull();
    });
  });

  describe("tenantId propagation", () => {
    it("all transform functions embed the provided tenantId", () => {
      const tenantId = "acme-corp";

      const chat = transformChat(tenantId, {
        jid: "c@s.whatsapp.net",
        name: null,
        last_message_time: null,
      });
      expect(chat.tenantId).toBe(tenantId);

      const msg = transformMessage(tenantId, {
        id: "m",
        chat_jid: "c",
        sender: null,
        content: null,
        timestamp: "2026-01-01T00:00:00Z",
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
      expect(msg.tenantId).toBe(tenantId);

      const contact = transformContact(tenantId, {
        jid: "x@s.whatsapp.net",
        name: null,
        notify: null,
        phone_number: null,
      });
      expect(contact.tenantId).toBe(tenantId);
    });
  });

  describe("transformMessage edge cases", () => {
    it("preserves all media fields when present", () => {
      const result = transformMessage(TENANT_ID, {
        id: "m-media",
        chat_jid: "c@s.whatsapp.net",
        sender: "5531@s.whatsapp.net",
        content: "Photo",
        timestamp: "2026-04-01T12:00:00.000Z",
        is_from_me: 0,
        media_type: "image",
        mimetype: "image/jpeg",
        media_key: "abc123",
        direct_path: "/media/enc",
        media_url: "https://cdn.whatsapp.net/img",
        file_length: 4096,
        file_sha256: "sha256hash",
        file_enc_sha256: "encsha256",
        media_object_key: "t/default/c/m.jpg",
      });

      expect(result.mediaType).toBe("image");
      expect(result.mimetype).toBe("image/jpeg");
      expect(result.mediaKey).toBe("abc123");
      expect(result.directPath).toBe("/media/enc");
      expect(result.mediaUrl).toBe("https://cdn.whatsapp.net/img");
      expect(result.fileLength).toBe(4096);
      expect(result.fileSha256).toBe("sha256hash");
      expect(result.fileEncSha256).toBe("encsha256");
      expect(result.mediaObjectKey).toBe("t/default/c/m.jpg");
    });

    it("handles null content", () => {
      const result = transformMessage(TENANT_ID, {
        id: "m",
        chat_jid: "c",
        sender: null,
        content: null,
        timestamp: "2026-01-01T00:00:00Z",
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
      expect(result.content).toBeNull();
      expect(result.sender).toBeNull();
    });
  });
});
