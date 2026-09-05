import { createMemo, createSignal, For, Show } from 'solid-js';
import { linearScale, niceCeiling, stepPath, ticks } from '../lib/chart';
import { londonDay, londonTime } from '../lib/format';
import type { RateSlot } from '../lib/queries';
import { ChartTooltip } from './ChartTooltip';
import { PAD, TimeAxis, WIDTH, type Window } from './TimeAxis';

const HEIGHT = 220;
const SLOT_MS = 30 * 60_000;

export function RateChart(props: {
  rates: readonly RateSlot[];
  cap: number | null;
  window: Window;
}) {
  const [hovered, setHovered] = createSignal<RateSlot>();
  const [focused, setFocused] = createSignal<RateSlot>();
  const [keyboardIndex, setKeyboardIndex] = createSignal(0);
  const active = createMemo(() => hovered() ?? focused());
  const targets: SVGRectElement[] = [];
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
  const anchorX = (rate: RateSlot) => x()(Date.parse(rate.start)) + slotWidth() / 2;
  const moveFocus = (event: KeyboardEvent, index: number) => {
    let next: number | undefined;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown')
      next = Math.min(index + 1, props.rates.length - 1);
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
      next = Math.max(index - 1, 0);
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = props.rates.length - 1;
    if (next === undefined || next === index) return;
    event.preventDefault();
    setKeyboardIndex(next);
    targets[next]?.focus();
  };

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
    <div class="relative">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        class="w-full"
        role="group"
        aria-label="Agile unit rates against the capped standard tariff. Use arrow keys to inspect each rate."
        onPointerLeave={() => setHovered()}
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
            </>
          )}
        </Show>

        <For each={props.rates}>
          {(rate, index) => (
            <rect
              ref={(element) => {
                targets[index()] = element;
              }}
              x={x()(Date.parse(rate.start))}
              y={PAD.top}
              width={slotWidth()}
              height={HEIGHT - PAD.bottom - PAD.top}
              fill="transparent"
              tabindex={keyboardIndex() === index() ? 0 : -1}
              role="img"
              aria-label={`${londonDay(rate.start)} ${londonTime(rate.start)}, ${rate.pIncVat.toFixed(2)} pence per kilowatt hour`}
              onPointerEnter={() => setHovered(rate)}
              onFocus={() => {
                setKeyboardIndex(index());
                setFocused(rate);
              }}
              onBlur={() => setFocused()}
              onKeyDown={(event) => moveFocus(event, index())}
            />
          )}
        </For>

        <Show when={active()}>
          {(rate) => (
            <>
              <line
                x1={anchorX(rate())}
                x2={anchorX(rate())}
                y1={PAD.top}
                y2={HEIGHT - PAD.bottom}
                stroke="currentColor"
                stroke-width="1"
                class="pointer-events-none text-white/35"
              />
              <circle
                cx={anchorX(rate())}
                cy={y()(rate().pIncVat)}
                r="3.5"
                class="pointer-events-none fill-accent stroke-neutral-950"
                stroke-width="2"
              />
            </>
          )}
        </Show>
      </svg>

      <Show when={active()}>
        {(rate) => (
          <ChartTooltip
            anchorX={anchorX(rate())}
            heading={`${londonDay(rate().start)} · ${londonTime(rate().start)}`}
            value={`${rate().pIncVat.toFixed(2)}p/kWh`}
            detail="Agile unit rate"
          />
        )}
      </Show>
    </div>
  );
}
