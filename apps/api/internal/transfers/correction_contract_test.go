package transfers_test

import (
	"errors"
	"math"
	"reflect"
	"testing"

	"luson/api/internal/transfers"
)

func TestCorrectionNormalization(t *testing.T) {
	input := transfers.CorrectionInput{Items: []transfers.Line{{3, math.MaxInt64}, {1, 0}, {2, math.MaxInt64}}}
	before := append([]transfers.Line(nil), input.Items...)
	got, err := transfers.NormalizeCorrection(input)
	want := []transfers.Line{{1, 0}, {2, math.MaxInt64}, {3, math.MaxInt64}}
	if err != nil || !reflect.DeepEqual(got.Items, want) {
		t.Fatalf("got %+v, %v; want %v", got, err, want)
	}
	if !reflect.DeepEqual(input.Items, before) {
		t.Fatal("normalization mutated input")
	}
	got.Items[0].Quantity = 7
	if !reflect.DeepEqual(input.Items, before) {
		t.Fatal("normalized items alias input")
	}
	// A correction can reduce every selected expected line to zero.
	zeros := transfers.CorrectionInput{Items: []transfers.Line{{2, 0}, {1, 0}}}
	got, err = transfers.NormalizeCorrection(zeros)
	if err != nil || !reflect.DeepEqual(got.Items, []transfers.Line{{1, 0}, {2, 0}}) {
		t.Fatalf("all-zero correction rejected: %+v, %v", got, err)
	}
	// No request decoder cap or aggregate quantity limit belongs here.
	items := make([]transfers.Line, 191)
	for i := range items {
		items[i] = transfers.Line{VariantID: int64(i + 1), Quantity: math.MaxInt64}
	}
	if _, err := transfers.NormalizeCorrection(transfers.CorrectionInput{Items: items}); err != nil {
		t.Fatal("arbitrary line or aggregate limit", err)
	}
}

func TestCorrectionNormalizationInvalid(t *testing.T) {
	for name, items := range map[string][]transfers.Line{
		"nil":                       nil,
		"empty":                     {},
		"zero_id":                   {{0, 1}},
		"negative_id":               {{-1, 1}},
		"id_overflow":               {{math.MaxInt32 + 1, 1}},
		"negative_quantity":         {{1, -1}},
		"quantity_overflow_wrapped": {{1, math.MinInt64}},
		"duplicate":                 {{2, 1}, {1, 0}, {2, 0}},
	} {
		t.Run(name, func(t *testing.T) {
			got, err := transfers.NormalizeCorrection(transfers.CorrectionInput{Items: items})
			if !errors.Is(err, transfers.ErrInvalid) || !reflect.DeepEqual(got, transfers.CorrectionInput{}) {
				t.Fatalf("got %+v, %v; want zero result and ErrInvalid", got, err)
			}
		})
	}
}

func TestCorrectionArithmetic(t *testing.T) {
	for _, tc := range []struct {
		name                                                 string
		sent, previousActual, correctedActual, credit, delta int64
	}{
		{"matching_original_down", 10, 10, 6, 6, -4},
		{"matching_original_up", 10, 10, 12, 10, 0},
		{"shortage_up", 10, 3, 8, 8, 5},
		{"shortage_down", 10, 8, 3, 3, -5},
		{"zero_corrected", 10, 8, 0, 0, -8},
		{"zero_previous", 10, 0, 8, 8, 8},
		{"zero_unchanged", 10, 0, 0, 0, 0},
		{"unchanged_actual", 10, 8, 8, 8, 0},
		{"cross_cap_up", 10, 8, 15, 10, 2},
		{"cross_cap_down", 10, 15, 8, 8, -2},
		{"above_cap_up", 10, 12, 15, 10, 0},
		{"above_cap_down", 10, 15, 12, 10, 0},
		{"max_increase", math.MaxInt64, 0, math.MaxInt64, math.MaxInt64, math.MaxInt64},
		{"max_decrease", math.MaxInt64, math.MaxInt64, 0, 0, -math.MaxInt64},
		{"max_actual_capped", 10, 0, math.MaxInt64, 10, 10},
	} {
		t.Run(tc.name, func(t *testing.T) {
			previous := transfers.ReceiptLine{VariantID: math.MaxInt32, ExpectedQuantity: tc.sent, ActualQuantity: tc.previousActual, AvailableQuantity: min(tc.sent, tc.previousActual)}
			before := previous
			got, err := transfers.CalculateCorrection(previous, tc.correctedActual)
			want := transfers.Correction{
				Line:        transfers.ReceiptLine{VariantID: previous.VariantID, ExpectedQuantity: tc.sent, ActualQuantity: tc.correctedActual, AvailableQuantity: tc.credit},
				CreditDelta: tc.delta,
			}
			if err != nil || got != want {
				t.Fatalf("got %+v, %v; want %+v", got, err, want)
			}
			if previous != before {
				t.Fatal("correction mutated previous evidence")
			}
		})
	}
}

