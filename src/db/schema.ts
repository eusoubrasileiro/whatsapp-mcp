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
