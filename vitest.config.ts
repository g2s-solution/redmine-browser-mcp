import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["daemon/test/**/*.test.ts", "extension/test/**/*.test.ts", "test/**/*.test.ts"],
    testTimeout: 15000,
    coverage: {
      provider: "v8",
      include: ["daemon/src/**", "extension/src/**", "shared/**"],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 80 },
      exclude: ["daemon/src/index.ts", "extension/src/worker.ts", "extension/src/popup.ts"],
    },
  },
});
