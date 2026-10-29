package transfers_test

import (
	"context"
	"errors"
	"fmt"
	"math"
	"reflect"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/transfers"
)

func c2StorePropose(t *testing.T, ctx context.Context, s *transfers.Store, r transfers.Request, who int, variant, revision, actual int64, key string) transfers.CountOperation {
	t.Helper()
	op, err := s.ProposeCount(ctx, actor(who), r.ID, transfers.CountProposalInput{VariantID: variant, OperationKey: key, ExpectedRevision: revision, Actual: actual, Reason: " count verified "})
	if err != nil {
		t.Fatal(err)
	}
	return op
}
func c2StoreDecide(t *testing.T, ctx context.Context, s *transfers.Store, r transfers.Request, who int, variant, revision int64, accept bool, key string) transfers.CountOperation {
	t.Helper()
	op, err := s.DecideCount(ctx, actor(who), r.ID, transfers.CountDecisionInput{VariantID: variant, OperationKey: key, ExpectedRevision: revision, Accept: accept, Reason: "count confirmed"})
	if err != nil {
		t.Fatal(err)
	}
	return op
}
func c2StoreRead(t *testing.T, ctx context.Context, s *transfers.Store, r transfers.Request) transfers.CountCorrections {
	t.Helper()
	out, err := s.GetCountCorrections(ctx, actor(r.Destination.ID), r.ID)
	if err != nil {
		t.Fatal(err)
	}
	return out
}
func c2BranchReceipt(t *testing.T) (context.Context, *pgxpool.Pool, transfers.Request) {
	t.Helper()
	ctx, p, s := fixture(t)
	in := input()
	in.CounterpartyID = 3
	r := create(t, ctx, s, 2, in).Request
	var err error
	if r, err = s.Approve(ctx, actor(3), r.ID); err != nil {
		t.Fatal(err)
	}
	if r, err = s.Dispatch(ctx, actor(3), r.ID); err != nil {
		t.Fatal(err)
	}
	if r, err = s.Receive(ctx, actor(2), r.ID, transfers.ReceiptInput{Items: []transfers.Line{{VariantID: 1, Quantity: 1}, {VariantID: 2, Quantity: 1}, {VariantID: 3, Quantity: 7}}}); err != nil {
		t.Fatal(err)
	}
	return ctx, p, r
}

