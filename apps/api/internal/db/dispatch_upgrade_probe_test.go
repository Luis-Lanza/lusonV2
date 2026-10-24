package db

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"luson/api/internal/testpg"
)

// Upgrade the real checksummed 001-012 prefix using the normal runner.
func TestDR1VerifierMigrationUpgrade(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	p := testpg.Open(t)
	all, err := versions()
	if err != nil || len(all) != 13 {
		t.Fatal("expected thirteen embedded migrations", err)
	}
	err = Locked(ctx, p, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `CREATE TABLE schema_migrations (
			version integer PRIMARY KEY CHECK (version > 0), name text NOT NULL,
			checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
			return err
		}
		for _, m := range all[:12] {
			if _, err := tx.Exec(ctx, m.sql); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, "INSERT INTO schema_migrations(version,name,checksum) VALUES($1,$2,$3)", m.version, m.name, m.checksum); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal("real prefix installation", err)
	}
	snapshot := func() string {
		var s string
		if err := p.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(m) ORDER BY version)::text FROM schema_migrations m WHERE version<=12`).Scan(&s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	before := snapshot()
	if err := Apply(ctx, p); err != nil {
		t.Fatal("normal upgrade", err)
	}
	if err := Check(ctx, p); err != nil {
		t.Fatal("tracking verification", err)
	}
	if before != snapshot() {
		t.Fatal("historical migration evidence changed")
	}
	if err := Apply(ctx, p); err != nil {
		t.Fatal("idempotent application", err)
	}
	if before != snapshot() {
		t.Fatal("replay changed historical tracking")
	}
	var n int
	if err := p.QueryRow(ctx, "SELECT count(*) FROM schema_migrations").Scan(&n); err != nil || n != 13 {
		t.Fatal("upgrade tracker", n, err)
	}
}
