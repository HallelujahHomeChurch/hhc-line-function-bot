import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: [
      "src/__tests__/kernel-redis-integration.test.ts",
      "src/__tests__/kernel-postgres-integration.test.ts"
    ],
    testTimeout: 5000
  }
});
