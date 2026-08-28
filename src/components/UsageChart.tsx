import { For } from 'solid-js';
import { linearScale, niceCeiling } from '../lib/chart';

export interface Slot {
  /** Start of the half-hour slot. */
  start: Date;
  kwh: number;
}

const WIDTH = 720;
const HEIGHT = 200;
const PAD = { top: 8, right: 8, bottom: 22, left: 32 };

/** Bars live in the HTML, so the chart reads without JavaScript. */
export function UsageChart(props: { slots: readonly Slot[] }) {
  const peak = () => niceCeiling(Math.max(...props.slots.map((s) => s.kwh)));
  const y = () => linearScale([0, peak()], [HEIGHT - PAD.bottom, PAD.top]);
  const barWidth = () => (WIDTH - PAD.left - PAD.right) / Math.max(props.slots.length, 1);

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
                {slot.start.toISOString().slice(11, 16)} — {slot.kwh.toFixed(2)} kWh
              </title>
            </rect>
          );
        }}
      </For>
    </svg>
  );
}
