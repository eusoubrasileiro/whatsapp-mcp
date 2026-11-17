import { describe, expect, it } from "vitest";
import { en, HUB_LANGS, stringsFor } from "../hub/strings.ts";

/** Every string of a table with the dotted path that leads to it. */
function flatten(node: unknown, path = ""): [string, string][] {
  if (typeof node === "string") return [[path, node]];
  return Object.entries(node as object).flatMap(([key, child]) =>
    flatten(child, path === "" ? key : `${path}.${key}`),
  );
}

const markers = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

const english = flatten(en);
const portuguese = flatten(stringsFor("pt-BR"));

describe("the language tables", () => {
  it("offers English and Brazilian Portuguese, in that order", () => {
    expect(HUB_LANGS).toEqual(["en", "pt-BR"]);
  });

  it("picks the table for a language", () => {
    expect(stringsFor("en")).toBe(en);
    expect(stringsFor("pt-BR").htmlLang).toBe("pt-BR");
    expect(en.htmlLang).toBe("en");
  });

  it("has exactly the same keys in both tables, in the same order", () => {
    expect(portuguese.map(([key]) => key)).toEqual(english.map(([key]) => key));
  });

  it("has no empty value and no raw markup in either table", () => {
    for (const [key, text] of [...english, ...portuguese]) {
      expect(text.trim().length, key).toBeGreaterThan(0);
      expect(text, key).not.toMatch(/[<>]/);
    }
  });

  it("fills the same {markers} in both languages for every sentence", () => {
    portuguese.forEach(([key, text], index) => {
      expect(markers(text), key).toEqual(markers(english[index][1]));
    });
  });

  it("translates every sentence: only the words that read the same are equal", () => {
    const same = portuguese
      .filter(([key, text]) => text === english.find(([k]) => k === key)?.[1])
      .map(([key]) => key);

    // "PIN" and the "min" / "h" abbreviations read the same in both languages.
    expect(same).toEqual([
      "durations.minutes",
      "durations.hoursMinutes",
      "pin.field",
      "unlink.pinField",
    ]);
  });

  it("writes the Portuguese with its accents", () => {
    const text = portuguese.map(([, value]) => value).join(" ");

    for (const word of ["Endereço", "não", "Configurações", "número", "página"]) {
      expect(text).toContain(word);
    }
  });
});
