/**
 * Records a slice of the live Octopus API into src/fixtures/octopus.json for
 * seeding preview deployments. Run manually with OCTOPUS_API_KEY in .dev.vars;
 * the output is committed, so every identifier is replaced with a synthetic one.
 *
 *   bun scripts/capture-fixture.ts [days]
 */
import { writeFileSync } from 'node:fs';
import {
  discoverAccountNumber,
  fetchAccount,
  fetchConsumption,
  fetchStandingCharges,
  fetchUnitRates,
} from '../src/lib/octopus';
import type { OctopusFixture } from '../src/lib/replay';

const ACCOUNT = 'A-SYNTH01';
const MPAN = '1234567890123';
const SERIAL = 'SYNTH00000001';

const days = Number(process.argv[2] ?? 14);
const key = process.env.OCTOPUS_API_KEY;
if (!key) throw new Error('OCTOPUS_API_KEY not set — source .dev.vars first');

const account = await fetchAccount(key, await discoverAccountNumber(key));
const point = account.meterPoints[0];
if (!point) throw new Error('No import meter point on the account');

const readings = (
  await Promise.all(
    point.meters.map((m) =>
      fetchConsumption(key, point.mpan, m.serial_number, '2020-01-01T00:00:00Z'),
    ),
  )
).flat();
readings.sort((a, b) => a.interval_start.localeCompare(b.interval_start));

// Trim to the most recent window; the fixture ships inside the Worker bundle.
const consumption = readings.slice(-days * 48);
const from = consumption[0]?.interval_start ?? '2020-01-01T00:00:00Z';

const tariffs = [...new Set(point.agreements.map((a) => a.tariff_code))];
const unitRates: Record<string, unknown[]> = {};
const standingCharges: Record<string, unknown[]> = {};
for (const tariff of tariffs) {
  unitRates[tariff] = await fetchUnitRates(key, tariff, from);
  standingCharges[tariff] = await fetchStandingCharges(key, tariff, from);
}

const fixture: OctopusFixture = {
  accountNumber: ACCOUNT,
  mpan: MPAN,
  meterSerial: SERIAL,
  agreements: point.agreements,
  consumption,
  unitRates,
  standingCharges,
};

const serialised = JSON.stringify(fixture);
for (const [label, real] of [
  ['MPAN', point.mpan],
  ['meter serial', point.meters.map((m) => m.serial_number)].flat(),
  ['account number', account.number],
].flatMap(([label, v]) =>
  Array.isArray(v) ? v.map((x) => [label, x]) : [[label, v]],
) as [string, string][]) {
  if (serialised.includes(real))
    throw new Error(`Refusing to write fixture: ${label} leaked`);
}

writeFileSync('src/fixtures/octopus.json', `${JSON.stringify(fixture, null, 0)}\n`);
console.log(
  `wrote src/fixtures/octopus.json — ${consumption.length} readings, ` +
    `${tariffs.map((t) => `${t}: ${unitRates[t]!.length}`).join(', ')}, ` +
    `${(serialised.length / 1024).toFixed(0)} kB`,
);
