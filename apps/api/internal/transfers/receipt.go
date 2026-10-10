package transfers

import (
	"context"
	"errors"
	"math"
	"reflect"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"luson/api/internal/auth"
)

// ReceiptInput uses quantities per variant, never an aggregate int64 total.
// Line.Quantity is the observed actual, including explicit expected zeros.
type ReceiptInput struct{ Items []Line }
type ReceiptLine struct {
	VariantID         int64
	ExpectedQuantity  int64
	ActualQuantity    int64
	AvailableQuantity int64
}
type ReceiptException struct {
	VariantID int64
	Kind      string
	Quantity  int64
}
type Receipt struct {
	Items      []ReceiptLine
	Exceptions []ReceiptException
}

// NormalizeReceipt copies and sorts the payload for order-independent retry
// identity. Catalog membership and expected-line completeness are store checks.
func NormalizeReceipt(in ReceiptInput) (ReceiptInput, error) {
	if len(in.Items) == 0 {
		return ReceiptInput{}, ErrInvalid
	}
	out := ReceiptInput{Items: append([]Line(nil), in.Items...)}
	sort.Slice(out.Items, func(i, j int) bool { return out.Items[i].VariantID < out.Items[j].VariantID })
	positive := false
	for i, line := range out.Items {
		if line.VariantID < 1 || line.VariantID > math.MaxInt32 || line.Quantity < 0 || (i > 0 && out.Items[i-1].VariantID == line.VariantID) {
			return ReceiptInput{}, ErrInvalid
		}
		positive = positive || line.Quantity > 0
	}
	if !positive {
		return ReceiptInput{}, ErrInvalid
	}
	return out, nil
}

