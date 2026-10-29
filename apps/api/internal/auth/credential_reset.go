package auth

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// retireAccountSessions requires the caller to hold the account row lock.
// Version changes and session retirement belong to the caller's transaction.
func retireAccountSessions(ctx context.Context, tx pgx.Tx, accountID int64, now time.Time) error {
	_, err := tx.Exec(ctx, `UPDATE auth_sessions SET revoked_at=$2 WHERE account_id=$1 AND revoked_at IS NULL`, accountID, now)
	return err
}

// resetAccountCredential is deliberately authority-neutral: its caller must
// authorize the operation and lock the account before any session locks. The
// future private recovery entry point can reuse this without an HTTP override.
// The replacement is an already validated, bounded-admission password hash.
// Reset does not reactivate disabled accounts.
func resetAccountCredential(ctx context.Context, tx pgx.Tx, accountID int64, replacement string, now time.Time) error {
	if _, err := tx.Exec(ctx, `UPDATE auth_accounts SET password_hash=$2,must_change_password=true,authority_version=authority_version+1 WHERE id=$1`, accountID, replacement); err != nil {
		return err
	}
	return retireAccountSessions(ctx, tx, accountID, now)
}
