# Manage personal accounts and passwords

The protected warehouse account (account 1 at location 1) manages personal branch operators from **Administración**. Every operator has all existing operations of their assigned branch. Consulting another location's stock never changes that assignment. There are no role checkboxes, public registration, email recovery, second administrator or warehouse-creation controls.

## Quick path

1. Sign in with a completed-password warehouse account and open **Administración → Usuarios**.
2. Choose **Crear usuario**, enter a display name and unique username, select a branch, and privately enter or explicitly generate a temporary password.
3. After the API confirms creation, use the private handoff panel to show or explicitly copy the submitted temporary password. Deliver it through a private channel, then close the panel. It cannot be retrieved later.
4. The operator signs in and must change the temporary password before inventory, transfer or realtime requests start. Logout remains available.

The directory supports local username/display-name search, account-state and branch filters. Unknown last-login/activity data is not invented. Legacy empty display names fall back to usernames.

## Account and branch lifecycle

| Action | Behavior |
| --- | --- |
| Edit name | Only changed PATCH fields are sent; an unchanged legacy blank name does not prevent reassignment. |
| Reassign | Choose an existing non-warehouse branch. The API retires previous sessions. |
| Deactivate / reactivate | Explicitly change **Acceso**. Reactivation does not revive retired sessions. |
| Reset password | Privately supply a new temporary password. The API retires sessions and requires a password change; a disabled account remains disabled. The previous password is never requested or returned. |
| Protected administrator | Only its display name can be managed here. Use **Mi contraseña** for its own password change. Private server recovery is separate work, not an HTTP override. |
| Create branch | **Sucursales → Crear sucursal** sends only its name. The confirmed branch starts with zero stock; the directory and actual inventory metadata are refetched without resetting login or the consulted inventory query. |

## Change your own password

Every authenticated account can open **Mi contraseña**, including the administrator. Mandatory-change sessions see a dedicated form instead of the operational shell.

Enter the current password, a different new password, and the client-only confirmation. Both passwords follow the existing **12–128 UTF-8 byte** policy without NUL. Spaces are preserved; there are no additional complexity or trimming rules. Only `current_password` and `new_password` are submitted to `/api/auth/password`.

A confirmed empty **204** retires local authority, aborts owned requests, closes all server sessions and returns to login with a success notice. There is no automatic login or reuse of the old password. `invalid_credentials` means the current password was wrong and does not blindly log out a valid session. Unavailable or uncertain responses never mean success and are not automatically retried.

## Privacy and request ownership

- Temporary passwords exist only in private input/request memory and, after confirmed create/reset, the one-time handoff panel. Close, logout, owner change or unmount retires the private UI. No plaintext is stored in localStorage, sessionStorage, navigation URLs or application logs. JavaScript cannot guarantee physical memory erasure.
- Clipboard access happens only after an explicit copy action. Clear the system clipboard after delivery; the application cannot revoke already copied content. Do not record private forms or capture screenshots containing revealed credentials.
- Private requests use the existing `useInventory` authentication/CSRF coordinator, same-origin cookies and no-store responses. Mount aborts and live epoch/session-owner checks apply at dispatch and settlement; obsolete responses cannot publish another owner's names/secrets or log out a newer owner.
- Mutations are never automatically retried. After network uncertainty, explicitly refresh the directory and consult the current account/branch state before submitting again. A refresh cannot recover a submitted temporary password.

Routes are `/#/administracion` and `/#/mi-contrasena`. Hashes contain navigation only and grant no authority. Existing inventory/transfer Back/Forward behavior and transfer creation/recovery navigation guards remain in place. Private form drafts are not restored after remount or refresh.

## API and verification boundary

See the authoritative [administration API](../../api/docs/administration.md) and [authentication API](../../api/docs/authentication.md) contracts. Account IDs are canonical decimal strings; location IDs are smallint integers. Warehouse context may appear in lists but is never assignable to operators. HTTP errors are mapped from known error codes; server/transport details and credentials are not displayed.

Focused frontend tests exercise React/controller behavior against mocked HTTP boundaries. They do not establish backend integration, browser geometry, deployment readiness or independent security acceptance; those checks remain parent-owned.
