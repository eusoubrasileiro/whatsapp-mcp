import { escapeHtml } from "../../hub/page.ts";
import { en, stringsFor } from "../../hub/strings.ts";

function flatten(node: unknown): string[] {
  if (typeof node === "string") return [node];
  return Object.values(node as object).flatMap(flatten);
}

const portuguese = new Set(flatten(stringsFor("pt-BR")));

/**
 * The words of the English table that read differently in Portuguese: for a sentence with
 * `{markers}`, its longest stretch of plain words. A page in Portuguese must contain none.
 */
const SENTINELS = flatten(en)
  .filter((text) => !portuguese.has(text))
  .map((text) =>
    text
      .split(/\{\w+\}/)
      .reduce((a, b) => (b.length > a.length ? b : a), "")
      .trim(),
  )
  .filter((fragment) => fragment.length >= 5);

/** The English sentences or sentence fragments that appear in `html`, escaped or not. */
export function englishLeaks(html: string): string[] {
  return SENTINELS.filter(
    (fragment) => html.includes(fragment) || html.includes(escapeHtml(fragment)),
  );
}