// Receive authorizes the physical destination before interpreting any retry or
// conflict. It prevalidates all catalog lines and all destination additions,
// then lets the guarded header transition own credit and exception persistence.
func (s *Store) Receive(ctx context.Context, actor auth.Identity, id int64, input ReceiptInput) (Request, error) {
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
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(714025,1)"); err != nil {
		return Request{}, fail(ctx)
	}
	var destination int
	err = tx.QueryRow(ctx, `SELECT destination_location_id FROM transfer_requests WHERE id=$1 AND $2 IN (origin_location_id,destination_location_id) FOR UPDATE`, id, actor.AccountID).Scan(&destination)
	if errors.Is(err, pgx.ErrNoRows) {
		return Request{}, ErrNotFound
	}
	if err != nil {
		return Request{}, fail(ctx)
	}
	if destination != actor.Location.ID {
		return Request{}, ErrForbidden
	}
	normalized, err := NormalizeReceipt(input)
	if err != nil {
		return Request{}, err
	}
	r, err := load(ctx, tx, actor.AccountID, id)
	if err != nil {
		return Request{}, err
	}
	if r.Status == "received" {
		persisted := make([]Line, 0, len(r.Receipt.Items))
		for _, line := range r.Receipt.Items {
			persisted = append(persisted, Line{line.VariantID, line.ActualQuantity})
		}
		if !reflect.DeepEqual(normalized.Items, persisted) {
			return Request{}, ErrRetryConflict
		}
		if tx.Commit(ctx) != nil {
			return Request{}, fail(ctx)
		}
		return r, nil
	}
	if r.Status != "in_transit" {
		return Request{}, ErrDecisionConflict
	}
	expected := make(map[int64]int64, len(r.Items))
	for _, item := range r.Items {
		expected[item.VariantID] = item.Quantity
	}
	ids := make([]int32, len(normalized.Items))
	actual := make(map[int64]int64, len(normalized.Items))
	for i, line := range normalized.Items {
		if expected[line.VariantID] == 0 && line.Quantity == 0 {
			return Request{}, ErrInvalid
		}
		ids[i] = int32(line.VariantID)
		actual[line.VariantID] = line.Quantity
	}
	for variant := range expected {
		if _, ok := actual[variant]; !ok {
			return Request{}, ErrInvalid
		}
	}
	var catalogCount int
	if tx.QueryRow(ctx, "SELECT count(*) FROM catalog_variants WHERE id=ANY($1::integer[])", ids).Scan(&catalogCount) != nil {
		return Request{}, fail(ctx)
	}
	if catalogCount != len(ids) {
		return Request{}, ErrInvalid
	}
	expectedIDs := make([]int32, 0, len(expected))
	for variant := range expected {
		expectedIDs = append(expectedIDs, int32(variant))
	}
	rows, err := tx.Query(ctx, `SELECT variant_id,existing FROM inventory_balances WHERE location_id=$1 AND variant_id=ANY($2::integer[]) ORDER BY variant_id FOR UPDATE`, destination, expectedIDs)
	if err != nil {
		return Request{}, fail(ctx)
	}
	balances := make(map[int64]int64, len(expected))
	for rows.Next() {
		var variant, existing int64
		if rows.Scan(&variant, &existing) != nil {
			rows.Close()
			return Request{}, fail(ctx)
		}
		balances[variant] = existing
	}
	err = rows.Err()
	rows.Close()
	if err != nil || len(balances) != len(expected) {
		return Request{}, fail(ctx)
	}
	for variant, sent := range expected {
		credit := min(sent, actual[variant])
		if balances[variant] > math.MaxInt64-credit {
			return Request{}, ErrInvalid
		}
	}
	for _, line := range normalized.Items {
		sent := expected[line.VariantID]
		if _, err = tx.Exec(ctx, `INSERT INTO transfer_receipt_lines(request_id,variant_id,expected_quantity,actual_quantity,available_quantity) VALUES($1,$2,$3,$4,$5)`, id, int32(line.VariantID), sent, line.Quantity, min(sent, line.Quantity)); err != nil {
			return Request{}, fail(ctx)
		}
	}
	if _, err = tx.Exec(ctx, "UPDATE transfer_requests SET status='received' WHERE id=$1", id); err != nil {
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

func loadReceipt(ctx context.Context, q querier, r *Request) error {
	if r.Status != "received" {
		if r.ReceiptLocationID != nil || r.ReceivedAt != nil {
			return ErrUnavailable
		}
		return nil
	}
	if r.ReceiptLocationID == nil || *r.ReceiptLocationID != r.Destination.ID || r.ReceivedAt == nil || r.ReceivedAt.Before(*r.DispatchedAt) {
		return ErrUnavailable
	}
	receipt := &Receipt{Items: []ReceiptLine{}, Exceptions: []ReceiptException{}}
	rows, err := q.Query(ctx, `SELECT variant_id,expected_quantity,actual_quantity,available_quantity FROM transfer_receipt_lines WHERE request_id=$1 ORDER BY variant_id`, r.ID)
	if err != nil {
		return fail(ctx)
	}
	for rows.Next() {
		var line ReceiptLine
		if rows.Scan(&line.VariantID, &line.ExpectedQuantity, &line.ActualQuantity, &line.AvailableQuantity) != nil {
			rows.Close()
			return fail(ctx)
		}
		receipt.Items = append(receipt.Items, line)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return fail(ctx)
	}
	rows, err = q.Query(ctx, `SELECT variant_id,kind,quantity FROM transfer_receipt_exceptions WHERE request_id=$1 ORDER BY variant_id,kind`, r.ID)
	if err != nil {
		return fail(ctx)
	}
	for rows.Next() {
		var exception ReceiptException
		if rows.Scan(&exception.VariantID, &exception.Kind, &exception.Quantity) != nil {
			rows.Close()
			return fail(ctx)
		}
		receipt.Exceptions = append(receipt.Exceptions, exception)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return fail(ctx)
	}
	r.Receipt = receipt
	return CheckReceipt(*r)
}

// CheckReceipt fences incomplete persisted or wire outcomes. Exceptions are
// independently typed, but must equal the arithmetic derived from exact lines.
func CheckReceipt(r Request) error {
	if r.Receipt == nil || len(r.Receipt.Items) == 0 {
		return ErrUnavailable
	}
	expected := map[int64]int64{}
	for _, item := range r.Items {
		expected[item.VariantID] = item.Quantity
	}
	positive := false
	seen := map[int64]bool{}
	exceptions := []ReceiptException{}
	for _, line := range r.Receipt.Items {
		if seen[line.VariantID] || line.VariantID < 1 || line.ExpectedQuantity != expected[line.VariantID] || line.ActualQuantity < 0 || line.AvailableQuantity != min(line.ExpectedQuantity, line.ActualQuantity) || (line.ExpectedQuantity == 0 && line.ActualQuantity == 0) {
			return ErrUnavailable
		}
		seen[line.VariantID] = true
		positive = positive || line.ActualQuantity > 0
		if line.ActualQuantity < line.ExpectedQuantity {
			exceptions = append(exceptions, ReceiptException{line.VariantID, "shortage", line.ExpectedQuantity - line.ActualQuantity})
		}
		if line.ActualQuantity > line.ExpectedQuantity {
			kind := "excess"
			if line.ExpectedQuantity == 0 {
				kind = "unexpected"
			}
			exceptions = append(exceptions, ReceiptException{line.VariantID, kind, line.ActualQuantity - line.ExpectedQuantity})
		}
	}
	for variant := range expected {
		if !seen[variant] {
			return ErrUnavailable
		}
	}
	if !positive || !reflect.DeepEqual(exceptions, r.Receipt.Exceptions) {
		return ErrUnavailable
	}
	return nil
}
