import type { JSX } from '@solidjs/web';
import { createEffect, createMemo, createSignal, For, onSettled, Show } from 'solid-js';
import { RateChart } from './components/RateChart';
import type { Window as ChartWindow } from './components/TimeAxis';
import { UsageChart } from './components/UsageChart';
import { recentDayBounds } from './lib/chart';
import {
  HALF_HOUR_MS,
  isMeterSlot,
  type MeterSlot,
  mergeConsumption,
} from './lib/consumption';
import {
  addLondonDays,
  londonDay,
  londonMidnight,
  londonTime,
  londonTimeSpan,
  pounds,
  timeUntil,
} from './lib/format';
import { cheapestWindow, rateAt, spendSince } from './lib/headline';
import {
  LIVE_READING_MAX_AGE_MS,
  LIVE_REFRESH_MS,
  retryAfterMs,
} from './lib/live-polling';
import {
  cappedRate,
  consumptionBetween,
  homeVisitor,
  ratesBetween,
  recentAverageDemand,
  standingChargeAt,
  telemetryBetween,
  usageRatesBetween,
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
      <div class="mt-3">{props.children}</div>
    </section>
  );
}

/** The answer a panel leads with: one figure, what it is, and its caveats. */
function Figure(props: { value: string; label: string; detail: string }) {
  return (
    <div>
      <p class="flex items-baseline gap-2">
        <span class="text-2xl font-semibold tracking-tight tabular-nums text-neutral-100">
          {props.value}
        </span>
        <span class="text-sm text-neutral-400">{props.label}</span>
      </p>
      <p class="mt-1 text-xs tabular-nums text-neutral-500">{props.detail}</p>
    </div>
  );
}

const WINDOW_HOURS = [1, 2, 3] as const;

