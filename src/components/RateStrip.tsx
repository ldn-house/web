import { createMemo, For } from 'solid-js';
import { linearScale } from '../lib/chart';
import { londonTime } from '../lib/format';
import type { RateSlot } from '../lib/queries';

const WIDTH = 720;
const HEIGHT = 56;

/**
 * Agile prices as a horizontal band. Server-rendered like the usage chart, so
 * it is readable without JavaScript; `<title>` carries the exact price.
 */
export function RateStrip(props: { rates: readonly RateSlot[] }) {
  // Read once per rate, so the bounds and scale are memoised rather than
  // rescanning every price for each bar.
  const prices = createMemo(() => props.rates.map((r) => r.pIncVat));
  const intensity = createMemo(() =>
    linearScale([Math.min(...prices(), 0), Math.max(...prices(), 1)], [0.15, 1]),
  );
  const width = createMemo(() => WIDTH / Math.max(props.rates.length, 1));

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      class="w-full"
      role="img"
      aria-label="Upcoming Agile unit rates"
    >
      <For each={props.rates}>
        {(rate, index) => (
          <rect
            x={index() * width()}
            y={0}
            width={Math.max(width() - 0.5, 0.5)}
            height={HEIGHT}
            class={rate.pIncVat < 0 ? 'fill-emerald-400' : 'fill-accent'}
            opacity={rate.pIncVat < 0 ? 1 : intensity()(rate.pIncVat)}
          >
            <title>
              {londonTime(rate.start)} — {rate.pIncVat.toFixed(2)}p/kWh
            </title>
          </rect>
        )}
      </For>
    </svg>
  );
}
