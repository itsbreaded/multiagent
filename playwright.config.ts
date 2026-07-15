import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  // E2E here is timing-sensitive (PTY output races, cross-window close races, shell
  // startup latency) and flakes on loaded shared CI runners even though it passes on a
  // fast local box. Retry in CI only: a test that flakes once but passes on retry is
  // marked flaky (run still green); a genuinely broken test fails all 3 attempts and
  // still fails the gate (this is what caught the macOS posix_spawnp regression). Locally
  // keep 0 so failures surface immediately.
  retries: process.env['CI'] ? 2 : 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env['CI'] ? [['github'], ['list']] : 'list',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
})
