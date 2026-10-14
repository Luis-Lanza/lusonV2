package transfers

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"luson/api/internal/auth"
)

// Approve reserves the immutable whole request at its physical origin. The
// caller supplies an authenticated identity; the persisted approver authorizes
// the decision. Direct shipments are already authorized at creation.
func (s *Store) Approve(ctx context.Context, actor auth.Identity, id int64) (Request, error) {
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
	// Match the lifecycle guards' integrity lock BEFORE any row locks. This
	// order serializes protected writers, not arbitrary SQL that prelocks rows.
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
	// Authorize before terminal handling: a visible non-approver cannot retry
	// an approval or probe a rejection through the decision method.
	if approver != actor.Location.ID {
		return Request{}, ErrForbidden
	}
	r, err := load(ctx, tx, actor.AccountID, id)
	if err != nil {
		return Request{}, err
	}
	if r.Kind == DirectShipment {
		return Request{}, ErrDecisionConflict
	}
	switch r.Status {
	case "approved", "in_transit", "received":
		// No stock query or mutation on same-action retry, even when later
		// independent holds have exhausted all remaining availability.
		if tx.Commit(ctx) != nil {
			return Request{}, fail(ctx)
		}
		return r, nil
	case "rejected", "cancelled":
		return Request{}, ErrDecisionConflict
	case "pending":
		// Continue with all-item current availability validation.
	default:
		return Request{}, ErrUnavailable
	}
	ids := make([]int32, len(r.Items))
	for i, item := range r.Items {
		ids[i] = int32(item.VariantID)
	}
	rows, err := tx.Query(ctx, `SELECT b.variant_id,b.available FROM inventory_balances b
 WHERE b.location_id=$1 AND b.variant_id=ANY($2::integer[])
 ORDER BY b.variant_id FOR UPDATE OF b`, r.Origin.ID, ids)
	if err != nil {
		return Request{}, fail(ctx)
	}
	available := make(map[int64]int64, len(ids))
	for rows.Next() {
		var variant, quantity int64
		if rows.Scan(&variant, &quantity) != nil {
			rows.Close()
			return Request{}, fail(ctx)
		}
		available[variant] = quantity
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return Request{}, fail(ctx)
	}
	// Close the result before any writes, and validate every line first. Each
	// quantity <= existing-reserved proves reserved+quantity <= MaxInt64;
	// summing quantities across unrelated variants would not be safe.
	for _, item := range r.Items {
		quantity, exists := available[item.VariantID]
		if !exists || quantity < item.Quantity {
			return Request{}, ErrInsufficientStock
		}
	}
	for _, item := range r.Items {
		tag, err := tx.Exec(ctx, `UPDATE inventory_balances SET reserved=reserved+$3
 WHERE location_id=$1 AND variant_id=$2`, r.Origin.ID, int32(item.VariantID), item.Quantity)
		if err != nil || tag.RowsAffected() != 1 {
			return Request{}, fail(ctx)
		}
		tag, err = tx.Exec(ctx, `INSERT INTO transfer_request_allocations(request_id,variant_id,quantity)
 VALUES($1,$2,$3)`, id, int32(item.VariantID), item.Quantity)
		if err != nil || tag.RowsAffected() != 1 {
			return Request{}, fail(ctx)
		}
	}
	// Database guards derive allocation origin and decision actor/time. Never
	// copy actor metadata supplied by the caller into persisted outcome fields.
	tag, err := tx.Exec(ctx, "UPDATE transfer_requests SET status='approved' WHERE id=$1", id)
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
