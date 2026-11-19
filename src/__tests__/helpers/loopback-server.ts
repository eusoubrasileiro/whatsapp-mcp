import http from "node:http";
import type { AddressInfo } from "node:net";

export interface Hit {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export type Route = (req: http.IncomingMessage, res: http.ServerResponse) => void;

export interface LoopbackServer {
  port: number;
  /** Every request received, in order, with its whole body. */
  hits: Hit[];
  /** Answers by exact request URL; anything else is a 404 "missing". */
  routes: Record<string, Route>;
  /** Empties `hits` and `routes` in place, so references taken earlier stay live. */
  reset(): void;
  close(): Promise<void>;
}

/** A real HTTP server on 127.0.0.1 standing in for a remote host. */
export async function startLoopbackServer(): Promise<LoopbackServer> {
  const hits: Hit[] = [];
  const routes: Record<string, Route> = {};
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, headers: req.headers, body });
      const route = routes[req.url ?? ""];
      if (route) route(req, res);
      else res.writeHead(404).end("missing");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    hits,
    routes,
    reset() {
      hits.length = 0;
      for (const url of Object.keys(routes)) delete routes[url];
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
