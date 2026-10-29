package transfers

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"luson/api/internal/auth"
)

// Totals counts requests, not quantities or possible decision buttons.
// ActionCount counts the union of location-owned lifecycle and review obligations.
type Totals struct {
	PendingTotal int64
	ActionCount  int64
	Actions      ActionBreakdown
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
	if err := checkAssignment(ctx, s.pool, actor); err != nil {
		return Totals{}, err
	}
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
	err = tx.QueryRow(ctx, `SELECT count(*) FILTER (WHERE status='pending'),
 count(*) FILTER (WHERE `+anyRequiredActionSQL+`),
 count(*) FILTER (WHERE approve), count(*) FILTER (WHERE dispatch),
 count(*) FILTER (WHERE receive), count(*) FILTER (WHERE review_count),
 count(*) FILTER (WHERE review_restitution),
 count(*) FILTER (WHERE review_dispatch_reconciliation)
 FROM (`+requiredActionsSQL+`) actions`, actor.Location.ID).Scan(
		&totals.PendingTotal, &totals.ActionCount, &totals.Actions.Approve,
		&totals.Actions.Dispatch, &totals.Actions.Receive,
		&totals.Actions.ReviewCount, &totals.Actions.ReviewRestitution,
		&totals.Actions.ReviewDispatchReconciliation)
	if err != nil {
		return Totals{}, fail(ctx)
	}
	// Do not return an apparently successful result before snapshot commit.
	if tx.Commit(ctx) != nil {
		return Totals{}, fail(ctx)
	}
	return totals, nil
}
