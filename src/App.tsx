import type { JSX } from '@solidjs/web';
import { createMemo, Show } from 'solid-js';
import { RateChart } from './components/RateChart';
import { UsageChart } from './components/UsageChart';
import { londonDay, londonTime } from './lib/format';
import { cappedRate, recentConsumption, upcomingRates } from './lib/queries';

/** Rates are half-hourly, so the current slot starts on the last :00 or :30. */
function currentSlotStart(now = new Date()): string {
  const floored = new Date(now);
  floored.setUTCMinutes(now.getUTCMinutes() < 30 ? 0 : 30, 0, 0);
  return floored.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

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
  const slots = createMemo(async () => recentConsumption(48));
  const rates = createMemo(async () => upcomingRates(currentSlotStart()));
  const cap = createMemo(async () => cappedRate(new Date().toISOString()));

  const total = () => slots().reduce((sum, slot) => sum + slot.kwh, 0);
  const now = () => rates()[0];

  return (
    <main class="mx-auto max-w-3xl px-6 py-16">
      <h1 class="text-3xl font-semibold tracking-tight">ldn.house</h1>
      <p class="mt-3 text-neutral-400">
        Energy and climate data for one house in London.
      </p>

      <Panel title="Last 48 hours" aside={`${total().toFixed(1)} kWh`}>
        <Show
          when={slots().length}
          fallback={<p class="text-sm text-neutral-500">No readings yet.</p>}
        >
          <UsageChart slots={slots()} />
          <p class="mt-3 text-xs text-neutral-500">
            {londonDay(slots()[0]!.start)} {londonTime(slots()[0]!.start)} —{' '}
            {londonDay(slots().at(-1)!.start)} {londonTime(slots().at(-1)!.start)}
          </p>
        </Show>
      </Panel>

      <Panel
        title="Agile rates from now"
        aside={now() ? `${now()!.pIncVat.toFixed(2)}p/kWh` : undefined}
      >
        <Show
          when={rates().length}
          fallback={<p class="text-sm text-neutral-500">No rates published.</p>}
        >
          <RateChart rates={rates()} cap={cap()} />
          <p class="mt-3 text-xs text-neutral-500">
            Cheapest {Math.min(...rates().map((r) => r.pIncVat)).toFixed(2)}p at{' '}
            {londonTime(rates().reduce((a, b) => (b.pIncVat < a.pIncVat ? b : a)).start)}
          </p>
        </Show>
      </Panel>
    </main>
  );
}
