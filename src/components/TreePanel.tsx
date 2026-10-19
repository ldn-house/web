import { createEffect, createSignal, For, NoHydration, onSettled, Show } from 'solid-js';
import { nearness, type Point, treeFrame } from '../lib/tree';
import { coordsUrl, framesUrl, serverCoords, treeIndex } from '../lib/tree-export';
import type { TreePlayer } from './tree-player';

/** The showcase moves on at the first loop end after this long. */
const SHOWCASE_DWELL_S = 9;

/** The front view from the server, so the tree reads without JavaScript. */
function TreeFront() {
  const coords = serverCoords;
  if (!coords) return null;
  const frame = treeFrame(coords);
  const leds = coords
    .flatMap((c) => (c ? [c] : []))
    .sort((a, b) => a[2] - b[2])
    .map((c) => {
      const near = nearness(c[2], frame.radius);
      return {
        x: c[0].toFixed(3),
        y: (-c[1]).toFixed(3),
        r: (0.03 * (0.8 + 0.3 * near)).toFixed(4),
        o: near.toFixed(2),
      };
    });
  return (
    <svg
      viewBox={[frame.left, frame.top, frame.width, frame.height]
        .map((v) => v.toFixed(4))
        .join(' ')}
      class="absolute inset-0 h-full w-full"
      aria-hidden="true"
    >
      <defs>
        <radialGradient id="tree-led">
          <stop offset="0" stop-color="#fff4e2" />
          <stop offset="0.14" stop-color="#ffc98a" />
          <stop offset="0.4" stop-color="#ff9f45" stop-opacity="0.22" />
          <stop offset="1" stop-color="#ff9f45" stop-opacity="0" />
        </radialGradient>
      </defs>
      <g fill="url(#tree-led)" style={{ 'mix-blend-mode': 'screen' }}>
        {leds.map((led) => (
          <circle cx={led.x} cy={led.y} r={led.r} opacity={led.o} />
        ))}
      </g>
    </svg>
  );
}

/**
 * The house's Christmas tree, playing the effects the tree itself runs.
 * `playing` is the effect on the real tree, once that is shared; until then
 * the panel cycles through every effect.
 */
