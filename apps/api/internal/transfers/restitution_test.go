package transfers_test

import (
	"context"
	"errors"
	"fmt"
	"math"
	"reflect"
	"testing"
	"time"

	"luson/api/internal/transfers"
)

func r3Proposal(key string, revision, quantity int64) transfers.RestitutionProposalInput {
	return transfers.RestitutionProposalInput{VariantID: 1, OperationKey: key, ExpectedRevision: revision, RetainedQuantity: quantity, RetainedAtOrigin: true, Reason: " retained at origin verified "}
}
func r3Decision(key string, revision int64, accept bool) transfers.RestitutionDecisionInput {
	return transfers.RestitutionDecisionInput{VariantID: 1, OperationKey: key, ExpectedRevision: revision, Accept: accept, Reason: " destination confirmed "}
}
func TestR3RestitutionStoreAgreement(t *testing.T) {
	ctx, p, r := r2Receipt(t, 5, 4)
	s := transfers.New(p)
	before := stocks(t, ctx, p)
	original := r2Original(t, ctx, p)
	a, b, other, inv := c2Revision(t, ctx, p, "transfers:1"), c2Revision(t, ctx, p, "transfers:2"), c2Revision(t, ctx, p, "transfers:3"), c2Revision(t, ctx, p, "inventory")
	history, err := s.GetRestitutions(ctx, actor(r.Origin.ID), r.ID)
	if err != nil || len(history.Lines) != 1 || history.Lines[0].Proposals == nil || history.Operations == nil || len(history.Operations) != 0 {
		t.Fatal("empty expected-line history", err)
	}
	prop := r3Proposal("r3-proposal-agreement", 0, 1)
	op, err := s.ProposeRestitution(ctx, actor(r.Origin.ID), r.ID, prop)
	if err != nil {
		t.Fatal(err)
	}
	if op.OperationKey != prop.OperationKey || op.RequestID != r.ID || op.VariantID != 1 || op.ActorLocationID != r.Origin.ID || op.Action != "propose" || op.ExpectedRevision != 0 || op.Revision != 1 || op.RetainedQuantity == nil || *op.RetainedQuantity != 1 || op.RetainedAtOrigin == nil || !*op.RetainedAtOrigin || op.SourceExistingBefore != nil || op.SourceExistingAfter != nil || op.Reason != prop.Reason || op.RecordedAt.IsZero() || op.RecordedAt.Location() != time.UTC {
		t.Fatal("persisted nine-parameter proposal mismatch")
	}
	if !reflect.DeepEqual(before, stocks(t, ctx, p)) {
		t.Fatal("proposal stock effect")
	}
	dec := r3Decision("r3-accept-agreement", 1, true)
	accepted, err := s.DecideRestitution(ctx, actor(r.Destination.ID), r.ID, dec)
	if err != nil {
		t.Fatal(err)
	}
	if accepted.Action != "accept" || accepted.RetainedQuantity != nil || accepted.RetainedAtOrigin != nil || accepted.SourceExistingBefore == nil || accepted.SourceExistingAfter == nil || *accepted.SourceExistingAfter-*accepted.SourceExistingBefore != 1 || accepted.RecordedAt.Location() != time.UTC {
		t.Fatal("nullable decision or persisted credit mismatch")
	}
	for i, row := range stocks(t, ctx, p) {
		want := before[i]
		if want.Location == r.Origin.ID && want.Variant == 1 {
			want.Existing++
			want.Available++
		}
		if row != want {
			t.Fatal("non-source or reservation effect")
		}
	}
	if original != r2Original(t, ctx, p) {
		t.Fatal("original evidence changed")
	}
	if c2Revision(t, ctx, p, "inventory") != inv+1 || c2Revision(t, ctx, p, "transfers:1") != a+2 || c2Revision(t, ctx, p, "transfers:2") != b+2 || c2Revision(t, ctx, p, "transfers:3") != other {
		t.Fatal("private invalidation scope")
	}
	settled := r2Snapshot(t, ctx, p)
	for i := 0; i < 2; i++ {
		again, e := s.ProposeRestitution(ctx, actor(r.Origin.ID), r.ID, prop)
		if e != nil || !reflect.DeepEqual(again, op) {
			t.Fatal("immutable proposal replay", e)
		}
		again, e = s.DecideRestitution(ctx, actor(r.Destination.ID), r.ID, dec)
		if e != nil || !reflect.DeepEqual(again, accepted) {
			t.Fatal("immutable decision replay", e)
		}
	}
	if settled != r2Snapshot(t, ctx, p) {
		t.Fatal("retry had effects")
	}
	history, err = s.GetRestitutions(ctx, actor(r.Destination.ID), r.ID)
	if err != nil {
		t.Fatal(err)
	}
	line := history.Lines[0]
	h := line.Proposals[0]
	if line.WorkflowRevision != 1 || line.AppliedRevision != 1 || line.AppliedRetainedQuantity != 1 || line.EffectiveCredit != 4 || line.CountGeneration != 0 || line.CountAppliedRevision != 0 || h.BaseRevision != 0 || h.BaseCredit != 4 || h.BaseRestitution != 0 || h.State != "applied" || h.Decision == nil || !h.Decision.Accepted || h.Application == nil || h.Application.Quantity != 1 || len(history.Operations) != 2 {
		t.Fatal("durable history pins")
	}
	originHistory, e := s.GetRestitutions(ctx, actor(r.Origin.ID), r.ID)
	if e != nil || !reflect.DeepEqual(history, originHistory) {
		t.Fatal("participant history differs", e)
	}
	// Current inventory is deliberately different; replay must retain its old
	// before/after snapshots, even after later unrelated balance changes.
	a01Exec(t, ctx, p, `UPDATE inventory_balances SET existing=existing+7 WHERE location_id=$1 AND variant_id=1`, r.Origin.ID)
	again, e := s.DecideRestitution(ctx, actor(r.Destination.ID), r.ID, dec)
	if e != nil || !reflect.DeepEqual(again, accepted) {
		t.Fatal("replay used current stock", e)
	}
}

