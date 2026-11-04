// Package stockentries persists immutable warehouse stock ingress documents.
package stockentries

import (
	"errors"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"luson/api/internal/auth"
)

var (
	ErrInvalid           = errors.New("invalid stock entry")
	ErrForbidden         = errors.New("stock entry forbidden")
	ErrRetryConflict     = errors.New("stock entry retry conflict")
	ErrInsufficientStock = errors.New("insufficient stock entry")
	ErrUnavailable       = errors.New("stock entry store unavailable")
)

const (
	// Only the warehouse account (id 1) assigned to location 1 registers ingress.
	warehouseAccountID  = 1
	warehouseLocationID = 1
	maxLines            = 190
	maxQuantity         = 1_000_000
	maxNote             = 500
)

type Line struct {
	VariantID int64 `json:"variant_id"`
	Quantity  int64 `json:"quantity"`
}

type CreateInput struct {
	OperationKey string
	Note         string
	Lines        []Line
}

type EntryLine struct {
	VariantID int64 `json:"variant_id"`
	Quantity  int64 `json:"quantity"`
}

// Entry is the persisted document exactly as the frozen HTTP contract exposes
// it. Lines are always ordered by variant id.
type Entry struct {
	ID                 int64       `json:"id"`
	LocationID         int         `json:"location_id"`
	Note               string      `json:"note"`
	CreatedByAccountID int64       `json:"created_by_account_id"`
	CreatedAt          time.Time   `json:"created_at"`
	Lines              []EntryLine `json:"lines"`
	TotalUnits         int64       `json:"total_units"`
}

var operationKeyPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)

// warehouseAdmin admits only the completed warehouse administrator identity.
func warehouseAdmin(actor auth.Identity) bool {
	return actor.AccountID == warehouseAccountID && actor.Location.ID == warehouseLocationID && !actor.MustChangePassword
}

// ValidOperationKey is the database regex, checked before any database work.
func ValidOperationKey(key string) bool { return operationKeyPattern.MatchString(key) }

// validNote matches the database bound in characters and refuses bytes that a
// JSON or SQL text column cannot represent faithfully.
func validNote(note string) bool {
	return utf8.ValidString(note) && !strings.ContainsRune(note, 0) && utf8.RuneCountInString(note) <= maxNote
}

// Validate returns the canonical payload used to persist and to detect a
// conflicting replay. Lines are copied and sorted by variant id; the caller's
// slice is never modified. Quantities are never summed blindly: an int64
// overflow is a rejection, not a wrapped total.
func Validate(input CreateInput) (CreateInput, error) {
	if !ValidOperationKey(input.OperationKey) || !validNote(input.Note) {
		return CreateInput{}, ErrInvalid
	}
	if len(input.Lines) < 1 || len(input.Lines) > maxLines {
		return CreateInput{}, ErrInvalid
	}
	seen := make(map[int64]bool, len(input.Lines))
	lines := make([]Line, 0, len(input.Lines))
	var total int64
	for _, line := range input.Lines {
		if line.VariantID < 1 || line.VariantID > math.MaxInt32 || line.Quantity < 1 ||
			line.Quantity > maxQuantity || seen[line.VariantID] {
			return CreateInput{}, ErrInvalid
		}
		if line.Quantity > math.MaxInt64-total {
			return CreateInput{}, ErrInvalid
		}
		seen[line.VariantID] = true
		total += line.Quantity
		lines = append(lines, line)
	}
	sort.Slice(lines, func(i, j int) bool { return lines[i].VariantID < lines[j].VariantID })
	return CreateInput{OperationKey: input.OperationKey, Note: input.Note, Lines: lines}, nil
}

// sameLines compares two variant-ordered line sets, never quantities across
// unrelated variants.
func sameLines(a []EntryLine, b []Line) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].VariantID != b[i].VariantID || a[i].Quantity != b[i].Quantity {
			return false
		}
	}
	return true
}
