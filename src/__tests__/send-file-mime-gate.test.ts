import { describe, expect, it } from "vitest";
import { assertMimeForType } from "../media-input.ts";

describe("assertMimeForType — WABA-allow-list gate", () => {
  describe("type=image", () => {
    it("accepts image/jpeg", () => {
      expect(() => assertMimeForType("image", "image/jpeg")).not.toThrow();
    });

    it("accepts image/png", () => {
      expect(() => assertMimeForType("image", "image/png")).not.toThrow();
    });

    it("rejects image/webp with a clear sticker hint", () => {
      expect(() => assertMimeForType("image", "image/webp")).toThrow(
        /webp.*sticker|sticker.*webp/i,
      );
    });

    it("rejects image/gif (WABA Cloud-API doesn't relay GIF-as-image)", () => {
      expect(() => assertMimeForType("image", "image/gif")).toThrow(/image\/gif|jpeg.*png/i);
    });

    it("rejects non-image mime for type=image with a mentions-of-bytes error", () => {
      expect(() => assertMimeForType("image", "application/pdf")).toThrow(
        /application\/pdf|type.*image|image.*type/i,
      );
    });
  });

  describe("type=video", () => {
    it("accepts video/mp4", () => {
      expect(() => assertMimeForType("video", "video/mp4")).not.toThrow();
    });

    it("accepts video/3gpp", () => {
      expect(() => assertMimeForType("video", "video/3gpp")).not.toThrow();
    });

    it("rejects video/quicktime (.mov)", () => {
      expect(() => assertMimeForType("video", "video/quicktime")).toThrow(/quicktime|mp4|3gpp/i);
    });

    it("rejects image bytes when type=video", () => {
      expect(() => assertMimeForType("video", "image/png")).toThrow(/png|video|type/i);
    });
  });

  describe("type=audio", () => {
    it.each([
      "audio/aac",
      "audio/amr",
      "audio/mpeg",
      "audio/mp4",
      "audio/ogg",
    ])("accepts %s", (mime) => {
      expect(() => assertMimeForType("audio", mime)).not.toThrow();
    });

    it("rejects non-audio mime", () => {
      expect(() => assertMimeForType("audio", "image/png")).toThrow(/png|audio|type/i);
    });
  });

  describe("type=document", () => {
    it("accepts anything — Meta's document set is broad and we don't enumerate", () => {
      expect(() => assertMimeForType("document", "application/pdf")).not.toThrow();
      expect(() => assertMimeForType("document", "application/x-anything")).not.toThrow();
      // Even image bytes — caller may legitimately want to send a PNG as a downloadable file.
      expect(() => assertMimeForType("document", "image/png")).not.toThrow();
    });
  });
});
