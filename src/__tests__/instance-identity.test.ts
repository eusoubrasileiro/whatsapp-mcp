import { afterEach, describe, expect, it, vi } from "vitest";
import {
  identityParagraph,
  pairedPhoneDigits,
  phoneLast4,
  readInstanceIdentity,
  sentFromSuffix,
} from "../instance-identity.ts";

describe("readInstanceIdentity", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is null when no label is set", () => {
    expect(readInstanceIdentity({})).toBeNull();
  });

  it("is null for an empty or whitespace-only label", () => {
    expect(readInstanceIdentity({ INSTANCE_LABEL: "" })).toBeNull();
    expect(readInstanceIdentity({ INSTANCE_LABEL: "   \n\t " })).toBeNull();
  });

  it("is null for a label that normalises to nothing", () => {
    expect(readInstanceIdentity({ INSTANCE_LABEL: "!!! ???" })).toBeNull();
    expect(readInstanceIdentity({ INSTANCE_LABEL: "---" })).toBeNull();
    expect(readInstanceIdentity({ INSTANCE_LABEL: "çãé" })).toBeNull();
  });

  it("is null when only a description is set", () => {
    expect(readInstanceIdentity({ INSTANCE_DESCRIPTION: "company line" })).toBeNull();
  });

  it("returns the label alone when there is no description", () => {
    expect(readInstanceIdentity({ INSTANCE_LABEL: "empresa" })).toStrictEqual({
      label: "empresa",
    });
  });

  it("trims and lowercases the label", () => {
    expect(readInstanceIdentity({ INSTANCE_LABEL: "  EmPresa  " })?.label).toBe("empresa");
  });

  it("turns each run of characters outside [a-z0-9-] into one hyphen", () => {
    expect(readInstanceIdentity({ INSTANCE_LABEL: "Minha Empresa Ltda" })?.label).toBe(
      "minha-empresa-ltda",
    );
    expect(readInstanceIdentity({ INSTANCE_LABEL: "a  _. b" })?.label).toBe("a-b");
    expect(readInstanceIdentity({ INSTANCE_LABEL: "a<b>c" })?.label).toBe("a-b-c");
  });

  it("keeps hyphens and digits that are already in the label", () => {
    expect(readInstanceIdentity({ INSTANCE_LABEL: "line-2" })?.label).toBe("line-2");
  });

  it("drops leading and trailing hyphens", () => {
    expect(readInstanceIdentity({ INSTANCE_LABEL: "--empresa--" })?.label).toBe("empresa");
    expect(readInstanceIdentity({ INSTANCE_LABEL: " !empresa! " })?.label).toBe("empresa");
  });

  it("cuts the label to 32 characters, and no further", () => {
    expect(readInstanceIdentity({ INSTANCE_LABEL: "a".repeat(32) })?.label).toBe("a".repeat(32));
    expect(readInstanceIdentity({ INSTANCE_LABEL: "a".repeat(33) })?.label).toBe("a".repeat(32));
    expect(readInstanceIdentity({ INSTANCE_LABEL: "b".repeat(80) })?.label).toBe("b".repeat(32));
  });

  it("collapses whitespace runs in the description, newlines included, and trims", () => {
    const identity = readInstanceIdentity({
      INSTANCE_LABEL: "empresa",
      INSTANCE_DESCRIPTION: "  the company\n\n line \t of the  business \r\n",
    });
    expect(identity).toStrictEqual({
      label: "empresa",
      description: "the company line of the business",
    });
  });

  it("cuts the description to 200 characters, and no further", () => {
    const at = readInstanceIdentity({
      INSTANCE_LABEL: "empresa",
      INSTANCE_DESCRIPTION: "d".repeat(200),
    });
    const over = readInstanceIdentity({
      INSTANCE_LABEL: "empresa",
      INSTANCE_DESCRIPTION: "d".repeat(201),
    });
    expect(at?.description).toBe("d".repeat(200));
    expect(over?.description).toBe("d".repeat(200));
  });

  it("omits the description key when it normalises to nothing", () => {
    expect(
      readInstanceIdentity({ INSTANCE_LABEL: "empresa", INSTANCE_DESCRIPTION: " \n\t " }),
    ).toStrictEqual({ label: "empresa" });
    expect(
      readInstanceIdentity({ INSTANCE_LABEL: "empresa", INSTANCE_DESCRIPTION: "" }),
    ).toStrictEqual({ label: "empresa" });
  });

  it("reads process.env when no env is passed", () => {
    vi.stubEnv("INSTANCE_LABEL", "Pessoal");
    vi.stubEnv("INSTANCE_DESCRIPTION", "my own number");
    expect(readInstanceIdentity()).toStrictEqual({
      label: "pessoal",
      description: "my own number",
    });
  });

  it("is null from process.env when the label is not set", () => {
    vi.stubEnv("INSTANCE_LABEL", "");
    vi.stubEnv("INSTANCE_DESCRIPTION", "orphan description");
    expect(readInstanceIdentity()).toBeNull();
  });
});

