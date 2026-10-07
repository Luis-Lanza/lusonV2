package bootstrap

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/catalog"
	"luson/api/internal/db"
)

// Credentials are supplied privately in location order: Almacén, A, B.
type Credentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// Provision refuses replay and partial datasets; it never touches inventory.
func Provision(ctx context.Context, pool *pgxpool.Pool, credentials []Credentials) error {
	if len(credentials) != 3 {
		return errors.New("exactly three credentials required")
	}
	users, passwords := map[string]bool{}, map[string]bool{}
	for _, c := range credentials {
		if !auth.ValidCredentials(c.Username, c.Password) || users[c.Username] || passwords[c.Password] {
			return errors.New("invalid or duplicate credentials")
		}
		users[c.Username] = true
		passwords[c.Password] = true
	}
	if err := db.Check(ctx, pool); err != nil {
		return err
	}
	hashes := make([]string, 3)
	for i, c := range credentials {
		var err error
		hashes[i], err = auth.HashPassword(c.Password)
		if err != nil {
			return err
		}
	}
	return db.Locked(ctx, pool, func(tx pgx.Tx) error {
		var count int
		if err := tx.QueryRow(ctx, "SELECT count(*) FROM auth_accounts").Scan(&count); err != nil {
			return err
		}
		if count != 0 {
			return errors.New("existing accounts present; provisioning refused")
		}
		for _, location := range catalog.Locations() {
			var name string
			if err := tx.QueryRow(ctx, "SELECT name FROM locations WHERE id=$1", location.ID).Scan(&name); err != nil {
				return errors.New("three existing locations required")
			}
			if name != location.Name {
				return errors.New("location assignment mismatch")
			}
		}
		for i, c := range credentials {
			if _, err := tx.Exec(ctx, "INSERT INTO auth_accounts(location_id,username,password_hash) VALUES($1,$2,$3)", i+1, c.Username, hashes[i]); err != nil {
				return err
			}
		}
		return nil
	})
}
