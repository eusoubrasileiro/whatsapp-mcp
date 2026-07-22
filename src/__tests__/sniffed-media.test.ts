import { describe, expect, it } from "vitest";
import { extensionFor, sniffMedia } from "../sniffed-media.ts";

/**
 * The sniffer is the single source of truth for the magic-byte ↔ mimetype
 * mapping consumed by both the send_file resolver and the POST /upload
 * endpoint. Each format below maps to one row of the table and one MCP
 * code path — drop a case and a real WhatsApp send breaks silently.
 */
describe("sniffMedia", () => {
  it("returns null for buffers shorter than 4 bytes", () => {
    expect(sniffMedia(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(sniffMedia(Buffer.alloc(0))).toBeNull();
  });

  it("returns null for unrecognized bytes", () => {
    expect(sniffMedia(Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]))).toBeNull();
  });

  it("sniffs JPEG (FF D8 FF)", () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(sniffMedia(buf)).toEqual({ mimetype: "image/jpeg", extension: "jpg" });
  });

  it("sniffs PNG (89 50 4E 47)", () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(sniffMedia(buf)).toEqual({ mimetype: "image/png", extension: "png" });
  });

  it("sniffs GIF (GIF8)", () => {
    const buf = Buffer.from("GIF89a", "ascii");
    expect(sniffMedia(buf)).toEqual({ mimetype: "image/gif", extension: "gif" });
  });

  it("sniffs WebP (RIFF....WEBP)", () => {
    const buf = Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from("WEBP", "ascii"),
    ]);
    expect(sniffMedia(buf)).toEqual({ mimetype: "image/webp", extension: "webp" });
  });

  it("sniffs PDF (%PDF)", () => {
    const buf = Buffer.from("%PDF-1.4", "ascii");
    expect(sniffMedia(buf)).toEqual({ mimetype: "application/pdf", extension: "pdf" });
  });

  it("sniffs MP4 (ftyp + generic brand)", () => {
    // bytes 4..8 = "ftyp", brand = "isom"
    const buf = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x20]),
      Buffer.from("ftypisom", "ascii"),
    ]);
    expect(sniffMedia(buf)).toEqual({ mimetype: "video/mp4", extension: "mp4" });
  });

  it("sniffs 3GP (ftyp + 3gp brand)", () => {
    const buf = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x20]),
      Buffer.from("ftyp3gp4", "ascii"),
    ]);
    expect(sniffMedia(buf)).toEqual({ mimetype: "video/3gpp", extension: "3gp" });
  });

  it("sniffs MOV (ftyp + qt   brand)", () => {
    const buf = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x20]),
      Buffer.from("ftypqt  ", "ascii"),
    ]);
    expect(sniffMedia(buf)).toEqual({ mimetype: "video/quicktime", extension: "mov" });
  });

  it("sniffs M4A (ftyp + M4A  brand)", () => {
    const buf = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x20]),
      Buffer.from("ftypM4A ", "ascii"),
    ]);
    expect(sniffMedia(buf)).toEqual({ mimetype: "audio/mp4", extension: "m4a" });
  });

  it("sniffs OGG (OggS)", () => {
    const buf = Buffer.from("OggS", "ascii");
    expect(sniffMedia(buf)).toEqual({ mimetype: "audio/ogg", extension: "ogg" });
  });

  it("sniffs WAV (RIFF....WAVE)", () => {
    const buf = Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from("WAVE", "ascii"),
    ]);
    expect(sniffMedia(buf)).toEqual({ mimetype: "audio/wav", extension: "wav" });
  });

  it("sniffs MP3 frame header (FF Ex/Fx)", () => {
    const buf = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
    expect(sniffMedia(buf)).toEqual({ mimetype: "audio/mpeg", extension: "mp3" });
  });

  it("sniffs MP3 ID3v2 tag (ID3)", () => {
    const buf = Buffer.from("ID3\x03\x00\x00\x00", "binary");
    expect(sniffMedia(buf)).toEqual({ mimetype: "audio/mpeg", extension: "mp3" });
  });
});

describe("extensionFor", () => {
  it("maps known mimetypes to file extensions", () => {
    expect(extensionFor("image/jpeg")).toBe("jpg");
    expect(extensionFor("image/png")).toBe("png");
    expect(extensionFor("video/mp4")).toBe("mp4");
    expect(extensionFor("audio/mpeg")).toBe("mp3");
    expect(extensionFor("application/pdf")).toBe("pdf");
  });

  it("is case-insensitive on the mimetype key", () => {
    expect(extensionFor("IMAGE/PNG")).toBe("png");
  });

  it("returns 'bin' for unknown mimetypes", () => {
    expect(extensionFor("application/x-custom")).toBe("bin");
  });
});
