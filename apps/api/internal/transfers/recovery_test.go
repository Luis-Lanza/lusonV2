package transfers_test

import (
	"context"
	"reflect"
	"testing"
	"time"

	"luson/api/internal/transfers"
)

// recoveryInput is the ordinary observed receipt payload plus one declared
// arrival that was never dispatched.
func recoveryInput(r transfers.Request) transfers.RecoveryInput {
	in := transfers.RecoveryInput{
		Items:      []transfers.Line{},
		Arrivals:   []transfers.Line{{VariantID: 3, Quantity: 5}},
		Reason:     "arrived physically but was never dispatched",
		Operator:   "operator-a",
		ReceivedAt: time.Now().UTC(),
	}
	for _, item := range r.Items {
		in.Items = append(in.Items, transfers.Line{VariantID: item.VariantID, Quantity: item.Quantity})
	}
	return in
}

func TestRecoveryStore(t *testing.T) {
	ctx, p, s := fixture(t)
	transit := receiptDispatch(t, ctx, s, input()) // dispatches variant 1 x2 and 2 x1
	in := recoveryInput(transit)
	in.Items = []transfers.Line{{VariantID: 1, Quantity: 2}, {VariantID: 2, Quantity: 0}}
	before := stocks(t, ctx, p)
	got, err := s.Recover(ctx, transit.ID, in)
	if err != nil {
		t.Fatal("recovery refused", err)
	}
	if got.Status != "received" || got.ReceiptLocationID == nil || *got.ReceiptLocationID != transit.Destination.ID || got.ReceivedAt == nil || got.ReceivedAt.Before(in.ReceivedAt) {
		t.Fatal("recovery did not complete the receipt transition")
	}
	want := &transfers.Receipt{Items: []transfers.ReceiptLine{{1, 2, 2, 2}, {2, 1, 0, 0}}, Exceptions: []transfers.ReceiptException{{2, "shortage", 1}}}
	if !reflect.DeepEqual(got.Receipt, want) {
		t.Fatalf("dispatched credit must be min(dispatched,observed): %+v", got.Receipt)
	}
	changed := 0
	after := stocks(t, ctx, p)
	for i, row := range before {
		if row == after[i] {
			continue
		}
		changed++
		if row.Location != transit.Destination.ID || row.Variant != 1 || after[i].Existing != row.Existing+2 || after[i].Available != row.Available+2 {
			t.Fatal("recovery credited something other than the dispatched variant")
		}
	}
	if changed != 1 {
		t.Fatal("undispatched arrival changed an inventory balance")
	}
	var quantity int64
	var reason, operator string
	var receivedAt time.Time
	if p.QueryRow(ctx, "SELECT quantity,reason,operator,received_at FROM transfer_recovery_events WHERE request_id=$1 AND variant_id=3", transit.ID).Scan(&quantity, &reason, &operator, &receivedAt) != nil {
		t.Fatal("recovery evidence missing")
	}
	if quantity != 5 || reason != in.Reason || operator != in.Operator || !receivedAt.Equal(in.ReceivedAt.Truncate(time.Microsecond)) {
		t.Fatalf("recovery evidence mismatch %d %q %q %v", quantity, reason, operator, receivedAt)
	}
	if scalar(t, ctx, p, "SELECT count(*) FROM transfer_recovery_events") != 1 || scalar(t, ctx, p, "SELECT count(*) FROM transfer_receipt_lines") != 2 {
		t.Fatal("undispatched arrival became a receipt line")
	}
	if retry, err := s.Recover(ctx, transit.ID, in); err != transfers.ErrDecisionConflict || !reflect.DeepEqual(retry, transfers.Request{}) {
		t.Fatal("received transfer was recovered twice")
	}
}

