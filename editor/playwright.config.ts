import { defineConfig, devices } from '@playwright/test'

/** Fixed port for the e2e dev server (separate from `pnpm dev` on 5173). */
export const E2E_PORT = 5179

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results',
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    headless: true,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  // channel 'chromium' = full Chromium in new headless mode (closer to WebView2 than headless-shell).
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chromium', viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${E2E_PORT} --strictPort`,
    url: `http://127.0.0.1:${E2E_PORT}`,
    env: { VITE_TEST: '1' },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
