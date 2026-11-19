package transfers_test

import (
	"errors"
	"reflect"
	"testing"

	"luson/api/internal/transfers"
)

// TestBranchFrozenRefusesTheGuardedWrites pins the two guarded transfer_requests writes that no test
// covered (S1): a dispatch out of a branch that has an open settlement, and a receipt into one, are
// the freeze's own refusal -- ErrBranchFrozen, never ErrUnavailable -- and the header keeps the state
// it had, so the refusal writes nothing.
func TestBranchFrozenRefusesTheGuardedWrites(t *testing.T) {
	ctx, p, s := fixture(t)
	freeze := func(branch int) {
		a01Exec(t, ctx, p, `INSERT INTO branch_settings(branch_location_id,commission_rate_percent,updated_by_account_id)
         VALUES($1,12.50,1) ON CONFLICT (branch_location_id) DO UPDATE SET commission_rate_percent=12.50`, int16(branch))
		a01Exec(t, ctx, p, `INSERT INTO branch_closings(branch_location_id,period_start,opened_by_account_id)
         VALUES($1,now(),1)`, int16(branch))
	}
	status := func(id int64) string {
		var got string
		if err := p.QueryRow(ctx, `SELECT status FROM transfer_requests WHERE id=$1`, id).Scan(&got); err != nil {
			t.Fatalf("the transfer header could not be read: %v", err)
		}
		return got
	}
	// Dispatch empties the origin, so the origin's open settlement is what refuses it.
	dispatchIn := input()
	dispatchIn.CounterpartyID = 3
	approved := create(t, ctx, s, 2, dispatchIn).Request
	if _, err := s.Approve(ctx, actor(approved.Approver.ID), approved.ID); err != nil {
		t.Fatalf("the request could not be approved: %v", err)
	}
	freeze(approved.Origin.ID)
	got, err := s.Dispatch(ctx, actor(approved.Origin.ID), approved.ID)
	if !errors.Is(err, transfers.ErrBranchFrozen) || !reflect.DeepEqual(got, transfers.Request{}) {
		t.Fatalf("a dispatch out of a frozen branch must be the freeze's own refusal and a zero request, got %v %+v", err, got)
	}
	if status(approved.ID) != "approved" {
		t.Fatal("a refused dispatch moved the header")
	}
	// Receipt fills the destination, so the destination's open settlement is what refuses it.
	receiptIn := input()
	receiptIn.RetryKey = "opaque-retry-key-0002"
	transit := create(t, ctx, s, 2, receiptIn).Request
	if _, err := s.Approve(ctx, actor(transit.Approver.ID), transit.ID); err != nil {
		t.Fatalf("the second request could not be approved: %v", err)
	}
	dispatched, err := s.Dispatch(ctx, actor(transit.Origin.ID), transit.ID)
	if err != nil {
		t.Fatalf("the second request must be dispatchable before the freeze: %v", err)
	}
	freeze(transit.Destination.ID)
	items := make([]transfers.Line, 0, len(dispatched.Items))
	for _, item := range dispatched.Items {
		items = append(items, transfers.Line{VariantID: int64(item.VariantID), Quantity: item.Quantity})
	}
	got, err = s.Receive(ctx, actor(transit.Destination.ID), transit.ID, transfers.ReceiptInput{Items: items})
	if !errors.Is(err, transfers.ErrBranchFrozen) || !reflect.DeepEqual(got, transfers.Request{}) {
		t.Fatalf("a receipt into a frozen branch must be the freeze's own refusal and a zero request, got %v %+v", err, got)
	}
	if status(transit.ID) != "in_transit" {
		t.Fatal("a refused receipt moved the header")
	}
}
