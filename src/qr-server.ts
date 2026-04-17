import http, { type Server } from "node:http";
import type { Logger } from "pino";
import QRCode from "qrcode";
import type { ConnectionState } from "@amiticia/baileys-client";

function renderHtml(state: ConnectionState): string {
  const { status, user, qrCode } = state;

  let body: string;
  if (status === "connected") {
    body = `<h1>Connected</h1><p>Linked as <code>${escapeHtml(user ?? "?")}</code>. You can close this tab.</p>`;
  } else if (status === "qr_pending" && qrCode) {
    body = `<h1>Scan QR with WhatsApp</h1>
      <img src="/qr.png" width="320" height="320" alt="WhatsApp QR" />
      <p>Settings &rarr; Linked Devices &rarr; Link a Device</p>`;
  } else if (status === "connecting" || status === "syncing") {
    body = `<h1>${status}...</h1><p>Please wait.</p>`;
  } else {
    body = `<h1>disconnected</h1><p>Waiting for WhatsApp socket to initialize...</p>`;
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta http-equiv="refresh" content="3" />
<title>WhatsApp MCP — ${status}</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 28rem; margin: 3rem auto; padding: 0 1rem; text-align: center; }
img { margin: 1rem auto; display: block; border: 1px solid #eee; padding: 0.5rem; background: #fff; }
code { background: #f3f3f3; padding: 0.1rem 0.3rem; border-radius: 3px; }
</style>
</head>
<body>
${body}
<hr />
<small>status: ${status}</small>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "\"": return "&quot;";
      case "'": return "&#39;";
      default: return c;
    }
  });
}

export function createQrServer(
  logger: Logger,
  getState: () => ConnectionState,
): Server {
  return http.createServer(async (req, res) => {
    const url = req.url ?? "/";
    const state = getState();

    try {
      if (url === "/health") {
        const body = JSON.stringify({
          status: state.status,
          user: state.user,
          syncProgress: state.syncProgress,
        });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(body);
        return;
      }

      if (url === "/qr.png") {
        if (state.status !== "qr_pending" || !state.qrCode) {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("no QR pending");
          return;
        }
        const png = await QRCode.toBuffer(state.qrCode, {
          errorCorrectionLevel: "M",
          width: 512,
          margin: 2,
        });
        res.writeHead(200, {
          "content-type": "image/png",
          "cache-control": "no-store",
        });
        res.end(png);
        return;
      }

      if (url === "/" || url === "/index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(renderHtml(state));
        return;
      }

      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    } catch (err) {
      logger.error({ err, url }, "qr-server request failed");
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("internal error");
      } else {
        res.end();
      }
    }
  });
}
