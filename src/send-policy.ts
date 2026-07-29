/**
 * The one entry point the sending tools call before handing bytes to Baileys.
 *
 * Composes the anti-restriction guards in the only order that is safe:
 *
 *   1. cold-contact — the cheapest refusal, and the one that must not cost
 *      anything. Running it first means a send that is about to be refused never
 *      burns a rate-limit slot or a typing pause.
 *   2. pacing — the account-wide gap and rolling caps.
 *   3. typing — cosmetic, text only, last so the "typing…" indicator is adjacent
 *      to the message rather than separated from it by a pacing wait.
 *
 * Keeping the composition here rather than in the FastMCP tool bodies is the
 * convention `send-guard.ts` set: policy stays testable without FastMCP.
 */

import type { Logger } from "pino";

import { assertNotColdContact } from "./cold-contact.ts";
import { applySendPacing } from "./send-pacer.ts";
import { type PresenceSocket, simulateTyping } from "./send-typing.ts";

type Env = Record<string, string | undefined>;

export type SendPolicyInput = {
  socket: PresenceSocket;
  /** The JID actually being sent to — i.e. after any PN→LID upgrade. */
  jid: string;
  logger: Logger;
  /** Text sends get a typing simulation; media does not. */
  isText: boolean;
  text?: string;
  allowCold?: boolean;
  /** The connected account's own JIDs, so its self-chat is never read as cold. */
  ownJids?: string[];
  env?: Env;
  hasInbound?: (chatJid: string) => boolean;
  /** All JID forms of one identity — injected for tests; defaults to the alias table. */
  aliasesOf?: (jid: string) => string[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

/** Run every pre-send guard. Throws — and sends nothing — when one refuses. */
export async function applySendPolicy(input: SendPolicyInput): Promise<void> {
  const { env, sleep, random } = input;

  assertNotColdContact(input.jid, {
    env,
    allowCold: input.allowCold,
    ownJids: input.ownJids,
    hasInbound: input.hasInbound,
    aliasesOf: input.aliasesOf,
  });

  await applySendPacing({ env, sleep, random, now: input.now });

  if (input.isText) {
    await simulateTyping(input.socket, input.jid, input.text ?? "", input.logger, {
      env,
      sleep,
      random,
    });
  }
}
