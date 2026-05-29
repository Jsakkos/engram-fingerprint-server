import type { D1Migration } from "cloudflare:test";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    // Read from ./migrations in vitest.config.ts and applied in test/setup.ts.
    TEST_MIGRATIONS: D1Migration[];
  }
}
