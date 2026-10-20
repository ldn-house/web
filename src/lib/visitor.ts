import { AsyncLocalStorage } from 'node:async_hooks';

export interface Visitor {
  /** In the house, or carrying a cookie issued there. */
  home: boolean;
}

const current = new AsyncLocalStorage<Visitor>();

/** Runs a request, including its streamed render, as `visitor`. */
export function withVisitor<T>(visitor: Visitor, run: () => T): T {
  return current.run(visitor, run);
}

/**
 * Server-side gate for anything live or near-live about the household. Outside
 * a request, such as in the scheduled ingest, nobody is home.
 */
export function isHome(): boolean {
  return current.getStore()?.home === true;
}
