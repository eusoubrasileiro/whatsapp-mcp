import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportOnFailure: true,
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**", "src/main.ts"],
      thresholds: {
        lines: 50,
        branches: 52,
        functions: 52,
        statements: 50,
      },
    },
  },
});
