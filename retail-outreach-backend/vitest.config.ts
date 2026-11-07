import { defineConfig } from "vitest/config";

export default defineConfig({
  // DB test files each reset the same throwaway database, so they must not run concurrently.
  test: { fileParallelism: !process.env.TEST_DATABASE_URL }
});
