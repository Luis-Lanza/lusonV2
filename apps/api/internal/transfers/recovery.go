package transfers

import (
	"context"
	"errors"
	"math"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// recoveryClockSkew tolerates a producer clock ahead of the database clock.
const recoveryClockSkew = 5 * time.Minute

// RecoveryInput is the administrative evidence for an in-transit transfer whose
// physical arrival included variants that were never dispatched. Items is the
// ordinary observed receipt payload for the dispatched variants; Arrivals is
// audit-only and never credited. ReceivedAt is the observed arrival time: the
// request's own received_at stays server derived by the guarded transition.
type RecoveryInput struct {
	Items      []Line
	Arrivals   []Line
	Reason     string
	Operator   string
	ReceivedAt time.Time
}

// RecoveryPreview reads the transfer an operator is about to recover.
// Administrative authority is the private database configuration; there is no
// account identity, so the read is not participant scoped.
func (s *Store) RecoveryPreview(ctx context.Context, id int64) (Request, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Request{}, ErrUnavailable
	}
	if id < 1 {
		return Request{}, ErrNotFound
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var destination int
	err := s.pool.QueryRow(ctx, "SELECT destination_location_id FROM transfer_requests WHERE id=$1", id).Scan(&destination)
	if errors.Is(err, pgx.ErrNoRows) {
		return Request{}, ErrNotFound
	}
	if err != nil {
		return Request{}, fail(ctx)
	}
	return load(ctx, s.pool, destination, id)
}

// Recover records the declared but undispatched arrivals as audit-only evidence
// and completes the receipt of the dispatched variants in one transaction. The
// receipt is the ordinary one: credit per variant is min(dispatched, observed)
// and the undispatched quantity reaches no balance. Any failure rolls both back.
func (s *Store) Recover(ctx context.Context, id int64, in RecoveryInput) (Request, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Request{}, ErrUnavailable
	}
	if id < 1 {
		return Request{}, ErrNotFound
	}
	normalized, arrivals, err := normalizeRecovery(in)
	if err != nil {
		return Request{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := s.beginRecovery(ctx)
	if err != nil {
		return Request{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	var destination int
	err = tx.QueryRow(ctx, "SELECT destination_location_id FROM transfer_requests WHERE id=$1 FOR UPDATE", id).Scan(&destination)
	if errors.Is(err, pgx.ErrNoRows) {
		return Request{}, ErrNotFound
	}
	if err != nil {
		return Request{}, fail(ctx)
	}
	r, err := load(ctx, tx, destination, id)
	if err != nil {
		return Request{}, err
	}
	if r.Status != "in_transit" {
		return Request{}, ErrDecisionConflict
	}
	// The observed arrival is human evidence, so it is compared at the whole
	// second an operator can actually supply, never below it.
	observed := in.ReceivedAt.UTC().Truncate(time.Microsecond)
	if observed.Before(r.DispatchedAt.UTC().Truncate(time.Second)) || observed.After(time.Now().Add(recoveryClockSkew)) {
		return Request{}, ErrInvalid
	}
	expected, _, _, err := receiptPayload(r, normalized)
	if err != nil {
		return Request{}, err
	}
	for _, arrival := range arrivals {
		if _, dispatched := expected[arrival.VariantID]; dispatched {
			return Request{}, ErrInvalid
		}
		if _, err = tx.Exec(ctx, `INSERT INTO transfer_recovery_events(request_id,variant_id,quantity,reason,operator,received_at) VALUES($1,$2,$3,$4,$5,$6)`, id, int32(arrival.VariantID), arrival.Quantity, in.Reason, in.Operator, observed); err != nil {
			return Request{}, fail(ctx)
		}
	}
	if err = writeReceipt(ctx, tx, id, normalized, expected); err != nil {
		return Request{}, err
	}
	r, err = load(ctx, tx, destination, id)
	if err != nil {
		return Request{}, err
	}
	if tx.Commit(ctx) != nil {
		return Request{}, fail(ctx)
	}
	return r, nil
}

// normalizeRecovery applies the receipt payload rules to the observed lines and
// requires positive, unique arrivals that no dispatched line can absorb.
func normalizeRecovery(in RecoveryInput) (ReceiptInput, []Line, error) {
	if strings.TrimSpace(in.Reason) == "" || utf8.RuneCountInString(in.Reason) > 2000 ||
		strings.TrimSpace(in.Operator) == "" || utf8.RuneCountInString(in.Operator) > 200 ||
		in.ReceivedAt.IsZero() || len(in.Arrivals) == 0 {
		return ReceiptInput{}, nil, ErrInvalid
	}
	normalized, err := NormalizeReceipt(ReceiptInput{Items: in.Items})
	if err != nil {
		return ReceiptInput{}, nil, err
	}
	arrivals := append([]Line(nil), in.Arrivals...)
	sort.Slice(arrivals, func(i, j int) bool { return arrivals[i].VariantID < arrivals[j].VariantID })
	for i, arrival := range arrivals {
		if arrival.VariantID < 1 || arrival.VariantID > math.MaxInt32 || arrival.Quantity < 1 ||
			(i > 0 && arrivals[i-1].VariantID == arrival.VariantID) {
			return ReceiptInput{}, nil, ErrInvalid
		}
	}
	return normalized, arrivals, nil
}

// Recovery runs without an authenticated account, so no actor setting is made
// and no personal activity is fabricated for the operator.
func (s *Store) beginRecovery(ctx context.Context) (pgx.Tx, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(714025,1)"); err != nil {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
		return nil, err
	}
	return tx, nil
}
