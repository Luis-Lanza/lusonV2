package transfers

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"luson/api/internal/auth"
)

// Dispatch consumes the whole approved request at its physical origin. The
// database transition owns stock deduction and allocation consumption together;
// even direct SQL cannot persist a header-only dispatch. No destination credit.
func (s *Store) Dispatch(ctx context.Context, actor auth.Identity, id int64) (Request, error) {
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
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
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
	var origin int
	err = tx.QueryRow(ctx, `SELECT origin_location_id FROM transfer_requests
 WHERE id=$1 AND $2 IN (origin_location_id,destination_location_id) FOR UPDATE`, id, actor.AccountID).Scan(&origin)
	if errors.Is(err, pgx.ErrNoRows) {
		return Request{}, ErrNotFound
	}
	if err != nil {
		return Request{}, fail(ctx)
	}
	// Authorization precedes retries/conflicts so destination cannot dispatch or
	// probe an outcome through this capability, including warehouse proposals.
	if origin != actor.Location.ID {
		return Request{}, ErrForbidden
	}
	r, err := load(ctx, tx, actor.AccountID, id)
	if err != nil {
		return Request{}, err
	}
	switch r.Status {
	case "in_transit":
		if tx.Commit(ctx) != nil {
			return Request{}, fail(ctx)
		}
		return r, nil
	case "approved":
		// The transition locks source inventory in sorted variant order.
	case "pending", "rejected":
		return Request{}, ErrDecisionConflict
	default:
		return Request{}, ErrUnavailable
	}
	tag, err := tx.Exec(ctx, "UPDATE transfer_requests SET status='in_transit' WHERE id=$1", id)
	if err != nil || tag.RowsAffected() != 1 {
		return Request{}, fail(ctx)
	}
	r, err = load(ctx, tx, actor.AccountID, id)
	if err != nil {
		return Request{}, err
	}
	if tx.Commit(ctx) != nil {
		return Request{}, fail(ctx)
	}
	return r, nil
}
