import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { livePowerResponse } from './live-power';
import type { Fetcher } from './octopus';

const START = Date.parse('2026-01-06T12:10:00Z');
const KEY = 'synthetic-api-key';

function upstream() {
  const state = {
    telemetryCalls: 0,
    limitCalls: 0,
    mode: 'fresh',
    resetAt: START + 900_000,
  };
  let intercept: ((end: string) => Promise<Response>) | undefined;
  const fetchImpl: Fetcher = async (_input, init) => {
    const { query, variables } = JSON.parse(String(init?.body));
    if (query.includes('mutation') && query.includes('obtainKrakenToken'))
      return Response.json({ data: { obtainKrakenToken: { token: 'synthetic-token' } } });
    if (query.includes('viewer'))
      return Response.json({ data: { viewer: { accounts: [{ number: 'A-SYNTH01' }] } } });
    if (query.includes('electricityAgreements'))
      return Response.json({
        data: {
          account: {
            electricityAgreements: [
              {
                meterPoint: {
                  meters: [{ smartDevices: [{ deviceId: 'SYNTH-DEVICE' }] }],
                },
              },
            ],
          },
        },
      });
    if (query.includes('rateLimitInfo')) {
      state.limitCalls++;
      return state.mode === 'unknown-reset'
        ? new Response('unavailable', { status: 503 })
        : Response.json({
            data: {
              rateLimitInfo: {
                fieldSpecificRateLimits: {
                  edges: [{ node: { isBlocked: true, ttl: state.resetAt / 1000 } }],
                },
              },
            },
          });
    }
    state.telemetryCalls++;
    if (intercept) return intercept(variables.e);
    if (state.mode === 'failure') return new Response('unavailable', { status: 503 });
    if (state.mode !== 'fresh')
      return Response.json({
        errors: [
          { message: 'Too many requests.', extensions: { errorCode: 'KT-CT-1199' } },
        ],
      });
    return fresh(variables.e);
  };
  return {
    state,
    fetchImpl,
    intercept: (fn: typeof intercept) => {
      intercept = fn;
    },
  };
}

function fresh(end: string) {
  const now = Date.parse(end);
  return Response.json({
    data: {
      smartMeterTelemetry: [
        { readAt: new Date(now - 1000).toISOString(), demand: '480' },
      ],
      halfHourly: [
        {
          readAt: new Date(Math.floor(now / 1800000) * 1800000).toISOString(),
          consumptionDelta: '120',
        },
      ],
    },
  });
}

describe('shared live power', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM live_power_cache').run();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('shares one refresh across simultaneous visitors and stays within 60 telemetry calls per hour', async () => {
    const api = upstream();
    let now = START;
    const request = () =>
      livePowerResponse(env.DB, KEY, { now: () => now, fetchImpl: api.fetchImpl });
    await Promise.all(Array.from({ length: 12 }, request));
    expect(api.state.telemetryCalls).toBe(1);
    const cached = await request();
    expect(cached.status).toBe(200);
    expect(cached.headers.get('Retry-After')).toBe('120');
    expect(cached.headers.get('Cache-Control')).toBe('no-store');
    for (let minute = 1; minute < 60; minute++) {
      now = START + minute * 60_000;
      await Promise.all([request(), request()]);
    }
    // Each request contains two telemetry fields.
    expect(api.state.telemetryCalls * 2).toBe(60);
  });

  it.each([START + 900_000, 900_000])(
    'persists epoch or duration reset times (%s) and does not retry during the cooldown',
    async (resetAt) => {
      const api = upstream();
      api.state.resetAt = resetAt;
      api.state.mode = 'limited';
      let now = START;
      const request = () =>
        livePowerResponse(env.DB, KEY, { now: () => now, fetchImpl: api.fetchImpl });
      const limited = await request();
      expect(limited.status).toBe(503);
      expect(limited.headers.get('Retry-After')).toBe('905');
      now += 600_000;
      const cached = await request();
      expect(cached.headers.get('Retry-After')).toBe('305');
      expect(api.state.telemetryCalls).toBe(1);
      expect(api.state.limitCalls).toBe(1);
      api.state.mode = 'fresh';
      now = START + 905_000;
      expect((await request()).status).toBe(200);
      expect(api.state.telemetryCalls).toBe(2);
    },
  );

  it('does not contact Octopus when the deployment has no API key', async () => {
    const fetchImpl = vi.fn();
    const response = await livePowerResponse(env.DB, '', {
      fetchImpl: fetchImpl as Fetcher,
    });
    expect(response.status).toBe(503);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('waits an hour when a throttled response provides no usable reset information', async () => {
    const api = upstream();
    api.state.mode = 'unknown-reset';
    const response = await livePowerResponse(env.DB, KEY, {
      now: () => START,
      fetchImpl: api.fetchImpl,
    });
    expect(response.headers.get('Retry-After')).toBe('3600');
    await livePowerResponse(env.DB, KEY, {
      now: () => START + 120_000,
      fetchImpl: api.fetchImpl,
    });
    expect(api.state.telemetryCalls).toBe(1);
  });

  it('keeps a recent reading during an outage, then stops serving it as current', async () => {
    const api = upstream();
    let now = START;
    const request = () =>
      livePowerResponse(env.DB, KEY, { now: () => now, fetchImpl: api.fetchImpl });
    const original = await (await request()).json();
    api.state.mode = 'limited';
    now += 120_000;
    const duringOutage = await request();
    expect(duringOutage.status).toBe(200);
    expect(await duringOutage.json()).toEqual(original);
    now = START + 300_000;
    expect((await request()).status).toBe(503);
    expect(api.state.telemetryCalls).toBe(2);
  });

  it('reserves the refresh interval even for ordinary upstream failures', async () => {
    const api = upstream();
    api.state.mode = 'failure';
    const options = { now: () => START, fetchImpl: api.fetchImpl };
    expect((await livePowerResponse(env.DB, KEY, options)).status).toBe(503);
    expect(
      (await livePowerResponse(env.DB, KEY, options)).headers.get('Retry-After'),
    ).toBe('120');
    expect(api.state.telemetryCalls).toBe(1);
  });

  it('recovers an abandoned lease and prevents a late response replacing the newer reading', async () => {
    const api = upstream();
    let now = START;
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      started = resolve;
    });
    api.intercept(async (end) => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return fresh(end);
    });
    const request = () =>
      livePowerResponse(env.DB, KEY, { now: () => now, fetchImpl: api.fetchImpl });
    const first = request();
    await pending;
    const waiting = await request();
    expect(waiting.status).toBe(503);
    expect(waiting.headers.get('Retry-After')).toBe('5');
    expect(api.state.telemetryCalls).toBe(1);
    now += 120_000;
    api.intercept(undefined);
    const newer = await (await request()).json();
    release();
    expect(await (await first).json()).toEqual(newer);
    expect(await (await request()).json()).toEqual(newer);
    expect(api.state.telemetryCalls).toBe(2);
  });
});
