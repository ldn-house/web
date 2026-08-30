import { createMemo, For } from 'solid-js';
import { linearScale, niceCeiling, ticks } from '../lib/chart';
import { londonTime } from '../lib/format';
import type { Slot } from '../lib/queries';
import { PAD, TimeAxis, WIDTH, type Window } from './TimeAxis';

const HEIGHT = 220;
const SLOT_MS = 30 * 60_000;

export function UsageChart(props: {
  slots: readonly Slot[];
  estimated: readonly Slot[];
  window: Window;
}) {
  const peak = createMemo(() =>
    niceCeiling(Math.max(0, ...props.slots.map((s) => s.kwh))),
  );
  const y = createMemo(() => linearScale([0, peak()], [HEIGHT - PAD.bottom, PAD.top]));
  const x = createMemo(() =>
    linearScale(
      [Date.parse(props.window.from), Date.parse(props.window.to)],
      [PAD.left, WIDTH - PAD.right],
    ),
  );
  const barWidth = createMemo(() => x()(SLOT_MS) - x()(0));

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      class="w-full"
      role="img"
      aria-label="Half-hourly electricity consumption"
    >
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

      <TimeAxis window={props.window} x={x()} height={HEIGHT} />

      <For
        each={[
          ...props.slots.map((s) => [s, false] as const),
          ...props.estimated.map((s) => [s, true] as const),
        ]}
      >
        {([slot, estimated]) => {
          const top = () => y()(slot.kwh);
          return (
            <rect
              x={x()(Date.parse(slot.start))}
              y={top()}
              width={Math.max(barWidth() - 0.5, 0.5)}
              height={HEIGHT - PAD.bottom - top()}
              class={estimated ? 'fill-accent/30' : 'fill-accent/70'}
            >
              <title>
                {londonTime(slot.start)} — {slot.kwh.toFixed(2)} kWh
                {estimated ? ' (meter, not yet billed)' : ''}
              </title>
            </rect>
          );
        }}
      </For>
    </svg>
  );
}
