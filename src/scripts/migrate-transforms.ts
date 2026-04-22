export type SqliteChatRow = {
  jid: string;
  name: string | null;
  last_message_time: string | null;
};

export type SqliteMessageRow = {
  id: string;
  chat_jid: string;
  sender: string | null;
  content: string | null;
  timestamp: string;
  is_from_me: number;
  media_type: string | null;
  mimetype: string | null;
  media_key: string | null;
  direct_path: string | null;
  media_url: string | null;
  file_length: number | null;
  file_sha256: string | null;
  file_enc_sha256: string | null;
  media_object_key: string | null;
};

export type SqliteContactRow = {
  jid: string;
  name: string | null;
  notify: string | null;
  phone_number: string | null;
};

export function transformChat(tenantId: string, row: SqliteChatRow) {
  return {
    tenantId,
    jid: row.jid,
    name: row.name,
    lastMessageTime: row.last_message_time ? new Date(row.last_message_time) : null,
  };
}

export function transformMessage(tenantId: string, row: SqliteMessageRow) {
  return {
    tenantId,
    chatJid: row.chat_jid,
    id: row.id,
    timestamp: new Date(row.timestamp),
    sender: row.sender,
    content: row.content,
    isFromMe: row.is_from_me === 1,
    mediaType: row.media_type,
    mimetype: row.mimetype,
    mediaKey: row.media_key,
    directPath: row.direct_path,
    mediaUrl: row.media_url,
    fileLength: row.file_length,
    fileSha256: row.file_sha256,
    fileEncSha256: row.file_enc_sha256,
    mediaObjectKey: row.media_object_key,
  };
}

export function transformContact(tenantId: string, row: SqliteContactRow) {
  return {
    tenantId,
    jid: row.jid,
    name: row.name,
    notify: row.notify,
    phoneNumber: row.phone_number,
  };
}
