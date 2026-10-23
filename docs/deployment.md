# Deployment

GitHub Actions deploys the site; Workers Builds is disconnected.

| Trigger | Effect |
|---|---|
| Pull request | Provisions `ldn-house-pr-N` (Worker and database), migrates, deploys, seeds, comments the URL and records a `pr-preview` deployment |
| Push to `main` | Migrates the production database, deploys and records a `production` deployment |
| Pull request closed | Deletes the PR's Worker and database, and marks its deployments inactive |
| Hourly, or run manually | Redeploys `main` to production when the tree export has changed, recording a `production` deployment |

Draft PRs also deploy previews. The generated preview config drops all
production routes and cron triggers, leaving an isolated fixture-seeded database
and a `workers.dev` URL.

Migrations run before the production deploy, which is only safe while they stay
additive — a destructive change needs expand/contract across two deploys.

## Hosts

Production binds exactly `ldn.house`, `www.ldn.house` and `preview.ldn.house`;
`dashboard.ldn.house` is separate. The Worker redirects `www` to the HTTPS apex
with a 301, preserving path and query, including assets and enrolment GET links.
`preview.ldn.house` serves the same gated app. The canonical and social URLs use
the apex; preview hosts discourage indexing via `robots.txt` and `X-Robots-Tag`.
These are crawler hints, not access controls.

Enrolment cookies are host-only, so a device using both the apex and preview
enrols on each; the Worker and D1 are shared.

## Secrets

Repository secrets: `CLOUDFLARE_ACCOUNT_ID`, and a `CLOUDFLARE_API_TOKEN` with
Workers Scripts edit, D1 edit and Workers Routes edit. Workers Routes must
include the `ldn.house` zone. Custom Domains create their own DNS records and
certificates, so DNS edit is not needed.

## Christmas tree export

The Christmas tree panel plays loops pre-rendered by
[ldn-house/tree](https://github.com/ldn-house/tree) (`export_web.py`), published as
`tree-effects.tar.gz` on its rolling `firmware-main` release. Deploys fetch the
latest at build time, and `/api/health` reports the archive's digest as
`treeExport`. The hourly `Tree export` workflow compares that with the release's
and redeploys when they differ; an export that fails validation is not deployed.
Without the export, locally or when a push deploy's download fails, the panel is
left out. `scripts/fetch-tree-export.ts` also takes a local archive or export
directory.
