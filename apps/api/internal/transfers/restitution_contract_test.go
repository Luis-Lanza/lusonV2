package transfers_test

import (
	"errors"
	"math"
	"testing"

	"luson/api/internal/transfers"
)

// Exercise the public Store over the admitted isolated fixture. Reads and
// refused reads must preserve inventory, original history and public counters.
func TestDR1RestitutionDispatchContract(t *testing.T) {
	ctx, pool, r := r2Receipt(t, 5, 7)
	s := transfers.New(pool)
	initial, err := s.GetRestitutions(ctx, actor(r.Origin.ID), r.ID)
	if err != nil || initial.Lines[0].EffectiveDispatch != 5 || initial.Lines[0].ReconciliationRevision != 0 {
		t.Fatal("unreconciled original dispatch compatibility", err)
	}
	for i, quantity := range []int64{7, 8, 6} {
		if i > 0 {
			c2StorePropose(t, ctx, s, r, r.Destination.ID, 1, int64(i-1), quantity, "t4b-count-propose-"+string(rune('a'+i)))
			c2StoreDecide(t, ctx, s, r, r.Origin.ID, 1, int64(i), true, "t4b-count-accept-"+string(rune('a'+i)))
		}
		if i == 2 {
			// D=8,C=6: pending retention pins 8 even after reconciliation to 6.
			if _, err := s.ProposeRestitution(ctx, actor(r.Origin.ID), r.ID, r3Proposal("t4b-historical-retention", 0, 1)); err != nil {
				t.Fatal(err)
			}
		}
		dr1Do(t, ctx, pool, r, r.Origin.ID, "t4b-dispatch-propose-"+string(rune('a'+i)), "propose", int64(i), quantity)
		dr1Do(t, ctx, pool, r, r.Destination.ID, "t4b-dispatch-accept-"+string(rune('a'+i)), "accept", int64(i+1), nil)
		before := dr1Snapshot(t, ctx, pool, r)
		for _, who := range []int{r.Origin.ID, r.Destination.ID} {
			got, err := s.GetRestitutions(ctx, actor(who), r.ID)
			if err != nil || len(got.Lines) != 1 {
				t.Fatal("participant dispatch history", err)
			}
			line := got.Lines[0]
			if line.ExpectedQuantity != 5 || line.OriginalCredit != 5 || line.EffectiveCredit != quantity || line.CountAppliedRevision != int64(i) {
				t.Fatal("original/count evidence changed", line)
			}
			if line.EffectiveDispatch != quantity || line.ReconciliationRevision != int64(i+1) {
				t.Fatal("current dispatch evidence missing or incorrect", line)
			}
			if i == 2 {
				p := line.Proposals[0]
				if p.BaseDispatch != 8 || p.BaseCredit != 6 || p.RetainedQuantity != 1 || p.State != "pending" || p.CountGeneration != 4 || p.CountAppliedRevision != 2 {
					t.Fatal("historical proposal replaced with current capacity", p)
				}
			}
		}
		if got, err := s.GetRestitutions(ctx, actor(3), r.ID); !errors.Is(err, transfers.ErrNotFound) || got.RequestID != 0 {
			t.Fatal("foreign history exposed", err)
		}
		if dr1Snapshot(t, ctx, pool, r) != before {
			t.Fatal("GET changed inventory/history/counters")
		}
	}
}

func TestRestitutionArithmetic(t *testing.T) {
	for _, tc := range []struct {
		name                                    string
		dispatched, actual, prior, q, remaining int64
	}{
		{"five_four_one", 5, 4, 0, 1, 0},
		{"zero_actual_and_credit", 5, 0, 0, 5, 0},
		{"partial_retention", 5, 1, 0, 2, 2},
		{"previous_restitution", 5, 1, 2, 1, 1},
		{"previous_restitution_exhausted", 5, 1, 2, 2, 0},
		{"max_source_delta", math.MaxInt64, 0, 0, math.MaxInt64, 0},
		{"max_remaining", math.MaxInt64, 0, 0, 1, math.MaxInt64 - 1},
		{"max_previous_restitution", math.MaxInt64, 0, math.MaxInt64 - 1, 1, 0},
		{"max_destination_credit", math.MaxInt64, math.MaxInt64 - 1, 0, 1, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			previous := transfers.ReceiptLine{
				VariantID: 1, ExpectedQuantity: tc.dispatched,
				ActualQuantity: tc.actual, AvailableQuantity: min(tc.dispatched, tc.actual),
			}
			before := previous
			got, err := transfers.CalculateRestitution(previous, tc.prior, tc.q)
			want := transfers.Restitution{SourceDelta: tc.q, RemainingQuantity: tc.remaining}
			if err != nil || got != want {
				t.Fatalf("got %+v, %v; want %+v", got, err, want)
			}
			if previous != before {
				t.Fatal("restitution mutated latest receipt evidence")
			}
			// The new total restitution fences future destination credit.
			applied := tc.prior + got.SourceDelta // Bounded by D in successful cases.
			if err := transfers.ValidateRestitutionDestinationCredit(tc.dispatched, applied, previous.AvailableQuantity); err != nil {
				t.Fatalf("existing credit violates post-application bound: %v", err)
			}
		})
	}
}

