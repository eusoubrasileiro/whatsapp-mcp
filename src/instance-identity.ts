/**
 * Which WhatsApp line is this server?
 *
 * One deployment can run several instances of this server, one per WhatsApp number. With
 * identical names and instructions an agent cannot tell them apart, and one slip sends a
 * personal message from the company line. Two optional env vars name the line; everything an
 * agent or the operator looks at (server instructions, `get_connection_status`, send results,
 * ntfy pushes, the QR page) then carries it.
 *
 * The identity exists only when `INSTANCE_LABEL` is non-empty after normalisation. Without it
 * every output is byte-identical to a server that never heard of this module.
 */

export type InstanceIdentity = {
  /** Short slug naming the line, e.g. `empresa`. Always `[a-z0-9-]`, 1 to 32 characters. */
  label: string;
  /** One line of plain words, at most 200 characters. Absent when not set. */
  description?: string;
};

const LABEL_MAX = 32;
const DESCRIPTION_MAX = 200;

function normalizeLabel(raw: string | undefined): string {
  return (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, LABEL_MAX);
}

function normalizeDescription(raw: string | undefined): string {
  return (raw ?? "").replace(/\s+/g, " ").trim().slice(0, DESCRIPTION_MAX);
}

/**
 * The identity from `INSTANCE_LABEL` / `INSTANCE_DESCRIPTION`, or `null` when no usable label
 * is set (unset, empty, or nothing left after normalisation). The description is ignored
 * without a label. Read once at startup and passed down, never re-read per call.
 */
export function readInstanceIdentity(
  env: Record<string, string | undefined> = process.env,
): InstanceIdentity | null {
  const label = normalizeLabel(env.INSTANCE_LABEL);
  if (!label) return null;
  const description = normalizeDescription(env.INSTANCE_DESCRIPTION);
  return description ? { label, description } : { label };
}

/**
 * The paragraph that opens the server instructions. Model-facing wording, ratified by the
 * owner: change it only on purpose.
 */
export function identityParagraph(identity: InstanceIdentity): string {
  const { label, description } = identity;
  const head = description
    ? `THIS SERVER IS ONE WHATSAPP LINE — "${label}": ${description}`
    : `THIS SERVER IS ONE WHATSAPP LINE — "${label}".`;
  return (
    `${head}\n` +
    "Every tool here reads and sends as this line only. Any other WhatsApp number is a " +
    "different MCP server with its own tools, chats and message IDs — nothing carries " +
    `over between them. Before you send, check that "${label}" is the line the user means; ` +
    "get_connection_status reports the line and its paired phone number."
  );
}

/** What a send result appends after today's sentence. Empty without an identity. */
export function sentFromSuffix(identity: InstanceIdentity | null): string {
  return identity ? ` Sent from the "${identity.label}" line.` : "";
}

/** `<digits>` or `<digits>:<device>`, on the phone-number server only. */
const PHONE_JID = /^(\d+)(?::\d+)?@s\.whatsapp\.net$/;

/**
 * The paired phone number's digits, read off the socket's own phone-number JID (the part
 * before `:` or `@`). Nothing is built or normalised: a LID or any other id yields
 * `undefined`, because its digits are not a phone number.
 */
export function pairedPhoneDigits(socketUserId: string | null | undefined): string | undefined {
  return socketUserId?.match(PHONE_JID)?.[1];
}
