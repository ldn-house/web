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

Home Mini readings refresh on demand at most every two minutes, and only a home
visitor's request can trigger one. D1 shares the reading and the next fetch time
across visitors and Worker instances, including cooldowns when Octopus throttles
requests. The power label shows the measurement time; readings older than five
minutes give way to the hourly average.

Each refresh uses two telemetry queries, so one deployment makes at most 60 per
hour. Local servers and other integrations using the same Octopus account share
its upstream quota. A throttle uses Octopus's reset time or `Retry-After`, falling
back to one hour when neither is available.

Scheduled ingestion runs at minutes 7 and 37. Its existing GraphQL
`smartMeterTelemetry(grouping: HALF_HOURLY)` request confirms a period only when
there is a valid consumption bucket at or beyond its end and the end is at least
two minutes old. A bucket timestamp is its start, so the final bucket cannot
prove its own completion. During an outage that bucket stays unconfirmed; an
open page keeps its last live partial reading, while a fresh page may omit it
until later telemetry or billing arrives. Missing or invalid deltas never erase
previously stored period consumption; valid corrections, including zero, replace it.

This uses the existing response, with no extra Octopus queries, retries or polling.
Each scheduled run still makes one half-hour telemetry query per discovered device,
independent of visitor count. Recovery still starts 24 hours behind the latest
stored completed period, capped at three days; withholding the last unconfirmed
bucket can keep that watermark earlier and return more history within that cap.
Telemetry failures (including throttling) still skip the secondary feed and leave
billing ingestion intact until the next scheduled run. This completion check adds
no rate-limit calls; it trades confirmation of the latest bucket for avoiding a
false completed reading. Grouped data does not establish uninterrupted coverage
inside older periods, and cannot repair historical gaps by itself.

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

## Home access

Live and same-day usage is shown only to visitors at home: from the house's
public address, or with the cookie a visit from there sets. Everyone else sees
usage to the end of yesterday.

Worker secrets:

```bash
bunx wrangler secret put HOME_REPORT_TOKEN  # Home Assistant's bearer token
bunx wrangler secret put HOME_COOKIE_SECRET # signs home cookies; rotate to revoke them
```

Home Assistant reports the address on change and every five minutes; an address
unreported for 15 minutes stops counting:

```http
POST /api/home/address
Authorization: Bearer <HOME_REPORT_TOKEN>
Content-Type: application/json

{"ipv4": "192.0.2.10", "ipv6_prefix": "2001:db8:1200::/56"}
```

`ipv6_prefix` is optional, /48 to /128. Locally and on PR previews, `?as=home`,
`?as=away` and `?as=outsider` simulate the house, a cookie-holder away from it,
and a stranger.

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
