import { applyD1Migrations, env } from 'cloudflare:test';

// Each test file gets isolated storage, so the schema is applied per run
// against the same migrations the deployed database uses.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
