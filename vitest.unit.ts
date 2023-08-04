import { defineConfig } from "vitest/config";
import { baseConfig } from "./vitest.config";

export default defineConfig({
  test: {
    ...baseConfig,
    include: ["**/*.test.?(c|m)[jt]s?(x)"],
  },
});
