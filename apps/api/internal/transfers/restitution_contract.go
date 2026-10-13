package transfers

import "math"

// Restitution describes a source credit, not a replacement for immutable
// dispatch or receipt evidence. RemainingQuantity is D-C-R-q, the remaining
// unreconciled debit, not evidence that any more goods were retained at origin.
type Restitution struct {
	SourceDelta       int64
	RemainingQuantity int64
}

// CalculateRestitution validates one expected line against immutable dispatched
// quantity D, trusted latest effective destination credit C=min(D,actual), prior
// source restitution R, and explicitly attested retained quantity q. It returns
// source delta q without changing destination credit or the supplied evidence.
// Positive R is valid arithmetic input; it does not establish workflow eligibility.
//
// Arithmetic proves neither physical retention nor inventory/account eligibility.
// SQL owns receipt membership, retention attestation, authorization, pending
// proposal generation fencing and terminal once-only application uniqueness.
// The caller must not reuse original receipt credit after a count correction.
func CalculateRestitution(previous ReceiptLine, priorRestitution, retainedQuantity int64) (Restitution, error) {
	if previous.VariantID < 1 || previous.VariantID > math.MaxInt32 || previous.ExpectedQuantity < 1 || previous.ActualQuantity < 0 || previous.AvailableQuantity != min(previous.ExpectedQuantity, previous.ActualQuantity) {
		return Restitution{}, ErrInvalid
	}
	if err := ValidateRestitutionDestinationCredit(previous.ExpectedQuantity, priorRestitution, previous.AvailableQuantity); err != nil {
		return Restitution{}, err
	}
	// The guard proves both subtractions are nonnegative; never add R+C+q,
	// which could overflow even when each input individually fits int64.
	remaining := previous.ExpectedQuantity - priorRestitution - previous.AvailableQuantity
	if retainedQuantity <= 0 || retainedQuantity > remaining {
		return Restitution{}, ErrInvalid
	}
	return Restitution{
		SourceDelta:       retainedQuantity,
		RemainingQuantity: remaining - retainedQuantity,
	}, nil
}

// ValidateRestitutionDestinationCredit rejects a proposed effective destination
// credit outside [0,D-R]. It never clips a forbidden upward credit or reverses
// source restitution. The caller derives proposed credit from trusted expected
// line counts and supplies total applied R; this is not an eligibility check or
// a substitute for atomic SQL revalidation in future count acceptance.
func ValidateRestitutionDestinationCredit(dispatched, priorRestitution, proposedCredit int64) error {
	if dispatched < 1 || priorRestitution < 0 || priorRestitution > dispatched || proposedCredit < 0 || proposedCredit > dispatched-priorRestitution {
		return ErrInvalid
	}
	return nil
}
