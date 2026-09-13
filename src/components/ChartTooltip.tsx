import { Show } from 'solid-js';
import { WIDTH } from './TimeAxis';

export function ChartTooltip(props: {
  anchorX: number;
  heading: string;
  value: string;
  secondary?: string;
  detail: string;
  swatchFill?: string;
}) {
  return (
    <div
      role="tooltip"
      class="pointer-events-none absolute top-2 z-10 w-44 rounded-lg border border-white/10 bg-neutral-950/95 px-3 py-2 shadow-lg shadow-black/25 backdrop-blur-sm"
      style={{
        left: `clamp(0.5rem, calc(${(props.anchorX / WIDTH) * 100}% + 0.5rem), calc(100% - 11.5rem))`,
      }}
    >
      <p class="whitespace-nowrap text-[10px] font-medium tracking-wide text-neutral-400 uppercase">
        {props.heading}
      </p>
      <div class="mt-1.5 flex items-center gap-2">
        <svg aria-hidden="true" width="2" height="14" class="shrink-0 text-accent">
          <rect width="2" height="14" rx="1" fill={props.swatchFill ?? 'currentColor'} />
        </svg>
        <p class="text-sm leading-none font-medium tabular-nums text-neutral-100">
          {props.value}
        </p>
      </div>
      <Show when={props.secondary}>
        <p class="mt-1.5 text-[11px] leading-4 tabular-nums text-neutral-300">
          {props.secondary}
        </p>
      </Show>
      <p class="mt-1 truncate text-[10px] leading-none text-neutral-500">
        {props.detail}
      </p>
    </div>
  );
}
