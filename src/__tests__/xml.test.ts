import { describe, expect, it } from "vitest";
import { renderEnvelope, renderImageDescription, renderTranscription } from "../xml.ts";

describe("renderEnvelope", () => {
  it("renders tag, attributes (in declared order), and body", () => {
    const out = renderEnvelope({
      tag: "thing",
      attrs: [
        ["a", "1"],
        ["b", "2"],
        ["c", 3],
      ],
      body: "hello",
    });
    expect(out).toBe(`<thing a="1" b="2" c="3">\nhello\n</thing>`);
  });

  it("omits attributes whose value is undefined while preserving order of the rest", () => {
    const out = renderEnvelope({
      tag: "t",
      attrs: [
        ["a", "1"],
        ["skipme", undefined],
        ["b", "2"],
      ],
      body: "x",
    });
    expect(out).toBe(`<t a="1" b="2">\nx\n</t>`);
  });

  it("escapes XML-unsafe characters in attribute values", () => {
    const out = renderEnvelope({
      tag: "t",
      attrs: [["q", `a"b&c<d>e`]],
      body: "x",
    });
    expect(out).toContain(`q="a&quot;b&amp;c&lt;d&gt;e"`);
  });

  it("escapes XML-unsafe characters in body (no quote escaping)", () => {
    const out = renderEnvelope({
      tag: "t",
      attrs: [],
      body: `<script>alert('x' & "y")</script>`,
    });
    // body escapes <, >, & but not " or '
    expect(out).toContain(`&lt;script&gt;alert('x' &amp; "y")&lt;/script&gt;`);
  });

  it("renders empty body with surrounding newlines", () => {
    const out = renderEnvelope({
      tag: "t",
      attrs: [["a", "1"]],
      body: "",
    });
    expect(out).toBe(`<t a="1">\n\n</t>`);
  });

  it("coerces numeric attribute values via String()", () => {
    const out = renderEnvelope({
      tag: "t",
      attrs: [["n", 42]],
      body: "x",
    });
    expect(out).toBe(`<t n="42">\nx\n</t>`);
  });

  it("renders no leading space before > when there are no attributes", () => {
    // Note: existing transcription/image_description tests assert a space
    // between tag and attrs; with zero attrs we should not emit a stray space.
    const out = renderEnvelope({
      tag: "t",
      attrs: [],
      body: "x",
    });
    expect(out).toBe(`<t>\nx\n</t>`);
  });
});

describe("renderTranscription", () => {
  it("wraps content in <transcription> with declared attributes in deterministic order", () => {
    const out = renderTranscription({
      message_id: "msg-1",
      chat_jid: "5511@s.whatsapp.net",
      model: "whisper-large-v3-turbo",
      duration_s: 138,
      text: "Olá, queria saber se vocês entregam.",
    });

    expect(out).toBe(
      `<transcription message_id="msg-1" chat_jid="5511@s.whatsapp.net" model="whisper-large-v3-turbo" duration_s="138">\nOlá, queria saber se vocês entregam.\n</transcription>`,
    );
  });

  it("escapes XML-unsafe characters in content and attribute values", () => {
    const out = renderTranscription({
      message_id: 'msg"1',
      chat_jid: "x&y@s.whatsapp.net",
      model: "whisper-large-v3-turbo",
      duration_s: 1,
      text: "<script>alert('x' & \"y\")</script>",
    });

    expect(out).toContain('message_id="msg&quot;1"');
    expect(out).toContain('chat_jid="x&amp;y@s.whatsapp.net"');
    expect(out).toContain("&lt;script&gt;alert('x' &amp; \"y\")&lt;/script&gt;");
  });

  it("omits duration_s attribute when not provided", () => {
    const out = renderTranscription({
      message_id: "m",
      chat_jid: "j",
      model: "whisper-1",
      text: "hi",
    });
    expect(out).toBe(
      `<transcription message_id="m" chat_jid="j" model="whisper-1">\nhi\n</transcription>`,
    );
  });
});

describe("renderImageDescription", () => {
  it("wraps content in <image_description> with declared attribute order", () => {
    const out = renderImageDescription({
      message_id: "msg-2",
      chat_jid: "5511@s.whatsapp.net",
      model: "gemini-2.5-flash",
      text: "Foto de um cardápio de pizzaria.",
    });

    expect(out).toBe(
      `<image_description message_id="msg-2" chat_jid="5511@s.whatsapp.net" model="gemini-2.5-flash">\nFoto de um cardápio de pizzaria.\n</image_description>`,
    );
  });

  it("escapes XML-unsafe characters in attributes and body", () => {
    const out = renderImageDescription({
      message_id: "m&1",
      chat_jid: "j",
      model: "gemini-2.5-flash",
      text: "x < y & z > 0",
    });
    expect(out).toContain('message_id="m&amp;1"');
    expect(out).toContain("x &lt; y &amp; z &gt; 0");
  });
});
