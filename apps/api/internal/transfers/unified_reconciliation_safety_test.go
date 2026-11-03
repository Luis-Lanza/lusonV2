package transfers_test

import (
	"context"
	"encoding/json"
	"fmt"
	"math"

	"github.com/jackc/pgx/v5/pgxpool"
	"reflect"
	"testing"

	"luson/api/internal/db"
	"luson/api/internal/transfers"
)

func urObserve(t *testing.T, ctx context.Context, p *pgxpool.Pool, s *transfers.Store, r transfers.Request) string {
	t.Helper()
	detail, e := s.Get(ctx, actor(r.Origin.ID), r.ID)
	if e != nil {
		t.Fatal(e)
	}
	raw, e := json.Marshal([]any{urRead(t, ctx, s, r), dr1Inventory(t, ctx, p), dr2Counts(t, ctx, s), detail})
	if e != nil {
		t.Fatal(e)
	}
	return string(raw)
}

func TestUR2ValidationAndReplacement(t *testing.T) {
	ctx, p, r := r2Receipt(t, 10, 8)
	s := transfers.New(p)
	before := urObserve(t, ctx, p, s, r)
	for i, tc := range []struct {
		who                     int
		variant, d, a, retained int64
		att                     bool
		want                    error
	}{
		{1, 1, 12, 8, 1, true, transfers.ErrInvalid},
		{1, 1, 9, 8, 2, true, transfers.ErrInvalid},
		{1, 1, -1, 8, 0, false, transfers.ErrInvalid},
		{1, 1, 9, -1, 0, false, transfers.ErrInvalid},
		{1, 1, 9, 8, -1, true, transfers.ErrInvalid},
		{1, 3, 9, 8, 0, false, transfers.ErrInvalid},
		{1, 1, 9, 8, 1, false, transfers.ErrDecisionConflict},
		{2, 1, 9, 8, 1, true, transfers.ErrForbidden},
		{3, 1, 9, 8, 1, false, transfers.ErrNotFound},
	} {
		in := urProposal(fmt.Sprintf("ur2-invalid-proposal-%d", i))
		in.VariantID = tc.variant
		in.DispatchQuantity = tc.d
		in.ArrivalQuantity = tc.a
		in.RetainedQuantity = tc.retained
		in.RetainedAtOrigin = tc.att
		op, e := s.ProposeUnifiedReconciliation(ctx, actor(tc.who), r.ID, in)
		if e != tc.want || !reflect.DeepEqual(op, transfers.UnifiedReconciliationOperation{}) || before != urObserve(t, ctx, p, s, r) {
			t.Fatal("invalid proposal effects", i, e)
		}
	}
	maximal := urProposal("ur2-maximal-proposal")
	maximal.DispatchQuantity = math.MaxInt64
	maximal.ArrivalQuantity = math.MaxInt64
	maximal.RetainedQuantity = 0
	first, e := s.ProposeUnifiedReconciliation(ctx, actor(r.Origin.ID), r.ID, maximal)
	if e != nil {
		t.Fatal("quantities must not be capped at original debit", e)
	}
	before = urObserve(t, ctx, p, s, r)
	if _, e = s.DecideUnifiedReconciliation(ctx, actor(r.Destination.ID), r.ID, urDecision("ur2-maximal-stock-accept")); e != transfers.ErrInsufficientStock || before != urObserve(t, ctx, p, s, r) {
		t.Fatal("unavailable stock must roll back", e)
	}
	next := urProposal("ur2-replacement-proposal")
	next.ExpectedRevision = 1
	if _, e = s.ProposeUnifiedReconciliation(ctx, actor(r.Destination.ID), r.ID, next); e != transfers.ErrForbidden || before != urObserve(t, ctx, p, s, r) {
		t.Fatal("counterparty replacement", e)
	}
	if _, e = s.ProposeUnifiedReconciliation(ctx, actor(r.Origin.ID), r.ID, next); e != nil {
		t.Fatal(e)
	}
	before = urObserve(t, ctx, p, s, r)
	if _, e = s.DecideUnifiedReconciliation(ctx, actor(r.Destination.ID), r.ID, urDecision("ur2-superseded-accept")); e != transfers.ErrDecisionConflict || before != urObserve(t, ctx, p, s, r) {
		t.Fatal("superseded acceptance", e)
	}
	if retry, e := s.ProposeUnifiedReconciliation(ctx, actor(r.Origin.ID), r.ID, maximal); e != nil || !reflect.DeepEqual(first, retry) || before != urObserve(t, ctx, p, s, r) {
		t.Fatal("old exact proposal retry", e)
	}
	decision := urDecision("ur2-replacement-accept")
	decision.ExpectedRevision = 2
	if _, e = s.DecideUnifiedReconciliation(ctx, actor(r.Destination.ID), r.ID, decision); e != nil {
		t.Fatal(e)
	}
	if got := urRead(t, ctx, s, r); got.Lines[0].Proposals[0].State != "superseded" || got.Lines[0].Proposals[1].State != "applied" || urCurrent(t, got).SourceDebit != 9 {
		t.Fatal(got)
	}
}

