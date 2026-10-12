// Package transfers persists immutable Pending requests without reserving stock.
package transfers

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"math"
	"regexp"
	"sort"
	"time"

	"luson/api/internal/auth"
	"luson/api/internal/catalog"
)

type Kind string

const (
	RequestStock    Kind = "request_stock"
	SendToWarehouse Kind = "send_to_warehouse"
)

var (
	ErrForbidden         = errors.New("transfer forbidden")
	ErrInvalid           = errors.New("invalid transfer request")
	ErrNotFound          = errors.New("transfer not found")
	ErrInsufficientStock = errors.New("insufficient transfer stock")
	ErrRetryConflict     = errors.New("transfer retry conflict")
	ErrDecisionConflict  = errors.New("transfer decision conflict")
	ErrUnavailable       = errors.New("transfer store unavailable")
)

type Line struct {
	VariantID int64
	Quantity  int64
}
type CreateInput struct {
	Kind           Kind
	CounterpartyID int
	RetryKey       string
	Items          []Line
}
type Intent struct {
	CreatorID, OriginID, DestinationID, ApproverID int
	Kind                                           Kind
	RetryKey                                       string
	Items                                          []Line
	Fingerprint                                    [32]byte
}
type Location struct {
	ID   int
	Name string
}
type Item struct {
	VariantID    int64
	Quantity     int64
	Brand, Model string
	Capacity     catalog.Decimal
	Polarity     string
}
type Request struct {
	ID                                     int64
	Reference                              string
	Kind                                   Kind
	Status                                 string
	Creator, Origin, Destination, Approver Location
	CreatedAt                              time.Time
	DecisionLocationID                     *int
	DecidedAt                              *time.Time
	DispatchLocationID                     *int
	DispatchedAt                           *time.Time
	Items                                  []Item
	ReceiptLocationID                      *int
	ReceivedAt                             *time.Time
	Receipt                                *Receipt
	CancellationLocationID                 *int
	CancelledAt                            *time.Time
}
type CreateResult struct {
	Request  Request
	Replayed bool
}

var retryKeyPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)

func assigned(actor auth.Identity) bool {
	return actor.AccountID == actor.Location.ID && actor.AccountID >= 1 && actor.AccountID <= 3
}

// Validate derives direction only from the trusted authenticated identity. It
// rejects duplicate variants before sorting a copy, never modifies the cart,
// and never adds quantities across lines (their sum could overflow int64).
func Validate(actor auth.Identity, input CreateInput) (Intent, error) {
	if !assigned(actor) || actor.AccountID == 1 {
		return Intent{}, ErrForbidden
	}
	if !retryKeyPattern.MatchString(input.RetryKey) || len(input.Items) == 0 || len(input.Items) > 190 {
		return Intent{}, ErrInvalid
	}
	n := Intent{CreatorID: actor.AccountID, Kind: input.Kind, RetryKey: input.RetryKey}
	switch input.Kind {
	case RequestStock:
		if input.CounterpartyID < 1 || input.CounterpartyID > 3 || input.CounterpartyID == n.CreatorID {
			return Intent{}, ErrInvalid
		}
		n.OriginID = input.CounterpartyID
		n.DestinationID = n.CreatorID
		n.ApproverID = n.OriginID
	case SendToWarehouse:
		if input.CounterpartyID != 1 {
			return Intent{}, ErrInvalid
		}
		n.OriginID = n.CreatorID
		n.DestinationID = 1
		n.ApproverID = 1
	default:
		return Intent{}, ErrInvalid
	}
	seen := make(map[int64]bool, len(input.Items))
	for _, line := range input.Items {
		if line.VariantID < 1 || line.VariantID > math.MaxInt32 || line.Quantity < 1 || seen[line.VariantID] {
			return Intent{}, ErrInvalid
		}
		seen[line.VariantID] = true
	}
	n.Items = append([]Line(nil), input.Items...)
	sort.Slice(n.Items, func(i, j int) bool { return n.Items[i].VariantID < n.Items[j].VariantID })
	h := sha256.New()
	_, _ = h.Write([]byte("luson.pending/v1\x00" + string(n.Kind) + "\x00"))
	for _, value := range []int64{int64(n.CreatorID), int64(input.CounterpartyID), int64(len(n.Items))} {
		_ = binary.Write(h, binary.BigEndian, value)
	}
	for _, line := range n.Items {
		_ = binary.Write(h, binary.BigEndian, line.VariantID)
		_ = binary.Write(h, binary.BigEndian, line.Quantity)
	}
	copy(n.Fingerprint[:], h.Sum(nil))
	return n, nil
}
