import { WIDTH } from './TimeAxis';

export function ChartTooltip(props: {
  anchorX: number;
  heading: string;
  value: string;
  detail: string;
}) {
  return (
    <div
      role="tooltip"
      class="pointer-events-none absolute top-2 z-10 w-36 rounded-lg border border-white/10 bg-neutral-950/95 px-3 py-2 shadow-lg shadow-black/25 backdrop-blur-sm"
      style={{
        left: `clamp(0.5rem, calc(${(props.anchorX / WIDTH) * 100}% + 0.5rem), calc(100% - 9.5rem))`,
      }}
    >
      <p class="truncate text-[10px] font-medium tracking-wide text-neutral-400 uppercase">
        {props.heading}
      </p>
      <div class="mt-1 flex items-center gap-2">
        <span class="h-5 w-0.5 shrink-0 rounded-full bg-accent" />
        <div class="min-w-0">
          <p class="text-sm leading-none font-medium tabular-nums text-neutral-100">
            {props.value}
          </p>
          <p class="mt-1 truncate text-[10px] leading-none text-neutral-500">
            {props.detail}
          </p>
        </div>
      </div>
    </div>
  );
}
