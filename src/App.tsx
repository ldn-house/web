import { UsageChart } from './components/UsageChart';
import { sampleDay } from './lib/sample-day';

export default function App() {
  const slots = sampleDay();
  const total = slots.reduce((sum, slot) => sum + slot.kwh, 0);

  return (
    <main class="mx-auto max-w-3xl px-6 py-16">
      <h1 class="text-3xl font-semibold tracking-tight">ldn.house</h1>
      <p class="mt-3 text-neutral-400">
        Energy and climate data for one house in London.
      </p>

      <section class="mt-10 rounded-xl bg-surface-raised p-5">
        <div class="flex items-baseline justify-between">
          <h2 class="text-sm font-medium text-neutral-300">Half-hourly consumption</h2>
          <p class="text-sm tabular-nums text-neutral-400">{total.toFixed(1)} kWh</p>
        </div>
        <div class="mt-4">
          <UsageChart slots={slots} />
        </div>
        <p class="mt-3 text-xs text-neutral-500">
          Synthetic data — Octopus ingest not wired up yet.
        </p>
      </section>
    </main>
  );
}
