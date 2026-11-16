import { defineConfig } from "vitest/config";

// The e2e suite: real servers in child processes, real SQLite, real RustFS. Separate from
// vitest.config.ts (unit tests under src/__tests__), run with `pnpm test:e2e`.
export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.test.ts"],
    environment: "node",
    // Each spec file boots its own server (random port, temp data dir), so files can run in
    // parallel; booting imports the whole app, hence the generous hook timeout.
    hookTimeout: 90_000,
    testTimeout: 30_000,
  },
});
