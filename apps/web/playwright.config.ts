import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';
import { branchASession } from './e2e/warranty/sessions';

/**
 * The end-to-end harness of the battery warranty vertical (S35). It drives a real browser against the
 * local server the operator already started: this config never boots, restarts or builds anything, so
 * `baseURL` is the running http://127.0.0.1:8080 and there is no `webServer`.
 *
 * One worker, because every spec shares the one database the server is reading: two browsers arranging
 * sales and cases at once would race on the stock of a variant. Each spec arranges its own data with its
 * own unique serial, so the order never matters and no spec waits for another.
 *
 * `sesiones` signs each role in once — the server throttles ten logins per minute per address — and the
 * specs start from that cookie. What a failure leaves behind is meant to diagnose it: a trace and a
 * screenshot of the moment, both written outside the worktree so a red run never becomes an untracked
 * file in the change.
 */
export default defineConfig({
  testDir: './e2e/warranty',
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? join(tmpdir(), 'luson-warranty-e2e-output'),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8080',
    headless: true,
    viewport: { width: 1440, height: 960 },
    locale: 'es-BO',
    timezoneId: 'America/La_Paz',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    storageState: branchASession,
  },
  projects: [
    // El proyecto que abre las dos sesiones del run; ningún spec firma un login propio.
    { name: 'sesiones', testMatch: /auth\.setup\.ts/, use: { storageState: { cookies: [], origins: [] } } },
    // Los flujos de la vertical, como el operador los hace: sobre la sucursal A.
    { name: 'garantías', testMatch: /.*\.spec\.ts/, dependencies: ['sesiones'] },
  ],
});
