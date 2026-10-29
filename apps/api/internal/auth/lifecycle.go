package auth

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

var ErrPassword = errors.New("invalid new password")

// ChangePassword retires all existing authority, including the caller's session.
// Lock account before sessions, as Login does, to serialize lifecycle writers.
func (s *Service) ChangePassword(ctx context.Context, token, current, next string) error {
	if !ValidCredentials("valid", next) || current == next {
		return ErrPassword
	}
	session, _, err := s.Peek(ctx, token)
	if err != nil {
		return err
	}
	select {
	case s.hashing <- struct{}{}:
		defer func() { <-s.hashing }()
	default:
		return ErrLimited
	}
	var encoded string
	var version int64
	if err := s.pool.QueryRow(ctx, `SELECT password_hash,authority_version FROM auth_accounts WHERE id=$1`, session.Identity.AccountID).Scan(&encoded, &version); err != nil {
		return err
	}
	if !ValidCredentials(session.Identity.Username, current) || !VerifyPassword(encoded, current) {
		return ErrCredentials
	}
	// Verify against the hash too: equality must not depend on plaintext alone.
	if VerifyPassword(encoded, next) {
		return ErrPassword
	}
	replacement, err := HashPassword(next)
	if err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	var latest string
	var latestVersion int64
	var enabled bool
	err = tx.QueryRow(ctx, `SELECT password_hash,authority_version,enabled FROM auth_accounts WHERE id=$1 FOR UPDATE`, session.Identity.AccountID).Scan(&latest, &latestVersion, &enabled)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrSession
	}
	if err != nil {
		return err
	}
	if !enabled || latestVersion != version || latest != encoded {
		return ErrSession
	}
	// Lock the current session so a completed logout cannot be overwritten.
	var live bool
	err = tx.QueryRow(ctx, `SELECT true FROM auth_sessions WHERE token_hash=$1 AND account_id=$2 AND authority_version=$3 AND revoked_at IS NULL AND absolute_deadline>$4 AND idle_deadline>$4 FOR UPDATE`, tokenHash(token), session.Identity.AccountID, version, s.now().UTC()).Scan(&live)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrSession
	}
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE auth_accounts SET password_hash=$2,must_change_password=false,authority_version=authority_version+1 WHERE id=$1`, session.Identity.AccountID, replacement); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE auth_sessions SET revoked_at=$2 WHERE account_id=$1 AND revoked_at IS NULL`, session.Identity.AccountID, s.now().UTC()); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
