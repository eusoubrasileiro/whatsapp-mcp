import {
  downloadMedia as baileysDownloadMedia,
  mimetypeToExtension,
  type DownloadMediaParams,
  type MediaType,
} from "@amiticia/baileys-client";
import pLimit from "p-limit";
import type P from "pino";

import type { TenantConnectionManager } from "./tenancy/manager.ts";

const downloadLimit = pLimit(2);

type DownloadMediaWrapperParams = {
  logger: P.Logger;
  manager: TenantConnectionManager;
  tenantId: string;
  mediaKey: string;
  directPath: string;
  mediaUrl: string | null;
  mediaType: MediaType;
  mimetype: string | null;
  chatJid: string;
  messageId: string;
  fromMe: boolean;
};

export async function downloadMedia(params: DownloadMediaWrapperParams): Promise<{ buffer: Buffer; mimetype: string; ext: string }> {
  const { logger, manager, tenantId, mediaKey, directPath, mediaUrl, mediaType, messageId, mimetype, chatJid, fromMe } = params;

  return downloadLimit(async () => {
    const tc = manager.get(tenantId);
    if (!tc) throw new Error(`Tenant ${tenantId} not found.`);
    const sock = tc.socket;
    if (!sock) throw new Error("Cannot download media: WhatsApp socket not connected.");

    logger.info({ messageId, mediaType, directPath }, "Downloading media");

    const downloadParams: DownloadMediaParams = {
      mediaKey,
      directPath,
      mediaUrl,
      mediaType,
      messageId,
      chatJid,
      fromMe,
    };

    const buffer = await baileysDownloadMedia(sock, downloadParams, logger);
    const resolvedMimetype = mimetype ?? "application/octet-stream";
    const ext = (mimetype && mimetypeToExtension[mimetype]) || "bin";

    logger.info({ messageId, size: buffer.length, ext }, "Media downloaded successfully");

    return { buffer, mimetype: resolvedMimetype, ext };
  });
}
