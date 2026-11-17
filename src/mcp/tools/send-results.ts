import { type InstanceIdentity, sentFromSuffix } from "../../instance-identity.ts";

/**
 * The success strings of `send_message` / `send_file`. With an identity they gain a trailing
 * ` Sent from the "<label>" line.`; without one they are exactly what they always were.
 */
export function formatMessageSent(
  target: string,
  messageId: string,
  identity: InstanceIdentity | null,
): string {
  return `Message sent successfully to ${target} (ID: ${messageId}).${sentFromSuffix(identity)}`;
}

export function formatFileSent(
  type: string,
  target: string,
  messageId: string,
  identity: InstanceIdentity | null,
): string {
  const shown = type.charAt(0).toUpperCase() + type.slice(1);
  return `${shown} sent successfully to ${target} (ID: ${messageId}).${sentFromSuffix(identity)}`;
}
