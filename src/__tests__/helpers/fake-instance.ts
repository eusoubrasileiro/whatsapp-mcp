import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import QRCode from "qrcode";

/** A real QR code image for `text`, as the instance's `/qr.png` would serve it. */
export function qrPng(text: string): Promise<Buffer> {
  return QRCode.toBuffer(text, { errorCorrectionLevel: "M", width: 512, margin: 2 });
}

/**
 * A stand-in for one whatsapp-mcp instance: just `GET /health` and `GET /qr.png`, the only two
 * things the hub ever asks. Everything it answers can be changed while the test runs.
 */
export interface FakeInstance {
  /** `http://127.0.0.1:<port>` */
  url: string;
  /** What `/health` answers next: the JSON body and the HTTP status. */
  setHealth(body: unknown, status?: number): void;
  /** The PNG `/qr.png` serves, or `null` for a 404 (nothing pending). */
  setQr(png: Buffer | null): void;
  /** While on, every request is accepted and never answered. */
  setHang(on: boolean): void;
  /** How many requests each path has received. */
  hits: { health: number; qr: number };
  close(): Promise<void>;
}

export async function startFakeInstance(
  health: unknown = { status: "connected" },
): Promise<FakeInstance> {
  let healthBody: unknown = health;
  let healthStatus = 200;
  let png: Buffer | null = null;
  let hang = false;
  const hits = { health: 0, qr: 0 };

  const server: Server = http.createServer((req, res) => {
    if (req.url === "/health") hits.health += 1;
    else if (req.url === "/qr.png") hits.qr += 1;
    if (hang) return;

    if (req.url === "/health") {
      res.writeHead(healthStatus, { "content-type": "application/json" });
      res.end(JSON.stringify(healthBody));
    } else if (req.url === "/qr.png" && png) {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(png);
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("no QR pending");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    setHealth(body, status = 200) {
      healthBody = body;
      healthStatus = status;
    },
    setQr(next) {
      png = next;
    },
    setHang(on) {
      hang = on;
    },
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** An address nothing listens on: connecting is refused at once. */
export async function deadAddress(): Promise<string> {
  const instance = await startFakeInstance();
  const { url } = instance;
  await instance.close();
  return url;
}
