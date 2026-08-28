import { createMemo, For } from 'solid-js';
import { linearScale, niceCeiling } from '../lib/chart';
import { londonTime } from '../lib/format';
import type { Slot } from '../lib/queries';

const WIDTH = 720;
const HEIGHT = 200;
const PAD = { top: 8, right: 8, bottom: 22, left: 32 };

/** Bars live in the HTML, so the chart reads without JavaScript. */
export function UsageChart(props: { slots: readonly Slot[] }) {
  // Memoised because each is read once per bar: recomputing would rescan
  // every slot for each one.
  const peak = createMemo(() => niceCeiling(Math.max(...props.slots.map((s) => s.kwh))));
  const y = createMemo(() => linearScale([0, peak()], [HEIGHT - PAD.bottom, PAD.top]));
  const barWidth = createMemo(
    () => (WIDTH - PAD.left - PAD.right) / Math.max(props.slots.length, 1),
  );

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      class="w-full"
      role="img"
      aria-label="Half-hourly electricity consumption"
    >
      {/* No root <title>: it would tooltip the gaps between bars too. */}
      <For each={[0, 0.5, 1]}>
        {(fraction) => (
          <>
            <line
              x1={PAD.left}
              x2={WIDTH - PAD.right}
              y1={y()(peak() * fraction)}
              y2={y()(peak() * fraction)}
              stroke="currentColor"
              class="text-white/10"
            />
            <text
              x={PAD.left - 6}
              y={y()(peak() * fraction) + 4}
              text-anchor="end"
              class="fill-neutral-500 text-[10px]"
            >
              {(peak() * fraction).toFixed(1)}
            </text>
          </>
        )}
      </For>
      <For each={props.slots}>
        {(slot, index) => {
          const x = () => PAD.left + index() * barWidth();
          const top = () => y()(slot.kwh);
          return (
            <rect
              x={x()}
              y={top()}
              width={Math.max(barWidth() - 1, 1)}
              height={HEIGHT - PAD.bottom - top()}
              class="fill-accent/70"
            >
              <title>
                {londonTime(slot.start)} — {slot.kwh.toFixed(2)} kWh
              </title>
            </rect>
          );
        }}
      </For>
    </svg>
  );
}
