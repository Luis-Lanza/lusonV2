package auth

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

var ErrRecovery = errors.New("warehouse recovery refused")

// RecoverWarehouseCredential is only for a private server command whose host
// database authority is the trust boundary. It intentionally takes no identity,
// session or current password. Never expose this entry point through HTTP.
func (s *Service) RecoverWarehouseCredential(ctx context.Context, password string) error {
	if !ValidCredentials("valid", password) {
		return ErrPassword
	}
	replacement, err := s.administrationHash(password)
	if err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	// Lock and read current account state before touching any sessions. A
	// concurrent login/change/reset must observe this committed replacement.
	var location int
	var enabled bool
	err = tx.QueryRow(ctx, `SELECT location_id,enabled FROM auth_accounts WHERE id=1 FOR UPDATE`).Scan(&location, &enabled)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && (location != 1 || !enabled)) {
		return ErrRecovery
	}
	if err != nil {
		return err
	}
	if err = resetAccountCredential(ctx, tx, 1, replacement, s.now().UTC()); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
