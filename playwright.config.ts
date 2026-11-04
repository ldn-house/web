import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.SMOKE_PORT ?? 8790);

/** Browser smoke test of the built artifact; see e2e/app.smoke.ts. */
export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.smoke.ts',
  forbidOnly: !!process.env.CI,
  // A flaky pass would let a broken update automerge, so a failure stays a failure.
  retries: 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'bun scripts/smoke-server.ts',
    env: { SMOKE_PORT: String(port) },
    // Ready once seeded, not merely once /api/health answers.
    wait: { stdout: /smoke server ready/ },
    // Each run starts from a freshly seeded database.
    reuseExistingServer: false,
    stdout: 'pipe',
    timeout: 120_000,
  },
});
