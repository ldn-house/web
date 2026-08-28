/** The free plan caps D1 at 10 databases, so this is not optional. */
import { $ } from 'bun';
import { previewNames } from './config';

const pr = process.env.PR_NUMBER;
if (!pr) throw new Error('PR_NUMBER not set');
const { worker, database } = previewNames(pr);

// Both may already be gone if the PR was closed twice; failures are not fatal.
await $`bunx wrangler delete --name ${worker} --force`.nothrow();
await $`bunx wrangler d1 delete ${database} --skip-confirmation`.nothrow();
console.log(`tore down ${worker}`);
