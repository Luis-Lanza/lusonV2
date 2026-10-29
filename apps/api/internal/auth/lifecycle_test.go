package auth_test

import (
	"context"
	"testing"
	"time"

	"luson/api/internal/auth"
	"luson/api/internal/bootstrap"
	"luson/api/internal/config"
	"luson/api/internal/testpg"
)

func TestT3LoginLifecycleRace(t *testing.T) {
	for _, mutation := range []string{"reset", "disable", "reassign"} {
		t.Run(mutation, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			p := testpg.Open(t)
			if err := bootstrap.Initialize(ctx, p, config.LocalTrial); err != nil {
				t.Fatal(err)
			}
			creds := make([]bootstrap.Credentials, 3)
			for i := range creds {
				creds[i] = bootstrap.Credentials{Username: "u" + testpg.Random(t)[:20], Password: testpg.Random(t)}
			}
			if err := bootstrap.Provision(ctx, p, creds); err != nil {
				t.Fatal(err)
			}
			svc, err := auth.New(p, nil)
			if err != nil {
				t.Fatal(err)
			}
			tx, err := p.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(context.Background())
			if _, err := tx.Exec(ctx, `SELECT id FROM auth_accounts WHERE id=2 FOR UPDATE`); err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() {
				_, _, err := svc.Login(ctx, creds[1].Username, creds[1].Password, "127.0.0.1", "")
				done <- err
			}()
			// Observe the post-hash lock wait, not a timing guess about hash duration.
			ticker := time.NewTicker(5 * time.Millisecond)
			defer ticker.Stop()
			for {
				var waiting bool
				if err := p.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT password_hash,authority_version,enabled%')`).Scan(&waiting); err != nil {
					t.Fatal("race observation failed")
				}
				if waiting {
					break
				}
				select {
				case err := <-done:
					t.Fatalf("login completed before lifecycle lock: %v", err)
				case <-ctx.Done():
					t.Fatal("login did not reach lifecycle lock")
				case <-ticker.C:
				}
			}
			query := `UPDATE auth_accounts SET authority_version=authority_version+1,location_id=3 WHERE id=2`
			if mutation == "disable" {
				query = `UPDATE auth_accounts SET authority_version=authority_version+1,enabled=false WHERE id=2`
			}
			if mutation == "reset" {
				replacement, err := auth.HashPassword(testpg.Random(t))
				if err != nil {
					t.Fatal(err)
				}
				if _, err := tx.Exec(ctx, `UPDATE auth_accounts SET authority_version=authority_version+1,password_hash=$1 WHERE id=2`, replacement); err != nil {
					t.Fatal(err)
				}
			} else if _, err := tx.Exec(ctx, query); err != nil {
				t.Fatal(err)
			}
			if err := tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			if err := <-done; err != auth.ErrCredentials {
				t.Fatalf("concurrent lifecycle login: %v", err)
			}
			var count int
			if p.QueryRow(ctx, `SELECT count(*) FROM auth_sessions`).Scan(&count) != nil || count != 0 {
				t.Fatal("concurrent lifecycle minted authority")
			}
		})
	}
}
