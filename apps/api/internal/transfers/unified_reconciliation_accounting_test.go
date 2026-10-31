package transfers

import (
	"math"
	"testing"
)

func TestUnifiedAccountingTargets(t *testing.T) {
	tests := []struct {
		name  string
		input UnifiedAccountingInput
		want  UnifiedAccounting
	}{
		{"original debit", UnifiedAccountingInput{10, 9, 8, 1, 10, 8}, UnifiedAccounting{9, 8, 1, 0, 0, 1, 0}},
		{"legacy restored", UnifiedAccountingInput{10, 9, 8, 1, 9, 8}, UnifiedAccounting{9, 8, 0, 0, 0, 1, 0}},
		{"overdispatch", UnifiedAccountingInput{10, 12, 12, 0, 10, 10}, UnifiedAccounting{12, 12, -2, 2, 0, 0, 0}},
		{"downward arrival", UnifiedAccountingInput{10, 10, 7, 0, 10, 10}, UnifiedAccounting{10, 7, 0, -3, 0, 3, 0}},
		{"zero arrival", UnifiedAccountingInput{10, 10, 0, 0, 10, 7}, UnifiedAccounting{10, 0, 0, -7, 0, 10, 0}},
		{"all retained", UnifiedAccountingInput{10, 0, 0, 10, 10, 0}, UnifiedAccounting{0, 0, 10, 0, 0, 0, 0}},
		{"none retained", UnifiedAccountingInput{10, 0, 0, 0, 10, 0}, UnifiedAccounting{10, 0, 0, 0, 10, 0, 0}},
		{"excess capped", UnifiedAccountingInput{10, 9, 12, 0, 10, 9}, UnifiedAccounting{10, 9, 0, 0, 1, 0, 3}},
		{"partial retention", UnifiedAccountingInput{10, 6, 4, 2, 10, 4}, UnifiedAccounting{8, 4, 2, 0, 2, 2, 0}},
		{"zero quantities", UnifiedAccountingInput{}, UnifiedAccounting{}},
		{"max targets", UnifiedAccountingInput{math.MaxInt64, math.MaxInt64, math.MaxInt64, 0, 0, 0}, UnifiedAccounting{math.MaxInt64, math.MaxInt64, -math.MaxInt64, math.MaxInt64, 0, 0, 0}},
		{"max restoration", UnifiedAccountingInput{math.MaxInt64, 0, 0, math.MaxInt64, math.MaxInt64, math.MaxInt64}, UnifiedAccounting{0, 0, math.MaxInt64, -math.MaxInt64, 0, 0, 0}},
		{"max excess", UnifiedAccountingInput{0, 0, math.MaxInt64, 0, 0, 0}, UnifiedAccounting{0, 0, 0, 0, 0, 0, math.MaxInt64}},
		{"max origin and transit", UnifiedAccountingInput{math.MaxInt64, 1, 0, 0, math.MaxInt64, 0}, UnifiedAccounting{math.MaxInt64, 0, 0, 0, math.MaxInt64 - 1, 1, 0}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			before := tt.input
			got, err := CalculateUnifiedAccounting(tt.input)
			if err != nil || got != tt.want {
				t.Fatalf("got %+v, %v; want %+v", got, err, tt.want)
			}
			if tt.input != before {
				t.Fatal("input mutated")
			}
			repeated := tt.input
			repeated.SourceDebit = got.TargetSourceDebit
			repeated.DestinationCredit = got.TargetDestinationCredit
			again, err := CalculateUnifiedAccounting(repeated)
			want := got
			want.SourceDelta, want.DestinationDelta = 0, 0
			if err != nil || again != want {
				t.Fatalf("repeat got %+v, %v; want %+v", again, err, want)
			}
		})
	}
}

func TestUnifiedAccountingRejectsInvalid(t *testing.T) {
	tests := []UnifiedAccountingInput{
		{-1, 0, 0, 0, 0, 0}, {0, -1, 0, 0, 0, 0}, {0, 0, -1, 0, 0, 0},
		{0, 0, 0, -1, 0, 0}, {0, 0, 0, 0, -1, 0}, {0, 0, 0, 0, 0, -1},
		{10, 9, 8, 2, 10, 8}, {10, 12, 12, 1, 10, 10}, {0, 0, 0, 1, 0, 0},
		{math.MinInt64, 0, 0, 0, 0, 0}, {0, 0, 0, 0, math.MinInt64, 0},
		{0, 0, 0, 0, 0, math.MinInt64}, {math.MaxInt64, 1, 0, math.MaxInt64, 0, 0},
	}
	for _, input := range tests {
		before := input
		got, err := CalculateUnifiedAccounting(input)
		if err != ErrInvalidUnifiedAccounting || got != (UnifiedAccounting{}) {
			t.Fatalf("input %+v: got %+v, %v", input, got, err)
		}
		if input != before {
			t.Fatal("invalid input mutated")
		}
	}
}