func TestUR2QuantitiesAndBothInitiators(t *testing.T) {
	for _, tc := range []struct {
		name                                                                         string
		d, a, retained, sourceDelta, destinationDelta, originUnknown, transitUnknown int64
		destinationInitiates                                                         bool
	}{
		{"overdispatch", 12, 12, 0, -2, 2, 0, 0, false},
		{"downward_arrival", 10, 7, 0, 0, -1, 0, 3, false},
		{"zero_arrival", 10, 0, 0, 0, -8, 0, 10, false},
		{"zero_dispatch_unknown", 0, 0, 0, 0, -8, 10, 0, false},
		{"partial_unknown_destination_initiates", 7, 6, 1, 1, -2, 2, 1, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			credit := int64(8)
			if tc.name == "overdispatch" {
				credit = 10
			}
			ctx, p, r := r2Receipt(t, 10, credit)
			s := transfers.New(p)
			before := dr1Inventory(t, ctx, p)
			in := urProposal("ur2-quantities-proposal")
			in.DispatchQuantity, in.ArrivalQuantity, in.RetainedQuantity = tc.d, tc.a, tc.retained
			in.RetainedAtOrigin = !tc.destinationInitiates
			proposer, decider := r.Origin.ID, r.Destination.ID
			if tc.destinationInitiates {
				proposer, decider = decider, proposer
			}
			if _, err := s.ProposeUnifiedReconciliation(ctx, actor(proposer), r.ID, in); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(before, dr1Inventory(t, ctx, p)) {
				t.Fatal("proposal stock effect")
			}
			decision := urDecision("ur2-quantities-accept")
			decision.RetainedAtOrigin = tc.destinationInitiates
			if _, err := s.DecideUnifiedReconciliation(ctx, actor(decider), r.ID, decision); err != nil {
				t.Fatal(err)
			}
			before[0].Items[0].Existing += tc.sourceDelta
			before[0].Items[0].Available += tc.sourceDelta
			before[4].Items[0].Existing += tc.destinationDelta
			before[4].Items[0].Available += tc.destinationDelta
			if !reflect.DeepEqual(before, dr1Inventory(t, ctx, p)) {
				t.Fatal("wrong joint stock effect")
			}
			l := urCurrent(t, urRead(t, ctx, s, r))
			if l.SourceDebit != 10-tc.sourceDelta || l.EffectiveCredit != credit+tc.destinationDelta || l.EffectiveActual != tc.a || l.EffectiveDispatch != tc.d || urUnknown(l.OriginUnknown) != tc.originUnknown || urUnknown(l.TransitUnknown) != tc.transitUnknown {
				t.Fatal(l)
			}
		})
	}
}