export function TreePanel(props: { playing?: string }) {
  const index = treeIndex;
  if (!index) return null;
  const effects = index.effects;
  const known = (name: string | undefined) =>
    effects.some((e) => e.name === name) ? name : undefined;

  const [enhanced, setEnhanced] = createSignal(false);
  const [live, setLive] = createSignal(false);
  const [player, setPlayer] = createSignal<TreePlayer>();
  const [picked, setPicked] = createSignal<string>();
  const [showcase, setShowcase] = createSignal(0);
  const [paused, setPaused] = createSignal(false);
  const [displayed, setDisplayed] = createSignal<string>();
  let stage: HTMLDivElement | undefined;
  let canvas: HTMLCanvasElement | undefined;
  let reducedMotion = false;

  const cycling = () => !picked() && !known(props.playing) && !paused();
  const selected = () =>
    picked() ?? known(props.playing) ?? effects[showcase() % effects.length]!.name;
  const effectOf = (name: string | undefined) => effects.find((e) => e.name === name);

  const cache = new Map<string, Promise<Uint8Array>>();
  let loadFrames: typeof import('./tree-player').loadFrames | undefined;
  const frames = (name: string) => {
    const effect = effectOf(name)!;
    let pending = cache.get(name);
    if (!pending && loadFrames) {
      pending = loadFrames(framesUrl(name)!, effect.frames * index.leds * 3);
      pending.catch(() => cache.delete(name));
      cache.set(name, pending);
    }
    return pending;
  };

  let loopsShown = 0;
  const onLoop = () => {
    const effect = effectOf(displayed());
    if (!effect || !cycling()) return;
    loopsShown++;
    if ((loopsShown * effect.frames) / index.fps >= SHOWCASE_DWELL_S) {
      setShowcase((i) => i + 1);
    }
  };

  createEffect(
    () => [selected(), player()] as const,
    ([name, p]) => {
      if (!p) return;
      let current = true;
      frames(name)
        ?.then(async (data) => {
          if (!current) return;
          const { brightestFrame } = await import('./tree-player');
          const effect = effectOf(name)!;
          p.show(
            data,
            effect.frames,
            reducedMotion ? brightestFrame(data, effect.frames) : 0,
          );
          loopsShown = 0;
          setDisplayed(name);
          setLive(true);
          if (cycling()) frames(effects[(showcase() + 1) % effects.length]!.name);
        })
        .catch((error) => console.warn('tree effect failed to load', name, error));
      return () => {
        current = false;
      };
    },
  );

  createEffect(
    () => [paused(), player()] as const,
    ([isPaused, p]) => p?.setPaused(isPaused),
  );

  onSettled(() => {
    if (typeof document === 'undefined' || !stage || !canvas || !coordsUrl) return;
    if (
      typeof DecompressionStream === 'undefined' ||
      !('IntersectionObserver' in globalThis)
    ) {
      return;
    }
    const motion = globalThis.matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotion = motion.matches;
    setPaused(reducedMotion);
    const onMotion = () => {
      reducedMotion = motion.matches;
      setPaused(reducedMotion);
    };
    motion.addEventListener('change', onMotion);
    setEnhanced(true);

    let disposed = false;
    let started: TreePlayer | undefined;
    let visible = false;
    const start = async () => {
      const [module, coords] = await Promise.all([
        import('./tree-player'),
        fetch(coordsUrl!).then((r) => {
          if (!r.ok) throw new Error(`coordinates: HTTP ${r.status}`);
          return r.json() as Promise<(Point | null)[]>;
        }),
      ]);
      if (disposed) return;
      loadFrames = module.loadFrames;
      started =
        module.createTreePlayer(canvas!, stage!, {
          coords,
          fps: index.fps,
          onLoop,
          onLost: () => {
            setLive(false);
            setEnhanced(false);
          },
          reducedMotion: () => reducedMotion,
        }) ?? undefined;
      if (!started) {
        setEnhanced(false);
        return;
      }
      started.setVisible(visible);
      setPlayer(started);
    };

    let starting: Promise<void> | undefined;
    const observer = new IntersectionObserver(
      ([entry]) => {
        visible = !!entry?.isIntersecting;
        started?.setVisible(visible);
        if (visible && !starting) {
          starting = start().catch((error) => {
            console.warn('tree player failed to start', error);
            setEnhanced(false);
          });
        }
      },
      { rootMargin: '200px 0px' },
    );
    observer.observe(stage);

    return () => {
      disposed = true;
      observer.disconnect();
      motion.removeEventListener('change', onMotion);
      started?.destroy();
    };
  });

  const turnWithKeys = (event: KeyboardEvent) => {
    const step = { ArrowLeft: -0.2, ArrowRight: 0.2 }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    player()?.turn(step);
  };

  const label = () => effectOf(displayed())?.label;
  const placedText =
    index.placed === index.leds
      ? `${index.leds} LEDs`
      : `${index.placed} of ${index.leds} LEDs`;

  return (
    <section class="mt-6 rounded-xl bg-surface-raised p-5">
      <div class="flex items-baseline justify-between gap-4">
        <h2 class="text-sm font-medium text-neutral-300">Christmas tree</h2>
        <Show when={live() && label()}>
          <p class="text-sm text-neutral-400">{label()}</p>
        </Show>
      </div>
      <div
        ref={stage}
        role="img"
        aria-label={
          live()
            ? `The Christmas tree's LEDs playing ${label()}. Drag or use the arrow keys to turn it.`
            : "The Christmas tree's LEDs, seen from the front."
        }
        tabindex={live() ? 0 : undefined}
        onKeyDown={turnWithKeys}
        class={[
          'relative mt-4 h-80 touch-pan-y select-none overflow-hidden rounded-lg bg-night outline-accent focus-visible:outline-2 sm:h-96',
          { 'cursor-grab active:cursor-grabbing': live() },
        ]}
      >
        <NoHydration>
          <TreeFront />
        </NoHydration>
        <canvas
          ref={canvas}
          aria-hidden="true"
          class={[
            'absolute inset-0 h-full w-full transition-opacity duration-700 motion-reduce:transition-none',
            live() ? 'opacity-100' : 'opacity-0',
          ]}
        />
      </div>
      <Show when={enhanced()}>
        <div class="mt-3 flex flex-wrap items-baseline gap-x-4 text-sm">
          <For each={effects}>
            {(effect) => (
              <button
                type="button"
                aria-pressed={selected() === effect.name ? 'true' : 'false'}
                onClick={() => setPicked(effect.name)}
                class="rounded-sm py-1 text-neutral-500 decoration-accent decoration-2 underline-offset-[6px] outline-accent hover:text-neutral-300 focus-visible:outline-2 focus-visible:outline-offset-2 aria-pressed:text-neutral-100 aria-pressed:underline"
              >
                {effect.label}
              </button>
            )}
          </For>
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            class="ml-auto rounded-sm py-1 text-neutral-400 outline-accent hover:text-neutral-200 focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            {paused() ? 'Play' : 'Pause'}
          </button>
        </div>
      </Show>
      <p class="mt-3 text-xs text-neutral-500">
        {placedText}, mapped in 3D from video.
        <Show when={live()}> Drag to turn it.</Show>
      </p>
    </section>
  );
}
