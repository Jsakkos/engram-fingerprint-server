import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  // Read the SAME migrations wrangler applies on deploy (migrations/*.sql) and hand
  // them to the test runtime via a binding. This makes tests run against the real
  // schema — there's no second, hand-maintained copy of the DDL that can drift.
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));

  return {
    test: {
      setupFiles: ["./test/setup.ts"],
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.toml" },
          miniflare: {
            d1Databases: ["DB"],
            r2Buckets: ["PACKS"],
            // Exposed to tests as env.TEST_MIGRATIONS (see test/setup.ts).
            // ALLOW_DEV_SEED enables the gated POST /v1/_dev/seed route under test
            // (it is absent from wrangler.toml, so the route stays 404 in production).
            // CANONICAL_HOST / SUNSET_DATE activate the domain-migration deprecation
            // signal under test without putting a real domain into wrangler.toml.
            bindings: {
              TEST_MIGRATIONS: migrations,
              ALLOW_DEV_SEED: "1",
              CANONICAL_HOST: "api.engram.example",
              SUNSET_DATE: "Thu, 31 Dec 2026 23:59:59 GMT",
            },
          },
        },
      },
      coverage: {
        // workerd has no Node inspector, so the default v8 provider can't instrument
        // it — istanbul instruments the source at transform time instead.
        provider: "istanbul",
        reporter: ["text", "html", "json-summary", "lcov"],
        reportsDirectory: "./coverage",
        include: ["src/**/*.ts"],
        exclude: ["src/**/*.d.ts"],
      },
    },
  };
});
