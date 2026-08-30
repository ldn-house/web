import type { JSX } from '@solidjs/web';
import { createMemo, Show } from 'solid-js';
import { RateChart } from './components/RateChart';
import type { Window } from './components/TimeAxis';
import { UsageChart } from './components/UsageChart';
import { addLondonDays, londonDay, londonMidnight, londonTime } from './lib/format';
import {
  cappedRate,
  consumptionBetween,
  type RateSlot,
  ratesBetween,
} from './lib/queries';

function Panel(props: { title: string; aside?: string; children: JSX.Element }) {
  return (
    <section class="mt-6 rounded-xl bg-surface-raised p-5">
      <div class="flex items-baseline justify-between gap-4">
        <h2 class="text-sm font-medium text-neutral-300">{props.title}</h2>
        <Show when={props.aside}>
          <p class="text-sm tabular-nums text-neutral-400">{props.aside}</p>
        </Show>
      </div>
      <div class="mt-4">{props.children}</div>
    </section>
  );
}

export default function App() {
  // Whole London days, from the day before yesterday to the end of tomorrow.
  // Readings lag by up to two days and rates run a day ahead, so one window
  // covers both and the charts share an axis.
  const now = new Date().toISOString();
  const today = londonMidnight(now);
  const window: Window = {
    from: addLondonDays(today, -2),
    to: addLondonDays(today, 2),
    now,
  };

  const slots = createMemo(async () => consumptionBetween(window.from, window.to));
  const rates = createMemo(async () => ratesBetween(window.from, window.to));
  const cap = createMemo(async () => cappedRate(now));

  const total = () => slots().reduce((sum, slot) => sum + slot.kwh, 0);
  const current = () =>
    rates().find(
      (r) => r.start <= now && Date.parse(r.start) + 1_800_000 > Date.parse(now),
    );
  const cheapestAhead = () =>
    rates()
      .filter((r) => r.start >= now)
      .reduce<RateSlot | undefined>(
        (best, r) => (!best || r.pIncVat < best.pIncVat ? r : best),
        undefined,
      );

  return (
    <main class="mx-auto max-w-3xl px-6 py-16">
      <h1 class="text-3xl font-semibold tracking-tight">ldn.house</h1>
      <p class="mt-3 text-neutral-400">
        Energy and climate data for one house in London.
      </p>

      <Panel
        title="Electricity consumption"
        aside={slots().length ? `${total().toFixed(1)} kWh` : undefined}
      >
        <Show
          when={slots().length}
          fallback={<p class="text-sm text-neutral-500">No readings yet.</p>}
        >
          <UsageChart slots={slots()} window={window} />
          <p class="mt-3 text-xs text-neutral-500">
            Latest reading {londonDay(slots().at(-1)!.start)}{' '}
            {londonTime(slots().at(-1)!.start)}
          </p>
        </Show>
      </Panel>

      <Panel
        title="Electricity unit rate"
        aside={current() ? `${current()!.pIncVat.toFixed(2)}p/kWh now` : undefined}
      >
        <Show
          when={rates().length}
          fallback={<p class="text-sm text-neutral-500">No rates published.</p>}
        >
          <RateChart rates={rates()} cap={cap()} window={window} />
          <ul class="mt-2 flex gap-5 text-xs text-neutral-400">
            <li class="flex items-center gap-2">
              <span class="inline-block h-0.5 w-5 bg-accent" />
              Agile
            </li>
            <Show when={cap()}>
              {(value) => (
                <li class="flex items-center gap-2">
                  <span class="inline-block h-0 w-5 border-t border-dashed border-sky-400" />
                  Price cap (SVT) {value().toFixed(1)}p/kWh
                </li>
              )}
            </Show>
          </ul>
          <Show when={cheapestAhead()}>
            {(slot) => (
              <p class="mt-3 text-xs text-neutral-500">
                Cheapest ahead {slot().pIncVat.toFixed(2)}p at {londonDay(slot().start)}{' '}
                {londonTime(slot().start)}
              </p>
            )}
          </Show>
        </Show>
      </Panel>
    </main>
  );
}
