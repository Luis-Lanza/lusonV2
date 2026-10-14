package transfers

import (
	"math"
	"sort"
)

// CorrectionInput contains corrected actual counts for selected lines.
// It does not establish receipt membership or proposal eligibility.
type CorrectionInput struct{ Items []Line }

// Correction describes an effective expected line, not a replacement for the
// immutable original receipt. CreditDelta is the signed destination credit
// change; zero means no stock operation, even when the actual count changed.
type Correction struct {
	Line        ReceiptLine
	CreditDelta int64
}

// NormalizeCorrection copies and sorts counts for order-independent identity.
// Unlike a receipt, a correction may contain only zeros. Quantities stay per
// variant: their aggregate may exceed int64 and is never calculated here.
func NormalizeCorrection(in CorrectionInput) (CorrectionInput, error) {
	if len(in.Items) == 0 {
		return CorrectionInput{}, ErrInvalid
	}
	out := CorrectionInput{Items: append([]Line(nil), in.Items...)}
	sort.Slice(out.Items, func(i, j int) bool { return out.Items[i].VariantID < out.Items[j].VariantID })
	for i, line := range out.Items {
		if line.VariantID < 1 || line.VariantID > math.MaxInt32 || line.Quantity < 0 || (i > 0 && out.Items[i-1].VariantID == line.VariantID) {
			return CorrectionInput{}, ErrInvalid
		}
	}
	return out, nil
}

// CalculateCorrection derives capped expected-line credit from the latest
// effective line. The caller must supply trusted dispatched quantity and latest
// effective count/credit, not reuse original receipt evidence after a correction.
// Originally matching lines need no exception to qualify for this arithmetic.
// Unexpected goods (expected quantity zero) and surplus incorporation are not
// supported. Inventory balances, reservations and authorization are not checked.
func CalculateCorrection(previous ReceiptLine, correctedActual int64) (Correction, error) {
	if previous.VariantID < 1 || previous.VariantID > math.MaxInt32 || previous.ExpectedQuantity < 1 || previous.ActualQuantity < 0 || correctedActual < 0 || previous.AvailableQuantity != min(previous.ExpectedQuantity, previous.ActualQuantity) {
		return Correction{}, ErrInvalid
	}
	credit := min(previous.ExpectedQuantity, correctedActual)
	// Both credits lie in [0, MaxInt64], so subtraction cannot overflow.
	return Correction{
		Line: ReceiptLine{
			VariantID:         previous.VariantID,
			ExpectedQuantity:  previous.ExpectedQuantity,
			ActualQuantity:    correctedActual,
			AvailableQuantity: credit,
		},
		CreditDelta: credit - previous.AvailableQuantity,
	}, nil
}