func TestC2CorrectionStoreProposal(t *testing.T) {
	for _, reverse := range []bool{false, true} {
		t.Run(fmt.Sprint(reverse), func(t *testing.T) {
			ctx, p, r := c2Receipt(t, reverse)
			s := transfers.New(p)
			original, err := s.Get(ctx, actor(r.Destination.ID), r.ID)
			if err != nil {
				t.Fatal(err)
			}
			initial := c2StoreRead(t, ctx, s, r)
			if len(initial.Lines) != 3 || len(initial.Operations) != 0 || initial.Lines[0].EffectiveActual != 1 || initial.Lines[0].WorkflowRevision != 0 {
				t.Fatal("initial receipt state", initial)
			}
			initiator, other := r.Origin.ID, r.Destination.ID
			for i, tc := range []struct{ actual, credit, delta int64 }{{2, 2, 1}, {9, 2, 0}, {0, 0, -2}, {1, 1, 1}} {
				revision := int64(i + 1)
				before := stocks(t, ctx, p)
				key := fmt.Sprintf("store-proposal-%02d", i)
				op := c2StorePropose(t, ctx, s, r, initiator, 1, revision-1, tc.actual, key)
				if op.OperationKey != key || op.RequestID != r.ID || op.VariantID != 1 || op.ActorLocationID != initiator || op.Action != "propose" || op.ExpectedRevision != revision-1 || op.Actual == nil || *op.Actual != tc.actual || op.Revision != revision || op.RecordedAt.IsZero() || op.Reason != " count verified " {
					t.Fatal("persisted identity", op)
				}
				if !reflect.DeepEqual(before, stocks(t, ctx, p)) {
					t.Fatal("pending inventory effect")
				}
				pending := c2StoreRead(t, ctx, s, r).Lines[0]
				if pending.WorkflowRevision != revision || pending.AppliedRevision != revision-1 || pending.Proposals[i].State != "pending" {
					t.Fatal("workflow/effective generation", pending)
				}
				if retry := c2StorePropose(t, ctx, s, r, initiator, 1, revision-1, tc.actual, key); !reflect.DeepEqual(op, retry) {
					t.Fatal("proposal replay identity changed")
				}
				decision := c2StoreDecide(t, ctx, s, r, other, 1, revision, true, fmt.Sprintf("store-decision-%02d", i))
				if decision.Actual != nil || decision.Action != "accept" || decision.Revision != revision {
					t.Fatal("decision identity")
				}
				state := c2StoreRead(t, ctx, s, r).Lines[0]
				if state.EffectiveActual != tc.actual || state.EffectiveCredit != tc.credit || state.AppliedRevision != revision || state.Proposals[i].State != "applied" || state.Proposals[i].Application.Delta != tc.delta {
					t.Fatal("application", state)
				}
				c2Credit(t, ctx, p, 1, revision, tc.credit, tc.delta)
				for j, row := range stocks(t, ctx, p) {
					want := before[j]
					if want.Location == r.Destination.ID && want.Variant == 1 {
						want.Existing += tc.delta
						want.Available += tc.delta
					}
					if row != want {
						t.Fatal("destination-only delta")
					}
				}
				initiator, other = other, initiator
			}
			// Historical retries return original persisted identity, not today's head.
			if old := c2StorePropose(t, ctx, s, r, r.Origin.ID, 1, 0, 2, "store-proposal-00"); old.Revision != 1 {
				t.Fatal("historical proposal retry")
			}
			if old := c2StoreDecide(t, ctx, s, r, r.Destination.ID, 1, 1, true, "store-decision-00"); old.Revision != 1 {
				t.Fatal("historical decision retry")
			}
			for _, variant := range []int64{2, 3} {
				c2StorePropose(t, ctx, s, r, r.Destination.ID, variant, 0, 0, fmt.Sprintf("store-extra-proposal-%d", variant))
				c2StoreDecide(t, ctx, s, r, r.Origin.ID, variant, 1, true, fmt.Sprintf("store-extra-decision-%d", variant))
			}
			// Unexpected lines accept the full nonnegative bigint range without
			// any stock incorporation, even after a previous zero correction.
			c2StorePropose(t, ctx, s, r, r.Origin.ID, 3, 1, math.MaxInt64, "store-unexpected-max")
			c2StoreDecide(t, ctx, s, r, r.Destination.ID, 3, 2, true, "store-unexpected-max-decision")
			out := c2StoreRead(t, ctx, s, r)
			if out.Lines[2].EffectiveActual != math.MaxInt64 {
				t.Fatal("maximum audit actual")
			}
			if len(out.Operations) != 14 || out.Lines[1].EffectiveActual != 0 || out.Lines[2].EffectiveCredit != 0 || out.Lines[2].Proposals[0].Application.Delta != 0 {
				t.Fatal("matching/unexpected", out)
			}
			if got, err := s.Get(ctx, actor(r.Origin.ID), r.ID); err != nil || !t10WorkflowDetailEqual(t, got, original) {
				t.Fatal("immutable receipt/header changed", err)
			}
			if got, err := s.GetCountCorrections(ctx, actor(r.Origin.ID), r.ID); err != nil || !reflect.DeepEqual(got, out) {
				t.Fatal("endpoint snapshot mismatch", err)
			}
		})
	}
}

