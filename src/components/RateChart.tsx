import { createMemo, For, Show } from 'solid-js';
import { linearScale, niceCeiling, stepPath, ticks } from '../lib/chart';
import { londonTime } from '../lib/format';
import type { RateSlot } from '../lib/queries';
import { PAD, TimeAxis, WIDTH, type Window } from './TimeAxis';

const HEIGHT = 220;
const SLOT_MS = 30 * 60_000;

export function RateChart(props: {
  rates: readonly RateSlot[];
  cap: number | null;
  window: Window;
}) {
  const prices = createMemo(() => props.rates.map((r) => r.pIncVat));
  const top = createMemo(() => niceCeiling(Math.max(...prices(), props.cap ?? 0, 1)));
  const bottom = createMemo(() => Math.min(...prices(), 0));

  const y = createMemo(() =>
    linearScale([bottom(), top()], [HEIGHT - PAD.bottom, PAD.top]),
  );
  const x = createMemo(() =>
    linearScale(
      [Date.parse(props.window.from), Date.parse(props.window.to)],
      [PAD.left, WIDTH - PAD.right],
    ),
  );
  const slotWidth = createMemo(() => x()(SLOT_MS) - x()(0));

  const line = createMemo(() => {
    const last = props.rates.at(-1);
    return stepPath(
      props.rates.map((rate) => ({
        x: x()(Date.parse(rate.start)),
        y: y()(rate.pIncVat),
      })),
      last ? x()(Date.parse(last.start) + SLOT_MS) : PAD.left,
    );
  });

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      class="w-full"
      role="img"
      aria-label="Agile unit rates against the capped standard tariff"
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

      <TimeAxis window={props.window} x={x()} height={HEIGHT} />

      <path
        d={line()}
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        class="text-accent"
      />

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
              class="text-sky-400"
            />
            <text x={PAD.left + 4} y={y()(cap()) - 5} class="fill-sky-400 text-[10px]">
              price cap {cap().toFixed(1)}p
            </text>
          </>
        )}
      </Show>

      <For each={props.rates}>
        {(rate) => (
          <rect
            x={x()(Date.parse(rate.start))}
            y={PAD.top}
            width={slotWidth()}
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
