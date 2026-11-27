import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Where the sessions of the suite live between the setup project and the specs.
 *
 * The server throttles ten logins per minute and per address (`internal/auth/service.go`), and the
 * specs would spend more than that on their own: the setup project signs each role in once, saves the
 * cookie, and every spec opens its contexts with that state. The files land outside the worktree, so a
 * run never leaves an untracked file in the change.
 */
export function sessionState(username: string): string {
  const directory = process.env.PLAYWRIGHT_SESSION_DIR ?? join(tmpdir(), 'luson-warranty-e2e-sessions');
  return join(directory, `${username}.json`);
}

export const branchASession = sessionState('bot_sucursal_a');
export const branchBSession = sessionState('bot_sucursal_b');
export const warehouseSessionState = sessionState('bot_almacen');
