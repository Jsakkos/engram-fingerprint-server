import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          d1Databases: ["DB"],
          r2Buckets: ["PACKS"],
          bindings: { ALLOW_DEV_SEED: "1" },
        },
      },
    },
    setupFiles: ["./test/setup.ts"],
  },
});