func TestC2CorrectionStoreReplacementRejection(t *testing.T) {
	ctx, p, r := c2Receipt(t, false)
	s := transfers.New(p)
	c2StorePropose(t, ctx, s, r, r.Origin.ID, 1, 0, 2, "store-replace-old")
	c2StorePropose(t, ctx, s, r, r.Origin.ID, 1, 1, 0, "store-replace-new")
	c2StoreDecide(t, ctx, s, r, r.Destination.ID, 1, 2, false, "store-reject-new")
	line := c2StoreRead(t, ctx, s, r).Lines[0]
	if line.WorkflowRevision != 2 || line.AppliedRevision != 0 || line.EffectiveActual != 1 || line.EffectiveCredit != 1 || line.Proposals[0].State != "superseded" || line.Proposals[0].Decision != nil || line.Proposals[1].State != "rejected" || line.Proposals[1].Application != nil || line.Proposals[1].Decision.Accepted {
		t.Fatal("rejection resolved or lost history", line)
	}
	c2StorePropose(t, ctx, s, r, r.Destination.ID, 1, 2, 2, "store-after-reject")
	c2StoreDecide(t, ctx, s, r, r.Origin.ID, 1, 3, true, "store-after-accept")
	line = c2StoreRead(t, ctx, s, r).Lines[0]
	if line.Proposals[2].BaseRevision != 0 || line.Proposals[2].BaseCredit != 1 || line.EffectiveCredit != 2 {
		t.Fatal("workflow used as applied predecessor")
	}
	c2StorePropose(t, ctx, s, r, r.Origin.ID, 1, 3, 0, "store-reject-after-applied")
	c2StoreDecide(t, ctx, s, r, r.Destination.ID, 1, 4, false, "store-rejected-after-applied")
	line = c2StoreRead(t, ctx, s, r).Lines[0]
	if line.WorkflowRevision != 4 || line.AppliedRevision != 3 || line.EffectiveActual != 2 || line.EffectiveCredit != 2 || line.Proposals[3].State != "rejected" {
		t.Fatal("rejected head replaced applied state")
	}
}

