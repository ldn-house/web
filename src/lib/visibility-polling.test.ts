import { afterEach, describe, expect, it, vi } from 'vitest';
import { startVisibilityPolling } from './visibility-polling';

function visibilitySource(initial: DocumentVisibilityState) {
  const source = new EventTarget();
  let state = initial;
  Object.defineProperty(source, 'visibilityState', { get: () => state });
  return {
    source: source as EventTarget & { readonly visibilityState: DocumentVisibilityState },
    set(next: DocumentVisibilityState) {
      state = next;
      source.dispatchEvent(new Event('visibilitychange'));
    },
  };
}

describe('startVisibilityPolling', () => {
  afterEach(() => vi.useRealTimers());

  it('pauses while hidden and polls immediately when visible again', () => {
    vi.useFakeTimers();
    const visibility = visibilitySource('visible');
    const poll = vi.fn();
    const pause = vi.fn();
    const dispose = startVisibilityPolling({
      source: visibility.source,
      intervalMs: 10_000,
      poll,
      pause,
    });

    expect(poll).toHaveBeenLastCalledWith(true);
    vi.advanceTimersByTime(10_000);
    expect(poll).toHaveBeenLastCalledWith(false);

    visibility.set('hidden');
    const callsWhileHidden = poll.mock.calls.length;
    vi.advanceTimersByTime(30_000);
    expect(poll).toHaveBeenCalledTimes(callsWhileHidden);
    expect(pause).toHaveBeenCalledOnce();

    visibility.set('visible');
    expect(poll).toHaveBeenCalledTimes(callsWhileHidden + 1);
    expect(poll).toHaveBeenLastCalledWith(true);

    dispose();
  });

  it('does not start until an initially hidden page becomes visible', () => {
    vi.useFakeTimers();
    const visibility = visibilitySource('hidden');
    const poll = vi.fn();
    const dispose = startVisibilityPolling({
      source: visibility.source,
      intervalMs: 10_000,
      poll,
      pause: vi.fn(),
    });

    vi.advanceTimersByTime(30_000);
    expect(poll).not.toHaveBeenCalled();
    visibility.set('visible');
    expect(poll).toHaveBeenCalledOnce();
    expect(poll).toHaveBeenLastCalledWith(true);

    dispose();
  });
});