describe("identityParagraph", () => {
  it("names the line and its description on the first line", () => {
    expect(identityParagraph({ label: "empresa", description: "the company line" })).toBe(
      'THIS SERVER IS ONE WHATSAPP LINE — "empresa": the company line\n' +
        "Every tool here reads and sends as this line only. Any other WhatsApp number is a " +
        "different MCP server with its own tools, chats and message IDs — nothing carries " +
        'over between them. Before you send, check that "empresa" is the line the user means; ' +
        "get_connection_status reports the line and its paired phone number.",
    );
  });

  it("ends the first line with a full stop when there is no description", () => {
    expect(identityParagraph({ label: "empresa" })).toBe(
      'THIS SERVER IS ONE WHATSAPP LINE — "empresa".\n' +
        "Every tool here reads and sends as this line only. Any other WhatsApp number is a " +
        "different MCP server with its own tools, chats and message IDs — nothing carries " +
        'over between them. Before you send, check that "empresa" is the line the user means; ' +
        "get_connection_status reports the line and its paired phone number.",
    );
  });
});

describe("sentFromSuffix", () => {
  it("is empty without an identity, so today's string is untouched", () => {
    expect(sentFromSuffix(null)).toBe("");
  });

  it("names the line, after a leading space", () => {
    expect(sentFromSuffix({ label: "empresa", description: "ignored here" })).toBe(
      ' Sent from the "empresa" line.',
    );
  });
});

describe("pairedPhoneDigits", () => {
  it("reads the digits before the device suffix", () => {
    expect(pairedPhoneDigits("5500000000000:12@s.whatsapp.net")).toBe("5500000000000");
  });

  it("reads the digits of an id with no device suffix", () => {
    expect(pairedPhoneDigits("5500000000000@s.whatsapp.net")).toBe("5500000000000");
  });

  it("is undefined when nothing is paired", () => {
    expect(pairedPhoneDigits(undefined)).toBeUndefined();
    expect(pairedPhoneDigits(null)).toBeUndefined();
    expect(pairedPhoneDigits("")).toBeUndefined();
  });

  it("never reports a LID as a phone number", () => {
    expect(pairedPhoneDigits("10000000000005@lid")).toBeUndefined();
    expect(pairedPhoneDigits("10000000000005:3@lid")).toBeUndefined();
  });

  it("is undefined for an id that is not a phone-number JID", () => {
    expect(pairedPhoneDigits("5500000000000")).toBeUndefined();
    expect(pairedPhoneDigits("abc@s.whatsapp.net")).toBeUndefined();
    expect(pairedPhoneDigits("55000:x@s.whatsapp.net")).toBeUndefined();
    expect(pairedPhoneDigits("120363000000000001@g.us")).toBeUndefined();
    expect(pairedPhoneDigits("x5500000000000@s.whatsapp.net")).toBeUndefined();
  });
});

describe("phoneLast4", () => {
  const PAIRED = "5500000001234:7@s.whatsapp.net";

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is the last four digits of the paired number", () => {
    expect(phoneLast4(PAIRED, {})).toBe("1234");
  });

  it("prefers the paired number over EXPECTED_WA_NUMBER", () => {
    expect(phoneLast4(PAIRED, { EXPECTED_WA_NUMBER: "5500000009999" })).toBe("1234");
  });

  it("falls back to the last four digits of EXPECTED_WA_NUMBER while nothing is paired", () => {
    expect(phoneLast4(undefined, { EXPECTED_WA_NUMBER: "5500000001234" })).toBe("1234");
    expect(phoneLast4(null, { EXPECTED_WA_NUMBER: "5500000001234" })).toBe("1234");
  });

  it("reads only the digits of EXPECTED_WA_NUMBER", () => {
    expect(phoneLast4(undefined, { EXPECTED_WA_NUMBER: "+55 (00) 00000-1234" })).toBe("1234");
  });

  it("accepts an EXPECTED_WA_NUMBER of exactly ten digits, not nine", () => {
    expect(phoneLast4(undefined, { EXPECTED_WA_NUMBER: "1234567890" })).toBe("7890");
    expect(phoneLast4(undefined, { EXPECTED_WA_NUMBER: "123456789" })).toBeUndefined();
  });

  it("is undefined when nothing is paired and EXPECTED_WA_NUMBER is unset, empty or not a number", () => {
    expect(phoneLast4(undefined, {})).toBeUndefined();
    expect(phoneLast4(undefined, { EXPECTED_WA_NUMBER: "" })).toBeUndefined();
    expect(phoneLast4(undefined, { EXPECTED_WA_NUMBER: "not-a-number" })).toBeUndefined();
  });

  it("does not take digits from a LID, so it falls back to EXPECTED_WA_NUMBER", () => {
    expect(phoneLast4("10000000009876:3@lid", {})).toBeUndefined();
    expect(phoneLast4("10000000009876:3@lid", { EXPECTED_WA_NUMBER: "5500000001234" })).toBe(
      "1234",
    );
  });

  it("is never shorter than four characters", () => {
    expect(phoneLast4("123@s.whatsapp.net", {})).toBeUndefined();
    expect(phoneLast4("1234@s.whatsapp.net", {})).toBe("1234");
  });

  it("reads process.env when no env is passed", () => {
    vi.stubEnv("EXPECTED_WA_NUMBER", "5500000001234");
    expect(phoneLast4(undefined)).toBe("1234");
  });
});
