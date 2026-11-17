import type { ConnectionState } from "@amiticia/baileys-client";
import pino from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  connectionState: {} as ConnectionState,
  socketState: { socket: null as { user?: { id: string } } | null },
  startWhatsAppConnection: vi.fn(),
  toFile: vi.fn(),
}));

vi.mock("../whatsapp.ts", () => ({
  connectionState: h.connectionState,
  socketState: h.socketState,
  startWhatsAppConnection: h.startWhatsAppConnection,
}));
vi.mock("../actions.ts", () => ({ executeLogout: vi.fn() }));
vi.mock("qrcode", () => ({ default: { toFile: h.toFile } }));
// The QR branch opens the PNG in a desktop viewer; make sure no real one is ever launched.
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const { registerConnectionTools } = await import("../mcp/tools/connection.ts");

type Tool = { name: string; execute: () => Promise<string> };

function statusTool(identity?: { label: string; description?: string } | null): Tool {
  const registered: Record<string, Tool> = {};
  const logger = pino({ level: "silent" });
  registerConnectionTools(
    { addTool: ((t: Tool) => (registered[t.name] = t)) as never },
    { mcpLogger: logger, waLogger: logger, identity },
  );
  return registered.get_connection_status as Tool;
}

function setState(overrides: Partial<ConnectionState>): void {
  Object.assign(h.connectionState, {
    status: "disconnected",
    qrCode: null,
    qrAscii: null,
    user: null,
    syncProgress: { chats: 0, contacts: 0, messages: 0, lastBatchAt: null },
    ...overrides,
  });
}

beforeEach(() => {
  h.startWhatsAppConnection.mockReset().mockResolvedValue(undefined);
  h.toFile.mockReset().mockResolvedValue(undefined);
  h.socketState.socket = null;
  setState({});
});

describe("get_connection_status", () => {
  it("returns today's JSON, pretty-printed, when no identity is set", async () => {
    setState({ status: "connected", user: "Alice" });
    h.socketState.socket = { user: { id: "5500000000000:7@s.whatsapp.net" } };

    const text = await statusTool().execute();

    expect(text).toBe(
      JSON.stringify(
        { status: "connected", user: "Alice", message: "WhatsApp is connected and ready" },
        null,
        2,
      ),
    );
  });

  it("names the line and the paired phone number when an identity is set", async () => {
    setState({ status: "connected", user: "Alice" });
    h.socketState.socket = { user: { id: "5500000000000:7@s.whatsapp.net" } };

    const body = JSON.parse(
      await statusTool({ label: "empresa", description: "company" }).execute(),
    );

    expect(body).toStrictEqual({
      status: "connected",
      instance: { label: "empresa", description: "company" },
      phone_number: "5500000000000",
      user: "Alice",
      message: "WhatsApp is connected and ready",
    });
  });

  it("has no phone_number while the socket is not paired", async () => {
    setState({ status: "connecting" });
    h.socketState.socket = { user: undefined };

    const body = JSON.parse(await statusTool({ label: "empresa" }).execute());

    expect(body).toStrictEqual({
      status: "connecting",
      instance: { label: "empresa" },
      message: "Connecting to WhatsApp...",
    });
  });

  it("has no phone_number when there is no socket at all", async () => {
    setState({ status: "connecting" });

    const body = JSON.parse(await statusTool({ label: "empresa" }).execute());

    expect(body).not.toHaveProperty("phone_number");
  });

  it("saves the pending QR as a PNG and names the line that must scan it", async () => {
    setState({ status: "qr_pending", qrCode: "2@abc" });

    const body = JSON.parse(await statusTool({ label: "empresa" }).execute());

    expect(h.toFile).toHaveBeenCalledWith("/tmp/whatsapp-mcp-qr.png", "2@abc", { scale: 10 });
    expect(body.instance).toStrictEqual({ label: "empresa" });
    expect(body.qr_code_path).toBe("/tmp/whatsapp-mcp-qr.png");
    expect(h.startWhatsAppConnection).not.toHaveBeenCalled();
  });

  it("writes no QR PNG when no QR is pending", async () => {
    setState({ status: "connected" });

    await statusTool().execute();

    expect(h.toFile).not.toHaveBeenCalled();
  });

  it("starts a reconnect only when the socket is down", async () => {
    setState({ status: "disconnected" });
    await statusTool().execute();
    expect(h.startWhatsAppConnection).toHaveBeenCalledTimes(1);

    h.startWhatsAppConnection.mockClear();
    setState({ status: "connected" });
    await statusTool().execute();
    expect(h.startWhatsAppConnection).not.toHaveBeenCalled();
  });

  it("still answers when the reconnect attempt fails", async () => {
    h.startWhatsAppConnection.mockRejectedValue(new Error("boom"));
    setState({ status: "disconnected" });

    const body = JSON.parse(await statusTool().execute());

    expect(body.status).toBe("disconnected");
  });
});
