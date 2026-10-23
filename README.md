# ldn.house

Energy and climate data for one house in London. Server-rendered Solid on a
Cloudflare Worker at [ldn.house](https://ldn.house).

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

```bash
bun cf-typegen                    # after changing bindings in wrangler.jsonc
bun run db:generate               # after changing src/db/schema.ts
bun scripts/capture-fixture.ts 14 # re-record src/fixtures/octopus.json
bun scripts/fetch-tree-export.ts  # tree animations into src/tree-export/
```

`worker-configuration.d.ts` is generated but committed so CI can typecheck
without Cloudflare credentials. The fixture is a scrubbed capture of the live
API used to seed preview deployments; it must never contain a real MPAN, meter
serial or account number.

## Docs

- [Octopus requests](docs/octopus.md): live power refresh, rate limits and scheduled ingestion
- [Home access](docs/home-access.md): device enrolment and the Home Assistant API
- [Deployment](docs/deployment.md): previews, production hosts, secrets and the tree export
