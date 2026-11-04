import {
  type Browser,
  test as base,
  expect,
  type Locator,
  type Page,
} from '@playwright/test';

/**
 * Loads the built app in Chromium against the seeded smoke server
 * (scripts/smoke-server.ts). Every test fails on an uncaught page error, a
 * console error, a failed or 4xx/5xx request, or any request leaving the
 * local server.
 */
const test = base.extend<{ problems: string[] }>({
  problems: [
    async ({ page, baseURL }, use) => {
      const problems: string[] = [];
      const origin = new URL(baseURL!).origin;
      await page.route('**/*', (route) => {
        const url = route.request().url();
        if (new URL(url).origin === origin) return route.continue();
        problems.push(`external request: ${url}`);
        return route.abort('blockedbyclient');
      });
      page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
      page.on('console', (message) => {
        if (message.type() === 'error') problems.push(`console error: ${message.text()}`);
      });
      page.on('requestfailed', (request) => {
        if (new URL(request.url()).origin !== origin) return;
        problems.push(`request failed: ${request.url()} ${request.failure()?.errorText}`);
      });
      page.on('response', (response) => {
        if (response.status() >= 400)
          problems.push(`HTTP ${response.status()}: ${response.url()}`);
      });
      await use(problems);
      expect(problems).toEqual([]);
    },
    { auto: true },
  ],
});

const panel = (page: Page, title: string) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: title }) });

/** Only the hydrated client renders chart tooltips, so one appearing proves hydration. */
async function expectTooltipOnHover(page: Page, chart: Locator) {
  const targets = chart.getByRole('img');
  const count = await targets.count();
  expect(count).toBeGreaterThan(0);
  const target = targets.nth(Math.floor(count / 2));
  const tooltip = page.getByRole('tooltip');
  await expect(async () => {
    await page.mouse.move(0, 0);
    await target.hover();
    await expect(tooltip).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  return tooltip;
}

/**
 * Solid can patch over a hydration mismatch without throwing, so the hydrated
 * page's headings are compared with the server's HTML, read with JavaScript off.
 */
async function expectServerHeadings(page: Page, browser: Browser, path: string) {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const server = await context.newPage();
  await server.goto(new URL(path, page.url()).href);
  const headings = await server.getByRole('heading').allTextContents();
  await context.close();
  expect(headings.length).toBeGreaterThan(1);
  await expect(page.getByRole('heading')).toHaveText(headings);
}

async function expectRatesPanel(page: Page) {
  const rates = panel(page, 'Electricity unit rate');
  await expect(rates.getByText(/^\d+\.\d{2}p$/).first()).toBeVisible();
  await expect(rates.getByText('No rate published')).toHaveCount(0);
  await expect(rates.getByRole('row')).toHaveCount(3);
  const chart = rates.getByRole('group', { name: /Agile unit rates/ });
  await expect(chart).toBeVisible();
  const tooltip = await expectTooltipOnHover(page, chart);
  await expect(tooltip).toContainText(/\d+\.\d{2}p/);
}

test('an outsider sees yesterday, today’s rates and the enrolment link', async ({
  page,
  browser,
}) => {
  await page.goto('/?as=outsider');

  await expect(page).toHaveTitle('ldn.house');
  await expect(page.getByRole('heading', { level: 1, name: 'ldn.house' })).toBeVisible();

  const usage = panel(page, 'Electricity consumption');
  await expect(usage.getByText('spent yesterday')).toBeVisible();
  await expect(usage.getByText(/^£\d+\.\d{2}$/)).not.toHaveText('£0.00');
  await expect(usage.getByText('Usage is shown to the end of yesterday.')).toBeVisible();
  const chart = usage.getByRole('group', { name: /Half-hourly electricity consumption/ });
  await expect(chart).toBeVisible();
  const tooltip = await expectTooltipOnHover(page, chart);
  await expect(tooltip).toContainText(/\d+\.\d{2} kWh/);

  await expectRatesPanel(page);

  // Stylesheet applied: the page background comes from Tailwind's compiled CSS.
  await expect(page.locator('body')).not.toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)',
  );
  await expect(page.locator('footer').getByRole('button').first()).toBeVisible();
  await expectServerHeadings(page, browser, '/?as=outsider');
});

test('the household sees today, a quiet live feed and the tree', async ({
  page,
  browser,
  request,
}) => {
  const livePower = page.waitForResponse((r) => r.url().endsWith('/api/live-power'));
  await page.goto('/?as=home');

  const usage = panel(page, 'Electricity consumption');
  await expect(usage.getByText('spent today')).toBeVisible();
  // No API key on the smoke server, so the client is told there is no live feed.
  expect((await livePower).status()).toBe(204);
  await expect(page.locator('footer')).toHaveCount(0);
  await expectRatesPanel(page);
  await expectServerHeadings(page, browser, '/?as=home');

  const { treeExport } = (await (await request.get('/api/health')).json()) as {
    treeExport: string | null;
  };
  const tree = panel(page, 'Christmas tree');
  if (!treeExport) {
    test.info().annotations.push({
      type: 'skipped',
      description: 'built without the tree export, so the tree panel is not checked',
    });
    await expect(tree).toHaveCount(0);
    return;
  }

  // The panel is a lazily loaded chunk; playing needs its coordinates and frames.
  await tree.scrollIntoViewIfNeeded();
  await expect(tree.getByRole('img', { name: /LEDs playing/ })).toBeVisible();
  const effect = tree.getByRole('button', { pressed: false }).first();
  const name = await effect.textContent();
  await effect.click();
  await expect(
    tree.getByRole('button', { name: name!, exact: true, pressed: true }),
  ).toBeVisible();
  await expect(
    tree.getByRole('img', { name: new RegExp(`playing ${name}`) }),
  ).toBeVisible();
});
