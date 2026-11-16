/**
 * Stands in for vitest in the mutation gate's self-referential test.
 *
 * Loads `src/window.ts` BY READING THE BYTES ON DISK, so it sees whatever the
 * gate wrote there — that is the entire point. Exit 0 = tests pass = the mutant
 * survived; exit 1 = tests fail = the mutant was killed.
 *
 * `MUTATION_FIXTURE_STRENGTH=weak` asserts only a case far from the boundary,
 * so `<=` → `<` slips past it. `strong` pins the boundary itself.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// `SRC` lets the gate's own test point the checker at the file it is mutating.
const source = readFileSync(process.env.SRC ?? join(here, "..", "src", "window.ts"), "utf8");
const { windowOpen } = await import(`data:text/javascript,${encodeURIComponent(source)}`);

const assert = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
};

assert(windowOpen(1) === true, "1h must be inside the window");
if (process.env.MUTATION_FIXTURE_STRENGTH === "strong") {
  assert(windowOpen(24) === true, "24h is the boundary and must still be OPEN");
}
console.log("ok");
