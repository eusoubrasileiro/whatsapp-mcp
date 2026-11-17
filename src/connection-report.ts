import type { ConnectionState } from "@amiticia/baileys-client";
import { type InstanceIdentity, pairedPhoneDigits } from "./instance-identity.ts";

/** Where `get_connection_status` saves the pending QR code as a PNG. */
export const QR_PNG_PATH = "/tmp/whatsapp-mcp-qr.png";

/** A QR code is waiting for a scan and the PNG can be written. */
export function isQrReady<S extends Pick<ConnectionState, "status" | "qrCode">>(
  state: S,
): state is S & { qrCode: string } {
  return state.status === "qr_pending" && Boolean(state.qrCode);
}

export type ConnectionReport = {
  /** What `get_connection_status` returns, as JSON. */
  body: Record<string, unknown>;
  /** The socket is down: the tool should start a (lazy) reconnect. */
  reconnect: boolean;
};

/**
 * The shape of `get_connection_status`, as a pure function of the connection state.
 *
 * Without an identity the body is exactly what the tool always returned. With one it gains
 * `instance` (every branch, so an agent waiting on a scan knows which phone must scan) and,
 * when the socket has a paired phone-number id, `phone_number` (digits only). Both go right
 * after `status`.
 */
export function buildConnectionReport(
  state: ConnectionState,
  options: {
    identity: InstanceIdentity | null;
    /** `socket.user.id` of the paired account, when there is one. */
    pairedId?: string | null;
    now: number;
  },
): ConnectionReport {
  const { body, reconnect } = describeState(state, options.now);
  const { identity } = options;
  if (!identity) return { body, reconnect };

  const { status, ...rest } = body;
  const phone = pairedPhoneDigits(options.pairedId);
  return {
    body: {
      status,
      instance: { ...identity },
      ...(phone ? { phone_number: phone } : {}),
      ...rest,
    },
    reconnect,
  };
}

function describeState(state: ConnectionState, now: number): ConnectionReport {
  if (isQrReady(state)) {
    return {
      body: {
        status: "qr_pending",
        qr_code_path: QR_PNG_PATH,
        message:
          "QR code saved (and opened if a desktop session is available). Scan with WhatsApp mobile (Settings > Linked Devices), or open the QR web page. Call this tool again after scanning.",
      },
      reconnect: false,
    };
  }

  const body: Record<string, unknown> = { status: state.status };
  if (state.user) body.user = state.user;

  if (state.status === "connected") {
    body.message = "WhatsApp is connected and ready";
  } else if (state.status === "syncing") {
    body.message = "WhatsApp is connected but syncing history. Some operations may fail.";
    body.sync_progress = {
      chats: state.syncProgress.chats,
      contacts: state.syncProgress.contacts,
      messages: state.syncProgress.messages,
      last_batch_ago_seconds: state.syncProgress.lastBatchAt
        ? Math.round((now - state.syncProgress.lastBatchAt.getTime()) / 1000)
        : null,
    };
  } else if (state.status === "connecting") {
    body.message = "Connecting to WhatsApp...";
  } else {
    body.message = "WhatsApp is disconnected. Attempting to reconnect...";
    return { body, reconnect: true };
  }
  return { body, reconnect: false };
}
