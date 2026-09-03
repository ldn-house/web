interface VisibilitySource {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: 'visibilitychange', listener: EventListener): void;
  removeEventListener(type: 'visibilitychange', listener: EventListener): void;
}

export function startVisibilityPolling(options: {
  source: VisibilitySource;
  intervalMs: number;
  poll: (force: boolean) => void;
  pause: () => void;
}) {
  let timer: ReturnType<typeof setInterval> | undefined;

  const stop = () => {
    clearInterval(timer);
    timer = undefined;
    options.pause();
  };
  const start = () => {
    if (timer !== undefined || options.source.visibilityState === 'hidden') return;
    options.poll(true);
    timer = setInterval(() => options.poll(false), options.intervalMs);
  };
  const update = () => {
    if (options.source.visibilityState === 'hidden') stop();
    else start();
  };

  start();
  options.source.addEventListener('visibilitychange', update);
  return () => {
    stop();
    options.source.removeEventListener('visibilitychange', update);
  };
}
