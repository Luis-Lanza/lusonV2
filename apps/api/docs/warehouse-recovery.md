# Recover the warehouse administrator privately

Use `recover-warehouse` on the trusted server when the sole warehouse administrator cannot log in. Private host/database access is the authority: no active administrator session or previous password is required. This is not a public recovery service.

## Quick path

1. Use an unrecorded private terminal on the server. Supply the existing private `LUSON_DATABASE_URL_FILE` and explicit `LUSON_PROFILE` configuration as in [local deployment](../../../docs/local-deployment.md). Exactly one database provider must be present. Do not place an account password in arguments, environment variables, scripts or logs.
2. From `apps/api`, run `go run ./cmd/recover-warehouse` (or the built `recover-warehouse` binary). Enter a replacement temporary password and confirm it. Both entries are hidden through `/dev/tty`; redirected input is not a credential source.
3. Wait for the private terminal confirmation. All warehouse sessions are retired atomically. Log in using the **unchanged username** and new temporary password, then change it through the mandatory password screen before doing any operational work.

`recover-warehouse --help` and `recover-warehouse -h` print public usage and exit successfully without configuration, terminal or database access. Any other arguments fail with a canned error, never an echo of the arguments.

## Policy and failure behavior

- The replacement follows the existing policy: **12–128 UTF-8 bytes, no NUL**. Spaces are meaningful and are not trimmed. Use a fresh private password; the command cannot deliver it by email or reveal the old password.
- Only existing, enabled account **1**, assigned to warehouse location **1**, can be recovered. There is no selectable identity, role or location. The command never provisions users, assigns usernames, creates a second administrator, reactivates accounts, initializes data, runs migrations or wipes anything.
- A complete migrated database is required. Recovery locks and rechecks the protected account before touching sessions, then commits the replacement hash, mandatory-change flag, authority-version increment and session retirement together. Operator credentials and sessions are unchanged. Hash policy and bounded hash admission are shared with existing authentication.
- Validation, confirmation, terminal and argument failures leave credentials unchanged. Errors are generic: no database URL, driver diagnostics or submitted password is printed. Success writes only a fixed confirmation to the private terminal; stdout and stderr remain empty. Errors use stderr and exit 1; success/help exit 0.
- Interrupt or termination signals restore terminal state and exit 1. Do not record the terminal. A signal or lost connection after a commit may prevent seeing confirmation; privately try the new password before deciding whether another recovery is needed. Recovery is not an audit log or a guarantee against a compromised host.

The new temporary session can inspect its identity, log out and change its own password, but cannot administer accounts or access inventory, transfers or realtime operations until the change is complete. The own-password change retires the temporary session too; log in again afterward. See [authentication](authentication.md) for that contract.
