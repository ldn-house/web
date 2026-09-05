import { createMemo, createSignal, For, Show } from 'solid-js';
import { linearScale, seriesCeiling, ticks } from '../lib/chart';
import { londonDay, londonTime } from '../lib/format';
import type { Slot } from '../lib/queries';
import { ChartTooltip } from './ChartTooltip';
import { PAD, TimeAxis, WIDTH, type Window } from './TimeAxis';

const HEIGHT = 220;
const SLOT_MS = 30 * 60_000;

export function UsageChart(props: {
  slots: readonly Slot[];
  estimated: readonly Slot[];
  window: Window;
}) {
  const allSlots = createMemo(() => [
    ...props.slots.map((slot) => ({ slot, estimated: false })),
    ...props.estimated.map((slot) => ({ slot, estimated: true })),
  ]);
  const [hovered, setHovered] = createSignal<
    { slot: Slot; estimated: boolean } | undefined
  >();
  const [focused, setFocused] = createSignal<
    { slot: Slot; estimated: boolean } | undefined
  >();
  const [keyboardIndex, setKeyboardIndex] = createSignal(0);
  const active = createMemo(() => hovered() ?? focused());
  const targets: SVGRectElement[] = [];
  const peak = createMemo(() =>
    seriesCeiling(
      props.slots.map((s) => s.kwh),
      props.estimated.map((s) => s.kwh),
    ),
  );
  const y = createMemo(() => linearScale([0, peak()], [HEIGHT - PAD.bottom, PAD.top]));
  const x = createMemo(() =>
    linearScale(
      [Date.parse(props.window.from), Date.parse(props.window.to)],
      [PAD.left, WIDTH - PAD.right],
    ),
  );
  const barWidth = createMemo(() => x()(SLOT_MS) - x()(0));
  const anchorX = (slot: Slot) => x()(Date.parse(slot.start)) + barWidth() / 2;
  const moveFocus = (event: KeyboardEvent, index: number) => {
    let next: number | undefined;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown')
      next = Math.min(index + 1, allSlots().length - 1);
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
      next = Math.max(index - 1, 0);
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = allSlots().length - 1;
    if (next === undefined || next === index) return;
    event.preventDefault();
    setKeyboardIndex(next);
    targets[next]?.focus();
  };

  return (
    <div class="relative">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        class="w-full"
        role="group"
        aria-label="Half-hourly electricity consumption. Use arrow keys to inspect each reading."
        onPointerLeave={() => setHovered()}
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

        <TimeAxis window={props.window} x={x()} height={HEIGHT} showNow={false} />

        <For each={allSlots()}>
          {({ slot, estimated }) => {
            const top = () => y()(slot.kwh);
            return (
              <rect
                x={x()(Date.parse(slot.start))}
                y={top()}
                width={Math.max(barWidth() - 0.5, 0.5)}
                height={HEIGHT - PAD.bottom - top()}
                class={estimated ? 'fill-accent/30' : 'fill-accent/70'}
              />
            );
          }}
        </For>

        <Show when={active()}>
          {(item) => (
            <>
              <line
                x1={anchorX(item().slot)}
                x2={anchorX(item().slot)}
                y1={PAD.top}
                y2={HEIGHT - PAD.bottom}
                stroke="currentColor"
                stroke-width="1"
                class="pointer-events-none text-white/35"
              />
              <circle
                cx={anchorX(item().slot)}
                cy={y()(item().slot.kwh)}
                r="3.5"
                class="pointer-events-none fill-accent stroke-neutral-950"
                stroke-width="2"
              />
            </>
          )}
        </Show>

        <For each={allSlots()}>
          {(item, index) => (
            <rect
              ref={(element) => {
                targets[index()] = element;
              }}
              x={x()(Date.parse(item.slot.start))}
              y={PAD.top}
              width={barWidth()}
              height={HEIGHT - PAD.bottom - PAD.top}
              fill="transparent"
              tabindex={keyboardIndex() === index() ? 0 : -1}
              role="img"
              aria-label={`${londonDay(item.slot.start)} ${londonTime(item.slot.start)}, ${item.slot.kwh.toFixed(2)} kilowatt hours, ${item.estimated ? 'meter estimate, not yet billed' : 'billed usage'}`}
              onPointerEnter={() => setHovered(item)}
              onFocus={() => {
                setKeyboardIndex(index());
                setFocused(item);
              }}
              onBlur={() => setFocused()}
              onKeyDown={(event) => moveFocus(event, index())}
            />
          )}
        </For>
      </svg>

      <Show when={active()}>
        {(item) => (
          <ChartTooltip
            anchorX={anchorX(item().slot)}
            heading={`${londonDay(item().slot.start)} · ${londonTime(item().slot.start)}`}
            value={`${item().slot.kwh.toFixed(2)} kWh`}
            detail={item().estimated ? 'Meter estimate' : 'Billed usage'}
          />
        )}
      </Show>
    </div>
  );
}
