package transfers

import "errors"

// ErrInvalidUnifiedAccounting means quantities or accounting baselines are
// negative, or retention exceeds the original goods not dispatched.
var ErrInvalidUnifiedAccounting = errors.New("invalid unified reconciliation accounting")

// UnifiedAccountingInput contains exact per-variant quantities, not a wire or
// persistence schema. OriginalDebit, Dispatch, Arrival and Retained are E,D,A,R.
// Retained is the total agreed retention, not an additional restoration.
//
// SourceDebit and DestinationCredit are nonnegative net accounting baselines
// derived from actual ledger effects, including prior legacy restorations and
// count corrections. Neither is inferred from Dispatch or Arrival. They may
// exceed the new targets: a previous agreement may have dispatched more goods.
// Callers must reject overflowing ledger aggregates before converting to int64.
// No variant membership or evidence provenance is established by these values.
type UnifiedAccountingInput struct {
	OriginalDebit     int64
	Dispatch          int64
	Arrival           int64
	Retained          int64
	SourceDebit       int64
	DestinationCredit int64
}

// UnifiedAccounting gives targets and signed stock changes. A positive
// SourceDelta restores source stock; a negative one debits it. A positive
// DestinationDelta credits destination stock. Unknown quantities are not losses;
// Excess is observed arrival beyond dispatch and is never credited here.
type UnifiedAccounting struct {
	TargetSourceDebit       int64
	TargetDestinationCredit int64
	SourceDelta             int64
	DestinationDelta        int64
	OriginUnknown           int64
	TransitUnknown          int64
	Excess                  int64
}

// CalculateUnifiedAccounting plans one variant without side effects. It does
// not authorize a proposal, attest physical retention, accept an agreement or
// establish retry identity. Origin attestation, bilateral acceptance, ledger
// ownership fencing, balance/reservation checks and atomic application belong
// in a future transactional caller. Repeating targets against updated ledger
// baselines yields zero deltas, but is not a transactional idempotency protocol.
func CalculateUnifiedAccounting(in UnifiedAccountingInput) (UnifiedAccounting, error) {
	if in.OriginalDebit < 0 || in.Dispatch < 0 || in.Arrival < 0 || in.Retained < 0 || in.SourceDebit < 0 || in.DestinationCredit < 0 {
		return UnifiedAccounting{}, ErrInvalidUnifiedAccounting
	}
	originGap := max(in.OriginalDebit-in.Dispatch, 0)
	if in.Retained > originGap {
		return UnifiedAccounting{}, ErrInvalidUnifiedAccounting
	}
	source := max(in.OriginalDebit, in.Dispatch) - in.Retained
	destination := min(in.Dispatch, in.Arrival)
	// Each operand is in [0, MaxInt64], so every difference fits int64.
	// Do not sum quantities across variants or combine unknowns with credits.
	return UnifiedAccounting{
		TargetSourceDebit:       source,
		TargetDestinationCredit: destination,
		SourceDelta:             in.SourceDebit - source,
		DestinationDelta:        destination - in.DestinationCredit,
		OriginUnknown:           originGap - in.Retained,
		TransitUnknown:          max(in.Dispatch-in.Arrival, 0),
		Excess:                  max(in.Arrival-in.Dispatch, 0),
	}, nil
}
