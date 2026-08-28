import { createMemo, For } from 'solid-js';
import { linearScale, niceCeiling, tickIndices, ticks } from '../lib/chart';
import { axisTicks, londonTime } from '../lib/format';
import type { Slot } from '../lib/queries';

const WIDTH = 720;
const HEIGHT = 220;
const PAD = { top: 10, right: 8, bottom: 24, left: 38 };

export function UsageChart(props: { slots: readonly Slot[] }) {
  const peak = createMemo(() => niceCeiling(Math.max(...props.slots.map((s) => s.kwh))));
  const y = createMemo(() => linearScale([0, peak()], [HEIGHT - PAD.bottom, PAD.top]));
  const barWidth = createMemo(
    () => (WIDTH - PAD.left - PAD.right) / Math.max(props.slots.length, 1),
  );
  const xTicks = createMemo(() =>
    axisTicks(
      props.slots.map((s) => s.start),
      tickIndices(props.slots.length, 6),
    ),
  );

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      class="w-full"
      role="img"
      aria-label="Half-hourly electricity consumption"
    >
      {/* No root <title>: it would tooltip the gaps between bars too. */}
      <For each={ticks(peak(), 4)}>
        {(value) => (
          <>
            <line
              x1={PAD.left}
              x2={WIDTH - PAD.right}
              y1={y()(value)}
              y2={y()(value)}
              stroke="currentColor"
              class="text-white/10"
            />
            <text
              x={PAD.left - 6}
              y={y()(value) + 4}
              text-anchor="end"
              class="fill-neutral-500 text-[10px]"
            >
              {value.toFixed(1)}
            </text>
          </>
        )}
      </For>

      <For each={xTicks()}>
        {(tick) => (
          <text
            x={PAD.left + tick.index * barWidth()}
            y={HEIGHT - 8}
            text-anchor="middle"
            class="fill-neutral-500 text-[10px]"
          >
            {tick.day ? `${tick.day} ${tick.time}` : tick.time}
          </text>
        )}
      </For>

      <For each={props.slots}>
        {(slot, index) => {
          const left = () => PAD.left + index() * barWidth();
          const top = () => y()(slot.kwh);
          return (
            <rect
              x={left()}
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
