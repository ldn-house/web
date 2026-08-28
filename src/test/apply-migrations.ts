import { applyD1Migrations, env } from 'cloudflare:test';

// Same migrations the deployed database uses.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
