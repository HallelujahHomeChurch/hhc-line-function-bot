import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/__tests__/kernel-redis-integration.test.ts",
      "src/__tests__/kernel-postgres-integration.test.ts"
    ],
    testTimeout: 60_000,
    fileParallelism: false
  }
});
