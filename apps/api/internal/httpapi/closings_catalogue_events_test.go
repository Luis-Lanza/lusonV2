package httpapi

// A write of the motive catalogue is a fact every session has to learn without a reload (S8): the list
// is global, so its frame is not addressed to a location. This proves the frame reaches a branch stream
// and the administrator's stream alike, and that a write the database refused or a transaction that was
// rolled back publishes nothing at all -- a hint for a change that did not happen would send every
// reader after a list that never moved.

import (
	"context"
	"testing"
	"time"

	"luson/api/internal/auth"
	"luson/api/internal/closings"
)

// TestCatalogueWriteReachesEveryStream proves the two halves of S8 on live streams: the rename of a
// motive arrives as the `catalogue` frame on every open stream, and the refusals of the catalogue --
// a rolled-back write, the guard's refusal and the store's own -- arrive as nothing.
func TestCatalogueWriteReachesEveryStream(t *testing.T) {
	env := eventFixture(t)
	server := eventServer(t, env)
	clients := make([]*eventClient, 3)
	for i := range clients {
		clients[i] = openEvents(t, env, server, i+1, "")
		expectHTTPEvent(t, clients[i], "resync")
	}
	if _, err := env.f.p.Exec(env.f.ctx, `UPDATE branch_cash_categories SET label='Agua potable'
 WHERE label='Agua'`); err != nil {
		t.Fatalf("the catalogue write failed: %v", err)
	}
	for i := range clients {
		expectHTTPEvent(t, clients[i], "catalogue")
	}

	// A write that never commits is a write that never happened.
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tx, err := env.f.p.Begin(ctx)
	if err != nil {
		t.Fatal("the uncommitted write could not be started")
	}
	if _, err := tx.Exec(ctx, `UPDATE branch_cash_categories SET label='Agua de mesa'
 WHERE label='Agua potable'`); err != nil {
		t.Fatalf("the uncommitted write failed: %v", err)
	}
	_ = tx.Rollback(ctx)

	// The guard refuses the archive of the pinned catch-all, and its refusal publishes nothing (S10).
	if _, err := env.f.p.Exec(env.f.ctx, `UPDATE branch_cash_categories SET retired_at=now(),
 retired_by='dev_almacen' WHERE pinned`); err == nil {
		t.Fatal("the pinned motive must not be archivable")
	}
	eventBoundary(t, env, clients, make([][]string, 3))

	// The store's own refusal of the same archive is silent too: the screen is answered, no scope moves.
	store := closings.New(env.f.p)
	actor := auth.Identity{AccountID: 1, Location: auth.Location{ID: 1}}
	var pinned int64
	if err := env.f.p.QueryRow(env.f.ctx, `SELECT id FROM branch_cash_categories WHERE pinned`).Scan(&pinned); err != nil {
		t.Fatalf("the catch-all must be seeded: %v", err)
	}
	if _, err := store.RetireCashCategory(env.f.ctx, actor, pinned); err == nil {
		t.Fatal("the store must refuse archiving the pinned motive")
	}
	eventBoundary(t, env, clients, make([][]string, 3))
}
