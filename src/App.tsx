import type { JSX } from '@solidjs/web';
import { createEffect, createMemo, createSignal, onSettled, Show } from 'solid-js';
import { RateChart } from './components/RateChart';
import type { Window as ChartWindow } from './components/TimeAxis';
import { UsageChart } from './components/UsageChart';
import { recentDayBounds } from './lib/chart';
import { addLondonDays, londonDay, londonMidnight, londonTime } from './lib/format';
import {
  cappedRate,
  consumptionBetween,
  type RateSlot,
  ratesBetween,
  recentAverageDemand,
  telemetryBetween,
} from './lib/queries';
import { startVisibilityPolling } from './lib/visibility-polling';

function Panel(props: {
  title: string;
  aside?: string;
  asideTitle?: string;
  /** Hands the aside element to the parent so it can animate it. */
  asideRef?: (el: HTMLParagraphElement) => void;
  children: JSX.Element;
}) {
  return (
    <section class="mt-6 rounded-xl bg-surface-raised p-5">
      <div class="flex items-baseline justify-between gap-4">
        <h2 class="text-sm font-medium text-neutral-300">{props.title}</h2>
        <Show when={props.aside}>
          <p
            ref={(el) => props.asideRef?.(el)}
            title={props.asideTitle}
            class="text-sm tabular-nums text-neutral-400"
          >
            {props.aside}
          </p>
        </Show>
      </div>
      <div class="mt-4">{props.children}</div>
    </section>
  );
}

