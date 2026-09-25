import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  initializeDatabase,
  type Message,
  resetDatabase,
  storeChat,
  storeMessage,
} from "../database.ts";
import { emitInbound, resetInboundBus, subscribeInbound } from "../inbound-bus.ts";
import { getNewMessagesCore } from "../monitoring.ts";
import { createStreamServer } from "../stream/server.ts";
import { createStreamTokenStore } from "../stream/token.ts";
import { markSentByUs, resetSentTracker } from "../webhooks/sent-tracker.ts";

const logger = pino({ level: "silent" });

function makeMsg(o: Partial<Message> & { id: string; chat_jid: string; content: string }): Message {
  return {
    timestamp: new Date("2026-07-02T14:58:20.000Z"),
    is_from_me: false,
    sender: "5511999999999@s.whatsapp.net",
    ...o,
  };
}

const openClients: WebSocket[] = [];

/** Open a client WS and collect JSON frames; resolves the socket once open. */
function connect(url: string): Promise<{ ws: WebSocket; frames: any[]; closed: Promise<number> }> {
  const ws = new WebSocket(url);
  openClients.push(ws);
  const frames: any[] = [];
  ws.addEventListener("message", (ev) => frames.push(JSON.parse(String(ev.data))));
  const closed = new Promise<number>((res) => ws.addEventListener("close", (ev) => res(ev.code)));
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve({ ws, frames, closed }));
    ws.addEventListener("error", () => reject(new Error("ws error")));
  });
}

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

describe("stream WS server", () => {
  let server: ReturnType<typeof createStreamServer>;
  let tokens: ReturnType<typeof createStreamTokenStore>;
  let baseWs: string;

  beforeEach(async () => {
    initializeDatabase(":memory:");
    resetInboundBus();
    resetSentTracker();
    storeChat({ jid: "g@g.us", name: "Project Group" });
    tokens = createStreamTokenStore({ ttlMs: 60_000 });
    server = createStreamServer({
      logger,
      tokens,
      readDelta: getNewMessagesCore,
      subscribe: subscribeInbound,
      transcribe: async () => "TRANSCRIPT",
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    baseWs = `ws://127.0.0.1:${port}/stream`;
  });

  afterEach(async () => {
    // Close any client sockets this test opened so the server can shut down.
    for (const ws of openClients.splice(0)) {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close();
    }
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    resetDatabase();
    resetInboundBus();
  });

  it("rejects the upgrade when the token is missing or invalid", async () => {
    await expect(connect(baseWs)).rejects.toThrow();
    await expect(connect(`${baseWs}?token=bogus`)).rejects.toThrow();
  });

  it("pushes one frame per live message in scope", async () => {
    const { token } = tokens.issue({ jids: ["g@g.us"], includeFromMe: true, transcribe: true });
    const { frames } = await connect(`${baseWs}?token=${token}`);

    storeMessage(makeMsg({ id: "a", chat_jid: "g@g.us", content: "Amei." }));
    emitInbound({ id: "a", chat_jid: "g@g.us", is_from_me: false });
    await tick();

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      id: "a",
      chat_jid: "g@g.us",
      content: "Amei.",
      chat_name: "Project Group",
    });
  });

  it("does not push messages outside the token's chat scope", async () => {
    storeChat({ jid: "other@g.us", name: "Other" });
    const { token } = tokens.issue({ jids: ["g@g.us"], includeFromMe: true, transcribe: true });
    const { frames } = await connect(`${baseWs}?token=${token}`);

    storeMessage(makeMsg({ id: "x", chat_jid: "other@g.us", content: "not for you" }));
    emitInbound({ id: "x", chat_jid: "other@g.us", is_from_me: false });
    await tick();

    expect(frames).toHaveLength(0);
  });

  it("gap-fills history since ?since= on connect (reconnect has no loss)", async () => {
    const { token } = tokens.issue({ jids: ["g@g.us"], includeFromMe: true, transcribe: true });

    // A message the client 'missed' while disconnected.
    storeMessage(makeMsg({ id: "missed", chat_jid: "g@g.us", content: "while you were gone" }));
    // Cursor the client held before it dropped (start-of-time → replays everything).
    const { frames } = await connect(`${baseWs}?token=${token}&since=row:0`);
    await tick();

    expect(frames.map((f) => f.id)).toEqual(["missed"]);
  });

  it("hydrates a voice note with its transcription", async () => {
    const { token } = tokens.issue({ jids: ["g@g.us"], includeFromMe: true, transcribe: true });
    const { frames } = await connect(`${baseWs}?token=${token}`);

    storeMessage(
      makeMsg({
        id: "v",
        chat_jid: "g@g.us",
        content: "",
        media_type: "ptt",
        mimetype: "audio/ogg",
      }),
    );
    emitInbound({ id: "v", chat_jid: "g@g.us", is_from_me: false });
    await tick();

    expect(frames[0].media).toMatchObject({ type: "ptt", transcription: "TRANSCRIPT" });
  });

  it("delivers the user's own phone reply (is_from_me) but never the agent's own send", async () => {
    const { token } = tokens.issue({ jids: ["g@g.us"], includeFromMe: true, transcribe: false });
    const { frames } = await connect(`${baseWs}?token=${token}`);

    // The user types from their own phone → is_from_me, must appear (persona mode).
    storeMessage(
      makeMsg({ id: "phone", chat_jid: "g@g.us", content: "eu respondo", is_from_me: true }),
    );
    emitInbound({ id: "phone", chat_jid: "g@g.us", is_from_me: true });
    // The agent's own MCP send echoes back as is_from_me → must be suppressed.
    markSentByUs("agent");
    storeMessage(
      makeMsg({ id: "agent", chat_jid: "g@g.us", content: "agent reply", is_from_me: true }),
    );
    emitInbound({ id: "agent", chat_jid: "g@g.us", is_from_me: true });
    await tick();

    expect(frames.map((f) => f.id)).toEqual(["phone"]);
    expect(frames[0].is_from_me).toBe(true);
  });

  it("unsubscribes from the bus when the socket closes", async () => {
    const { token } = tokens.issue({ jids: null, includeFromMe: true, transcribe: false });
    const { ws, closed } = await connect(`${baseWs}?token=${token}`);
    await tick();
    ws.close();
    await closed;
    await tick();
    // The connect-time listener must be gone.
    const { listenerCount } = await import("../inbound-bus.ts");
    expect(listenerCount()).toBe(0);
  });
});
