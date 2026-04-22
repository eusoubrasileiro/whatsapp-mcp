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
});
