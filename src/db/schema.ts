import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";

export const chats = sqliteTable("chats", {
  jid: text("jid").primaryKey(),
  name: text("name"),
  lastMessageTime: text("last_message_time"), // ISO string
});

export const messages = sqliteTable("messages", {
  id: text("id"),
  chatJid: text("chat_jid").references(() => chats.jid, { onDelete: 'cascade' }),
  sender: text("sender"),
  content: text("content"),
  timestamp: text("timestamp"), // ISO string
  isFromMe: integer("is_from_me", { mode: 'boolean' }),
  // Media metadata (populated for image/video/audio/document/sticker messages)
  mediaType: text("media_type"),       // 'image' | 'video' | 'audio' | 'ptt' | 'document' | 'sticker'
  mimetype: text("mimetype"),          // e.g. 'image/jpeg'
  mediaKey: text("media_key"),         // base64-encoded encryption key
  directPath: text("direct_path"),     // WhatsApp CDN path (stable, used to refresh expired URLs)
  mediaUrl: text("media_url"),         // full CDN URL (may expire)
  fileLength: integer("file_length"),  // file size in bytes
  fileSha256: text("file_sha256"),     // base64-encoded hash
  fileEncSha256: text("file_enc_sha256"), // base64-encoded encrypted hash
  mediaLocalPath: text("media_local_path"), // local file path after download
}, (table) => {
  return [
    primaryKey({ columns: [table.id, table.chatJid] }),
  ];
});

export const contacts = sqliteTable("contacts", {
  jid: text("jid").primaryKey(),
  name: text("name"),
  notify: text("notify"),
  phoneNumber: text("phone_number"),
});
