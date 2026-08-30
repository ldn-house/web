import { For, Show } from 'solid-js';
import type { Scale } from '../lib/chart';
import { dayTicks } from '../lib/format';

export const WIDTH = 720;
export const PAD = { top: 10, right: 8, bottom: 26, left: 38 };

export interface Window {
  from: string;
  to: string;
  now: string;
}

export function TimeAxis(props: { window: Window; x: Scale; height: number }) {
  const at = (iso: string) => props.x(Date.parse(iso));
  return (
    <>
      <For each={dayTicks(props.window.from, props.window.to)}>
        {(tick) => (
          <>
            <line
              x1={at(tick.iso)}
              x2={at(tick.iso)}
              y1={PAD.top}
              y2={props.height - PAD.bottom}
              stroke="currentColor"
              class={tick.major ? 'text-white/20' : 'text-white/8'}
            />
            <text
              x={at(tick.iso) + 3}
              y={props.height - 8}
              class={
                tick.major
                  ? 'fill-neutral-400 text-[10px]'
                  : 'fill-neutral-600 text-[10px]'
              }
            >
              {tick.label}
            </text>
          </>
        )}
      </For>
      <Show
        when={props.window.now >= props.window.from && props.window.now < props.window.to}
      >
        <line
          x1={at(props.window.now)}
          x2={at(props.window.now)}
          y1={PAD.top}
          y2={props.height - PAD.bottom}
          stroke="currentColor"
          stroke-dasharray="2 3"
          class="text-emerald-400/70"
        />
        <text
          x={at(props.window.now) + 3}
          y={PAD.top + 9}
          class="fill-emerald-400/80 text-[10px]"
        >
          now
        </text>
      </Show>
    </>
  );
}
