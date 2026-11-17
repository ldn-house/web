import { createSignal, Match, onCleanup, Switch } from 'solid-js';

type State =
  | { name: 'idle' }
  | { name: 'starting' }
  | { name: 'waiting'; check: string }
  | { name: 'expired' }
  | { name: 'unavailable' }
  | { name: 'failed'; message: string };

const POLL_MS = 2_000;
const POLL_FOR_MS = 10 * 60_000;

const quiet =
  'underline decoration-neutral-600 underline-offset-2 hover:text-neutral-300';

/**
 * Asks the Worker for a code bound to this browser. The Worker passes it to
 * Home Assistant, which asks a household phone to approve the check digits
 * shown here, then this browser polls until it is approved.
 */
export function EnrolDevice() {
  const [state, setState] = createSignal<State>({ name: 'idle' });
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let pollUntil = 0;
  let unlisten: (() => void) | undefined;

  const stopPolling = () => {
    clearTimeout(pollTimer);
    pollTimer = undefined;
    unlisten?.();
    unlisten = undefined;
  };
  onCleanup(stopPolling);

  async function recheck() {
    if (state().name !== 'waiting' || document.visibilityState === 'hidden') return;
    const response = await fetch('/api/enrol/status', { method: 'POST' }).catch(
      () => null,
    );
    const { state: result } = ((await response?.json().catch(() => null)) ?? {}) as {
      state?: string;
    };
    if (result === 'home') {
      stopPolling();
      location.reload();
    } else if (result === 'expired' || Date.now() > pollUntil) {
      stopPolling();
      setState({ name: 'expired' });
    }
  }

  function poll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      await recheck();
      if (state().name === 'waiting') poll();
    }, POLL_MS);
  }

  async function enrol() {
    setState({ name: 'starting' });
    const response = await fetch('/api/enrol/start', { method: 'POST' }).catch(
      () => null,
    );
    if (response?.status === 503) return setState({ name: 'unavailable' });
    if (!response?.ok) {
      return setState({
        name: 'failed',
        message:
          response?.status === 429
            ? 'Too many attempts.'
            : response?.status === 502
              ? 'Couldn’t reach Home Assistant.'
              : 'Could not start enrolment.',
      });
    }
    const { check } = (await response.json()) as { check: string };
    setState({ name: 'waiting', check });
    pollUntil = Date.now() + POLL_FOR_MS;
    // Returning to the tab after approving on the same phone checks straight away.
    stopPolling();
    window.addEventListener('focus', recheck);
    document.addEventListener('visibilitychange', recheck);
    unlisten = () => {
      window.removeEventListener('focus', recheck);
      document.removeEventListener('visibilitychange', recheck);
    };
    poll();
  }

  const waiting = () => {
    const current = state();
    return current.name === 'waiting' ? current : undefined;
  };
  const failed = () => {
    const current = state();
    return current.name === 'failed' ? current : undefined;
  };
  const Retry = () => (
    <button type="button" class={quiet} onClick={enrol}>
      Try again
    </button>
  );

  return (
    <Switch>
      <Match when={state().name === 'idle'}>
        Live readings are for the household.{' '}
        <button type="button" class={quiet} onClick={enrol}>
          Enrol this device
        </button>
      </Match>
      <Match when={state().name === 'starting'}>Asking for a code…</Match>
      <Match when={waiting()}>
        {(waiting) => (
          <p>
            Waiting for the house admin to approve. If they ask, this device is showing{' '}
            <strong class="font-medium text-neutral-300 tabular-nums">
              {waiting().check}
            </strong>
            .
          </p>
        )}
      </Match>
      <Match when={state().name === 'expired'}>
        That code expired. <Retry />
      </Match>
      <Match when={state().name === 'unavailable'}>Enrolment is not set up here.</Match>
      <Match when={failed()}>
        {(failed) => (
          <>
            {failed().message} <Retry />
          </>
        )}
      </Match>
    </Switch>
  );
}
