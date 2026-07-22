import { describe, expect, it } from "vitest";
import type { Message } from "../database.ts";
import { buildStreamFrame } from "../stream/frame.ts";

function msg(o: Partial<Message> & { id: string; chat_jid: string; content: string }): Message {
  return {
    timestamp: new Date("2026-07-02T14:58:20.000Z"),
    is_from_me: false,
    sender: "5511999999999@s.whatsapp.net",
    chat_name: "AmiticIA AutoSys",
    ...o,
  };
}

describe("buildStreamFrame", () => {
  it("maps a text message to the frame schema", () => {
    const frame = buildStreamFrame(
      msg({ id: "A577AE", chat_jid: "1203@g.us", content: "Para o Dave 👆" }),
      12,
      "Beatriz A. Example",
    );

    expect(frame).toEqual({
      seq: 12,
      id: "A577AE",
      chat_jid: "1203@g.us",
      chat_name: "AmiticIA AutoSys",
      sender_jid: "5511999999999@s.whatsapp.net",
      sender_display: "Beatriz A. Example",
      is_from_me: false,
      content: "Para o Dave 👆",
      timestamp: "2026-07-02T14:58:20.000Z",
      reply_to: null,
      media: null,
    });
  });

  it("emits a media block with the transcription and a download fetch_id", () => {
    const frame = buildStreamFrame(
      msg({
        id: "V1",
        chat_jid: "1203@g.us",
        content: "",
        media_type: "ptt",
        mimetype: "audio/ogg; codecs=opus",
        file_length: 4821,
      }),
      13,
      "Beatriz",
      "Olá, tudo bem?",
    );

    expect(frame.media).toEqual({
      type: "ptt",
      mimetype: "audio/ogg; codecs=opus",
      transcription: "Olá, tudo bem?",
      fetch_id: "V1",
    });
  });

  it("carries is_from_me for the persona (act-as-me) case", () => {
    const frame = buildStreamFrame(
      msg({ id: "M1", chat_jid: "1203@g.us", content: "eu respondo", is_from_me: true }),
      1,
      "Me",
    );
    expect(frame.is_from_me).toBe(true);
  });

  it("falls back to 'Unknown Chat' when the chat has no name", () => {
    const frame = buildStreamFrame(
      msg({ id: "X", chat_jid: "1203@g.us", content: "hi", chat_name: null }),
      1,
      "Someone",
    );
    expect(frame.chat_name).toBe("Unknown Chat");
  });
});