func TestRestitutionInvalidPriorLine(t *testing.T) {
	valid := transfers.ReceiptLine{VariantID: 1, ExpectedQuantity: 5, ActualQuantity: 4, AvailableQuantity: 4}
	for name, mutate := range map[string]func(*transfers.ReceiptLine){
		"zero_variant":            func(l *transfers.ReceiptLine) { l.VariantID = 0 },
		"negative_variant":        func(l *transfers.ReceiptLine) { l.VariantID = -1 },
		"variant_overflow":        func(l *transfers.ReceiptLine) { l.VariantID = math.MaxInt32 + 1 },
		"unexpected_line":         func(l *transfers.ReceiptLine) { l.ExpectedQuantity = 0 },
		"negative_dispatched":     func(l *transfers.ReceiptLine) { l.ExpectedQuantity = -1 },
		"wrapped_dispatched":      func(l *transfers.ReceiptLine) { l.ExpectedQuantity = math.MinInt64 },
		"negative_actual":         func(l *transfers.ReceiptLine) { l.ActualQuantity = -1 },
		"wrapped_actual":          func(l *transfers.ReceiptLine) { l.ActualQuantity = math.MinInt64 },
		"negative_credit":         func(l *transfers.ReceiptLine) { l.AvailableQuantity = -1 },
		"wrapped_credit":          func(l *transfers.ReceiptLine) { l.AvailableQuantity = math.MinInt64 },
		"credit_above_dispatched": func(l *transfers.ReceiptLine) { l.AvailableQuantity = 6 },
		"credit_above_actual":     func(l *transfers.ReceiptLine) { l.AvailableQuantity = 5 },
		"credit_below_effective":  func(l *transfers.ReceiptLine) { l.AvailableQuantity = 3 },
		"uncapped_surplus":        func(l *transfers.ReceiptLine) { l.ActualQuantity = 6; l.AvailableQuantity = 6 },
	} {
		t.Run(name, func(t *testing.T) {
			previous := valid
			mutate(&previous)
			before := previous
			got, err := transfers.CalculateRestitution(previous, 0, 1)
			if !errors.Is(err, transfers.ErrInvalid) || got != (transfers.Restitution{}) {
				t.Fatalf("got %+v, %v; want zero result and ErrInvalid", got, err)
			}
			if previous != before {
				t.Fatal("invalid input mutated")
			}
		})
	}
}

func TestRestitutionInvalidBudget(t *testing.T) {
	for _, tc := range []struct {
		name                         string
		dispatched, actual, prior, q int64
	}{
		{"zero_retained", 5, 4, 0, 0},
		{"negative_retained", 5, 4, 0, -1},
		{"wrapped_retained", 5, 4, 0, math.MinInt64},
		{"excess_retained", 5, 4, 0, 2},
		{"negative_prior", 5, 4, -1, 1},
		{"wrapped_prior", 5, 4, math.MinInt64, 1},
		{"prior_above_dispatched", 5, 0, 6, 1},
		{"prior_plus_credit_above_dispatched", 5, 4, 2, 1},
		{"prior_exhausts_budget", 5, 4, 1, 1},
		{"previous_restitution_reduces_budget", 5, 1, 2, 3},
		{"matching_receipt", 5, 5, 0, 1},
		{"capped_surplus", 5, math.MaxInt64, 0, 1},
		{"max_prior_plus_credit_overflow", math.MaxInt64, math.MaxInt64, math.MaxInt64, 1},
		{"max_q_plus_prior_overflow", math.MaxInt64, 0, 1, math.MaxInt64},
		{"max_q_plus_credit_overflow", math.MaxInt64, 1, 0, math.MaxInt64},
	} {
		t.Run(tc.name, func(t *testing.T) {
			previous := transfers.ReceiptLine{VariantID: 1, ExpectedQuantity: tc.dispatched, ActualQuantity: tc.actual, AvailableQuantity: min(tc.dispatched, tc.actual)}
			got, err := transfers.CalculateRestitution(previous, tc.prior, tc.q)
			if !errors.Is(err, transfers.ErrInvalid) || got != (transfers.Restitution{}) {
				t.Fatalf("got %+v, %v; want zero result and ErrInvalid", got, err)
			}
		})
	}
}

