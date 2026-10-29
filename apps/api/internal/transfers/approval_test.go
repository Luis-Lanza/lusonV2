package transfers_test

import (
	"context"
	"errors"
	"math"
	"reflect"
	"testing"
	"time"

	"luson/api/internal/auth"
	"luson/api/internal/transfers"
)

func a02Error(t *testing.T, got transfers.Request, err, want error) {
	t.Helper()
	if !errors.Is(err, want) || !reflect.DeepEqual(got, transfers.Request{}) {
		t.Fatal("approval must return the expected error and a zero request")
	}
}

func TestA02ApprovalDependencies(t *testing.T) {
	var absent *transfers.Store
	for _, s := range []*transfers.Store{absent, transfers.New(nil)} {
		for _, ctx := range []context.Context{nil, context.Background()} {
			got, err := s.Approve(ctx, actor(1), 1)
			a02Error(t, got, err, transfers.ErrUnavailable)
		}
	}
	if errors.Is(transfers.ErrDecisionConflict, transfers.ErrRetryConflict) {
		t.Fatal("decision and creation retry conflicts must remain distinct")
	}
}

func TestA02ApprovalStore(t *testing.T) {
	t.Run("identity_privacy_and_context", a02Refusals)
	t.Run("whole_outcomes_all_flows", a02WholeOutcomes)
	t.Run("rejected_conflict", a02Rejected)
	t.Run("shortages_and_missing_balance", a02Shortages)
	t.Run("int64_boundary", a02Int64)
	t.Run("midwrite_rollback", a02Midwrite)
}

func a02Refusals(t *testing.T) {
	ctx, p, s := fixture(t)
	r := create(t, ctx, s, 2, input()).Request
	before := outcomeSnapshot(t, ctx, p)
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	expired, done := context.WithDeadline(ctx, time.Now().Add(-time.Second))
	defer done()
	for _, tc := range []struct {
		name  string
		ctx   context.Context
		actor auth.Identity
		id    int64
		want  error
	}{
		{"nil_context", nil, actor(1), r.ID, transfers.ErrUnavailable},
		{"canceled", canceled, actor(1), r.ID, context.Canceled},
		{"deadline", expired, actor(1), r.ID, context.DeadlineExceeded},
		{"zero_identity", ctx, auth.Identity{}, r.ID, transfers.ErrForbidden},
		{"unassigned", ctx, actor(32768), r.ID, transfers.ErrForbidden},
		{"mismatch", ctx, auth.Identity{AccountID: 1, Location: auth.Location{ID: 2}}, r.ID, transfers.ErrForbidden},
		{"zero_id", ctx, actor(1), 0, transfers.ErrNotFound},
		{"negative_id", ctx, actor(1), -1, transfers.ErrNotFound},
		{"missing", ctx, actor(1), math.MaxInt64, transfers.ErrNotFound},
		{"foreign", ctx, actor(3), r.ID, transfers.ErrNotFound},
		{"participant_not_approver", ctx, actor(2), r.ID, transfers.ErrForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := s.Approve(tc.ctx, tc.actor, tc.id)
			a02Error(t, got, err, tc.want)
			if outcomeSnapshot(t, ctx, p) != before {
				t.Fatal("refusal changed complete persisted state")
			}
		})
	}
}