func TestUR2RolesRetryAndOwnership(t *testing.T) {
	ctx, p, r := r2Receipt(t, 10, 8)
	s := transfers.New(p)
	// An existing pending consent is not converted into unified consent.
	legacy := c2StorePropose(t, ctx, s, r, r.Destination.ID, 1, 0, 9, "ur2-legacy-count-proposal")
	in := urProposal("ur2-destination-proposal")
	in.RetainedAtOrigin = false
	proposed, err := s.ProposeUnifiedReconciliation(ctx, actor(r.Destination.ID), r.ID, in)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := func() []byte {
		t.Helper()
		coordinated := urRead(t, ctx, s, r)
		counts, restitutions, dispatch := coordinated.Legacy.Count, coordinated.Legacy.Restitution, coordinated.Legacy.Dispatch
		detail, e := s.Get(ctx, actor(r.Origin.ID), r.ID)
		if e != nil {
			t.Fatal(e)
		}
		out, e := json.Marshal([]any{urRead(t, ctx, s, r), dr1Inventory(t, ctx, p), dr2Counts(t, ctx, s), counts, restitutions, dispatch, detail})
		if e != nil {
			t.Fatal(e)
		}
		return out
	}
	before := snapshot()
	for _, tc := range []struct {
		name string
		who  int
		att  bool
		want error
	}{
		{"self", r.Destination.ID, false, transfers.ErrForbidden},
		{"nonparticipant", 3, false, transfers.ErrNotFound},
		{"origin_unattested", r.Origin.ID, false, transfers.ErrDecisionConflict},
		{"destination_attestation", r.Destination.ID, true, transfers.ErrForbidden},
	} {
		decision := urDecision("ur2-role-" + tc.name + "-accept")
		decision.RetainedAtOrigin = tc.att
		if _, e := s.DecideUnifiedReconciliation(ctx, actor(tc.who), r.ID, decision); e != tc.want {
			t.Fatal(tc.name, e)
		}
		if !reflect.DeepEqual(before, snapshot()) {
			t.Fatal("refusal effects", tc.name)
		}
	}
	changed := in
	changed.ArrivalQuantity++
	if _, e := s.ProposeUnifiedReconciliation(ctx, actor(r.Destination.ID), r.ID, changed); e != transfers.ErrRetryConflict {
		t.Fatal("changed retry payload", e)
	}
	if _, e := s.DecideCount(ctx, actor(r.Origin.ID), r.ID, transfers.CountDecisionInput{VariantID: 1, OperationKey: "ur2-legacy-stale-accept", ExpectedRevision: 1, Accept: true, Reason: "verified"}); e != transfers.ErrDecisionConflict {
		t.Fatal("legacy acceptance not fenced", e)
	}
	if !reflect.DeepEqual(before, snapshot()) {
		t.Fatal("conflict changed public state")
	}
	if got := c2StorePropose(t, ctx, s, r, r.Destination.ID, 1, 0, 9, "ur2-legacy-count-proposal"); !reflect.DeepEqual(got, legacy) {
		t.Fatal("legacy exact retry changed")
	}
	// Rejection remains available and increments the predecessor generation.
	c2StoreDecide(t, ctx, s, r, r.Origin.ID, 1, 1, false, "ur2-legacy-count-reject")
	before = snapshot()
	accept := urDecision("ur2-stale-unified-accept")
	accept.RetainedAtOrigin = true
	if _, e := s.DecideUnifiedReconciliation(ctx, actor(r.Origin.ID), r.ID, accept); e != transfers.ErrDecisionConflict {
		t.Fatal("stale generation accepted", e)
	}
	if !reflect.DeepEqual(before, snapshot()) {
		t.Fatal("stale acceptance changed state")
	}
	if got, e := s.ProposeUnifiedReconciliation(ctx, actor(r.Destination.ID), r.ID, in); e != nil || !reflect.DeepEqual(got, proposed) {
		t.Fatal("old exact unified retry", e)
	}
	reject := urDecision("ur2-reject-stale-unified")
	reject.Accept = false
	rejected, e := s.DecideUnifiedReconciliation(ctx, actor(r.Origin.ID), r.ID, reject)
	if e != nil {
		t.Fatal("stale rejection", e)
	}
	before = snapshot()
	if got, e := s.DecideUnifiedReconciliation(ctx, actor(r.Origin.ID), r.ID, reject); e != nil || !reflect.DeepEqual(got, rejected) {
		t.Fatal("exact reject retry", e)
	}
	changedReject := reject
	changedReject.Reason += " "
	if _, e := s.DecideUnifiedReconciliation(ctx, actor(r.Origin.ID), r.ID, changedReject); e != transfers.ErrRetryConflict {
		t.Fatal("changed reject identity", e)
	}
	if !reflect.DeepEqual(before, snapshot()) {
		t.Fatal("reject retry changed public state")
	}
}

