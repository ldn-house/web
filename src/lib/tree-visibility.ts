'use server';

import { inTreeSeason } from './tree-season';
import { isHome, visitorNow } from './visitor';

/**
 * The household sees the tree all year; everyone else only in season. Like any
 * `'use server'` export this is a public RPC, and it returns nothing but that.
 */
export async function treePanelShown(): Promise<boolean> {
  return isHome() || inTreeSeason(visitorNow());
}
