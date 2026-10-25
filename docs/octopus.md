# Octopus requests

## Live power

Home Mini readings refresh on demand at most every two minutes, and only a home
visitor's request can trigger one. D1 shares the reading and the next fetch time
across visitors and Worker instances, including cooldowns when Octopus throttles
requests. The power label shows the measurement time; readings older than five
minutes give way to the hourly average.

Each refresh uses two telemetry queries, so one deployment makes at most 60 per
hour. Local servers and other integrations using the same Octopus account share
its upstream quota. A throttle uses Octopus's reset time or `Retry-After`, falling
back to one hour when neither is available.

`ldn.house` serves the app using one shared D1 cache and refresh gate.
Cloudflare redirects the old preview hostname to the apex before invoking the
Worker; following the redirect uses the same cache and two-minute refresh gate.
The redirect adds no Octopus requests or changes to refresh timing or throttling.
PR previews have no cron triggers and are seeded from a fixture, so they make no
Octopus requests.

## Scheduled ingestion

Scheduled ingestion runs at minutes 7 and 37. Each run makes one half-hour
telemetry query per discovered device, independent of visitor count, with no
retries or polling. Recovery starts 24 hours behind the latest stored completed
period, capped at three days. Telemetry failures (including throttling) skip the
secondary feed and leave billing ingestion intact until the next scheduled run.

The GraphQL `smartMeterTelemetry(grouping: HALF_HOURLY)` response confirms a
period only when there is a valid consumption bucket at or beyond its end and the
end is at least two minutes old. A bucket timestamp is its start, so the final
bucket cannot prove its own completion. During an outage that bucket stays
unconfirmed; an open page keeps its last live partial reading, while a fresh page
may omit it until later telemetry or billing arrives. Withholding the last
unconfirmed bucket can keep the recovery watermark earlier and return more
history within the three-day cap.

Missing or invalid deltas never erase previously stored period consumption;
valid corrections, including zero, replace it. Grouped data does not establish
uninterrupted coverage inside older periods, and cannot repair historical gaps
by itself.
