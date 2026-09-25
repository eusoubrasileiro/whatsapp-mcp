/**
 * WebSocket surface for `follow_chat`. One socket = one present agent watching a
 * scoped set of chats; each JSON frame the server pushes is one inbound message,
 * designed to be attached to a harness background monitor (Claude Code
 * `Monitor({ws:{url}})`) so the agent is woken per message while it keeps
 * working — the presence half of the persona pattern the pull tools couldn't
 * serve (see docs/agent-presence-stream-recipe.md).
 *
 * Auth: the token rides the query string (WS clients can't set headers from a
 * background monitor) and is verified at the HTTP `upgrade` — a bad/expired
 * token is rejected before the socket is established. Tokens are log-redacted.
 *
 * Fan-out reuses the same DB-delta + inbound-bus model as `wait_for_messages`
 * via {@link StreamConnection}: the bus wakes the socket, the DB delta is the
 * source of truth, and `?since=` gap-fills on reconnect.
 */

import http, { type Server } from "node:http";
import type { Duplex } from "node:stream";
import type { Logger } from "pino";
import { type WebSocket, WebSocketServer } from "ws";
import { getContactName, type Message } from "../database.ts";
import { subscribeInbound } from "../inbound-bus.ts";
import { getNewMessagesCore, type NewMessagesResult, resolveStartCursor } from "../monitoring.ts";
import { StreamConnection } from "./connection.ts";
import type { StreamScope, StreamTokenStore } from "./token.ts";

export interface StreamServerDeps {
  logger: Logger;
  tokens: StreamTokenStore;
  /** HTTP path the WS lives on (default "/stream"). */
  path?: string;
  /** Scope-filtered delta read (default `getNewMessagesCore`). */
  readDelta?: (opts: {
    chatJids: string[] | null;
    since: string;
    includeFromMe: boolean;
    limit: number;
  }) => NewMessagesResult;
  /** Long-lived inbound subscription (default `subscribeInbound`). */
  subscribe?: (listener: () => void) => () => void;
  /** Voice-note transcription, injected from main (bound to the WA logger). */
  transcribe?: (msg: Message) => Promise<string | null>;
}

const DEFAULT_PATH = "/stream";

/** Sender display name, mirroring `formatDbMessageForJson` (src/formatters.ts). */
function resolveSenderDisplay(msg: Message): string {
  const name = msg.sender ? getContactName(msg.sender) : null;
  return (
    name ?? (msg.sender ? msg.sender.split("@")[0] : null) ?? (msg.is_from_me ? "Me" : "Unknown")
  );
}

export function createStreamServer(deps: StreamServerDeps): Server {
  const path = deps.path ?? DEFAULT_PATH;
  const readDelta = deps.readDelta ?? getNewMessagesCore;
  const subscribe = deps.subscribe ?? subscribeInbound;
  const transcribe = deps.transcribe ?? (async () => null);
  const { logger, tokens } = deps;

  const wss = new WebSocketServer({ noServer: true });

  const server = http.createServer((_req, res) => {
    // The only thing on this port is the WS upgrade.
    res.writeHead(426, { "content-type": "text/plain" });
    res.end("upgrade required");
  });

  server.on("upgrade", (req, socket: Duplex, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== path) {
      socket.destroy();
      return;
    }

    const token = url.searchParams.get("token");
    const scope = token ? tokens.verify(token) : null;
    if (!scope) {
      // Never echo the token back.
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const since = url.searchParams.get("since");
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleConnection(ws, scope, since);
    });
  });

  function handleConnection(ws: WebSocket, scope: StreamScope, since: string | null): void {
    // Pin the starting cursor once (from-now → current high-water mark).
    const initialCursor = resolveStartCursor(since ?? null);

    const conn = new StreamConnection(
      {
        scope,
        readDelta,
        resolveSenderDisplay,
        transcribe,
        send: (frame) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
        },
        logger,
      },
      initialCursor,
    );

    // Lost-wakeup pattern (as in waitForMessagesCore): subscribe FIRST so a
    // message persisted after this point wakes us, THEN drain once to catch
    // anything persisted before the subscribe (and to replay the ?since= gap).
    const unsubscribe = subscribe(() => conn.wake());
    void conn.drain();

    const cleanup = (): void => unsubscribe();
    ws.on("close", cleanup);
    ws.on("error", cleanup);

    logger.info(
      { jids: scope.jids ?? "all", includeFromMe: scope.includeFromMe, cursor: initialCursor },
      "follow_chat stream connected",
    );
  }

  return server;
}
