import { type SQL, sql } from "drizzle-orm";

/**
 * The name a chat is shown under: its own name, else its contact's.
 *
 * WhatsApp sends no chat name for a 1:1 LID chat, so `chats.name` stays NULL
 * for good while the owner's address book (`name`) and the sender's push name
 * (`notify`) land in `contacts`. Without this every such chat read back as a
 * bare LID and its messages as "Unknown Chat" (2026-11-18: 162 of 163 chats on
 * the "empresa" line, with 434 contacts named).
 *
 * The contact may sit on the chat's own JID or on an alias twin (PN ↔ LID).
 * A row on the chat's own JID wins, then one with an address-book name. The
 * phone number is the last resort, shown bare (it is stored as a PN JID). A
 * group keeps its subject because `chats.name` is set for groups.
 *
 * The columns are spelled `chats.jid` / `chats.name` on purpose: Drizzle
 * renders a column of a single-table query unqualified (`"jid"`), and inside
 * this subquery an unqualified `jid` binds to `contacts`, which matched every
 * contact to every chat. Use it only in queries over the un-aliased `chats`.
 */
export function chatDisplayName(): SQL<string | null> {
  return sql<string | null>`COALESCE(NULLIF(chats.name, ''), (
    SELECT COALESCE(
      NULLIF(k.name, ''),
      NULLIF(k.notify, ''),
      NULLIF(REPLACE(k.phone_number, '@s.whatsapp.net', ''), '')
    )
    FROM contacts k
    WHERE k.jid = chats.jid
       OR k.jid IN (SELECT a.jid FROM jid_aliases a WHERE a.canonical_jid = chats.jid)
    ORDER BY (k.jid <> chats.jid), (k.name IS NULL OR k.name = '')
    LIMIT 1
  ))`;
}
