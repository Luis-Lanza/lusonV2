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
	ErrNotFound          = errors.New("stock entry not found")
	ErrDecisionConflict  = errors.New("stock entry decision conflict")
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
	maxReason           = 500
)

const (
	// MaxPage and the admitted page sizes are the frozen read contract.
	MaxPage         = 1_000_000
	DefaultPageSize = 25
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
	// ReversesEntryID is the document this one counters, or nil for an ingress
	// document. It is never part of the wire shape: it only tells the boundary
	// which sign rule the derived lines must obey.
	ReversesEntryID *int64 `json:"-"`
}

// EntrySummary is one row of the read-only ingress history. The per-line detail
// stays out of this projection; only the line count and the exact unit total are
// exposed.
type EntrySummary struct {
	ID         int64
	Note       string
	CreatedAt  time.Time
	Lines      int
	TotalUnits int64
	// ReversedBy is the counter-entry that reverses this document, or nil.
	ReversedBy *int64
}

// EntryPage is one newest-first page of persisted documents plus the total.
type EntryPage struct {
	Page         int
	PageSize     int
	TotalEntries int64
	Entries      []EntrySummary
}

// ValidPage admits only the page and page size of the frozen read contract, so
// every other value is refused before the database is touched.
func ValidPage(page, pageSize int) bool {
	return page >= 1 && page <= MaxPage && (pageSize == 10 || pageSize == DefaultPageSize || pageSize == 50)
}

var operationKeyPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)

// warehouseAdmin admits only the completed warehouse administrator identity.
func warehouseAdmin(actor auth.Identity) bool {
	return actor.AccountID == warehouseAccountID && actor.Location.ID == warehouseLocationID && !actor.MustChangePassword
}

// ValidOperationKey is the database regex, checked before any database work.
func ValidOperationKey(key string) bool { return operationKeyPattern.MatchString(key) }

// CanonicalReason admits the mandatory counter-entry reason and returns the exact
// text that is persisted and compared on a replay: valid UTF-8, no NUL, at most
// 500 characters, and never blank once trimmed.
func CanonicalReason(reason string) (string, bool) {
	if !utf8.ValidString(reason) || strings.ContainsRune(reason, 0) || utf8.RuneCountInString(reason) > maxReason {
		return "", false
	}
	trimmed := strings.TrimSpace(reason)
	if trimmed == "" {
		return "", false
	}
	return trimmed, true
}

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
