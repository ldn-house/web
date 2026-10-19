import { createSignal, Match, onCleanup, Switch } from 'solid-js';

type State =
  | { name: 'idle' }
  | { name: 'starting' }
  | { name: 'waiting'; confirmUrl: string; reached: boolean | null }
  | { name: 'expired' }
  | { name: 'unavailable' }
  | { name: 'failed'; message: string };

const POLL_MS = 2_000;
const POLL_FOR_MS = 10 * 60_000;

const quiet =
  'underline decoration-neutral-600 underline-offset-2 hover:text-neutral-300';

/**
 * Asks the Worker for a code bound to this browser, then hands it to Home
 * Assistant on the LAN. Chromium can send it directly once Local Network
 * Access is allowed; elsewhere, or if that fails, the link opens it instead.
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

  async function check() {
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
      await check();
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
          response?.status === 429 ? 'Too many attempts.' : 'Could not start enrolment.',
      });
    }
    const { confirmUrl } = (await response.json()) as { confirmUrl: string };
    setState({ name: 'waiting', confirmUrl, reached: null });
    pollUntil = Date.now() + POLL_FOR_MS;
    // Returning from Home Assistant's tab checks straight away.
    stopPolling();
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    unlisten = () => {
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
    poll();
    try {
      // Chromium prompts for Local Network Access and then allows plain HTTP
      // to the LAN; other browsers reject this as mixed content.
      await fetch(confirmUrl, {
        method: 'POST',
        mode: 'no-cors',
        targetAddressSpace: 'local',
      } as RequestInit);
      setState((current) =>
        current.name === 'waiting' ? { ...current, reached: true } : current,
      );
    } catch {
      setState((current) =>
        current.name === 'waiting' ? { ...current, reached: false } : current,
      );
    }
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
        <button type="button" class={quiet} onClick={enrol}>
          Enrol this device
        </button>
      </Match>
      <Match when={state().name === 'starting'}>Asking for a code…</Match>
      <Match when={waiting()}>
        {(waiting) => (
          <>
            {waiting().reached === false
              ? 'On the home Wi-Fi, '
              : 'Waiting for Home Assistant. If nothing happens, on the home Wi-Fi, '}
            <a
              href={waiting().confirmUrl}
              target="_blank"
              rel="noopener noreferrer"
              class={quiet}
            >
              confirm with Home Assistant
            </a>
            , then come back here.
          </>
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