func TestUR2UnexpectedAuditCorrectionPreserved(t *testing.T) {
	// The subject is the historical unexpected line plus its audit-only
	// correction. Both are seeded on 001-018 as the pre-S1 flows could produce
	// them, then 019 is applied on top and the evidence must survive intact.
	ctx, p := urPrefixFixtureAt(t, 19)
	s := transfers.New(p)
	r := urHistoricalReceipt(t, ctx, s)
	urSeedUnexpectedLine(t, ctx, p, r, 3, 1)
	if _, e := s.ProposeUnifiedReconciliation(ctx, actor(r.Origin.ID), r.ID, urProposal("ur2-expected-ownership")); e != nil {
		t.Fatal(e)
	}
	stock := dr1Inventory(t, ctx, p)
	expected := urRead(t, ctx, s, r)
	urSeedCountCorrection(t, ctx, p, r, 3, 2)
	after := urRead(t, ctx, s, r)
	if !reflect.DeepEqual(stock, dr1Inventory(t, ctx, p)) || !reflect.DeepEqual(urCurrent(t, expected), urCurrent(t, after)) || !reflect.DeepEqual(expected.Lines, after.Lines) || !reflect.DeepEqual(expected.Operations, after.Operations) {
		t.Fatal("unexpected audit-only correction affected expected accounting or inventory")
	}
	got := after.Legacy.Count
	found := false
	for _, l := range got.Lines {
		if l.VariantID == 3 {
			found = true
			if l.ExpectedQuantity != 0 || l.EffectiveActual != 2 || l.EffectiveCredit != 0 || l.AppliedRevision != 1 {
				t.Fatal(l)
			}
		}
	}
	if !found {
		t.Fatal("unexpected audit history missing")
	}
	// 019 keeps refusing new zero-quantity lines without deleting this history.
	if err := db.Apply(ctx, p); err != nil {
		t.Fatal("apply019 over historical correction evidence", err)
	}
	urAssert019NotValid(t, ctx, p, r, 3)
	settled := urRead(t, ctx, s, r)
	if !reflect.DeepEqual(after.Legacy, settled.Legacy) || !reflect.DeepEqual(after.Original, settled.Original) {
		t.Fatal("upgrade lost historical correction evidence", settled)
	}
	if !reflect.DeepEqual(after.Current, settled.Current) {
		t.Fatal("upgrade changed the projected legacy current line", settled)
	}
}

func TestUR2ConcurrentAcceptanceOnce(t *testing.T) {
	for _, sameKey := range []bool{false, true} {
		t.Run(fmt.Sprint(sameKey), func(t *testing.T) {
			ctx, p, r := r2Receipt(t, 10, 8)
			s := transfers.New(p)
			if _, e := s.ProposeUnifiedReconciliation(ctx, actor(r.Origin.ID), r.ID, urProposal("ur2-concurrent-proposal")); e != nil {
				t.Fatal(e)
			}
			stock := dr1Inventory(t, ctx, p)
			type result struct {
				op  transfers.UnifiedReconciliationOperation
				err error
			}
			start := make(chan struct{})
			results := make(chan result, 2)
			for i := 0; i < 2; i++ {
				key := fmt.Sprintf("ur2-concurrent-accept-%d", i)
				if sameKey {
					key = "ur2-concurrent-same-accept"
				}
				go func(key string) {
					<-start
					op, e := s.DecideUnifiedReconciliation(ctx, actor(r.Destination.ID), r.ID, urDecision(key))
					results <- result{op, e}
				}(key)
			}
			close(start)
			first, second := <-results, <-results
			successes := 0
			for _, got := range []result{first, second} {
				if got.err == nil {
					successes++
				} else if got.err != transfers.ErrDecisionConflict {
					t.Fatal(got.err)
				}
			}
			want := 1
			if sameKey {
				want = 2
			}
			if successes != want || (sameKey && !reflect.DeepEqual(first.op, second.op)) {
				t.Fatal("concurrent retry/terminal result", first, second)
			}
			stock[0].Items[0].Existing++
			stock[0].Items[0].Available++
			if !reflect.DeepEqual(stock, dr1Inventory(t, ctx, p)) {
				t.Fatal("concurrent double stock effect")
			}
			history := urRead(t, ctx, s, r)
			if len(history.Operations) != 2 || history.Lines[0].UnifiedGeneration != 2 || history.Lines[0].Proposals[0].State != "applied" {
				t.Fatal("acceptance recorded more than once", history)
			}
		})
	}
}