func TestC2CorrectionStoreRefusals(t *testing.T) {
	ctx, p, r := c2BranchReceipt(t)
	s := transfers.New(p)
	in := transfers.CountProposalInput{VariantID: 1, OperationKey: "store-refusal-key", Actual: 2, Reason: "count verified"}
	for _, tc := range []struct {
		name   string
		change func(*transfers.CountProposalInput)
	}{
		{"variant_zero", func(i *transfers.CountProposalInput) { i.VariantID = 0 }},
		{"variant_overflow", func(i *transfers.CountProposalInput) { i.VariantID = math.MaxInt32 + 1 }},
		{"negative_actual", func(i *transfers.CountProposalInput) { i.Actual = -1 }},
		{"negative_revision", func(i *transfers.CountProposalInput) { i.ExpectedRevision = -1 }},
		{"overflow_revision", func(i *transfers.CountProposalInput) { i.ExpectedRevision = math.MaxInt64 }},
		{"key", func(i *transfers.CountProposalInput) { i.OperationKey = "short" }},
		{"empty_reason", func(i *transfers.CountProposalInput) { i.Reason = "   " }},
		{"long_reason", func(i *transfers.CountProposalInput) { i.Reason = strings.Repeat("é", 2001) }},
		{"nul_reason", func(i *transfers.CountProposalInput) { i.Reason = "count\x00" }},
		{"utf8_reason", func(i *transfers.CountProposalInput) { i.Reason = string([]byte{255}) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			bad := in
			tc.change(&bad)
			before := c2Snapshot(t, ctx, p)
			if op, err := s.ProposeCount(ctx, actor(r.Origin.ID), r.ID, bad); !errors.Is(err, transfers.ErrInvalid) || !reflect.DeepEqual(op, transfers.CountOperation{}) {
				t.Fatal("invalid input", err)
			}
			if c2Snapshot(t, ctx, p) != before {
				t.Fatal("invalid input effects")
			}
		})
	}
	// The warehouse approver is not a physical branch-to-branch participant.
	for _, who := range []int{1, 4} {
		want := transfers.ErrNotFound
		if who == 4 {
			want = transfers.ErrForbidden
		}
		if _, err := s.ProposeCount(ctx, actor(who), r.ID, transfers.CountProposalInput{}); !errors.Is(err, want) {
			t.Fatal("authorization before payload", err)
		}
		if _, err := s.GetCountCorrections(ctx, actor(who), r.ID); !errors.Is(err, want) {
			t.Fatal("private history", err)
		}
	}
	badActor := actor(r.Origin.ID)
	badActor.Location.ID = r.Destination.ID
	if _, err := s.ProposeCount(ctx, badActor, r.ID, in); !errors.Is(err, transfers.ErrForbidden) {
		t.Fatal("untrusted physical identity")
	}
	if _, err := s.ProposeCount(ctx, actor(r.Origin.ID), 0, in); !errors.Is(err, transfers.ErrNotFound) {
		t.Fatal("request id")
	}
	missing := in
	missing.VariantID = 4
	if _, err := s.ProposeCount(ctx, actor(r.Origin.ID), r.ID, missing); !errors.Is(err, transfers.ErrInvalid) {
		t.Fatal("receipt membership", err)
	}
	persisted, err := s.ProposeCount(ctx, actor(r.Origin.ID), r.ID, in)
	if err != nil {
		t.Fatal(err)
	}
	before := c2Snapshot(t, ctx, p)
	for _, change := range []func(*transfers.CountProposalInput){func(i *transfers.CountProposalInput) { i.Actual = 1 }, func(i *transfers.CountProposalInput) { i.Reason = " count verified" }, func(i *transfers.CountProposalInput) { i.VariantID = 2 }, func(i *transfers.CountProposalInput) { i.ExpectedRevision = 1 }} {
		bad := in
		change(&bad)
		if _, err := s.ProposeCount(ctx, actor(r.Origin.ID), r.ID, bad); !errors.Is(err, transfers.ErrRetryConflict) {
			t.Fatal("changed reuse", err)
		}
	}
	if _, err := s.ProposeCount(ctx, actor(1), r.ID, in); !errors.Is(err, transfers.ErrNotFound) {
		t.Fatal("replay privacy", err)
	}
	if _, err := s.ProposeCount(ctx, actor(r.Destination.ID), r.ID, in); !errors.Is(err, transfers.ErrRetryConflict) {
		t.Fatal("actor identity conflict", err)
	}
	in.OperationKey = "store-fresh-key-01"
	if _, err := s.ProposeCount(ctx, actor(r.Origin.ID), r.ID, in); !errors.Is(err, transfers.ErrDecisionConflict) {
		t.Fatal("stale proposal", err)
	}
	in.ExpectedRevision = 1
	if _, err := s.ProposeCount(ctx, actor(r.Destination.ID), r.ID, in); !errors.Is(err, transfers.ErrForbidden) {
		t.Fatal("counterparty replacement", err)
	}
	d := transfers.CountDecisionInput{VariantID: 1, OperationKey: "store-decision-key", ExpectedRevision: 1, Accept: true, Reason: "count confirmed"}
	if _, err := s.DecideCount(ctx, actor(r.Origin.ID), r.ID, d); !errors.Is(err, transfers.ErrForbidden) {
		t.Fatal("self consent", err)
	}
	d.ExpectedRevision = 0
	if _, err := s.DecideCount(ctx, actor(r.Destination.ID), r.ID, d); !errors.Is(err, transfers.ErrDecisionConflict) {
		t.Fatal("stale decision", err)
	}
	if c2Snapshot(t, ctx, p) != before {
		t.Fatal("refusal mutated state")
	}
	d.ExpectedRevision = 1
	decision, err := s.DecideCount(ctx, actor(r.Destination.ID), r.ID, d)
	if err != nil {
		t.Fatal(err)
	}
	d.Accept = false
	if _, err := s.DecideCount(ctx, actor(r.Destination.ID), r.ID, d); !errors.Is(err, transfers.ErrRetryConflict) {
		t.Fatal("decision reuse", err)
	}
	d.OperationKey = "store-terminal-key"
	if _, err := s.DecideCount(ctx, actor(r.Destination.ID), r.ID, d); !errors.Is(err, transfers.ErrDecisionConflict) {
		t.Fatal("terminal decision", err)
	}
	if out := c2StoreRead(t, ctx, s, r); !reflect.DeepEqual(out.Operations, []transfers.CountOperation{persisted, decision}) {
		t.Fatal("full immutable operation history", out.Operations)
	}
}

