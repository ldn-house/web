import { createMemo, For, Show } from 'solid-js';
import { linearScale, niceCeiling, stepPath, tickIndices, ticks } from '../lib/chart';
import { axisTicks, londonTime } from '../lib/format';
import type { RateSlot } from '../lib/queries';

const WIDTH = 720;
const HEIGHT = 220;
const PAD = { top: 10, right: 8, bottom: 24, left: 38 };

export function RateChart(props: { rates: readonly RateSlot[]; cap: number | null }) {
  const prices = createMemo(() => props.rates.map((r) => r.pIncVat));
  const top = createMemo(() => niceCeiling(Math.max(...prices(), props.cap ?? 0)));
  const bottom = createMemo(() => Math.min(...prices(), 0));

  const y = createMemo(() =>
    linearScale([bottom(), top()], [HEIGHT - PAD.bottom, PAD.top]),
  );
  const x = createMemo(() =>
    linearScale([0, Math.max(props.rates.length, 1)], [PAD.left, WIDTH - PAD.right]),
  );

  const xTicks = createMemo(() =>
    axisTicks(
      props.rates.map((r) => r.start),
      tickIndices(props.rates.length, 6),
    ),
  );

  const line = createMemo(() =>
    stepPath(
      props.rates.map((rate, i) => ({ x: x()(i), y: y()(rate.pIncVat) })),
      WIDTH - PAD.right,
    ),
  );

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      class="w-full"
      role="img"
      aria-label="Upcoming Agile unit rates against the capped standard tariff"
    >
      <For each={ticks(top(), 5)}>
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
              {value.toFixed(0)}p
            </text>
          </>
        )}
      </For>

      <For each={xTicks()}>
        {(tick) => (
          <text
            x={x()(tick.index)}
            y={HEIGHT - 8}
            text-anchor="middle"
            class="fill-neutral-500 text-[10px]"
          >
            {tick.day ? `${tick.day} ${tick.time}` : tick.time}
          </text>
        )}
      </For>

      <Show when={props.cap}>
        {(cap) => (
          <>
            <line
              x1={PAD.left}
              x2={WIDTH - PAD.right}
              y1={y()(cap())}
              y2={y()(cap())}
              stroke="currentColor"
              stroke-dasharray="4 3"
              class="text-neutral-400"
            />
            <text
              x={PAD.left + 4}
              y={y()(cap()) - 5}
              class="fill-neutral-400 text-[10px]"
            >
              price cap {cap().toFixed(1)}p
            </text>
          </>
        )}
      </Show>

      <path
        d={line()}
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        class="text-accent"
      />

      {/* Invisible hit areas so every slot keeps a native tooltip. */}
      <For each={props.rates}>
        {(rate, index) => (
          <rect
            x={x()(index())}
            y={PAD.top}
            width={x()(1) - x()(0)}
            height={HEIGHT - PAD.bottom - PAD.top}
            fill="transparent"
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
