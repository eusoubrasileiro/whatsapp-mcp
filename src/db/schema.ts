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
  mediaObjectKey: text("media_object_key"), // S3/R2 object key after upload
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

/**
 * Maps every WhatsApp JID (phone-number or LID) to a single canonical JID, so
 * a contact who migrated PN→LID resolves to one identity. Canonical direction
 * is LID-preferred (see BUG-lid-contact-fragmentation.md). Both the PN row and
 * the LID row of a pair point at the same `canonicalJid`, so one lookup
 * resolves either direction.
 */
export const jidAliases = sqliteTable("jid_aliases", {
  jid: text("jid").primaryKey(),
  canonicalJid: text("canonical_jid").notNull(),
  pnJid: text("pn_jid"),
  lidJid: text("lid_jid"),
  updatedAt: text("updated_at"),
});

/** Key/value table for schema versioning and one-time migration sentinels. */
export const schemaMeta = sqliteTable("schema_meta", {
  key: text("key").primaryKey(),
  value: text("value"),
});

/**
 * Outbound webhook subscriptions. Each row is a delivery target that receives
 * inbound WhatsApp messages from a curated allow-list of chats, in real time.
 * Tenant-tagged for a future per-tenant SaaS (single `default` tenant today).
 */
export const webhookSubscriptions = sqliteTable("webhook_subscriptions", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  targetUrl: text("target_url").notNull(),
  secret: text("secret"),
  authMode: text("auth_mode").notNull().default("hmac"), // 'hmac' | 'bearer'
  allowedJids: text("allowed_jids").notNull(),            // JSON array of canonical JIDs, or ["*"]
  transcribe: integer("transcribe", { mode: "boolean" }).notNull().default(true),
  includeFromMe: integer("include_from_me", { mode: "boolean" }).notNull().default(false),
  label: text("label"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
