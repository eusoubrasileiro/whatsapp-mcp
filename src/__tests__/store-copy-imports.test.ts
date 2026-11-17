import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(import.meta.dirname, "..");

/** Every module a file names: static imports, `export … from`, `import()` and `require()`. */
function importsOf(text: string): string[] {
  return ts.preProcessFile(text, true, true).importedFiles.map((one) => one.fileName);
}

const read = (name: string) => fs.readFileSync(path.join(SRC, name), "utf8");

describe("the media-store copy tool stands alone", () => {
  it("is run through an entry point that imports the tool and nothing else", () => {
    expect(importsOf(read("store-copy-cli.ts"))).toEqual(["./store-copy.ts"]);
  });

  it("imports minio and node's own modules, and nothing of the application", () => {
    const imports = importsOf(read("store-copy.ts"));

    expect(imports.sort()).toEqual(["minio", "node:crypto", "node:stream"]);
  });

  it("sees a module however it is named", () => {
    const sample = [
      'import a from "./a.ts";',
      'import type { B } from "./b.ts";',
      'export { c } from "./c.ts";',
      'const d = await import("./d.ts");',
      'const e = require("./e.js");',
      'import "./f.ts";',
    ].join("\n");

    expect(importsOf(sample)).toEqual(["./a.ts", "./b.ts", "./c.ts", "./d.ts", "./e.js", "./f.ts"]);
  });
});
