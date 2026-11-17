/**
 * Every word the hub shows a person, in one table. A second language is a second table with the
 * same shape; the templates and the page script take the table as an argument.
 *
 * `{name}` marks a value filled in at render time.
 */
export const en = {
  title: "WhatsApp numbers",
  liveNote: "This page updates by itself.",
  offline: "Lost contact with the hub. Trying again…",
  states: {
    connected: "Connected",
    waiting_qr: "Waiting for you to scan the QR code",
    starting: "Connecting…",
    disconnected: "Disconnected",
    down: "Down for {duration}",
    mismatch: "Misconfigured: this address answers as another number",
  },
  durations: {
    lessThanMinute: "less than a minute",
    minutes: "{n} min",
    hoursMinutes: "{h} h {m} min",
  },
  numberEnding: "number ending {last4}",
  scan: {
    withDigits:
      'Pick up the phone for "{label}" (number ending {last4}) and scan this code: WhatsApp → Settings → Linked devices → Link a device.',
    withoutDigits:
      'Pick up the phone for "{label}" and scan this code: WhatsApp → Settings → Linked devices → Link a device.',
    imageAlt: 'QR code to link the WhatsApp number "{label}"',
  },
  unknownLabel: 'There is no number called "{label}". These are the numbers this hub shows.',
  pin: {
    title: "Enter the PIN",
    field: "PIN",
    submit: "Open",
    wrong: "That PIN did not work.",
    lockedTitle: "Too many wrong PINs",
    locked: "Try again later.",
  },
};

type Widen<T> = { [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };

export type Strings = Widen<typeof en>;

/** Fills the `{name}` markers of a template. Unknown markers are left as written. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (marker, name: string) =>
    name in values ? String(values[name]) : marker,
  );
}