func a02WholeOutcomes(t *testing.T) {
	for _, flow := range []struct {
		name         string
		kind         transfers.Kind
		counterparty int
	}{
		{"warehouse_request", transfers.RequestStock, 1},
		{"branch_request", transfers.RequestStock, 3},
		{"warehouse_proposal", transfers.SendToWarehouse, 1},
	} {
		t.Run(flow.name, func(t *testing.T) {
			ctx, p, s := fixture(t)
			in := input()
			in.Kind, in.CounterpartyID = flow.kind, flow.counterparty
			original := create(t, ctx, s, 2, in).Request
			immutable := a01Original(t, ctx, p, original.ID)
			a01Exec(t, ctx, p, "UPDATE inventory_balances SET reserved=1 WHERE location_id=$1 AND variant_id IN(1,2)", original.Origin.ID)
			before := stocks(t, ctx, p)
			got, err := s.Approve(ctx, actor(original.Approver.ID), original.ID)
			if err != nil {
				t.Fatal("assigned approver could not approve a valid whole request")
			}
			var decision int
			var decided time.Time
			if p.QueryRow(ctx, "SELECT decision_location_id,decided_at FROM transfer_requests WHERE id=$1", original.ID).Scan(&decision, &decided) != nil {
				t.Fatal("decision lookup failed")
			}
			want := original
			want.Status, want.DecisionLocationID, want.DecidedAt = "approved", &decision, &decided
			if !reflect.DeepEqual(got, want) || decision != original.Approver.ID || decided.Before(original.CreatedAt) || a01Original(t, ctx, p, original.ID) != immutable {
				t.Fatal("approval did not return the complete original payload and persisted decision")
			}
			wantStock := append([]stockRow(nil), before...)
			for i := range wantStock {
				for _, item := range original.Items {
					if wantStock[i].Location == original.Origin.ID && int64(wantStock[i].Variant) == item.VariantID {
						wantStock[i].Reserved += item.Quantity
						wantStock[i].Available -= item.Quantity
					}
				}
			}
			if !reflect.DeepEqual(stocks(t, ctx, p), wantStock) {
				t.Fatal("physical/destination/unrelated balances or independent holds changed")
			}
			if scalar(t, ctx, p, "SELECT count(*) FROM transfer_request_allocations") != int64(len(original.Items)) {
				t.Fatal("approval did not persist exactly one owned allocation per item")
			}
			a01Invariant(t, ctx, p)
			// Discard the mutation reply and recover through the existing Get.
			recovered, err := s.Get(ctx, actor(2), original.ID)
			if err != nil || !reflect.DeepEqual(recovered, got) {
				t.Fatal("lost reply recovery changed the canonical outcome")
			}
			// Prove no availability recheck on an authorized same-action retry.
			a01Exec(t, ctx, p, "UPDATE inventory_balances SET reserved=existing WHERE location_id=$1 AND variant_id IN(1,2)", original.Origin.ID)
			terminal := outcomeSnapshot(t, ctx, p)
			retryStore, stockProbe, _ := a02Gated(t, ctx, p, "inventory_balances", false)
			retry, err := retryStore.Approve(ctx, actor(original.Approver.ID), original.ID)
			if len(stockProbe.arrived) != 0 {
				t.Fatal("Approved retry queried or locked stock")
			}
			if err != nil || !reflect.DeepEqual(retry, got) {
				t.Fatal("exhausted-stock retry changed or refused original approval")
			}
			unauthorized, err := s.Approve(ctx, actor(2), original.ID)
			a02Error(t, unauthorized, err, transfers.ErrForbidden)
			foreign, err := s.Approve(ctx, actor(6-original.Origin.ID-original.Destination.ID), original.ID)
			a02Error(t, foreign, err, transfers.ErrNotFound)
			replay, err := s.Create(ctx, actor(2), in)
			if err != nil || !replay.Replayed || !reflect.DeepEqual(replay.Request, got) {
				t.Fatal("approval broke original creation replay")
			}
			if _, err := s.Create(ctx, actor(1), in); !errors.Is(err, transfers.ErrForbidden) {
				t.Fatal("warehouse approval must not enable warehouse creation")
			}
			page, err := s.List(ctx, actor(2), transfers.Query{Page: 1, PageSize: 25, Status: "pending"})
			if err != nil || page.Total != 0 || len(page.Records) != 0 {
				t.Fatal("approval escaped the Pending-only list fence")
			}
			if outcomeSnapshot(t, ctx, p) != terminal {
				t.Fatal("retry, replay, reads or refusals changed terminal state")
			}
		})
	}
}

func a02Rejected(t *testing.T) {
	ctx, p, s := fixture(t)
	r := create(t, ctx, s, 2, input()).Request
	a01Exec(t, ctx, p, "UPDATE transfer_requests SET status='rejected' WHERE id=$1", r.ID)
	before := outcomeSnapshot(t, ctx, p)
	got, err := s.Approve(ctx, actor(r.Approver.ID), r.ID)
	a02Error(t, got, err, transfers.ErrDecisionConflict)
	got, err = s.Approve(ctx, actor(2), r.ID)
	a02Error(t, got, err, transfers.ErrForbidden)
	if outcomeSnapshot(t, ctx, p) != before {
		t.Fatal("Rejected approval conflict changed state")
	}
}

