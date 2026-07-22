/**
 * Sniffed-media: single source of truth for "what bytes are these?"
 *
 * Two code paths consume this:
 *  - `media-input.ts#resolveMediaInput()` — sniffs http/data/local payloads
 *    before handing them to Baileys so the declared mimetype matches the
 *    actual bytes (WABA Cloud-API drops mismatched envelopes silently).
 *  - `upload-server.ts` POST /upload — sniffs the raw request body to
 *    decide whether to accept it and what object-key extension to use.
 *
 * Centralising the magic-byte table here means adding a new accepted format
 * is a one-row change, and the MIME→extension mapping can't drift away from
 * the formats we actually recognise.
 */

export type SniffedMedia = {
  mimetype: string;
  extension: string;
};

/**
 * Magic-byte signatures for every format WhatsApp/WABA will accept.
 *
 * Encoded as predicates so multi-brand containers (ISO Base Media's `ftyp`
 * box with M4A/3GP/MOV/MP4 sub-brands) and RIFF (WebP vs WAV) can share a
 * common prefix without duplicating the table.
 */
type Signature = {
  test: (buf: Buffer) => boolean;
  /** Resolve the mimetype — may inspect buf when the format has sub-brands. */
  mimetype: (buf: Buffer) => string;
};

const SIGNATURES: readonly Signature[] = [
  // PNG: 89 50 4E 47
  {
    test: (b) => b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
    mimetype: () => "image/png",
  },
  // JPEG: FF D8 FF
  {
    test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
    mimetype: () => "image/jpeg",
  },
  // GIF: "GIF8"
  {
    test: (b) => b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38,
    mimetype: () => "image/gif",
  },
  // WebP: "RIFF"....\"WEBP"
  {
    test: (b) =>
      b.length >= 12 &&
      b[0] === 0x52 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 &&
      b[8] === 0x57 &&
      b[9] === 0x45 &&
      b[10] === 0x42 &&
      b[11] === 0x50,
    mimetype: () => "image/webp",
  },
  // PDF: "%PDF"
  {
    test: (b) => b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46,
    mimetype: () => "application/pdf",
  },
  // ISO Base Media (MP4/M4A/MOV/3GP) — bytes 4..8 = "ftyp", brand at 8..12
  {
    test: (b) => b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70,
    mimetype: (b) => {
      const brand = b.slice(8, 12).toString("ascii");
      if (brand === "M4A ") return "audio/mp4";
      if (brand === "qt  ") return "video/quicktime";
      if (brand.startsWith("3gp")) return "video/3gpp";
      return "video/mp4";
    },
  },
  // OGG: "OggS"
  {
    test: (b) => b.length >= 4 && b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53,
    mimetype: () => "audio/ogg",
  },
  // WAV: "RIFF"...."WAVE"
  {
    test: (b) =>
      b.length >= 12 &&
      b[0] === 0x52 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 &&
      b[8] === 0x57 &&
      b[9] === 0x41 &&
      b[10] === 0x56 &&
      b[11] === 0x45,
    mimetype: () => "audio/wav",
  },
  // MP3: frame header (FF Ex/Fx) or ID3v2 tag ("ID3")
  {
    test: (b) =>
      b.length >= 3 &&
      ((b[0] === 0xff && (b[1] & 0xe0) === 0xe0) ||
        (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33)),
    mimetype: () => "audio/mpeg",
  },
];

/**
 * MIME → extension. Kept in lockstep with SIGNATURES (every mimetype the
 * sniffer can produce must have a row here) plus a handful of extras that
 * callers may pass through from declared Content-Type / data: mediatype.
 */
const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/webm": "weba",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "text/plain": "txt",
};

/**
 * Detect a SniffedMedia from the buffer's magic bytes. Returns null when
 * nothing matches — callers fall back to a declared/transport-level type.
 */
export function sniffMedia(buffer: Buffer): SniffedMedia | null {
  if (buffer.length < 4) return null;
  for (const sig of SIGNATURES) {
    if (sig.test(buffer)) {
      const mimetype = sig.mimetype(buffer);
      return { mimetype, extension: extensionFor(mimetype) };
    }
  }
  return null;
}

/** Convenience wrapper preserved for callers that only want the mimetype. */
export function sniffMimetype(buffer: Buffer): string | null {
  return sniffMedia(buffer)?.mimetype ?? null;
}

/** Look up the file extension for a known mimetype (case-insensitive). */
export function extensionFor(mimetype: string): string {
  return MIME_TO_EXT[mimetype.toLowerCase()] ?? "bin";
}

/** Reverse mapping: which mimetype produces this extension? Null when unknown. */
export function mimeFromExtension(ext: string): string | null {
  const needle = ext.toLowerCase();
  const entry = Object.entries(MIME_TO_EXT).find(([, e]) => e === needle);
  return entry ? entry[0] : null;
}
