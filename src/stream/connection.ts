/**
 * Transport-agnostic drain driver for one `follow_chat` subscriber.
 *
 * The inbound bus is only a wake-up; the authoritative read is a DB delta since
 * this connection's rolling rowid cursor (exactly the `wait_for_messages`
 * model). On every wake we drain all new messages for the token's scope, build
 * one frame per message (hydrating voice notes with a transcript when the scope
 * asks for it), and hand each frame to `send`. The cursor is exclusive and
 * monotonic, so nothing is re-sent and nothing is lost — and the same drain,
 * run once on connect against a `?since=` cursor, is the reconnect gap-fill.
 *
 * Kept free of `ws`/DB imports so it unit-tests against fakes.
 */

import type { Logger } from "pino";
import type { Message } from "../database.ts";
import type { NewMessagesResult } from "../monitoring.ts";
import { buildStreamFrame, type StreamFrame } from "./frame.ts";
import type { StreamScope } from "./token.ts";

export interface ReadDeltaOpts {
  chatJids: string[] | null;
  since: string;
  includeFromMe: boolean;
  limit: number;
}

export interface StreamConnectionDeps {
  scope: StreamScope;
  /** Scope-filtered delta read (the real impl is `getNewMessagesCore`). */
  readDelta: (opts: ReadDeltaOpts) => NewMessagesResult;
  /** Resolve a display name for the sender (mirrors `formatDbMessageForJson`). */
  resolveSenderDisplay: (msg: Message) => string;
  /** Fetch + transcribe a voice note, or resolve null. Never throws. */
  transcribe: (msg: Message) => Promise<string | null>;
  /** Deliver one frame to the wire. */
  send: (frame: StreamFrame) => void;
  logger?: Logger;
  batchSize?: number;
}

const DEFAULT_BATCH = 50;

function isAudio(mediaType?: string | null): boolean {
  return mediaType === "audio" || mediaType === "ptt";
}

export class StreamConnection {
  /** Exclusive `row:<n>` cursor; public so the server can log/gap-fill from it. */
  cursor: string;
  private seq = 0;
  private draining = false;
  private redrain = false;
  private readonly deps: StreamConnectionDeps;
  private readonly batchSize: number;

  constructor(deps: StreamConnectionDeps, initialCursor: string) {
    this.deps = deps;
    this.cursor = initialCursor;
    this.batchSize = deps.batchSize ?? DEFAULT_BATCH;
  }

  /** Signal that new messages may exist. Coalesces concurrent wakes. */
  wake(): void {
    void this.drain();
  }

  /**
   * Drain every new message for this scope to the wire. Serialized: a wake that
   * lands mid-drain sets a re-run flag rather than starting a parallel drain, so
   * frames are always sent in cursor order exactly once.
   */
  async drain(): Promise<void> {
    if (this.draining) {
      this.redrain = true;
      return;
    }
    this.draining = true;
    try {
      let progressed: boolean;
      do {
        this.redrain = false;
        const prev = this.cursor;
        const res = this.deps.readDelta({
          chatJids: this.deps.scope.jids,
          since: prev,
          includeFromMe: this.deps.scope.includeFromMe,
          limit: this.batchSize,
        });

        for (const m of res.messages) {
          let transcription: string | null = null;
          if (this.deps.scope.transcribe && isAudio(m.media_type)) {
            transcription = await this.deps.transcribe(m);
          }
          this.deps.send(
            buildStreamFrame(m, ++this.seq, this.deps.resolveSenderDisplay(m), transcription),
          );
        }

        this.cursor = res.next_since;
        // If the cursor advanced we may have hit the batch limit with more rows
        // waiting (even when every fetched row was filtered out); keep going.
        progressed = res.next_since !== prev;
      } while (progressed || this.redrain);
    } catch (err) {
      this.deps.logger?.warn({ err }, "stream drain failed");
    } finally {
      this.draining = false;
    }
  }
}
