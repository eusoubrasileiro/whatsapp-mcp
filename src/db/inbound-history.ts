/**
 * Inbound-history reads for the send path.
 *
 * Lives outside `database.ts` on purpose. That file is frozen at its current
 * size by the quality-gate ratchet (splitting it is separate work with its own
 * tests — see CLAUDE.md "What We Won't Build"), so new queries land in focused
 * modules like this one rather than growing the monolith.
 */

import { and, eq, inArray } from "drizzle-orm";

import { getAliasGroup, getDb } from "../database.ts";
import * as schema from "./schema.ts";

/**
 * Has this contact ever sent us anything?
 *
 * Backs the cold-contact send guard: a first-ever outbound to someone who has
 * never messaged you is, per WhatsApp's reach-out policy, the most reliable way
 * to get an account restricted. `false` means no inbound message has ever been
 * stored for this chat under ANY of its JID forms — the alias group is resolved
 * first so a PN→LID upgrade cannot turn an established chat back into a cold
 * first contact.
 *
 * Fails **safe**: a query error returns `false` (read as cold → the send is
 * refused) rather than waving an unverified reach-out through.
 */
export function hasInboundMessage(chatJid: string): boolean {
  try {
    const row = getDb()
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(
        and(
          inArray(schema.messages.chatJid, getAliasGroup(chatJid)),
          eq(schema.messages.isFromMe, false),
        ),
      )
      .limit(1)
      .get();

    return row !== undefined;
  } catch {
    return false;
  }
}
