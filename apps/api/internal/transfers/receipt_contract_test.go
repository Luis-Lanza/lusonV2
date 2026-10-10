package transfers_test

import (
	"errors"
	"math"
	"reflect"
	"testing"

	"luson/api/internal/transfers"
)

func TestR1ReceiptNormalization(t *testing.T) {
	original := transfers.ReceiptInput{Items: []transfers.Line{{3, math.MaxInt64}, {1, 0}, {2, math.MaxInt64}}}
	before := append([]transfers.Line(nil), original.Items...)
	normalized, err := transfers.NormalizeReceipt(original)
	if err != nil || !reflect.DeepEqual(normalized.Items, []transfers.Line{{1, 0}, {2, math.MaxInt64}, {3, math.MaxInt64}}) {
		t.Fatal("normalization must admit zeros and cross-variant totals above int64", err)
	}
	if !reflect.DeepEqual(original.Items, before) {
		t.Fatal("normalization mutated caller input")
	}
	normalized.Items[0].Quantity = 1
	if !reflect.DeepEqual(original.Items, before) {
		t.Fatal("normalized payload aliases caller input")
	}
	for _, items := range [][]transfers.Line{nil, {}, {{1, 0}}, {{1, 0}, {2, 0}}, {{1, -1}}, {{0, 1}}, {{math.MaxInt32 + 1, 1}}, {{1, 1}, {1, 2}}, {{1, 0}, {1, 1}}} {
		got, err := transfers.NormalizeReceipt(transfers.ReceiptInput{Items: items})
		if !errors.Is(err, transfers.ErrInvalid) || !reflect.DeepEqual(got, transfers.ReceiptInput{}) {
			t.Errorf("malformed receipt admitted: %v", items)
		}
	}
	// Catalogue uniqueness, not request's 190-item decoder limit, controls size.
	items := make([]transfers.Line, 191)
	for i := range items {
		items[i] = transfers.Line{int64(i + 1), 1}
	}
	if _, err := transfers.NormalizeReceipt(transfers.ReceiptInput{Items: items}); err != nil {
		t.Fatal("arbitrary smaller line cap", err)
	}
}

func TestR1ReceiptArithmeticFence(t *testing.T) {
	valid := transfers.Request{Items: []transfers.Item{{VariantID: 1, Quantity: 3}, {VariantID: 2, Quantity: 2}}, Receipt: &transfers.Receipt{
		Items:      []transfers.ReceiptLine{{1, 3, 1, 1}, {2, 2, 5, 2}, {3, 0, 7, 0}},
		Exceptions: []transfers.ReceiptException{{1, "shortage", 2}, {2, "excess", 3}, {3, "unexpected", 7}},
	}}
	if err := transfers.CheckReceipt(valid); err != nil {
		t.Fatal("exact line truth refused", err)
	}
	for name, mutate := range map[string]func(*transfers.Request){
		"missing_receipt":    func(r *transfers.Request) { r.Receipt = nil },
		"missing_expected":   func(r *transfers.Request) { r.Receipt.Items = r.Receipt.Items[1:] },
		"duplicate":          func(r *transfers.Request) { r.Receipt.Items = append(r.Receipt.Items, r.Receipt.Items[0]) },
		"sent_tamper":        func(r *transfers.Request) { r.Receipt.Items[0].ExpectedQuantity++ },
		"available_excess":   func(r *transfers.Request) { r.Receipt.Items[1].AvailableQuantity++ },
		"unexpected_credit":  func(r *transfers.Request) { r.Receipt.Items[2].AvailableQuantity = 1 },
		"negative":           func(r *transfers.Request) { r.Receipt.Items[0].ActualQuantity = -1 },
		"missing_exception":  func(r *transfers.Request) { r.Receipt.Exceptions = r.Receipt.Exceptions[1:] },
		"exception_quantity": func(r *transfers.Request) { r.Receipt.Exceptions[0].Quantity++ },
		"exception_kind":     func(r *transfers.Request) { r.Receipt.Exceptions[0].Kind = "unexpected" },
	} {
		t.Run(name, func(t *testing.T) {
			bad := valid
			bad.Receipt = &transfers.Receipt{Items: append([]transfers.ReceiptLine(nil), valid.Receipt.Items...), Exceptions: append([]transfers.ReceiptException(nil), valid.Receipt.Exceptions...)}
			mutate(&bad)
			if !errors.Is(transfers.CheckReceipt(bad), transfers.ErrUnavailable) {
				t.Fatal("partial or inconsistent persisted receipt admitted")
			}
		})
	}
}
