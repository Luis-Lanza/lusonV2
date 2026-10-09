package transfers

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"luson/api/internal/auth"
)

// Totals counts requests, not quantities or possible decision buttons.
// ActionCount is the Pending subset assigned to the persisted approver.
type Totals struct {
	PendingTotal int64
	ActionCount  int64
}

// Counts reads both participant-private totals in one aggregate and one
// read-only repeatable-read snapshot. It never loads items or paginates.
// A separately fetched List can see a different committed snapshot.
func (s *Store) Counts(ctx context.Context, actor auth.Identity) (Totals, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Totals{}, ErrUnavailable
	}
	if !assigned(actor) {
		return Totals{}, ErrForbidden
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return Totals{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()

	var totals Totals
	// Apply participant privacy before aggregating. Each header contributes
	// exactly once regardless of item count, quantities, or future actions.
	err = tx.QueryRow(ctx, `SELECT count(*),
 count(*) FILTER (WHERE approver_location_id=$1)
 FROM transfer_requests
 WHERE $1 IN (origin_location_id,destination_location_id) AND status='pending'`,
		actor.AccountID).Scan(&totals.PendingTotal, &totals.ActionCount)
	if err != nil {
		return Totals{}, fail(ctx)
	}
	// Do not return an apparently successful result before snapshot commit.
	if tx.Commit(ctx) != nil {
		return Totals{}, fail(ctx)
	}
	return totals, nil
}
