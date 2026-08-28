# ldn.house

Energy and climate data for one house in London. Server-rendered Solid on a
Cloudflare Worker, deployed to [ldn.house](https://ldn.house).

## Status

Scaffold only. The page renders a synthetic half-hourly profile; Octopus
ingest is not wired up yet.

## Commands

```bash
bun dev         # Vite dev server, pages rendered in workerd
bun run build   # client -> dist/client, worker -> dist/ldn_house
bun run preview # build, then serve the production artifact in workerd
bun run deploy  # build and wrangler deploy
bun typecheck
bun lint
bun run test    # vitest in the Workers runtime, D1 included
```

## Architecture

- **Solid 2 start mode** (`solid({ start: { external: true }, ssr: true })`)
  owns the entries and both builds. `src/App.tsx` is the root component and
  `src/Document.tsx` the document shell — one set of components, rendered on
  the server and hydrated on the client.
- **`src/worker.ts`** is the Worker entry. Hono owns `/api/*` (and later the
  cron ingest, the Home Assistant push endpoint and Discord webhooks);
  everything else goes to Solid's `virtual:solid-ssr-handler`.
- **Charts are server-rendered SVG** (`src/components/UsageChart.tsx`). The
  bars are in the HTML, so a chart is readable with JavaScript disabled and
  paints without a client round trip — `<title>` gives native hover tooltips
  for free. Chart maths lives in `src/lib/chart.ts` as pure functions with no
  DOM access.
- **No `<Loading>` boundary around the data.** Solid 2's loading boundary (the
  successor to `Suspense`) defers its children into `<template>` blocks that
  only JavaScript can materialise, so a no-JS client sees the fallback forever.
  Without a boundary the render blocks until the async memos resolve and the
  markup lands in the shell instead. That trades streaming for a first byte
  that already contains the chart, which is the right way round here.
- **Data comes from `"use server"` functions** in `src/lib/queries.ts` reading
  D1 through `env` from `cloudflare:workers`.
- **Tailwind v4** via `@tailwindcss/vite` — a pure Vite plugin, so it never
  interacts with Solid's OXC JSX transform.

## Testing

Tests run under [`@cloudflare/vitest-plugin`](https://developers.cloudflare.com/workers/testing/vitest-integration/)
(renamed from `@cloudflare/vitest-pool-workers` in August 2026), so they execute
inside workerd against a real Miniflare-backed D1 with the same migrations the
deployed database uses. That matters for the ingest: D1 caps a statement at 100
bound parameters, and a mocked database would never surface it.

Storage is isolated per test *file*, not per test, so cases that assert on row
counts reset their tables in `beforeEach`. Use `bun run test` — a bare
`bun test` invokes Bun's own runner, which cannot resolve `cloudflare:test`.

## Deployment

A single GitHub Actions workflow owns deploys; Workers Builds is disconnected so
nothing deploys twice.

| Trigger | Effect |
|---|---|
| Pull request | Provisions `ldn-house-pr-N` (database and Worker), migrates it, deploys, seeds from the fixture, comments the URL |
| Push to `main` | Migrates the production database, then deploys |
| Pull request closed | Deletes the PR's Worker and database |

Previews get their own D1 so a PR never writes to production, and the generated
config drops `routes` and `triggers` — a preview must not answer on
preview.ldn.house, and every open PR running the ingest cron would hammer
Octopus. Migrations run *before* the production deploy so new code never meets an
old schema; that only holds while migrations stay additive, and a destructive
change needs expand/contract across two deploys.

`src/fixtures/octopus.json` is a scrubbed capture of the live API, regenerated
with `bun scripts/capture-fixture.ts [days]`. Seeding posts it to `/api/seed`,
which runs the ordinary `ingest()` against a replaying fetcher rather than a
second write path — so previews exercise the same parsing, upserts and
normalisation as production. The route does not exist without `SEED_TOKEN`,
which is only set on previews.

`worker-configuration.d.ts` is generated but committed, so CI can typecheck
without Cloudflare credentials. Regenerate it with `bun cf-typegen` after
changing bindings in `wrangler.jsonc`.

Required repository secrets: `CLOUDFLARE_ACCOUNT_ID`, and a `CLOUDFLARE_API_TOKEN`
with Workers Scripts edit, D1 edit and Workers Routes edit.

## Version notes

Solid 2 is at RC and moved things that Solid 1 guides still get wrong:

- `jsxImportSource` is **`@solidjs/web`**, not `solid-js` — `solid-js` no
  longer ships a `/web` subpath or a JSX runtime.
- `JSX`, `HydrationScript` and `getRequestEvent` come from `@solidjs/web`.
  Pin it to the `next` tag so it matches `solid-js`; the transitive default
  resolves to an older RC.
- `vite-plugin-solid` is now **`@solidjs/vite-plugin`**, and compiles through
  a Rust/OXC compiler by default rather than Babel.
- `start: { external: true }` hands the server environment to
  `@cloudflare/vite-plugin`, which builds its own environment named after the
  Worker instead of adopting Solid's `ssr` one.
