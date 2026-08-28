# ldn.house

Energy and climate data for one house in London. Server-rendered Solid on a
Cloudflare Worker, deployed to [ldn.house](https://ldn.house).

## Commands

```bash
bun dev         # Vite dev server, pages rendered in workerd
bun run build   # client -> dist/client, worker -> dist/ldn_house
bun run preview # build, then serve the production artifact in workerd
bun run test    # vitest inside workerd, against a real D1
bun typecheck
bun lint
```

`bun run test`, not `bun test` — the latter invokes Bun's own runner, which
cannot resolve `cloudflare:test`.

## Deployment

A GitHub Actions workflow owns deploys. Workers Builds is disconnected.

| Trigger | Effect |
|---|---|
| Pull request | Provisions `ldn-house-pr-N` (Worker and database), migrates, deploys, seeds, comments the URL |
| Push to `main` | Migrates the production database, then deploys |
| Pull request closed | Deletes the PR's Worker and database |

Migrations run before the production deploy, which is only safe while they stay
additive — a destructive change needs expand/contract across two deploys.

Repository secrets: `CLOUDFLARE_ACCOUNT_ID`, and a `CLOUDFLARE_API_TOKEN` with
Workers Scripts edit, D1 edit and Workers Routes edit.

## Maintenance

```bash
bun cf-typegen                    # after changing bindings in wrangler.jsonc
bun run db:generate               # after changing src/db/schema.ts
bun scripts/capture-fixture.ts 14 # re-record src/fixtures/octopus.json
```

`worker-configuration.d.ts` is generated but committed so CI can typecheck
without Cloudflare credentials. The fixture is a scrubbed capture of the live
API used to seed preview deployments; it must never contain a real MPAN, meter
serial or account number.
