// Package db applies embedded schema versions atomically under a shared lock.
package db

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/migrations"
)

// InitializationLock serializes schema and seed transactions across processes.
// Transaction-scoped: PostgreSQL releases it on commit, rollback or disconnect.
const InitializationLock int64 = 0x4c55534f4e3031

func Locked(ctx context.Context, pool *pgxpool.Pool, fn func(pgx.Tx) error) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", InitializationLock); err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

type migration struct {
	version             int
	name, sql, checksum string
}

func versions() ([]migration, error) {
	files, err := migrations.Files.ReadDir(".")
	if err != nil {
		return nil, err
	}
	result := []migration{}
	for _, file := range files {
		if !strings.HasSuffix(file.Name(), ".sql") {
			continue
		}
		prefix, _, ok := strings.Cut(file.Name(), "_")
		version, err := strconv.Atoi(prefix)
		if !ok || err != nil || version != len(result)+1 {
			return nil, errors.New("migration versions must be contiguous")
		}
		sql, err := migrations.Files.ReadFile(file.Name())
		if err != nil {
			return nil, err
		}
		hash := sha256.Sum256(sql)
		result = append(result, migration{version, file.Name(), string(sql), hex.EncodeToString(hash[:])})
	}
	return result, nil
}

func Apply(ctx context.Context, pool *pgxpool.Pool) error {
	all, err := versions()
	if err != nil {
		return err
	}
	return Locked(ctx, pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
   version integer PRIMARY KEY CHECK (version > 0),
   name text NOT NULL,
   checksum text NOT NULL,
   applied_at timestamptz NOT NULL DEFAULT now()
  )`); err != nil {
			return err
		}
		applied, err := readApplied(ctx, tx, all)
		if err != nil {
			return err
		}
		for _, m := range all[applied:] {
			if _, err := tx.Exec(ctx, m.sql); err != nil {
				return fmt.Errorf("migration %d failed: %w", m.version, err)
			}
			if _, err := tx.Exec(ctx, "INSERT INTO schema_migrations(version,name,checksum) VALUES($1,$2,$3)", m.version, m.name, m.checksum); err != nil {
				return err
			}
		}
		return nil
	})
}

// Check verifies tracking without applying missing versions or modifying data.
func Check(ctx context.Context, pool *pgxpool.Pool) error {
	all, err := versions()
	if err != nil {
		return err
	}
	return Locked(ctx, pool, func(tx pgx.Tx) error {
		applied, err := readApplied(ctx, tx, all)
		if err != nil {
			return err
		}
		if applied != len(all) {
			return errors.New("schema migrations are incomplete")
		}
		return nil
	})
}
func readApplied(ctx context.Context, tx pgx.Tx, all []migration) (int, error) {
	rows, err := tx.Query(ctx, "SELECT version,name,checksum FROM schema_migrations ORDER BY version")
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var version int
		var name, checksum string
		if err := rows.Scan(&version, &name, &checksum); err != nil {
			return 0, err
		}
		if count >= len(all) || version != all[count].version || name != all[count].name || checksum != all[count].checksum {
			return 0, errors.New("migration tracking differs from embedded schema")
		}
		count++
	}
	return count, rows.Err()
}
