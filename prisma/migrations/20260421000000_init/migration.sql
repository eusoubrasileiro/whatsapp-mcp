-- Initial multi-tenant schema for whatsapp-mcp.

-- Extensions for PT-BR full-text search (accent-insensitive, case-insensitive).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "expectedWaNumber" TEXT NOT NULL,
    "ntfyTopicUrl" TEXT,
    "writeToolsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "allowedWriteTools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "conversionKeywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'disconnected',
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chats" (
    "tenantId" TEXT NOT NULL,
    "jid" TEXT NOT NULL,
    "name" TEXT,
    "lastMessageTime" TIMESTAMP(3),

    CONSTRAINT "chats_pkey" PRIMARY KEY ("tenantId", "jid")
);

-- CreateTable
CREATE TABLE "messages" (
    "tenantId" TEXT NOT NULL,
    "chatJid" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "sender" TEXT,
    "content" TEXT,
    "isFromMe" BOOLEAN NOT NULL,
    "mediaType" TEXT,
    "mimetype" TEXT,
    "mediaKey" TEXT,
    "directPath" TEXT,
    "mediaUrl" TEXT,
    "fileLength" INTEGER,
    "fileSha256" TEXT,
    "fileEncSha256" TEXT,
    "mediaObjectKey" TEXT,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("tenantId", "chatJid", "id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "tenantId" TEXT NOT NULL,
    "jid" TEXT NOT NULL,
    "name" TEXT,
    "notify" TEXT,
    "phoneNumber" TEXT,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("tenantId", "jid")
);

-- CreateTable
CREATE TABLE "admin_users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chats_tenantId_lastMessageTime_idx" ON "chats" ("tenantId", "lastMessageTime" DESC);

-- CreateIndex
CREATE INDEX "messages_tenantId_timestamp_idx" ON "messages" ("tenantId", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "messages_tenantId_chatJid_timestamp_idx" ON "messages" ("tenantId", "chatJid", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "messages_tenantId_mediaType_idx" ON "messages" ("tenantId", "mediaType");

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users" ("email");

-- AddForeignKey
ALTER TABLE "chats" ADD CONSTRAINT "chats_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenantId_chatJid_fkey"
    FOREIGN KEY ("tenantId", "chatJid") REFERENCES "chats"("tenantId", "jid") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- FTS (PT-BR: accent-insensitive ILIKE via unaccent + trigram GIN).
-- Raw SQL — not expressible in Prisma schema.
--
-- `unaccent(text)` is STABLE, not IMMUTABLE, so it cannot be used directly
-- in an index expression. Wrap it in an IMMUTABLE SQL function to pin it
-- to the current dictionary — standard Postgres pattern.
CREATE OR REPLACE FUNCTION immutable_unaccent(text)
    RETURNS text AS $$
    SELECT unaccent('unaccent', $1)
$$ LANGUAGE SQL IMMUTABLE PARALLEL SAFE;

CREATE INDEX "messages_content_trgm_idx"
    ON "messages" USING GIN ("tenantId", immutable_unaccent(lower("content")) gin_trgm_ops);