func TestC2CorrectionStoreStockGuards(t *testing.T) {
	for _, guard := range []string{"insufficient", "reserved", "overflow"} {
		t.Run(guard, func(t *testing.T) {
			ctx, p, r := c2Receipt(t, false)
			s := transfers.New(p)
			actual := int64(0)
			if guard == "overflow" {
				actual = 2
			}
			c2StorePropose(t, ctx, s, r, r.Origin.ID, 1, 0, actual, "store-stock-proposal")
			existing, reserved := int64(0), int64(0)
			if guard == "reserved" {
				existing = 1
				reserved = 1
			}
			if guard == "overflow" {
				existing = math.MaxInt64
			}
			if _, err := p.Exec(ctx, `UPDATE inventory_balances SET existing=$1,reserved=$2 WHERE location_id=$3 AND variant_id=1`, existing, reserved, r.Destination.ID); err != nil {
				t.Fatal(err)
			}
			before := c2Snapshot(t, ctx, p)
			d := transfers.CountDecisionInput{VariantID: 1, OperationKey: "store-stock-accept", ExpectedRevision: 1, Accept: true, Reason: "count confirmed"}
			if _, err := s.DecideCount(ctx, actor(r.Destination.ID), r.ID, d); !errors.Is(err, transfers.ErrInsufficientStock) {
				t.Fatal("stock guard", err)
			}
			if c2Snapshot(t, ctx, p) != before {
				t.Fatal("failed acceptance left partial effect")
			}
			if _, err := p.Exec(ctx, `UPDATE inventory_balances SET existing=10,reserved=0 WHERE location_id=$1 AND variant_id=1`, r.Destination.ID); err != nil {
				t.Fatal(err)
			}
			if _, err := s.DecideCount(ctx, actor(r.Destination.ID), r.ID, d); err != nil {
				t.Fatal("rolled back identity cannot retry", err)
			}
		})
	}
}

