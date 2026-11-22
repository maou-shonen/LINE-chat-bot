import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { FIXTURE_HEADERS: "1" } },
    }),
  ],
  test: {
    include: ["bench/c-measure.measure.ts"],
    globalSetup: ["./bench/c-measure.setup.mjs"],
    testTimeout: 300_000,
  },
});
