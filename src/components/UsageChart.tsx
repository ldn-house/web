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
import { londonDay, londonTime, londonTimeRange } from '../lib/format';
import { ChartTooltip } from './ChartTooltip';
import { PAD, TimeAxis, WIDTH, type Window } from './TimeAxis';

const HEIGHT = 220;
const BASELINE = HEIGHT - PAD.bottom;
/**
 * A half hour that is still recording is drawn dimmed under a bright lid at the
 * measured value: "this much so far", with nothing implied about the rest.
 * The lid also keeps a zero-so-far period visible on the axis.
 */
const CAP = 2.5;

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
  const captionId = createUniqueId();
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
  // A half hour is only a few pixels wide across three days, and fewer on a
  // phone, so the running column gets a floor width and stays centred on its bar.
  const highlightWidth = () => Math.max(barWidth() + 2, 7);
  const highlightLeft = (slot: UsageSlot) => anchorX(slot) - highlightWidth() / 2;

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
  const currentPartial = createMemo(() =>
    props.slots.find((slot) => isCurrent(slot) && isPartialSlot(slot)),
  );

  /** Explains the odd-looking bar in words, whether it is live or stranded. */
  const note = createMemo(() => {
    const slot = currentPartial() ?? props.slots.filter(isPartialSlot).at(-1);
    if (!slot) return undefined;
    const kwh = slot.kwh.toFixed(2);
    const coverage = londonTime(slot.through);
    return isRunning(slot)
      ? {
          state: 'In progress',
          text: `${kwh} kWh so far in ${londonTimeRange(slot.start)} · measured through ${coverage}`,
        }
      : {
          state: 'Partial',
          text: `${kwh} kWh recorded in ${londonDay(slot.start)} ${londonTimeRange(slot.start)} · last reading ${coverage}`,
        };
  });

  const tooltipValue = (slot: UsageSlot) =>
    `${slot.kwh.toFixed(2)} kWh${isPartialSlot(slot) ? ' so far' : ''}`;
  const tooltipDetail = (slot: UsageSlot) =>
    isPartialSlot(slot)
      ? `${isRunning(slot) ? 'In progress' : 'Partial'} · through ${londonTime(slot.through)}`
      : SOURCE_LABEL[slot.source];
  const ariaLabel = (slot: UsageSlot) => {
    const when = `${londonDay(slot.start)} ${londonTimeRange(slot.start)}`;
    const source = SOURCE_LABEL[slot.source];
    const kwh = `${slot.kwh.toFixed(2)} kilowatt hours`;
    if (!isPartialSlot(slot)) return `${when}, ${kwh}, ${source}`;
    const coverage = londonTime(slot.through);
    return isRunning(slot)
      ? `${when}, in progress, ${kwh} so far, measured through ${coverage}, ${source}`
      : `${when}, incomplete period, ${kwh} recorded, last reading ${coverage}, ${source}`;
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
        aria-describedby={note() ? captionId : undefined}
        onPointerLeave={() => setHoveredStart()}
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

        {/* Tint behind the running half hour, so the column reads as one thing. */}
        <Show when={currentPartial()}>
          {(slot) => (
            <rect
              x={highlightLeft(slot())}
              y={PAD.top}
              width={highlightWidth()}
              height={BASELINE - PAD.top}
              class="pointer-events-none fill-accent/8"
            />
          )}
        </Show>

        <For each={props.slots} keyed={(slot) => slot.start}>
          {(slot) => {
            const partial = () => isPartialSlot(slot());
            const top = () => y()(slot().kwh);
            const width = () => Math.max(barWidth() - 0.5, 0.5);
            return (
              <>
                <rect
                  x={barLeft(slot())}
                  y={top()}
                  width={width()}
                  height={BASELINE - top()}
                  class={partial() ? 'fill-accent/25' : 'fill-accent/70'}
                />
                <Show when={partial()}>
                  <rect
                    x={barLeft(slot())}
                    y={Math.min(top(), BASELINE - CAP)}
                    width={width()}
                    height={CAP}
                    class="fill-accent"
                  />
                </Show>
              </>
            );
          }}
        </For>

        {/* Bracket and marker over the running column: quiet, and never animated. */}
        <Show when={currentPartial()}>
          {(slot) => (
            <>
              <rect
                x={highlightLeft(slot())}
                y={PAD.top}
                width={highlightWidth()}
                height={BASELINE - PAD.top}
                fill="none"
                stroke="currentColor"
                stroke-width="1"
                class={[
                  'pointer-events-none',
                  isRunning(slot()) ? 'text-accent/45' : 'text-white/30',
                ]}
              />
              <polygon
                points={`${anchorX(slot()) - 4},${PAD.top - 6} ${anchorX(slot()) + 4},${PAD.top - 6} ${anchorX(slot())},${PAD.top}`}
                class={[
                  'pointer-events-none',
                  isRunning(slot()) ? 'fill-accent' : 'fill-neutral-400',
                ]}
              />
            </>
          )}
        </Show>

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
            value={tooltipValue(slot())}
            detail={tooltipDetail(slot())}
          />
        )}
      </Show>

      <Show when={note()}>
        {(info) => (
          <p
            id={captionId}
            class="mt-2 flex items-start gap-2 text-xs leading-4 text-neutral-500"
          >
            <span
              aria-hidden="true"
              class="mt-0.5 inline-block h-3 w-2 shrink-0 border-t-2 border-accent bg-accent/25"
            />
            {/* Tabular digits so the growing kWh figure does not twitch. */}
            <span class="tabular-nums">
              <span class="font-medium text-neutral-300">{info().state}</span> ·{' '}
              {info().text}
            </span>
          </p>
        )}
      </Show>
    </div>
  );
}