func TestC2CorrectionStoreReleasedAllocation(t *testing.T) {
	ctx, p, r := c2Receipt(t, false)
	s := transfers.New(p)
	var stock int64
	if err := p.QueryRow(ctx, `SELECT existing FROM inventory_balances WHERE location_id=$1 AND variant_id=1`, r.Destination.ID).Scan(&stock); err != nil {
		t.Fatal(err)
	}
	in := input()
	in.Kind = transfers.SendToWarehouse
	in.RetryKey = "store-released-outbound"
	in.Items = []transfers.Line{{VariantID: 1, Quantity: stock}}
	outgoing := create(t, ctx, s, r.Destination.ID, in).Request
	if _, err := s.Approve(ctx, actor(outgoing.Approver.ID), outgoing.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Cancel(ctx, actor(outgoing.Creator.ID), outgoing.ID); err != nil {
		t.Fatal(err)
	}
	var evidence string
	if err := p.QueryRow(ctx, `SELECT to_jsonb(a)::text FROM transfer_request_allocations a WHERE request_id=$1 AND released_at IS NOT NULL`, outgoing.ID).Scan(&evidence); err != nil {
		t.Fatal(err)
	}
	in.RetryKey = "store-live-outbound"
	in.Items = []transfers.Line{{VariantID: 1, Quantity: 1}}
	live := create(t, ctx, s, r.Destination.ID, in).Request
	if _, err := s.Approve(ctx, actor(live.Approver.ID), live.ID); err != nil {
		t.Fatal(err)
	}
	for i, actual := range []int64{2, 0} {
		c2StorePropose(t, ctx, s, r, r.Origin.ID, 1, int64(i), actual, fmt.Sprintf("store-released-proposal-%d", i))
		c2StoreDecide(t, ctx, s, r, r.Destination.ID, 1, int64(i+1), true, fmt.Sprintf("store-released-decision-%d", i))
	}
	var after string
	if err := p.QueryRow(ctx, `SELECT to_jsonb(a)::text FROM transfer_request_allocations a WHERE request_id=$1`, outgoing.ID).Scan(&after); err != nil || evidence != after {
		t.Fatal("released history modified", err)
	}
	if c2StoreRead(t, ctx, s, r).Lines[0].EffectiveCredit != 0 {
		t.Fatal("released allocation blocks valid correction")
	}
}

// Unknown database failures must not be disguised as user conflicts, even
// when their SQLSTATE is also used by the correction function's known guards.
func TestC2CorrectionStoreOperationalFailures(t *testing.T) {
	for _, code := range []string{"23514", "23505", "42501", "25000", "P0001", "deferred"} {
		t.Run(code, func(t *testing.T) {
			ctx, p, r := c2Receipt(t, false)
			s := transfers.New(p)
			c2StorePropose(t, ctx, s, r, r.Origin.ID, 1, 0, 2, "operational-proposal-01")
			before := c2Snapshot(t, ctx, p)
			state := code
			if code == "deferred" {
				state = "P0001"
			}
			statement := fmt.Sprintf(`CREATE FUNCTION c2_store_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='%s', MESSAGE='private SQL and reason must not escape'; END $$;`, state)
			if code == "deferred" {
				statement += `CREATE CONSTRAINT TRIGGER c2_store_fail AFTER INSERT ON transfer_count_applications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION c2_store_fail()`
			} else {
				statement += `CREATE TRIGGER c2_store_fail BEFORE UPDATE ON inventory_balances FOR EACH ROW EXECUTE FUNCTION c2_store_fail()`
			}
			if _, err := p.Exec(ctx, statement); err != nil {
				t.Fatal("failure injection setup")
			}
			op, err := s.DecideCount(ctx, actor(r.Destination.ID), r.ID, transfers.CountDecisionInput{VariantID: 1, OperationKey: "operational-decision-01", ExpectedRevision: 1, Accept: true, Reason: "count confirmed"})
			if !errors.Is(err, transfers.ErrUnavailable) || !reflect.DeepEqual(op, transfers.CountOperation{}) {
				t.Fatal("database details leaked or masked as conflict", err)
			}
			if c2Snapshot(t, ctx, p) != before {
				t.Fatal("operational failure left partial effects")
			}
		})
	}
}

func TestC2CorrectionStoreUnavailableAndLifecycle(t *testing.T) {
	var s *transfers.Store
	if _, err := s.GetCountCorrections(context.Background(), actor(2), 1); !errors.Is(err, transfers.ErrUnavailable) {
		t.Fatal(err)
	}
	ctx, _, store := fixture(t)
	r := create(t, ctx, store, 2, input()).Request
	if _, err := store.GetCountCorrections(ctx, actor(2), r.ID); !errors.Is(err, transfers.ErrDecisionConflict) {
		t.Fatal("unreceived read", err)
	}
	if _, err := store.ProposeCount(ctx, actor(2), r.ID, transfers.CountProposalInput{}); !errors.Is(err, transfers.ErrDecisionConflict) {
		t.Fatal("unreceived mutation", err)
	}
	if _, err := store.GetCountCorrections(nil, actor(2), r.ID); !errors.Is(err, transfers.ErrUnavailable) {
		t.Fatal("nil context", err)
	}
}
