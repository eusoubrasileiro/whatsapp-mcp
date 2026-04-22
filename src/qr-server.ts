import http, { type Server } from "node:http";
import type { Logger } from "pino";
import QRCode from "qrcode";
import type { TenantConnectionManager } from "./tenancy/manager.ts";

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

function statusBadge(status: string): string {
  const colors: Record<string, string> = {
    connected: "#22c55e",
    syncing: "#eab308",
    connecting: "#3b82f6",
    qr_pending: "#f97316",
    disconnected: "#ef4444",
  };
  const color = colors[status] ?? "#6b7280";
  return `<span style="display:inline-block;padding:0.15rem 0.5rem;border-radius:9999px;background:${color};color:#fff;font-size:0.8rem;">${escapeHtml(status)}</span>`;
}

function renderOverviewHtml(manager: TenantConnectionManager): string {
  const tenants = manager.list();
  const snapshot = manager.statusSnapshot();
  const connected = snapshot.filter((s) => s.status === "connected").length;

  let rows = "";
  for (const s of snapshot) {
    rows += `<tr>
      <td><a href="/t/${escapeHtml(s.id)}/">${escapeHtml(s.displayName)}</a></td>
      <td>${statusBadge(s.status)}</td>
      <td>${s.hasQr ? `<a href="/t/${escapeHtml(s.id)}/qr.png">QR</a>` : "-"}</td>
    </tr>`;
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta http-equiv="refresh" content="5" />
<title>WhatsApp MCP -- ${connected}/${tenants.length} connected</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; }
table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
th, td { padding: 0.5rem; text-align: left; border-bottom: 1px solid #eee; }
a { color: #2563eb; text-decoration: none; }
</style>
</head>
<body>
<h1>WhatsApp MCP</h1>
<p>${connected} of ${tenants.length} tenant(s) connected.</p>
<table>
<thead><tr><th>Tenant</th><th>Status</th><th>QR</th></tr></thead>
<tbody>${rows}</tbody>
</table>
</body>
</html>`;
}

function renderTenantHtml(tenantId: string, manager: TenantConnectionManager): string {
  const tc = manager.get(tenantId);
  if (!tc) {
    return `<!doctype html><html><body><h1>Tenant not found</h1></body></html>`;
  }

  const state = tc.connectionState;
  const { status, user, qrCode } = state;

  let body: string;
  if (status === "connected") {
    body = `<h1>${escapeHtml(tc.displayName)} - Connected</h1><p>Linked as <code>${escapeHtml(user ?? "?")}</code>. You can close this tab.</p>`;
  } else if (status === "qr_pending" && qrCode) {
    body = `<h1>${escapeHtml(tc.displayName)} - Scan QR</h1>
      <img src="/t/${escapeHtml(tenantId)}/qr.png" width="320" height="320" alt="WhatsApp QR" />
      <p>Settings &rarr; Linked Devices &rarr; Link a Device</p>`;
  } else if (status === "connecting" || status === "syncing") {
    body = `<h1>${escapeHtml(tc.displayName)} - ${escapeHtml(status)}...</h1><p>Please wait.</p>`;
  } else {
    body = `<h1>${escapeHtml(tc.displayName)} - disconnected</h1><p>Waiting for socket to initialize...</p>`;
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta http-equiv="refresh" content="3" />
<title>WhatsApp MCP -- ${escapeHtml(tc.displayName)}</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 28rem; margin: 3rem auto; padding: 0 1rem; text-align: center; }
img { margin: 1rem auto; display: block; border: 1px solid #eee; padding: 0.5rem; background: #fff; }
code { background: #f3f3f3; padding: 0.1rem 0.3rem; border-radius: 3px; }
</style>
</head>
<body>
${body}
<hr />
<p><a href="/">Back to overview</a></p>
<small>status: ${escapeHtml(status)}</small>
</body>
</html>`;
}

export function createQrServer(
  logger: Logger,
  manager: TenantConnectionManager,
): Server {
  const internalToken = process.env.WHATSAPP_MCP_INTERNAL_TOKEN;

  return http.createServer(async (req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    try {
      // Health endpoint
      if (url === "/health") {
        const snapshot = manager.statusSnapshot();
        const connected = snapshot.filter((s) => s.status === "connected").length;
        const body = JSON.stringify({
          status: connected > 0 ? "ok" : "degraded",
          connected,
          total: snapshot.length,
          tenants: snapshot,
        });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(body);
        return;
      }

      // Tenants JSON endpoint
      if (url === "/tenants") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(manager.statusSnapshot()));
        return;
      }

      // Internal API: POST /internal/tenants/:id/start or /stop
      const internalMatch = url.match(/^\/internal\/tenants\/([^/]+)\/(start|stop)$/);
      if (internalMatch && method === "POST") {
        if (!internalToken) {
          res.writeHead(503, { "content-type": "text/plain" });
          res.end("WHATSAPP_MCP_INTERNAL_TOKEN not configured");
          return;
        }
        const auth = req.headers.authorization;
        if (!auth || auth !== `Bearer ${internalToken}`) {
          res.writeHead(401, { "content-type": "text/plain" });
          res.end("unauthorized");
          return;
        }
        const [, tenantId, action] = internalMatch;
        try {
          if (action === "start") {
            await manager.start(tenantId);
          } else {
            manager.stop(tenantId);
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, tenantId, action }));
        } catch (err: any) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // Per-tenant QR PNG
      const qrMatch = url.match(/^\/t\/([^/]+)\/qr\.png$/);
      if (qrMatch) {
        const tenantId = qrMatch[1];
        const tc = manager.get(tenantId);
        if (!tc || tc.connectionState.status !== "qr_pending" || !tc.connectionState.qrCode) {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("no QR pending");
          return;
        }
        const png = await QRCode.toBuffer(tc.connectionState.qrCode, {
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

      // Per-tenant HTML page
      const tenantMatch = url.match(/^\/t\/([^/]+)\/?$/);
      if (tenantMatch) {
        const tenantId = tenantMatch[1];
        const html = renderTenantHtml(tenantId, manager);
        const status = manager.get(tenantId) ? 200 : 404;
        res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      // Overview page
      if (url === "/" || url === "/index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(renderOverviewHtml(manager));
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
