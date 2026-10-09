package transfers

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"luson/api/internal/auth"
)

// Reject closes an authorized whole Pending request without reserving stock.
// The caller supplies an authenticated identity; the persisted approver is
// authoritative, including warehouse actors who cannot create requests.
func (s *Store) Reject(ctx context.Context, actor auth.Identity, id int64) (Request, error) {
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
	// Match lifecycle integrity guards BEFORE any row locks. The database
	// may inspect stock internally; this method issues no inventory queries.
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(714025,1)"); err != nil {
		return Request{}, fail(ctx)
	}
	var approver int
	err = tx.QueryRow(ctx, `SELECT approver_location_id FROM transfer_requests
 WHERE id=$1 AND $2 IN (origin_location_id,destination_location_id) FOR UPDATE`, id, actor.AccountID).Scan(&approver)
	if errors.Is(err, pgx.ErrNoRows) {
		return Request{}, ErrNotFound
	}
	if err != nil {
		return Request{}, fail(ctx)
	}
	// Authorize before terminal handling: visible non-approvers cannot retry
	// a rejection or learn a conflicting decision through this method.
	if approver != actor.Location.ID {
		return Request{}, ErrForbidden
	}
	r, err := load(ctx, tx, actor.AccountID, id)
	if err != nil {
		return Request{}, err
	}
	switch r.Status {
	case "rejected":
		// Same-action retry returns the original outcome/time without writes.
		if tx.Commit(ctx) != nil {
			return Request{}, fail(ctx)
		}
		return r, nil
	case "approved":
		return Request{}, ErrDecisionConflict
	case "pending":
		// Continue with the whole-request status transition only.
	default:
		return Request{}, ErrUnavailable
	}
	// Guards derive decision actor/time from the persisted request. No stock,
	// allocation, independent hold or owned reservation is changed/released.
	tag, err := tx.Exec(ctx, "UPDATE transfer_requests SET status='rejected' WHERE id=$1", id)
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
