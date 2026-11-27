import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';
import { branchASession } from './e2e/warranty/sessions';

/**
 * The origin of the server the suite drives, stated once for every use of it: the browser's `baseURL`
 * here and the `origin` constant of `e2e/warranty/harness.ts`, which is what every spec's API context
 * and every second browser signs in on. `LUSON_E2E_ORIGIN` is the one input, and the default is the
 * address every documented local command uses, so a run that states nothing keeps working untouched.
 * `scripts/test-e2e.sh` states it for the server it starts itself, on a port it chose.
 */
export const origin = process.env.LUSON_E2E_ORIGIN?.trim() || 'http://127.0.0.1:8080';

/**
 * The end-to-end harness of the battery warranty vertical (S35). It drives a real browser against the
 * local server the operator already started: this config never boots, restarts or builds anything, so
 * `baseURL` is that running origin (see above) and there is no `webServer`.
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
  testDir: './e2e',
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? join(tmpdir(), 'luson-warranty-e2e-output'),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: origin,
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
    // El piso de stock que todos los grupos dan por sentado, declarado una vez por corrida.
    { name: 'suministro', testMatch: /stock\.setup\.ts/, dependencies: ['sesiones'] },
    // Los flujos de la vertical de garantías, como el operador los hace: sobre la sucursal A.
    { name: 'garantías', testMatch: /warranty\/.*\.spec\.ts/, dependencies: ['suministro'] },
    // El acto de ajuste de la sucursal (S36), el mismo operador sobre su propio stock.
    { name: 'ajustes', testMatch: /adjustments\/.*\.spec\.ts/, dependencies: ['suministro'] },
    // El resto del producto, un directorio por grupo de pantallas (odd/tasks/e2e-all-flows.md).
    {
      name: 'flujos',
      testMatch: /(inventory|sales|purchases|cash|closings|metrics|transfers|entries|catalog|administration|account)\/.*\.spec\.ts/,
      dependencies: ['suministro'],
    },
  ],
});
