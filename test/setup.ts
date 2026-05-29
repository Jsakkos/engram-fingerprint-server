import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";

// Apply the migrations from ./migrations (read in vitest.config.ts and provided to
// the worker via the TEST_MIGRATIONS binding) to the test D1 database once, before
// any test runs. The source of truth is migrations/*.sql — the same files
// `wrangler d1 migrations apply` ships to production — so the test schema can't
// drift from the deployed schema.
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
