import { describe, it, expect, vi } from "vitest";

import { StreamConnection } from "../stream/connection.ts";
import type { Message } from "../database.ts";
import type { NewMessagesResult } from "../monitoring.ts";

function msg(o: Partial<Message> & { id: string; content: string }): Message {
  return {
    chat_jid: "g@g.us",
    timestamp: new Date("2026-07-02T14:58:20.000Z"),
    is_from_me: false,
    sender: "5511999999999@s.whatsapp.net",
    chat_name: "AmiticIA AutoSys",
    ...o,
  };
}

/**
 * Fake delta backend: a rowid-keyed log the test appends to, read with the same
 * `{ messages, next_since }` contract getNewMessagesCore exposes. Cursor is
 * `row:<n>` (exclusive), matching the real cursor semantics.
 */
function fakeDelta(rows: Array<{ rowid: number; m: Message; fromMe?: boolean }>) {
  return (opts: { since: string; limit: number }): NewMessagesResult => {
    const after = opts.since.startsWith("row:") ? Number(opts.since.slice(4)) : 0;
    const fresh = rows.filter((r) => r.rowid > after).sort((a, b) => a.rowid - b.rowid);
    const batch = fresh.slice(0, opts.limit);
    const maxFetched = batch.length ? batch[batch.length - 1].rowid : after;
    return {
      messages: batch.filter((r) => !r.fromMe).map((r) => r.m), // filtered like the real core
      next_since: `row:${maxFetched}`,
    };
  };
}

function makeConn(rows: Parameters<typeof fakeDelta>[0], overrides = {}) {
  const sent: unknown[] = [];
  const conn = new StreamConnection({
    scope: { jids: null, includeFromMe: true, transcribe: true },
    readDelta: fakeDelta(rows),
    resolveSenderDisplay: () => "Beatriz",
    transcribe: async () => "TRANSCRIPT",
    send: (f) => sent.push(f),
    ...overrides,
  }, "row:0");
  return { conn, sent };
}

describe("StreamConnection", () => {
  it("drains all messages since the cursor as one frame each, advancing seq", async () => {
    const { conn, sent } = makeConn([
      { rowid: 1, m: msg({ id: "a", content: "one" }) },
      { rowid: 2, m: msg({ id: "b", content: "two" }) },
    ]);
    await conn.drain();
    expect(sent.map((f: any) => [f.seq, f.id])).toEqual([[1, "a"], [2, "b"]]);
    expect(conn.cursor).toBe("row:2");
  });

  it("does not re-send on a second drain with nothing new", async () => {
    const { conn, sent } = makeConn([{ rowid: 1, m: msg({ id: "a", content: "one" }) }]);
    await conn.drain();
    await conn.drain();
    expect(sent).toHaveLength(1);
  });

  it("hydrates a voice note with a transcription in the media block", async () => {
    const { conn, sent } = makeConn([
      { rowid: 1, m: msg({ id: "v", content: "", media_type: "ptt", mimetype: "audio/ogg" }) },
    ]);
    await conn.drain();
    expect((sent[0] as any).media).toMatchObject({ type: "ptt", transcription: "TRANSCRIPT" });
  });

  it("does not transcribe when the scope disables it", async () => {
    const transcribe = vi.fn(async () => "X");
    const { conn, sent } = makeConn(
      [{ rowid: 1, m: msg({ id: "v", content: "", media_type: "ptt" }) }],
      { scope: { jids: null, includeFromMe: true, transcribe: false }, transcribe },
    );
    await conn.drain();
    expect(transcribe).not.toHaveBeenCalled();
    expect((sent[0] as any).media.transcription).toBeNull();
  });

  it("advances past filtered-out rows so it never re-scans them", async () => {
    // rowid 1 is the agent's own send (filtered by readDelta); rowid 2 is real.
    const { conn, sent } = makeConn([
      { rowid: 1, m: msg({ id: "mine", content: "x", is_from_me: true }), fromMe: true },
      { rowid: 2, m: msg({ id: "real", content: "hi" }) },
    ]);
    await conn.drain();
    expect(sent.map((f: any) => f.id)).toEqual(["real"]);
    expect(conn.cursor).toBe("row:2"); // advanced past the filtered row 1 too
  });

  it("drains across multiple batches when more than one limit's worth is waiting", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ rowid: i + 1, m: msg({ id: `m${i + 1}`, content: "x" }) }));
    const { conn, sent } = makeConn(rows, { batchSize: 2 });
    await conn.drain();
    expect(sent.map((f: any) => f.id)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
  });

  it("coalesces a wake that arrives mid-drain instead of running twice", async () => {
    let calls = 0;
    const rows = [{ rowid: 1, m: msg({ id: "a", content: "one" }) }];
    const conn = new StreamConnection({
      scope: { jids: null, includeFromMe: true, transcribe: false },
      readDelta: (opts) => { calls++; return fakeDelta(rows)(opts); },
      resolveSenderDisplay: () => "R",
      transcribe: async () => null,
      send: () => { conn.wake(); }, // re-entrant wake during send
    }, "row:0");
    await conn.drain();
    // The mid-drain wake causes exactly one extra empty re-scan, not a parallel drain.
    expect(calls).toBe(2);
  });
});