func TestCorrectionUsesLatestEffectiveCredit(t *testing.T) {
	original := transfers.ReceiptLine{VariantID: 1, ExpectedQuantity: 10, ActualQuantity: 3, AvailableQuantity: 3}
	first, err := transfers.CalculateCorrection(original, 8)
	if err != nil || first.CreditDelta != 5 {
		t.Fatalf("first correction: %+v, %v", first, err)
	}
	second, err := transfers.CalculateCorrection(first.Line, 6)
	if err != nil || second.CreditDelta != -2 || second.Line.AvailableQuantity != 6 {
		t.Fatalf("second correction must subtract latest credit, not original: %+v, %v", second, err)
	}
	if original.ActualQuantity != 3 || original.AvailableQuantity != 3 {
		t.Fatal("original evidence changed")
	}
}

func TestCorrectionInvalidPriorOrActual(t *testing.T) {
	valid := transfers.ReceiptLine{VariantID: 1, ExpectedQuantity: 10, ActualQuantity: 8, AvailableQuantity: 8}
	for name, mutate := range map[string]func(*transfers.ReceiptLine){
		"zero_id":                 func(l *transfers.ReceiptLine) { l.VariantID = 0 },
		"negative_id":             func(l *transfers.ReceiptLine) { l.VariantID = -1 },
		"id_overflow":             func(l *transfers.ReceiptLine) { l.VariantID = math.MaxInt32 + 1 },
		"unexpected_line":         func(l *transfers.ReceiptLine) { l.ExpectedQuantity = 0 },
		"negative_sent":           func(l *transfers.ReceiptLine) { l.ExpectedQuantity = -1 },
		"negative_actual":         func(l *transfers.ReceiptLine) { l.ActualQuantity = -1 },
		"actual_overflow_wrapped": func(l *transfers.ReceiptLine) { l.ActualQuantity = math.MinInt64 },
		"negative_credit":         func(l *transfers.ReceiptLine) { l.AvailableQuantity = -1 },
		"credit_above_sent":       func(l *transfers.ReceiptLine) { l.AvailableQuantity = 11 },
		"credit_above_actual":     func(l *transfers.ReceiptLine) { l.AvailableQuantity = 9 },
		"credit_below_effective":  func(l *transfers.ReceiptLine) { l.AvailableQuantity = 7 },
		"uncapped_prior_surplus":  func(l *transfers.ReceiptLine) { l.ActualQuantity = 12; l.AvailableQuantity = 12 },
	} {
		t.Run(name, func(t *testing.T) {
			previous := valid
			mutate(&previous)
			got, err := transfers.CalculateCorrection(previous, 6)
			if !errors.Is(err, transfers.ErrInvalid) || got != (transfers.Correction{}) {
				t.Fatalf("got %+v, %v; want zero result and ErrInvalid", got, err)
			}
		})
	}
	for _, actual := range []int64{-1, math.MinInt64} {
		got, err := transfers.CalculateCorrection(valid, actual)
		if !errors.Is(err, transfers.ErrInvalid) || got != (transfers.Correction{}) {
			t.Fatalf("invalid corrected actual %d admitted: %+v, %v", actual, got, err)
		}
	}
}
