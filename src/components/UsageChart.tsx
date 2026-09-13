import {
  createMemo,
  createSignal,
  createUniqueId,
  For,
  onCleanup,
  Show,
  untrack,
} from 'solid-js';
import { linearScale, seriesCeiling, ticks } from '../lib/chart';
import { HALF_HOUR_MS, isPartialSlot, type UsageSlot } from '../lib/consumption';
import { londonDay, londonTimeRange } from '../lib/format';
import { ChartTooltip } from './ChartTooltip';
import { PAD, TimeAxis, WIDTH, type Window } from './TimeAxis';

const HEIGHT = 220;
const BASELINE = HEIGHT - PAD.bottom;
// Keep a zero-so-far period visible on the axis.
const MIN_PARTIAL_HEIGHT = 2.5;

/** Source stays in the tooltip; completed periods share the same visual weight. */
const SOURCE_LABEL = {
  billing: 'Octopus reading',
  meter: 'Home Mini reading',
} as const;

export function UsageChart(props: {
  slots: readonly UsageSlot[];
  window: Window;
  live: boolean;
}) {
  const stripeId = createUniqueId();
  const stripeFill = `url(#${stripeId})`;
  // Hover and focus remember a period, not a slot object: polling hands us a
  // fresh array every few seconds, and the pointer or keyboard has to stay on
  // the same half hour while its value grows.
  const [hoveredStart, setHoveredStart] = createSignal<string>();
  const [focusedStart, setFocusedStart] = createSignal<string>();
  const [keyboardStart, setKeyboardStart] = createSignal<string>();
  const targets = new Map<string, SVGRectElement>();

  const slotAt = (start: string | undefined) =>
    start === undefined ? undefined : props.slots.find((slot) => slot.start === start);
  const active = createMemo(() => slotAt(hoveredStart()) ?? slotAt(focusedStart()));
  // One tab stop for the series, falling back to the first period when the
  // remembered one scrolls out of the window.
  const tabStop = createMemo(() => {
    const wanted = keyboardStart();
    return wanted !== undefined && props.slots.some((slot) => slot.start === wanted)
      ? wanted
      : props.slots[0]?.start;
  });

  const peak = createMemo(() => seriesCeiling(props.slots.map((slot) => slot.kwh)));
  const y = createMemo(() => linearScale([0, peak()], [BASELINE, PAD.top]));
  const x = createMemo(() =>
    linearScale(
      [Date.parse(props.window.from), Date.parse(props.window.to)],
      [PAD.left, WIDTH - PAD.right],
    ),
  );
  const barWidth = createMemo(() => x()(HALF_HOUR_MS) - x()(0));
  const barLeft = (slot: UsageSlot) => x()(Date.parse(slot.start));
  const anchorX = (slot: UsageSlot) => barLeft(slot) + barWidth() / 2;

  /** The period the clock is inside; readings for it are still arriving. */
  const isCurrent = (slot: UsageSlot) => {
    const start = Date.parse(slot.start);
    const now = Date.parse(props.window.now);
    return start <= now && now < start + HALF_HOUR_MS;
  };
  /**
   * Only the period we are inside *and* still hearing from is running. A
   * partial period never becomes complete just because the clock moved on, and
   * it never claims to be updating once the live feed has dropped.
   */
  const isRunning = (slot: UsageSlot) =>
    props.live &&
    isCurrent(slot) &&
    isPartialSlot(slot) &&
    Date.parse(props.window.now) - Date.parse(slot.through) < 120_000;

  const ariaLabel = (slot: UsageSlot) => {
    const when = `${londonDay(slot.start)} ${londonTimeRange(slot.start)}`;
    const source = SOURCE_LABEL[slot.source];
    const kwh = `${slot.kwh.toFixed(2)} kilowatt hours`;
    if (!isPartialSlot(slot)) return `${when}, ${kwh}, ${source}`;
    return isRunning(slot)
      ? `${when}, in progress, ${kwh}, ${source}`
      : `${when}, incomplete period, ${kwh}, ${source}`;
  };

  const moveFocus = (event: KeyboardEvent, start: string) => {
    const slots = props.slots;
    const index = slots.findIndex((slot) => slot.start === start);
    if (index < 0) return;
    let next: number | undefined;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown')
      next = Math.min(index + 1, slots.length - 1);
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
      next = Math.max(index - 1, 0);
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = slots.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    const target = next === index ? undefined : slots[next];
    if (!target) return;
    setKeyboardStart(target.start);
    targets.get(target.start)?.focus();
  };

  return (
    <div class="relative">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        class="w-full"
        role="group"
        aria-label="Half-hourly electricity consumption. Use arrow keys to inspect each half hour."
        onPointerLeave={() => setHoveredStart()}
      >
        <defs>
          <pattern
            id={stripeId}
            width="4"
            height="4"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect width="2" height="4" class="fill-accent/70" />
          </pattern>
        </defs>
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

        <For each={props.slots} keyed={(slot) => slot.start}>
          {(slot) => {
            const partial = () => isPartialSlot(slot());
            const top = () =>
              partial()
                ? Math.min(y()(slot().kwh), BASELINE - MIN_PARTIAL_HEIGHT)
                : y()(slot().kwh);
            return (
              <rect
                x={barLeft(slot())}
                y={top()}
                width={Math.max(barWidth() - 0.5, 0.5)}
                height={BASELINE - top()}
                fill={partial() ? stripeFill : undefined}
                class={partial() ? undefined : 'fill-accent/70'}
              />
            );
          }}
        </For>

        <Show when={active()}>
          {(slot) => (
            <>
              <line
                x1={anchorX(slot())}
                x2={anchorX(slot())}
                y1={PAD.top}
                y2={BASELINE}
                stroke="currentColor"
                stroke-width="1"
                class="pointer-events-none text-white/35"
              />
              <circle
                cx={anchorX(slot())}
                cy={y()(slot().kwh)}
                r="3.5"
                class="pointer-events-none fill-accent stroke-neutral-950"
                stroke-width="2"
              />
            </>
          )}
        </Show>

        <For each={props.slots} keyed={(slot) => slot.start}>
          {(slot) => {
            // Keyed rows survive polling, so the focused rect is never replaced.
            const start = untrack(() => slot().start);
            onCleanup(() => targets.delete(start));
            return (
              <rect
                ref={(element) => {
                  targets.set(start, element);
                }}
                x={barLeft(slot())}
                y={PAD.top}
                width={barWidth()}
                height={BASELINE - PAD.top}
                fill="transparent"
                tabindex={tabStop() === start ? 0 : -1}
                role="img"
                aria-label={ariaLabel(slot())}
                onPointerEnter={() => setHoveredStart(start)}
                onFocus={() => {
                  setKeyboardStart(start);
                  setFocusedStart(start);
                }}
                onBlur={() => setFocusedStart()}
                onKeyDown={(event) => moveFocus(event, start)}
              />
            );
          }}
        </For>
      </svg>

      <Show when={active()}>
        {(slot) => (
          <ChartTooltip
            anchorX={anchorX(slot())}
            heading={`${londonDay(slot().start)} · ${londonTimeRange(slot().start)}`}
            value={`${slot().kwh.toFixed(2)} kWh`}
            detail={`${SOURCE_LABEL[slot().source]}${isPartialSlot(slot()) ? ' · Partial' : ''}`}
            swatchFill={isPartialSlot(slot()) ? stripeFill : undefined}
          />
        )}
      </Show>
    </div>
  );
}