func a02Shortages(t *testing.T) {
	for _, tc := range []struct {
		name  string
		query string
	}{
		{"first_item", "UPDATE inventory_balances SET existing=1 WHERE location_id=1 AND variant_id=1"},
		{"later_item", "UPDATE inventory_balances SET existing=0 WHERE location_id=1 AND variant_id=2"},
		{"missing_balance", "DELETE FROM inventory_balances WHERE location_id=1 AND variant_id=2"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, p, s := fixture(t)
			r := create(t, ctx, s, 2, input()).Request
			a01Exec(t, ctx, p, tc.query)
			before := outcomeSnapshot(t, ctx, p)
			got, err := s.Approve(ctx, actor(1), r.ID)
			a02Error(t, got, err, transfers.ErrInsufficientStock)
			if outcomeSnapshot(t, ctx, p) != before {
				t.Fatal("shortage leaked an earlier reservation, allocation or decision")
			}
			a01Invariant(t, ctx, p)
		})
	}
}

func a02Int64(t *testing.T) {
	ctx, p, s := fixture(t)
	a01Exec(t, ctx, p, "UPDATE inventory_balances SET existing=$1 WHERE location_id=1 AND variant_id IN(1,2)", int64(math.MaxInt64))
	in := input()
	in.Items = []transfers.Line{{VariantID: 1, Quantity: math.MaxInt64 - 1}, {VariantID: 2, Quantity: math.MaxInt64 - 1}}
	r := create(t, ctx, s, 2, in).Request
	in.RetryKey = "overflow-shortage-key-0002"
	in.Items = []transfers.Line{{VariantID: 1, Quantity: math.MaxInt64}}
	second := create(t, ctx, s, 2, in).Request
	a01Exec(t, ctx, p, "UPDATE inventory_balances SET reserved=1 WHERE location_id=1 AND variant_id IN(1,2)")
	got, err := s.Approve(ctx, actor(1), r.ID)
	if err != nil || got.Status != "approved" {
		t.Fatal("valid independent int64 quantities must not be summed or overflow")
	}
	if scalar(t, ctx, p, "SELECT count(*) FROM inventory_balances WHERE location_id=1 AND variant_id IN(1,2) AND reserved=existing AND available=0") != 2 {
		t.Fatal("near-MaxInt64 reservation was not exact")
	}
	before := outcomeSnapshot(t, ctx, p)
	got, err = s.Approve(ctx, actor(1), second.ID)
	a02Error(t, got, err, transfers.ErrInsufficientStock)
	if outcomeSnapshot(t, ctx, p) != before {
		t.Fatal("overflow-provoking shortage changed persisted state")
	}
	a01Invariant(t, ctx, p)
}

func a02Midwrite(t *testing.T) {
	ctx, p, s := fixture(t)
	r := create(t, ctx, s, 2, input()).Request
	// Additional test-only guards strengthen, never disable, real constraints.
	// Fail the second allocation after the first item has actually been written.
	a01Exec(t, ctx, p, "CREATE SEQUENCE a02_midwrite_seen")
	a01Exec(t, ctx, p, `CREATE FUNCTION a02_fail_second() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
 IF NEW.variant_id=2 THEN
   IF NOT EXISTS(SELECT 1 FROM transfer_request_allocations WHERE request_id=NEW.request_id AND variant_id=1) THEN
     RAISE EXCEPTION 'first write missing' USING ERRCODE='P0002';
   END IF;
   PERFORM nextval('a02_midwrite_seen');
   RAISE EXCEPTION 'injected second write failure' USING ERRCODE='P0001';
 END IF;
 RETURN NEW;
 END $$`)
	a01Exec(t, ctx, p, "CREATE TRIGGER a02_fail_second BEFORE INSERT ON transfer_request_allocations FOR EACH ROW EXECUTE FUNCTION a02_fail_second()")
	before := outcomeSnapshot(t, ctx, p)
	got, err := s.Approve(ctx, actor(1), r.ID)
	a02Error(t, got, err, transfers.ErrUnavailable)
	// Sequence state is nontransactional test instrumentation: it proves the
	// failure was reached with the first allocation present, not a setup error.
	if scalar(t, ctx, p, "SELECT count(*) FROM a02_midwrite_seen WHERE is_called AND last_value=1") != 1 {
		t.Fatal("injected failure did not observe a successful earlier write")
	}
	if outcomeSnapshot(t, ctx, p) != before {
		t.Fatal("midwrite failure did not roll back the whole request")
	}
	a01Invariant(t, ctx, p)
}
