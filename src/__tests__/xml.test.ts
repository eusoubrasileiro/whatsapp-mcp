import { describe, it, expect } from "vitest";
import { renderTranscription, renderImageDescription } from "../xml.ts";

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