func TestUR2InjectedRollback(t *testing.T) {
	for _, mode := range []string{"suppressed_destination", "deferred"} {
		t.Run(mode, func(t *testing.T) {
			ctx, p, r := r2Receipt(t, 10, 8)
			s := transfers.New(p)
			in := urProposal("ur2-injected-proposal")
			in.ArrivalQuantity = 9
			if _, e := s.ProposeUnifiedReconciliation(ctx, actor(r.Origin.ID), r.ID, in); e != nil {
				t.Fatal(e)
			}
			if mode == "suppressed_destination" {
				a01Exec(t, ctx, p, `CREATE FUNCTION ur2_suppress() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.location_id=2 THEN RETURN NULL; END IF; RETURN NEW; END $$; CREATE TRIGGER ur2_suppress BEFORE UPDATE ON inventory_balances FOR EACH ROW EXECUTE FUNCTION ur2_suppress()`)
			} else {
				a01Exec(t, ctx, p, `CREATE FUNCTION ur2_deferred() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected deferred failure'; END $$; CREATE CONSTRAINT TRIGGER ur2_deferred AFTER INSERT ON transfer_unified_applications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ur2_deferred()`)
			}
			before := urObserve(t, ctx, p, s, r)
			op, e := s.DecideUnifiedReconciliation(ctx, actor(r.Destination.ID), r.ID, urDecision("ur2-injected-accept"))
			if e != transfers.ErrUnavailable || !reflect.DeepEqual(op, transfers.UnifiedReconciliationOperation{}) || before != urObserve(t, ctx, p, s, r) {
				t.Fatal("partial effects survived failure", op, e)
			}
		})
	}
}

func TestUR2EvidenceAdmission(t *testing.T) {
	ctx, p, r := r2Receipt(t, 10, 8)
	s := transfers.New(p)
	if _, e := s.ProposeUnifiedReconciliation(ctx, actor(r.Origin.ID), r.ID, urProposal("ur2-evidence-proposal")); e != nil {
		t.Fatal(e)
	}
	if _, e := s.DecideUnifiedReconciliation(ctx, actor(r.Destination.ID), r.ID, urDecision("ur2-evidence-accept")); e != nil {
		t.Fatal(e)
	}
	for _, table := range []string{"transfer_unified_operations", "transfer_unified_proposals", "transfer_unified_decisions", "transfer_unified_applications"} {
		before := urObserve(t, ctx, p, s, r)
		if _, e := p.Exec(ctx, "UPDATE "+table+" SET request_id=request_id"); !sqlState(e, "P0001") || before != urObserve(t, ctx, p, s, r) {
			t.Fatal("mutable evidence", table, e)
		}
		want := "23514"
		if table == "transfer_unified_operations" {
			want = "23505"
		}
		if _, e := p.Exec(ctx, "INSERT INTO "+table+" SELECT * FROM "+table); !sqlState(e, want) || before != urObserve(t, ctx, p, s, r) {
			t.Fatal("direct evidence admission", table, e)
		}
	}
}

func TestUR2ReservedRollback(t *testing.T) {
	ctx, p, r := r2Receipt(t, 10, 8)
	s := transfers.New(p)
	// Use the normal transfer interface to reserve all remaining destination
	// variant1 stock. No synthetic balance or ledger mutation is needed.
	pages := dr1Inventory(t, ctx, p)
	quantity := pages[4].Items[0].Available
	in := input()
	in.CounterpartyID = r.Destination.ID
	in.RetryKey = "ur2-reserve-destination"
	in.Items = []transfers.Line{{VariantID: 1, Quantity: quantity}}
	created, e := s.Create(ctx, actor(3), in)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.Approve(ctx, actor(r.Destination.ID), created.Request.ID); e != nil {
		t.Fatal(e)
	}
	proposal := urProposal("ur2-reserved-proposal")
	proposal.ArrivalQuantity = 0
	if _, e = s.ProposeUnifiedReconciliation(ctx, actor(r.Origin.ID), r.ID, proposal); e != nil {
		t.Fatal(e)
	}
	beforeStock, beforeCounters, beforeHistory := dr1Inventory(t, ctx, p), dr2Counts(t, ctx, s), urRead(t, ctx, s, r)
	beforeDetail, e := s.Get(ctx, actor(r.Origin.ID), r.ID)
	if e != nil {
		t.Fatal(e)
	}
	op, e := s.DecideUnifiedReconciliation(ctx, actor(r.Destination.ID), r.ID, urDecision("ur2-reserved-accept"))
	if e != transfers.ErrInsufficientStock || !reflect.DeepEqual(op, transfers.UnifiedReconciliationOperation{}) {
		t.Fatal(fmt.Sprint(op), e)
	}
	afterDetail, e := s.Get(ctx, actor(r.Origin.ID), r.ID)
	if e != nil {
		t.Fatal(e)
	}
	if !reflect.DeepEqual(beforeStock, dr1Inventory(t, ctx, p)) || beforeCounters != dr2Counts(t, ctx, s) || !reflect.DeepEqual(beforeHistory, urRead(t, ctx, s, r)) || !reflect.DeepEqual(beforeDetail, afterDetail) {
		t.Fatal("failed acceptance changed stock, reservation, audit, counters or consent")
	}
}
