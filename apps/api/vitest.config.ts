import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [swc.vite()],
  test: {
    include: ["test/unit/**/*.spec.ts"],
    environment: "node",
    globals: false,
  },
});
