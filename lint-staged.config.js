// Single-package repo: biome auto-fixes staged files in place. The heavier
// full-project tsc + tests run as separate pre-commit stages (see .husky/
// pre-commit), so they are intentionally NOT duplicated per-file here.
export default {
  "*.{ts,js,mjs,cjs,json}": ["biome check --write --no-errors-on-unmatched"],
};
