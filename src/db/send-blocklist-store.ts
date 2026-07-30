/**
 * Storage for recipients WhatsApp has permanently refused.
 *
 * Lives outside `database.ts` for the same reason `inbound-history.ts` does:
 * that file is frozen at its current size by the quality-gate ratchet, so new
 * queries land in focused modules instead of growing the monolith. Only the
 * `CREATE TABLE` for `send_blocklist` had to go there — SQLite has no migration
 * runner in this project, so the DDL and the schema declaration must agree.
 *
 * The policy that decides *what* to record lives in `../send-blocklist.ts`;
 * this module only reads and writes rows.
 */

import { inArray } from "drizzle-orm";

import { getDb } from "../database.ts";
import * as schema from "./schema.ts";

export type BlocklistEntry = {
  /** The canonical jid the refusal was recorded against. */
  jid: string;
  tenantId: string;
  /** Server refusal code — `463` in every case recorded today. */
  code: string | null;
  firstRefusedAt: string;
  lastRefusedAt: string;
  refusalCount: number;
  /** Whatever text the server attached, kept for forensics. */
  detail: string | null;
};

/** The two operations the policy needs, injectable so it is testable in isolation. */
export type BlocklistStore = {
  find: (jids: string[]) => BlocklistEntry | null;
  upsert: (entry: BlocklistEntry) => void;
};

/**
 * The recorded refusal for any of these jids, if there is one.
 *
 * Takes a list rather than a single jid because a contact is one identity across
 * several address forms: the caller passes the whole alias group, so a send
 * addressed by `@lid` still finds a refusal recorded against the phone jid.
 *
 * Throws when the database is unavailable — the caller decides which way to fail.
 */
export function findBlocklistEntry(jids: string[]): BlocklistEntry | null {
  if (jids.length === 0) return null;

  const row = getDb()
    .select()
    .from(schema.sendBlocklist)
    .where(inArray(schema.sendBlocklist.jid, jids))
    .limit(1)
    .get();

  return row ?? null;
}

/** Insert a refusal, or update the row already recorded for this jid. */
export function upsertBlocklistEntry(entry: BlocklistEntry): void {
  getDb()
    .insert(schema.sendBlocklist)
    .values(entry)
    .onConflictDoUpdate({
      target: schema.sendBlocklist.jid,
      // `first_refused_at` is deliberately absent: the first refusal is the
      // historical fact, and only the tail of the story changes.
      set: {
        code: entry.code,
        lastRefusedAt: entry.lastRefusedAt,
        refusalCount: entry.refusalCount,
        detail: entry.detail,
      },
    })
    .run();
}

/** The real store, used unless a test injects its own. */
export const blocklistStore: BlocklistStore = {
  find: findBlocklistEntry,
  upsert: upsertBlocklistEntry,
};