export default function App() {
  // Fetch yesterday through tomorrow. Both charts share yesterday and today,
  // adding tomorrow to their common axis once those rates are published.
  // Hydrate against the server's clock, so time-derived markup matches the HTML.
  const renderedAt =
    (typeof document === 'undefined'
      ? undefined
      : document.querySelector('main')?.dataset.renderedAt) ?? new Date().toISOString();
  const [now, setNow] = createSignal(renderedAt);
  const today = createMemo(() => londonMidnight(now()));
  const yesterday = createMemo(() => addLondonDays(today(), -1));
  // Away from home the server stops usage at the end of yesterday and refuses
  // live readings; this only shapes what the page offers around that.
  const home = createMemo(async () => homeVisitor());
  const period = createMemo(() => Math.floor(Date.parse(now()) / HALF_HOUR_MS));
  const queryWindow = createMemo(() => ({
    from: addLondonDays(today(), -1),
    to: addLondonDays(today(), 2),
  }));

  const slots = createMemo(async () => {
    period();
    return consumptionBetween(queryWindow().from, queryWindow().to);
  });
  const meter = createMemo(async () => {
    period();
    return telemetryBetween(queryWindow().from, queryWindow().to);
  });
  const [recentMeter, setRecentMeter] = createSignal<MeterSlot[]>([]);
  const usage = createMemo(() =>
    mergeConsumption(
      slots(),
      meter(),
      recentMeter(),
      queryWindow().from,
      queryWindow().to,
    ),
  );
  const average = createMemo(async () => {
    period();
    return recentAverageDemand();
  });
  const averageDemand = () => {
    const value = average();
    return value && Date.parse(now()) - Date.parse(value.through) <= 45 * 60_000
      ? value
      : null;
  };
  const [liveDemand, setLiveDemand] = createSignal<{
    readAt: string;
    watts: number;
  } | null>(null);
  // Flash only when the meter timestamp advances, not when a cached response repeats.
  const [liveTick, setLiveTick] = createSignal(0);
  let liveAside: HTMLParagraphElement | undefined;
  let liveFlash: Animation | undefined;
  const rates = createMemo(async () => {
    period();
    return ratesBetween(queryWindow().from, queryWindow().to);
  });
  const usageRates = createMemo(async () => {
    period();
    return usageRatesBetween(queryWindow().from, queryWindow().to);
  });
  const chartWindow = createMemo<ChartWindow>(() => {
    const bounds = recentDayBounds(
      now(),
      rates().map((rate) => rate.start),
    );
    return { from: bounds[0], to: bounds[1], now: now() };
  });
  const cap = createMemo(async () => cappedRate(today()));
  const standingCharge = createMemo(async () => standingChargeAt(today()));

  onSettled(() => {
    if (typeof document === 'undefined') return;
    let activeRequest: AbortController | undefined;
    let staleTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let polling = false;
    let nextPollAt = 0;
    const clearLiveDemand = () => {
      clearTimeout(staleTimer);
      staleTimer = undefined;
      setLiveDemand(null);
    };
    const poll = async () => {
      if (document.visibilityState === 'hidden') return;
      // The chart clock still advances while network polling is in a cooldown.
      const now = Date.now();
      setNow(new Date(now).toISOString());
      if (!home() || polling || now < nextPollAt) return;
      polling = true;
      nextPollAt = now + LIVE_REFRESH_MS;
      const request = new AbortController();
      activeRequest = request;
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        request.abort();
      }, 25_000);
      try {
        const response = await fetch('/api/live-power', { signal: request.signal });
        if (stopped || request.signal.aborted) return;
        nextPollAt =
          Date.now() +
          Math.max(
            5_000,
            retryAfterMs(response.headers.get('Retry-After')) ?? LIVE_REFRESH_MS,
          );
        // This deployment has no live feed, so there is nothing to poll for.
        if (response.status === 204) {
          nextPollAt = Infinity;
          clearLiveDemand();
          return;
        }
        if (!response.ok) {
          clearLiveDemand();
          return;
        }
        const reading = (await response.json()) as {
          readAt?: unknown;
          watts?: unknown;
          consumption?: unknown;
        };
        if (stopped || request.signal.aborted) return;
        const age =
          typeof reading.readAt === 'string'
            ? Date.now() - Date.parse(reading.readAt)
            : Number.NaN;
        if (
          typeof reading.readAt === 'string' &&
          typeof reading.watts === 'number' &&
          Number.isFinite(reading.watts) &&
          age >= 0 &&
          age < LIVE_READING_MAX_AGE_MS
        ) {
          const isNewReading = liveDemand()?.readAt !== reading.readAt;
          setLiveDemand({ readAt: reading.readAt, watts: reading.watts });
          if (Array.isArray(reading.consumption)) {
            const recent = reading.consumption.filter(isMeterSlot);
            const window = queryWindow();
            setRecentMeter((previous) =>
              mergeConsumption([], previous, recent, window.from, window.to),
            );
          }
          if (isNewReading) setLiveTick((tick) => tick + 1);
          clearTimeout(staleTimer);
          staleTimer = setTimeout(
            () => setLiveDemand(null),
            LIVE_READING_MAX_AGE_MS - age,
          );
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
    };
    const stopVisibilityPolling = startVisibilityPolling({
      source: document,
      intervalMs: 10_000,
      poll: () => void poll(),
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

  const spend = createMemo(() =>
    home()
      ? spendSince(today(), usage(), usageRates())
      : spendSince(yesterday(), usage(), usageRates(), today()),
  );
  const spendDetail = () => {
    const { through, kwh, missing, unpriced } = spend();
    const halfHours = (count: number) =>
      count === 1 ? '1 half-hour has' : `${count} half-hours have`;
    const pence = standingCharge();
    const priced = "priced at each half-hour's Agile rate with VAT.";
    return [
      !through
        ? home()
          ? 'No readings yet today.'
          : 'No readings yesterday.'
        : home()
          ? `${kwh.toFixed(2)} kWh to ${londonTime(through)}, ${priced}`
          : `${kwh.toFixed(2)} kWh, ${priced}`,
      missing ? `${halfHours(missing)} no reading.` : '',
      unpriced
        ? `${halfHours(unpriced)} no price and ${unpriced === 1 ? 'is' : 'are'} left out.`
        : '',
      pence === null
        ? 'Excludes the daily standing charge.'
        : `Excludes the ${pence.toFixed(2)}p daily standing charge.`,
    ]
      .filter(Boolean)
      .join(' ');
  };
  const current = () => rateAt(rates(), Date.parse(now()));
  const next = () => {
    const slot = current();
    return slot ? rateAt(rates(), Date.parse(slot.start) + HALF_HOUR_MS) : undefined;
  };
  const windows = createMemo(() =>
    WINDOW_HOURS.flatMap((hours) => {
      const window = cheapestWindow(rates(), Date.parse(now()), hours * 2);
      return window ? [{ hours, ...window }] : [];
    }),
  );
  /** Times on another London day than today carry their day. */
  const dayTime = (iso: string) =>
    londonMidnight(iso) === today()
      ? londonTime(iso)
      : `${londonDay(iso)} ${londonTime(iso)}`;
  const publishedTo = () => {
    const last = rates().at(-1);
    return last
      ? new Date(Date.parse(last.start) + HALF_HOUR_MS).toISOString()
      : undefined;
  };

  return (
    <main class="mx-auto max-w-3xl px-6 py-16" data-rendered-at={renderedAt}>
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
            ? `Home Mini reading at ${londonTime(liveDemand()!.readAt)}; refreshes at most every 2 minutes`
            : averageDemand()
              ? 'Average demand from the most recent hour of Home Mini readings'
              : undefined
        }
        aside={
          liveDemand()
            ? `${liveDemand()!.watts.toFixed(0)} W at ${londonTime(liveDemand()!.readAt)}`
            : averageDemand()
              ? `~${averageDemand()!.watts.toFixed(0)} W last hour`
              : undefined
        }
      >
        <Figure
          value={spend().through ? pounds(spend().gbp) : '£0.00'}
          label={home() ? 'spent today' : 'spent yesterday'}
          detail={spendDetail()}
        />
        <div class="mt-4">
          <Show
            when={usage().length}
            fallback={<p class="text-sm text-neutral-500">No readings yet.</p>}
          >
            <UsageChart
              slots={usage()}
              rates={usageRates()}
              window={chartWindow()}
              live={!!liveDemand()}
            />
          </Show>
          <Show when={!home()}>
            <p class="mt-3 text-xs text-neutral-500">
              Usage is shown to the end of yesterday.
            </p>
          </Show>
        </div>
      </Panel>

      <Panel title="Electricity unit rate">
        <div class="flex flex-wrap gap-x-12 gap-y-4">
          <div class="flex gap-x-8">
            <Show
              when={current()}
              fallback={<Figure value="–" label="now" detail="No rate published" />}
            >
              {(slot) => (
                <Figure
                  value={`${slot().pIncVat.toFixed(2)}p`}
                  label="now"
                  detail={`Per kWh until ${londonTime(new Date(Date.parse(slot().start) + HALF_HOUR_MS).toISOString())}`}
                />
              )}
            </Show>
            <Show
              when={next()}
              fallback={<Figure value="–" label="next" detail="Not yet published" />}
            >
              {(following) => (
                <Figure
                  value={`${following().pIncVat.toFixed(2)}p`}
                  label="next"
                  detail={`From ${londonTime(following().start)}`}
                />
              )}
            </Show>
          </div>
          <Show when={windows().length}>
            <table class="text-sm tabular-nums">
              <caption class="mb-1 text-left text-xs text-neutral-500">
                Cheapest time to run something for
              </caption>
              <tbody>
                <For each={windows()}>
                  {(window) => (
                    <tr>
                      <th scope="row" class="pr-4 text-left font-normal text-neutral-400">
                        {window.hours} hour{window.hours === 1 ? '' : 's'}
                      </th>
                      <td class="pr-4 text-neutral-300">
                        {londonMidnight(window.start) === today()
                          ? ''
                          : `${londonDay(window.start)} `}
                        {londonTimeSpan(window.start, window.end)}
                      </td>
                      <td class="pr-4 text-right text-neutral-100">
                        {window.average.toFixed(2)}p
                      </td>
                      <td class="text-neutral-400">{timeUntil(window.start, now())}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </div>
        <div class="mt-4">
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
            <Show when={publishedTo()}>
              {(end) => (
                <p class="mt-3 text-xs text-neutral-500">
                  Unit rates include VAT; windows show their average. Rates are published
                  to {dayTime(end())}, and the next day's usually arrive between 16:00 and
                  20:00.
                </p>
              )}
            </Show>
          </Show>
        </div>
      </Panel>
    </main>
  );
}
