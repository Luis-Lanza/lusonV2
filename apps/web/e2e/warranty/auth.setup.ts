import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { expect, test as setup } from '@playwright/test';
import { branchA, branchB, login, origin, warehouseRole, type Role } from './harness';
import { sessionState } from './sessions';

/**
 * One sign-in per role for the whole run, saved as the cookie every spec starts from.
 *
 * The server throttles ten logins per minute and per address, and the specs alone would ask for more
 * than that: signing in here keeps the suite repeatable, and the login the operator uses is still the
 * real one — the same form, the same origin and the same session the screens then read.
 *
 * A saved session that the server still accepts is reused instead of signing in again: two runs in a
 * row, back to back, would otherwise spend six of the ten logins per minute on the setup alone and the
 * second run would fail before any spec ran. Reuse is proven, not assumed — the cookie is probed
 * against `/api/auth/session` with the same origin the browser uses.
 */
for (const role of [branchA, branchB, warehouseRole] satisfies readonly Role[]) {
  setup(`abre la sesión de ${role.locationName}`, async ({ page, playwright }) => {
    const target = sessionState(role.username);
    if (existsSync(target)) {
      const probe = await playwright.request.newContext({
        baseURL: origin, extraHTTPHeaders: { Origin: origin }, storageState: target,
      });
      const answer = await probe.get('/api/auth/session');
      const current = answer.ok() ? (await answer.json()) as { authenticated?: boolean } : {};
      await probe.dispose();
      if (current.authenticated === true) {
        setup.skip(true, `la sesión guardada de ${role.username} sigue viva y se reusa`);
        return;
      }
    }
    await login(page, role);
    // La sesión se guarda desde la página ya autenticada: es la cookie que el servidor acaba de emitir.
    await mkdir(dirname(target), { recursive: true });
    await page.context().storageState({ path: target });
    await expect(page.getByRole('button', { name: 'Cerrar sesión' })).toBeVisible();
    expect(new URL(page.url()).origin).toBe(origin);
  });
}