func TestRestitutionVariantBounds(t *testing.T) {
	for _, variant := range []int64{1, math.MaxInt32} {
		previous := transfers.ReceiptLine{VariantID: variant, ExpectedQuantity: 5, ActualQuantity: 4, AvailableQuantity: 4}
		got, err := transfers.CalculateRestitution(previous, 0, 1)
		if err != nil || got != (transfers.Restitution{SourceDelta: 1}) {
			t.Fatalf("valid variant %d rejected: %+v, %v", variant, got, err)
		}
	}
}

func TestRestitutionUsesLatestEffectiveCredit(t *testing.T) {
	original := transfers.ReceiptLine{VariantID: 1, ExpectedQuantity: 5, ActualQuantity: 2, AvailableQuantity: 2}
	latest, err := transfers.CalculateCorrection(original, 4)
	if err != nil {
		t.Fatal(err)
	}
	before := latest.Line
	got, err := transfers.CalculateRestitution(latest.Line, 0, 1)
	if err != nil || got != (transfers.Restitution{SourceDelta: 1}) {
		t.Fatalf("latest credit not used: %+v, %v", got, err)
	}
	if _, err := transfers.CalculateRestitution(latest.Line, 0, 2); !errors.Is(err, transfers.ErrInvalid) {
		t.Fatalf("original receipt budget reused: %v", err)
	}
	if latest.Line != before || original != (transfers.ReceiptLine{VariantID: 1, ExpectedQuantity: 5, ActualQuantity: 2, AvailableQuantity: 2}) {
		t.Fatal("original or latest evidence changed")
	}
}

func TestRestitutionDestinationCredit(t *testing.T) {
	for _, tc := range []struct {
		name                      string
		dispatched, prior, credit int64
		valid                     bool
	}{
		{"lower_credit", 5, 1, 3, true},
		{"equal_bound", 5, 1, 4, true},
		{"forbidden_upward_credit", 5, 1, 5, false},
		{"zero_credit", 5, 1, 0, true},
		{"no_restitution", 5, 0, 5, true},
		{"full_restitution_zero_credit", 5, 5, 0, true},
		{"full_restitution_positive_credit", 5, 5, 1, false},
		{"zero_dispatched", 0, 0, 0, false},
		{"negative_dispatched", -1, 0, 0, false},
		{"wrapped_dispatched", math.MinInt64, 0, 0, false},
		{"negative_prior", 5, -1, 0, false},
		{"wrapped_prior", 5, math.MinInt64, 0, false},
		{"prior_above_dispatched", 5, 6, 0, false},
		{"negative_credit", 5, 0, -1, false},
		{"wrapped_credit", 5, 0, math.MinInt64, false},
		{"credit_above_dispatched", 5, 0, 6, false},
		{"max_credit", math.MaxInt64, 0, math.MaxInt64, true},
		{"max_prior", math.MaxInt64, math.MaxInt64, 0, true},
		{"max_bound", math.MaxInt64, 1, math.MaxInt64 - 1, true},
		{"max_sum_overflow", math.MaxInt64, 1, math.MaxInt64, false},
		{"max_both_overflow", math.MaxInt64, math.MaxInt64, math.MaxInt64, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := transfers.ValidateRestitutionDestinationCredit(tc.dispatched, tc.prior, tc.credit)
			if tc.valid && err != nil {
				t.Fatalf("valid proposed credit rejected: %v", err)
			}
			if !tc.valid && !errors.Is(err, transfers.ErrInvalid) {
				t.Fatalf("invalid proposed credit admitted: %v", err)
			}
		})
	}
}
