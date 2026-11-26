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
 */
for (const role of [branchA, branchB, warehouseRole] satisfies readonly Role[]) {
  setup(`abre la sesión de ${role.locationName}`, async ({ page }) => {
    await login(page, role);
    // La sesión se guarda desde la página ya autenticada: es la cookie que el servidor acaba de emitir.
    const target = sessionState(role.username);
    await mkdir(dirname(target), { recursive: true });
    await page.context().storageState({ path: target });
    await expect(page.getByRole('button', { name: 'Cerrar sesión' })).toBeVisible();
    expect(new URL(page.url()).origin).toBe(origin);
  });
}