func TestRecoveryRefusals(t *testing.T) {
	for _, s := range []*transfers.Store{nil, transfers.New(nil)} {
		for _, ctx := range []context.Context{nil, context.Background()} {
			got, err := s.Recover(ctx, 1, transfers.RecoveryInput{})
			a02Error(t, got, err, transfers.ErrUnavailable)
			got, err = s.RecoveryPreview(ctx, 1)
			a02Error(t, got, err, transfers.ErrUnavailable)
		}
	}
	ctx, p, s := fixture(t)
	pending := input()
	pending.RetryKey = "recovery-pending-key-0001"
	pendingRequest := create(t, ctx, s, 2, pending).Request
	transit := receiptDispatch(t, ctx, s, input())
	before := receiptSnapshot(t, ctx, p)
	for name, change := range map[string]func(*transfers.RecoveryInput){
		"missing_reason":     func(in *transfers.RecoveryInput) { in.Reason = " \t " },
		"missing_operator":   func(in *transfers.RecoveryInput) { in.Operator = "" },
		"zero_arrival":       func(in *transfers.RecoveryInput) { in.Arrivals[0].Quantity = 0 },
		"negative_arrival":   func(in *transfers.RecoveryInput) { in.Arrivals[0].Quantity = -1 },
		"duplicate_arrival":  func(in *transfers.RecoveryInput) { in.Arrivals = append(in.Arrivals, in.Arrivals[0]) },
		"dispatched_arrival": func(in *transfers.RecoveryInput) { in.Arrivals[0].VariantID = 1 },
		"missing_arrivals":   func(in *transfers.RecoveryInput) { in.Arrivals = nil },
		"missing_observed":   func(in *transfers.RecoveryInput) { in.Items = nil },
		"missing_dispatched": func(in *transfers.RecoveryInput) { in.Items = in.Items[:1] },
		"negative_observed":  func(in *transfers.RecoveryInput) { in.Items[0].Quantity = -1 },
		"undispatched_observed": func(in *transfers.RecoveryInput) {
			in.Items = append(in.Items, transfers.Line{VariantID: 4, Quantity: 1})
		},
		"before_dispatch": func(in *transfers.RecoveryInput) { in.ReceivedAt = transit.CreatedAt.Add(-time.Hour) },
		"future_arrival":  func(in *transfers.RecoveryInput) { in.ReceivedAt = time.Now().Add(time.Hour) },
	} {
		t.Run(name, func(t *testing.T) {
			in := recoveryInput(transit)
			change(&in)
			got, err := s.Recover(ctx, transit.ID, in)
			a02Error(t, got, err, transfers.ErrInvalid)
			if receiptSnapshot(t, ctx, p) != before || scalar(t, ctx, p, "SELECT count(*) FROM transfer_recovery_events") != 0 {
				t.Fatal("refused recovery wrote evidence")
			}
		})
	}
	// Only an in-transit transfer is recoverable and only a stored request exists.
	for _, tc := range []struct {
		id   int64
		want error
	}{{pendingRequest.ID, transfers.ErrDecisionConflict}, {0, transfers.ErrNotFound}, {-1, transfers.ErrNotFound}, {999999, transfers.ErrNotFound}} {
		got, err := s.Recover(ctx, tc.id, recoveryInput(transit))
		a02Error(t, got, err, tc.want)
	}
	if receiptSnapshot(t, ctx, p) != before || scalar(t, ctx, p, "SELECT count(*) FROM transfer_recovery_events") != 0 {
		t.Fatal("state refusal wrote evidence")
	}
	if preview, err := s.RecoveryPreview(ctx, transit.ID); err != nil || preview.Status != "in_transit" || preview.ID != transit.ID {
		t.Fatal("recovery preview refused the candidate", err)
	}
}

func TestRecoveryRollback(t *testing.T) {
	ctx, p, s := fixture(t)
	transit := receiptDispatch(t, ctx, s, input())
	before := receiptSnapshot(t, ctx, p)
	a01Exec(t, ctx, p, `CREATE FUNCTION rc_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'recovery must roll back'; END $$;
CREATE TRIGGER rc_refuse BEFORE INSERT ON transfer_receipt_lines
FOR EACH ROW EXECUTE FUNCTION rc_refuse()`)
	got, err := s.Recover(ctx, transit.ID, recoveryInput(transit))
	a02Error(t, got, err, transfers.ErrUnavailable)
	if receiptSnapshot(t, ctx, p) != before || scalar(t, ctx, p, "SELECT count(*) FROM transfer_recovery_events") != 0 {
		t.Fatal("failed recovery persisted evidence or a partial receipt")
	}
	a01Exec(t, ctx, p, "DROP TRIGGER rc_refuse ON transfer_receipt_lines")
	if got, err = s.Recover(ctx, transit.ID, recoveryInput(transit)); err != nil || got.Status != "received" {
		t.Fatal("rollback left the transfer unrecoverable", err)
	}
}
