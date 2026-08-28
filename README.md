# ldn.house

Energy and climate data for one house in London. Server-rendered Solid on a
Cloudflare Worker, deployed to [ldn.house](https://ldn.house).

## Status

Scaffold only. The page renders a synthetic half-hourly profile; Octopus
ingest is not wired up yet.

## Commands

```bash
bun dev         # Vite dev server, pages rendered in workerd
bun run build   # client -> dist/client, worker -> dist/ldn_house_web
bun run preview # build, then serve the production artifact in workerd
bun run deploy  # build and wrangler deploy
bun typecheck
bun lint
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
  for free. Hydration only adds interaction on top. Chart maths lives in
  `src/lib/chart.ts` as pure functions with no DOM access.
- **Tailwind v4** via `@tailwindcss/vite` — a pure Vite plugin, so it never
  interacts with Solid's OXC JSX transform.

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
