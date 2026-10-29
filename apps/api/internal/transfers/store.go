package transfers

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/catalog"
)

type Store struct{ pool *pgxpool.Pool }

func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

// fail retains cancellation semantics but never driver/config/SQL details.
func fail(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return ErrUnavailable
}
func retryLock(creator int, key string) int64 {
	h := sha256.Sum256([]byte(fmt.Sprintf("luson.pending.retry/v1:%d:%s", creator, key)))
	return int64(binary.BigEndian.Uint64(h[:8]))
}

// Create serializes only this actor/key, then checks replay before acquiring
// stock locks. Every selected source row is locked in ascending variant order.
// Branch Pending writes no balances. Direct creation reserves the complete cart
// under the same integrity-before-row lock order as approval/dispatch/cancel.
func (s *Store) Create(ctx context.Context, actor auth.Identity, input CreateInput) (CreateResult, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return CreateResult{}, ErrUnavailable
	}
	n, err := Validate(actor, input)
	if err != nil {
		return CreateResult{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return CreateResult{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", retryLock(n.CreatorID, n.RetryKey)); err != nil {
		return CreateResult{}, fail(ctx)
	}
	if err := checkAssignment(ctx, tx, actor); err != nil {
		return CreateResult{}, err
	}
	var destinationExists bool
	if tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM locations WHERE id=$1)", n.DestinationID).Scan(&destinationExists) != nil {
		return CreateResult{}, fail(ctx)
	}
	if !destinationExists {
		return CreateResult{}, ErrInvalid
	}
	var id int64
	var fingerprint []byte
	err = tx.QueryRow(ctx, "SELECT id,payload_sha256 FROM transfer_requests WHERE creator_location_id=$1 AND retry_key=$2", n.CreatorID, n.RetryKey).Scan(&id, &fingerprint)
	replayed := err == nil
	if replayed {
		if !bytes.Equal(fingerprint, n.Fingerprint[:]) {
			return CreateResult{}, ErrRetryConflict
		}
	} else if errors.Is(err, pgx.ErrNoRows) {
		if n.Kind == DirectShipment {
			if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(714025,1)"); err != nil {
				return CreateResult{}, fail(ctx)
			}
		}
		ids := make([]int32, len(n.Items))
		for i, line := range n.Items {
			ids[i] = int32(line.VariantID)
		}
		rows, err := tx.Query(ctx, `SELECT b.variant_id,b.available FROM inventory_balances b
   JOIN catalog_variants v ON v.id=b.variant_id
   WHERE b.location_id=$1 AND b.variant_id=ANY($2::integer[])
   ORDER BY b.variant_id FOR UPDATE OF b`, n.OriginID, ids)
		if err != nil {
			return CreateResult{}, fail(ctx)
		}
		available := make(map[int64]int64, len(ids))
		for rows.Next() {
			var variant, quantity int64
			if rows.Scan(&variant, &quantity) != nil {
				rows.Close()
				return CreateResult{}, fail(ctx)
			}
			available[variant] = quantity
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return CreateResult{}, fail(ctx)
		}
		if len(available) != len(n.Items) {
			return CreateResult{}, ErrInvalid
		}
		for _, line := range n.Items {
			if available[line.VariantID] < line.Quantity {
				return CreateResult{}, ErrInsufficientStock
			}
		}
		status := "pending"
		if n.Kind == DirectShipment {
			status = "approved"
		}
		err = tx.QueryRow(ctx, `INSERT INTO transfer_requests
   (creator_location_id,kind,origin_location_id,destination_location_id,approver_location_id,retry_key,payload_sha256,status)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, n.CreatorID, string(n.Kind), n.OriginID, n.DestinationID, n.ApproverID, n.RetryKey, n.Fingerprint[:], status).Scan(&id)
		if err != nil {
			return CreateResult{}, fail(ctx)
		}
		for _, line := range n.Items {
			if _, err := tx.Exec(ctx, "INSERT INTO transfer_request_items(request_id,variant_id,quantity) VALUES($1,$2,$3)", id, int32(line.VariantID), line.Quantity); err != nil {
				return CreateResult{}, fail(ctx)
			}
			if n.Kind == DirectShipment {
				// Whole-cart availability was checked before any writes. Each
				// addition is bounded by existing stock, not a summed cart total.
				tag, err := tx.Exec(ctx, "UPDATE inventory_balances SET reserved=reserved+$3 WHERE location_id=$1 AND variant_id=$2", n.OriginID, int32(line.VariantID), line.Quantity)
				if err != nil || tag.RowsAffected() != 1 {
					return CreateResult{}, fail(ctx)
				}
				if _, err := tx.Exec(ctx, "INSERT INTO transfer_request_allocations(request_id,variant_id,quantity) VALUES($1,$2,$3)", id, int32(line.VariantID), line.Quantity); err != nil {
					return CreateResult{}, fail(ctx)
				}
			}
		}
	} else {
		return CreateResult{}, fail(ctx)
	}
	r, err := load(ctx, tx, actor.Location.ID, id)
	if err != nil {
		return CreateResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return CreateResult{}, fail(ctx)
	}
	return CreateResult{Request: r, Replayed: replayed}, nil
}

// Get is participant-scoped; neither a foreign nor missing ID reveals a record.
// The caller must supply a server-authenticated Identity, never a client DTO.
func (s *Store) Get(ctx context.Context, actor auth.Identity, id int64) (Request, error) {
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
	return load(ctx, s.pool, actor.Location.ID, id)
}

type querier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

func load(ctx context.Context, q querier, participant int, id int64) (Request, error) {
	var r Request
	var retryKey string
	var fingerprint []byte
	err := q.QueryRow(ctx, `SELECT r.id,r.kind,r.status,r.created_at,
  c.id,c.name,o.id,o.name,d.id,d.name,a.id,a.name,r.retry_key,r.payload_sha256,
  r.decision_location_id,r.decided_at,r.dispatch_location_id,r.dispatched_at,r.receipt_location_id,r.received_at,
  r.cancellation_location_id,r.cancelled_at
  FROM transfer_requests r
  JOIN locations c ON c.id=r.creator_location_id JOIN locations o ON o.id=r.origin_location_id
  JOIN locations d ON d.id=r.destination_location_id JOIN locations a ON a.id=r.approver_location_id
  WHERE r.id=$1 AND $2 IN (r.origin_location_id,r.destination_location_id)`, id, participant).Scan(
		&r.ID, &r.Kind, &r.Status, &r.CreatedAt, &r.Creator.ID, &r.Creator.Name, &r.Origin.ID, &r.Origin.Name, &r.Destination.ID, &r.Destination.Name, &r.Approver.ID, &r.Approver.Name, &retryKey, &fingerprint, &r.DecisionLocationID, &r.DecidedAt, &r.DispatchLocationID, &r.DispatchedAt, &r.ReceiptLocationID, &r.ReceivedAt, &r.CancellationLocationID, &r.CancelledAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Request{}, ErrNotFound
	}
	if err != nil {
		return Request{}, fail(ctx)
	}
	rows, err := q.Query(ctx, `SELECT i.variant_id,i.quantity,e.brand,e.model,e.capacity_ah::text,v.polarity
  FROM transfer_request_items i JOIN catalog_variants v ON v.id=i.variant_id
  JOIN catalog_entries e ON e.id=v.catalog_entry_id WHERE i.request_id=$1 ORDER BY i.variant_id`, id)
	if err != nil {
		return Request{}, fail(ctx)
	}
	defer rows.Close()
	lines := []Line{}
	for rows.Next() {
		var item Item
		var capacity string
		if rows.Scan(&item.VariantID, &item.Quantity, &item.Brand, &item.Model, &capacity, &item.Polarity) != nil {
			return Request{}, fail(ctx)
		}
		item.Capacity, err = catalog.ParseDecimal(capacity)
		if err != nil {
			return Request{}, ErrUnavailable
		}
		r.Items = append(r.Items, item)
		lines = append(lines, Line{VariantID: item.VariantID, Quantity: item.Quantity})
	}
	if rows.Err() != nil {
		return Request{}, fail(ctx)
	}
	counterparty := r.Origin.ID
	if r.Kind == SendToWarehouse {
		counterparty = 1
	} else if r.Kind == DirectShipment {
		counterparty = r.Destination.ID
	}
	// Verify completeness/canonical payload as well as SQL constraints. Private
	// retry material is used only internally, never included in the public record.
	expected, err := locationIntent(r.Creator.ID, CreateInput{Kind: r.Kind, CounterpartyID: counterparty, RetryKey: retryKey, Items: lines})
	if err != nil || !bytes.Equal(fingerprint, expected.Fingerprint[:]) ||
		r.Origin.ID != expected.OriginID || r.Destination.ID != expected.DestinationID || r.Approver.ID != expected.ApproverID {
		return Request{}, ErrUnavailable
	}
	if r.Kind == DirectShipment && (r.Status == "pending" || r.Status == "rejected" ||
		r.DecisionLocationID == nil || *r.DecisionLocationID != 1 || r.DecidedAt == nil || !r.DecidedAt.Equal(r.CreatedAt)) {
		return Request{}, ErrUnavailable
	}
	// Admit only persisted lifecycle outcomes with consistent decision metadata.
	// HTTP callers must separately fence outcomes until their DTO supports them.
	switch r.Status {
	case "pending":
		if r.DecisionLocationID != nil || r.DecidedAt != nil {
			return Request{}, ErrUnavailable
		}
	case "cancelled":
		if (r.DecisionLocationID == nil) != (r.DecidedAt == nil) {
			return Request{}, ErrUnavailable
		}
		if r.DecidedAt != nil && (*r.DecisionLocationID != r.Approver.ID || r.DecidedAt.Before(r.CreatedAt)) {
			return Request{}, ErrUnavailable
		}
	case "approved", "rejected", "in_transit", "received":
		if r.DecisionLocationID == nil || *r.DecisionLocationID != r.Approver.ID || r.DecidedAt == nil || r.DecidedAt.Before(r.CreatedAt) {
			return Request{}, ErrUnavailable
		}
	default:
		return Request{}, ErrUnavailable
	}
	if r.Status == "cancelled" {
		if r.CancellationLocationID == nil || *r.CancellationLocationID != r.Creator.ID || r.CancelledAt == nil ||
			r.CancelledAt.Before(r.CreatedAt) || (r.DecidedAt != nil && r.CancelledAt.Before(*r.DecidedAt)) {
			return Request{}, ErrUnavailable
		}
	} else if r.CancellationLocationID != nil || r.CancelledAt != nil {
		return Request{}, ErrUnavailable
	}
	if r.Status == "in_transit" || r.Status == "received" {
		if r.DispatchLocationID == nil || *r.DispatchLocationID != r.Origin.ID || r.DispatchedAt == nil || r.DispatchedAt.Before(*r.DecidedAt) {
			return Request{}, ErrUnavailable
		}
	} else if r.DispatchLocationID != nil || r.DispatchedAt != nil {
		return Request{}, ErrUnavailable
	}
	rows.Close()
	if err := loadReceipt(ctx, q, &r); err != nil {
		return Request{}, err
	}
	r.Reference = fmt.Sprintf("TR-%03d", r.ID)
	return r, nil
}
