package transfers

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"luson/api/internal/auth"
)

// Cancel seals a creator-owned Pending or Approved request before dispatch.
// SQL owns the release of active reservations; the public API never edits stock
// or deletes history. Authorization precedes even a read-only duplicate retry.
func (s *Store) Cancel(ctx context.Context, actor auth.Identity, id int64) (Request, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Request{}, ErrUnavailable
	}
	if !assigned(actor) {
		return Request{}, ErrForbidden
	}
	if id < 1 {
		return Request{}, ErrNotFound
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := checkAssignment(ctx, s.pool, actor); err != nil {
		return Request{}, err
	}
	tx, err := s.beginPersonal(ctx, actor)
	if err != nil {
		return Request{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(714025,1)"); err != nil {
		return Request{}, fail(ctx)
	}
	var creator int
	err = tx.QueryRow(ctx, `SELECT creator_location_id FROM transfer_requests
 WHERE id=$1 AND $2 IN (origin_location_id,destination_location_id) FOR UPDATE`, id, actor.Location.ID).Scan(&creator)
	if errors.Is(err, pgx.ErrNoRows) {
		return Request{}, ErrNotFound
	}
	if err != nil {
		return Request{}, fail(ctx)
	}
	if creator != actor.Location.ID {
		return Request{}, ErrForbidden
	}
	r, err := load(ctx, tx, actor.Location.ID, id)
	if err != nil {
		return Request{}, err
	}
	switch r.Status {
	case "cancelled":
		if tx.Commit(ctx) != nil {
			return Request{}, fail(ctx)
		}
		return r, nil
	case "pending", "approved":
		// The transition locks source balances sorted, then releases only its
		// own complete active allocations without deducting physical stock.
	default:
		return Request{}, ErrDecisionConflict
	}
	tag, err := tx.Exec(ctx, "UPDATE transfer_requests SET status='cancelled' WHERE id=$1", id)
	if err != nil || tag.RowsAffected() != 1 {
		return Request{}, fail(ctx)
	}
	r, err = load(ctx, tx, actor.Location.ID, id)
	if err != nil {
		return Request{}, err
	}
	if tx.Commit(ctx) != nil {
		return Request{}, fail(ctx)
	}
	return r, nil
}