export default function App() {
  // Fetch yesterday through tomorrow. Both charts share yesterday and today,
  // adding tomorrow to their common axis once those rates are published.
  const now = new Date().toISOString();
  const today = londonMidnight(now);
  const queryWindow: ChartWindow = {
    from: addLondonDays(today, -1),
    to: addLondonDays(today, 2),
    now,
  };

  const slots = createMemo(async () =>
    consumptionBetween(queryWindow.from, queryWindow.to),
  );
  const estimated = createMemo(async () => {
    const billed = slots().at(-1);
    const from = billed
      ? new Date(Date.parse(billed.start) + 1800_000)
          .toISOString()
          .replace(/\.\d{3}Z$/, 'Z')
      : queryWindow.from;
    return telemetryBetween(from, queryWindow.to);
  });
  const averageDemand = createMemo(async () => recentAverageDemand());
  const [liveDemand, setLiveDemand] = createSignal<{
    readAt: string;
    watts: number;
  } | null>(null);
  // Bumped on every successful live reading, including unchanged ones, so the
  // label can flash even when the number stays put.
  const [liveTick, setLiveTick] = createSignal(0);
  let liveAside: HTMLParagraphElement | undefined;
  let liveFlash: Animation | undefined;
  const rates = createMemo(async () => ratesBetween(queryWindow.from, queryWindow.to));
  const chartWindow = createMemo<ChartWindow>(() => {
    const bounds = recentDayBounds(
      now,
      rates().map((rate) => rate.start),
    );
    return { from: bounds[0], to: bounds[1], now };
  });
  const cap = createMemo(async () => cappedRate(now));

  onSettled(() => {
    if (typeof document === 'undefined') return;
    let activeRequest: AbortController | undefined;
    let staleTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let polling = false;
    let lastPollAt = 0;
    const clearLiveDemand = () => {
      clearTimeout(staleTimer);
      staleTimer = undefined;
      setLiveDemand(null);
    };
    const poll = async (force = false) => {
      if (
        polling ||
        document.visibilityState === 'hidden' ||
        (!force && Date.now() - lastPollAt < 9_000)
      )
        return;
      polling = true;
      lastPollAt = Date.now();
      const request = new AbortController();
      activeRequest = request;
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        request.abort();
      }, 8_000);
      try {
        const response = await fetch('/api/live-power', { signal: request.signal });
        if (!response.ok) {
          clearLiveDemand();
          return;
        }
        const reading = (await response.json()) as { readAt?: unknown; watts?: unknown };
        if (typeof reading.readAt === 'string' && typeof reading.watts === 'number') {
          setLiveDemand({ readAt: reading.readAt, watts: reading.watts });
          setLiveTick((tick) => tick + 1);
          clearTimeout(staleTimer);
          staleTimer = setTimeout(() => setLiveDemand(null), 20_000);
        } else {
          clearLiveDemand();
        }
      } catch (error) {
        if (!stopped && (timedOut || !request.signal.aborted)) {
          clearLiveDemand();
          console.warn('live power poll failed', error);
        }
      } finally {
        clearTimeout(timeout);
        if (activeRequest === request) {
          activeRequest = undefined;
          polling = false;
        }
      }
    };
    const pausePolling = () => {
      activeRequest?.abort();
      activeRequest = undefined;
      polling = false;
      clearLiveDemand();
    };
    const stopVisibilityPolling = startVisibilityPolling({
      source: document,
      intervalMs: 10_000,
      poll: (force) => void poll(force),
      pause: pausePolling,
    });
    return () => {
      stopped = true;
      stopVisibilityPolling();
      clearTimeout(staleTimer);
    };
  });

  // Each fresh reading lights the live label up to near-white, then it settles
  // back into the panel's muted colour over about two seconds. Deferred so it
  // only ever fires for readings that arrive after the page is up, which keeps
  // the server-rendered hourly-average fallback quiet.
  createEffect(
    () => liveTick(),
    () => {
      // Drop any in-flight flash first, so the resting colour below is read
      // from the class rather than from a half-faded animated value.
      liveFlash?.cancel();
      const el = liveAside;
      if (!el || !el.isConnected || typeof el.animate !== 'function') return;
      // Reduced motion keeps the label at its resting colour, no animation.
      if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
      // Read the resting colour off the element so this keeps tracking the
      // Tailwind class instead of duplicating the token.
      const settled = globalThis.getComputedStyle(el).color;
      const lit = 'oklch(0.985 0 0)'; // neutral-50
      const flash = el.animate(
        [
          { color: lit, offset: 0, easing: 'linear' },
          { color: lit, offset: 0.1, easing: 'ease-out' },
          { color: settled, offset: 1 },
        ],
        { duration: 2_000 },
      );
      liveFlash = flash;
      return () => flash.cancel();
    },
    { defer: true },
  );

  const total = () =>
    [...slots(), ...estimated()].reduce((sum, slot) => sum + slot.kwh, 0);
  const current = () =>
    rates().find(
      (r) => r.start <= now && Date.parse(r.start) + 1_800_000 > Date.parse(now),
    );
  const cheapestAhead = () =>
    rates()
      .filter((r) => r.start >= now)
      .reduce<RateSlot | undefined>(
        (best, r) => (!best || r.pIncVat < best.pIncVat ? r : best),
        undefined,
      );

  return (
    <main class="mx-auto max-w-3xl px-6 py-16">
      <h1 class="text-3xl font-semibold tracking-tight">ldn.house</h1>
      <p class="mt-3 text-neutral-400">
        Energy and climate data for one house in London.
      </p>

      <Panel
        title="Electricity consumption"
        asideRef={(el) => {
          liveAside = el;
        }}
        asideTitle={
          liveDemand()
            ? `Home Mini reading at ${londonTime(liveDemand()!.readAt)}; refreshes every 10 seconds`
            : averageDemand()
              ? 'Average demand from the most recent hour of Home Mini readings'
              : undefined
        }
        aside={
          liveDemand()
            ? `${liveDemand()!.watts.toFixed(0)} W live`
            : averageDemand()
              ? `~${averageDemand()!.watts.toFixed(0)} W last hour`
              : undefined
        }
      >
        <Show
          when={slots().length + estimated().length}
          fallback={<p class="text-sm text-neutral-500">No readings yet.</p>}
        >
          <UsageChart slots={slots()} estimated={estimated()} window={chartWindow()} />
          <p class="mt-3 text-xs text-neutral-500">
            {total().toFixed(1)} kWh since{' '}
            {londonDay((slots()[0] ?? estimated()[0])!.start)}
            <Show when={slots().at(-1)}>
              {(last) => (
                <>
                  {' '}
                  · billed to {londonDay(last().start)} {londonTime(last().start)},
                  lighter bars are from the meter since
                </>
              )}
            </Show>
          </p>
        </Show>
      </Panel>

      <Panel
        title="Electricity unit rate"
        aside={current() ? `${current()!.pIncVat.toFixed(2)}p/kWh now` : undefined}
      >
        <Show
          when={rates().length}
          fallback={<p class="text-sm text-neutral-500">No rates published.</p>}
        >
          <RateChart rates={rates()} cap={cap()} window={chartWindow()} />
          <ul class="mt-2 flex gap-5 text-xs text-neutral-400">
            <li class="flex items-center gap-2">
              <span class="inline-block h-0.5 w-5 bg-accent" />
              Agile
            </li>
            <Show when={cap()}>
              {(value) => (
                <li class="flex items-center gap-2">
                  <span class="inline-block h-0 w-5 border-t border-dashed border-sky-400" />
                  Price cap (SVT) {value().toFixed(1)}p/kWh
                </li>
              )}
            </Show>
          </ul>
          <Show when={cheapestAhead()}>
            {(slot) => (
              <p class="mt-3 text-xs text-neutral-500">
                Cheapest ahead {slot().pIncVat.toFixed(2)}p at {londonDay(slot().start)}{' '}
                {londonTime(slot().start)}
              </p>
            )}
          </Show>
        </Show>
      </Panel>
    </main>
  );
}