func TestR3RestitutionStorePrivacyAndValidation(t *testing.T) {
	ctx, p, r := r2Receipt(t, 5, 2)
	s := transfers.New(p)
	before := r2Snapshot(t, ctx, p)
	bad := transfers.RestitutionProposalInput{}
	for _, who := range []int{3, 4} {
		_, err := s.ProposeRestitution(ctx, actor(who), r.ID, bad)
		// 4 is not an assigned account in the shared fixture.
		want := transfers.ErrNotFound
		if who == 4 {
			want = transfers.ErrForbidden
		}
		if !errors.Is(err, want) {
			t.Fatalf("membership before payload: actor %d got %v", who, err)
		}
		_, err = s.GetRestitutions(ctx, actor(who), r.ID)
		if !errors.Is(err, want) {
			t.Fatal("private read fence", err)
		}
	}
	if _, err := s.ProposeRestitution(ctx, actor(r.Origin.ID), r.ID, bad); !errors.Is(err, transfers.ErrInvalid) {
		t.Fatal("participant payload", err)
	}
	if _, err := s.ProposeRestitution(ctx, actor(r.Origin.ID), 0, bad); !errors.Is(err, transfers.ErrNotFound) {
		t.Fatal("invalid id", err)
	}
	for i, c := range []struct {
		who               int
		variant, quantity int64
		att               bool
		want              error
	}{
		{r.Destination.ID, 1, 1, true, transfers.ErrForbidden},
		{r.Origin.ID, 3, 1, true, transfers.ErrInvalid},
		{r.Origin.ID, 4, 1, true, transfers.ErrInvalid},
		{r.Origin.ID, 1, 0, true, transfers.ErrInvalid},
		{r.Origin.ID, 1, 1, false, transfers.ErrInvalid},
		{r.Origin.ID, 1, 4, true, transfers.ErrDecisionConflict},
	} {
		in := r3Proposal(fmt.Sprintf("r3-invalid-proposal-%02d", i), 0, c.quantity)
		in.VariantID = c.variant
		in.RetainedAtOrigin = c.att
		op, err := s.ProposeRestitution(ctx, actor(c.who), r.ID, in)
		if !errors.Is(err, c.want) || !reflect.DeepEqual(op, transfers.RestitutionOperation{}) {
			t.Fatal("invalid proposal", i, err)
		}
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if op, err := s.ProposeRestitution(canceled, actor(r.Origin.ID), r.ID, r3Proposal("r3-canceled-proposal", 0, 1)); !errors.Is(err, context.Canceled) || !reflect.DeepEqual(op, transfers.RestitutionOperation{}) {
		t.Fatal("cancellation", err)
	}
	if _, err := s.GetRestitutions(canceled, actor(r.Origin.ID), r.ID); !errors.Is(err, context.Canceled) {
		t.Fatal("read cancellation", err)
	}
	if before != r2Snapshot(t, ctx, p) {
		t.Fatal("invalid/canceled operation leaked effects")
	}
}

func TestR3RestitutionStoreRejectionAndConflicts(t *testing.T) {
	ctx, p, r := r2Receipt(t, 5, 2)
	s := transfers.New(p)
	prop := r3Proposal("r3-first-proposal-key", 0, 1)
	first, err := s.ProposeRestitution(ctx, actor(r.Origin.ID), r.ID, prop)
	if err != nil {
		t.Fatal(err)
	}
	before := r2Snapshot(t, ctx, p)
	for _, change := range []string{"reason", "quantity", "revision", "actor"} {
		in := prop
		who := r.Origin.ID
		switch change {
		case "reason":
			in.Reason += " "
		case "quantity":
			in.RetainedQuantity = 2
		case "revision":
			in.ExpectedRevision = 1
		case "actor":
			who = r.Destination.ID
		}
		if _, e := s.ProposeRestitution(ctx, actor(who), r.ID, in); !errors.Is(e, transfers.ErrRetryConflict) {
			t.Fatal("changed retry payload", change, e)
		}
	}
	if _, e := s.DecideRestitution(ctx, actor(r.Origin.ID), r.ID, r3Decision("r3-self-decide-key", 1, true)); !errors.Is(e, transfers.ErrForbidden) {
		t.Fatal("origin cannot decide", e)
	}
	if before != r2Snapshot(t, ctx, p) {
		t.Fatal("conflict leaked effects")
	}
	rejection, e := s.DecideRestitution(ctx, actor(r.Destination.ID), r.ID, r3Decision("r3-reject-first-key", 1, false))
	if e != nil || rejection.Action != "reject" || rejection.SourceExistingBefore != nil || rejection.RetainedQuantity != nil || rejection.RetainedAtOrigin != nil {
		t.Fatal("rejection", e)
	}
	if _, e = s.DecideRestitution(ctx, actor(r.Destination.ID), r.ID, r3Decision("r3-terminal-decision", 1, true)); !errors.Is(e, transfers.ErrDecisionConflict) {
		t.Fatal("terminal decision", e)
	}
	if _, e = s.ProposeRestitution(ctx, actor(r.Origin.ID), r.ID, r3Proposal("r3-fresh-proposal-key", 1, 1)); e != nil {
		t.Fatal(e)
	}
	if _, e = s.DecideRestitution(ctx, actor(r.Destination.ID), r.ID, r3Decision("r3-stale-decision-key", 1, true)); !errors.Is(e, transfers.ErrDecisionConflict) {
		t.Fatal("stale", e)
	}
	if _, e = s.DecideRestitution(ctx, actor(r.Destination.ID), r.ID, r3Decision("r3-partial-accept-key", 2, true)); e != nil {
		t.Fatal(e)
	}
	settled := r2Snapshot(t, ctx, p)
	if _, e = s.ProposeRestitution(ctx, actor(r.Origin.ID), r.ID, r3Proposal("r3-second-application", 2, 1)); !errors.Is(e, transfers.ErrDecisionConflict) {
		t.Fatal("second partial application", e)
	}
	if _, e = s.DecideRestitution(ctx, actor(r.Destination.ID), r.ID, r3Decision("r3-different-key-accept", 2, true)); !errors.Is(e, transfers.ErrDecisionConflict) {
		t.Fatal("different key decision", e)
	}
	if again, e := s.ProposeRestitution(ctx, actor(r.Origin.ID), r.ID, prop); e != nil || !reflect.DeepEqual(again, first) {
		t.Fatal("historical retry", e)
	}
	if settled != r2Snapshot(t, ctx, p) {
		t.Fatal("duplicate or historical retry effects")
	}
	history, e := s.GetRestitutions(ctx, actor(r.Origin.ID), r.ID)
	if e != nil || history.Lines[0].Proposals[0].State != "rejected" || history.Lines[0].Proposals[1].State != "applied" || history.Lines[0].AppliedRetainedQuantity != 1 {
		t.Fatal("rejected/fresh history", e)
	}
}

func TestR3RestitutionStoreCountPins(t *testing.T) {
	ctx, p, r := r2Receipt(t, 5, 2)
	s := transfers.New(p)
	if _, err := s.ProposeRestitution(ctx, actor(r.Origin.ID), r.ID, r3Proposal("r3-count-base-proposal", 0, 1)); err != nil {
		t.Fatal(err)
	}
	c2StorePropose(t, ctx, s, r, r.Destination.ID, 1, 0, 3, "r3-count-propose-key")
	pending := r2Snapshot(t, ctx, p)
	if _, e := s.DecideRestitution(ctx, actor(r.Destination.ID), r.ID, r3Decision("r3-count-pending-accept", 1, true)); !errors.Is(e, transfers.ErrDecisionConflict) {
		t.Fatal("pending count guard", e)
	}
	if _, e := s.ProposeRestitution(ctx, actor(r.Origin.ID), r.ID, r3Proposal("r3-pending-count-propose", 1, 1)); !errors.Is(e, transfers.ErrDecisionConflict) {
		t.Fatal("pending proposal guard", e)
	}
	if pending != r2Snapshot(t, ctx, p) {
		t.Fatal("pending refusal effects")
	}
	c2StoreDecide(t, ctx, s, r, r.Origin.ID, 1, 1, true, "r3-count-accept-key")
	h, e := s.GetRestitutions(ctx, actor(r.Origin.ID), r.ID)
	if e != nil || h.Lines[0].CountGeneration != 2 || h.Lines[0].CountAppliedRevision != 1 || h.Lines[0].EffectiveCredit != 3 || h.Lines[0].Proposals[0].CountGeneration != 0 || h.Lines[0].Proposals[0].BaseCredit != 2 {
		t.Fatal("pinned versus current count", e)
	}
	if _, e = s.DecideRestitution(ctx, actor(r.Destination.ID), r.ID, r3Decision("r3-count-stale-accept", 1, true)); !errors.Is(e, transfers.ErrDecisionConflict) {
		t.Fatal("count predecessor", e)
	}
	if _, e = s.ProposeRestitution(ctx, actor(r.Origin.ID), r.ID, r3Proposal("r3-count-refresh-proposal", 1, 1)); e != nil {
		t.Fatal(e)
	}
	h, e = s.GetRestitutions(ctx, actor(r.Origin.ID), r.ID)
	if e != nil || h.Lines[0].Proposals[0].State != "superseded" || h.Lines[0].Proposals[1].CountGeneration != 2 || h.Lines[0].Proposals[1].CountAppliedRevision != 1 || h.Lines[0].Proposals[1].BaseCredit != 3 {
		t.Fatal("refreshed pins", e)
	}
	if _, e = s.DecideRestitution(ctx, actor(r.Destination.ID), r.ID, r3Decision("r3-count-refresh-accept", 2, true)); e != nil {
		t.Fatal(e)
	}
	c2StorePropose(t, ctx, s, r, r.Destination.ID, 1, 1, 5, "r3-count-over-cap-propose")
	before := r2Snapshot(t, ctx, p)
	op, e := s.DecideCount(ctx, actor(r.Origin.ID), r.ID, transfers.CountDecisionInput{VariantID: 1, OperationKey: "r3-count-over-cap-accept", ExpectedRevision: 2, Accept: true, Reason: "verified"})
	if !errors.Is(e, transfers.ErrDecisionConflict) || !reflect.DeepEqual(op, transfers.CountOperation{}) {
		t.Fatal("count restitution conservation map", e)
	}
	if before != r2Snapshot(t, ctx, p) {
		t.Fatal("count conservation rollback")
	}
	c2StoreDecide(t, ctx, s, r, r.Origin.ID, 1, 2, false, "r3-count-over-cap-reject")
	c2StorePropose(t, ctx, s, r, r.Destination.ID, 1, 2, 4, "r3-count-valid-cap-propose")
	c2StoreDecide(t, ctx, s, r, r.Origin.ID, 1, 3, true, "r3-count-valid-cap-accept")
	h, e = s.GetRestitutions(ctx, actor(r.Destination.ID), r.ID)
	if e != nil || h.Lines[0].EffectiveCredit != 4 || h.Lines[0].AppliedRetainedQuantity != 1 || h.Lines[0].Proposals[1].BaseCredit != 3 {
		t.Fatal("post-application count history", e)
	}
}

func TestR3RestitutionStorePhysicalRoles(t *testing.T) {
	ctx, p, r := c2BranchReceipt(t)
	s := transfers.New(p)
	// Warehouse account 1 is not a physical endpoint of this branch transfer.
	if _, e := s.ProposeRestitution(ctx, actor(1), r.ID, transfers.RestitutionProposalInput{}); !errors.Is(e, transfers.ErrNotFound) {
		t.Fatal("warehouse participant leak", e)
	}
	if _, e := s.GetRestitutions(ctx, actor(1), r.ID); !errors.Is(e, transfers.ErrNotFound) {
		t.Fatal("warehouse read leak", e)
	}
	if _, e := s.ProposeRestitution(ctx, actor(r.Origin.ID), r.ID, r3Proposal("r3-physical-origin-proposal", 0, 1)); e != nil {
		t.Fatal(e)
	}
	if _, e := s.DecideRestitution(ctx, actor(1), r.ID, r3Decision("r3-warehouse-decision", 1, true)); !errors.Is(e, transfers.ErrNotFound) {
		t.Fatal("warehouse decision leak", e)
	}
	if _, e := s.DecideRestitution(ctx, actor(r.Destination.ID), r.ID, r3Decision("r3-physical-destination", 1, true)); e != nil {
		t.Fatal(e)
	}
	if _, e := s.GetRestitutions(ctx, actor(r.Origin.ID), r.ID); e != nil {
		t.Fatal("physical branch history", e)
	}
}

func TestR3RestitutionStoreCountRejectionInvalidates(t *testing.T) {
	for _, replace := range []bool{false, true} {
		t.Run(fmt.Sprint(replace), func(t *testing.T) {
			ctx, p, r := r2Receipt(t, 5, 2)
			s := transfers.New(p)
			if _, e := s.ProposeRestitution(ctx, actor(r.Origin.ID), r.ID, r3Proposal("r3-before-count-reject", 0, 1)); e != nil {
				t.Fatal(e)
			}
			c2StorePropose(t, ctx, s, r, r.Destination.ID, 1, 0, 2, "r3-zero-delta-count-proposal")
			revision, generation := int64(1), int64(2)
			if replace {
				c2StorePropose(t, ctx, s, r, r.Destination.ID, 1, 1, 2, "r3-replacement-count-proposal")
				revision = 2
				generation = 3
			}
			c2StoreDecide(t, ctx, s, r, r.Origin.ID, 1, revision, false, "r3-count-rejection-key")
			before := r2Snapshot(t, ctx, p)
			if _, e := s.DecideRestitution(ctx, actor(r.Destination.ID), r.ID, r3Decision("r3-after-count-reject", 1, true)); !errors.Is(e, transfers.ErrDecisionConflict) {
				t.Fatal("count rejection did not invalidate consent", e)
			}
			if before != r2Snapshot(t, ctx, p) {
				t.Fatal("invalidated acceptance effects")
			}
			if _, e := s.DecideRestitution(ctx, actor(r.Destination.ID), r.ID, r3Decision("r3-reject-invalid-consent", 1, false)); e != nil {
				t.Fatal("reject stale proposal", e)
			}
			if _, e := s.ProposeRestitution(ctx, actor(r.Origin.ID), r.ID, r3Proposal("r3-post-rejection-proposal", 1, 1)); e != nil {
				t.Fatal(e)
			}
			h, e := s.GetRestitutions(ctx, actor(r.Destination.ID), r.ID)
			if e != nil || h.Lines[0].CountGeneration != generation || h.Lines[0].CountAppliedRevision != 0 || h.Lines[0].Proposals[1].CountGeneration != generation || h.Lines[0].Proposals[1].BaseCredit != 2 {
				t.Fatal("count rejection pins", e)
			}
			if _, e := s.DecideRestitution(ctx, actor(r.Destination.ID), r.ID, r3Decision("r3-post-rejection-accept", 2, true)); e != nil {
				t.Fatal(e)
			}
		})
	}
}

func TestR3RestitutionStoreRollback(t *testing.T) {
	for _, mode := range []string{"overflow", "balance_failure", "application_failure", "suppressed_credit", "commit_failure"} {
		t.Run(mode, func(t *testing.T) {
			ctx, p, r := r2Receipt(t, 5, 4)
			s := transfers.New(p)
			if _, err := s.ProposeRestitution(ctx, actor(r.Origin.ID), r.ID, r3Proposal("r3-rollback-proposal", 0, 1)); err != nil {
				t.Fatal(err)
			}
			want := transfers.ErrUnavailable
			switch mode {
			case "overflow":
				a01Exec(t, ctx, p, `UPDATE inventory_balances SET existing=$1 WHERE location_id=$2 AND variant_id=1`, int64(math.MaxInt64), r.Origin.ID)
				want = transfers.ErrInsufficientStock
			case "balance_failure":
				a01Exec(t, ctx, p, `CREATE FUNCTION r3_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$; CREATE TRIGGER r3_fail BEFORE UPDATE ON inventory_balances FOR EACH ROW EXECUTE FUNCTION r3_fail()`)
			case "application_failure":
				a01Exec(t, ctx, p, `CREATE FUNCTION r3_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected application failure'; END $$; CREATE TRIGGER r3_fail BEFORE INSERT ON transfer_restitution_applications FOR EACH ROW EXECUTE FUNCTION r3_fail()`)
			case "suppressed_credit":
				a01Exec(t, ctx, p, `CREATE FUNCTION r3_suppress() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; CREATE TRIGGER r3_suppress BEFORE UPDATE ON inventory_balances FOR EACH ROW EXECUTE FUNCTION r3_suppress()`)
			case "commit_failure":
				a01Exec(t, ctx, p, `CREATE FUNCTION r3_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected commit failure'; END $$; CREATE CONSTRAINT TRIGGER r3_fail AFTER INSERT ON transfer_restitution_applications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION r3_fail()`)
				// Prove the injected failure actually occurs at COMMIT, not on statement
				// execution. This only touches the test helper's owned random database.
				tx, e := p.Begin(ctx)
				if e != nil {
					t.Fatal(e)
				}
				var rev int64
				e = tx.QueryRow(ctx, r2Call, r.ID, 1, r.Destination.ID, "r3-manual-commit-probe", "accept", 1, nil, nil, "verified").Scan(&rev)
				if e != nil {
					_ = tx.Rollback(ctx)
					t.Fatal("commit seam failed before commit", e)
				}
				if rev != 1 {
					t.Fatal("missing precommit operation")
				}
				if e = tx.Commit(ctx); e == nil {
					t.Fatal("commit seam did not fail")
				}
			}
			before := r2Snapshot(t, ctx, p)
			op, e := s.DecideRestitution(ctx, actor(r.Destination.ID), r.ID, r3Decision("r3-rollback-accept-key", 1, true))
			if !errors.Is(e, want) || !reflect.DeepEqual(op, transfers.RestitutionOperation{}) {
				t.Fatal("rollback error/zero operation", e)
			}
			if before != r2Snapshot(t, ctx, p) {
				t.Fatal("rollback leaked stock/reservations/evidence/invalidation")
			}
			h, e := s.GetRestitutions(ctx, actor(r.Origin.ID), r.ID)
			if e != nil || h.Lines[0].Proposals[0].Decision != nil || h.Lines[0].AppliedRetainedQuantity != 0 {
				t.Fatal("uncommitted evidence visible", e)
			}
		})
	}
}
