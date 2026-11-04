// Package stockadjustments persists immutable warehouse stock adjustments by
// physical count: a document records what was counted, the database keeps the
// expected snapshot it had at apply time and applies the difference atomically.
// Only the warehouse (account 1, location 1) adjusts, and a persisted document is
// corrected only by a single counter-entry.
package stockadjustments

import (
	"errors"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"luson/api/internal/auth"
	"luson/api/internal/catalog"
)

var (
	ErrInvalid           = errors.New("invalid stock adjustment")
	ErrForbidden         = errors.New("stock adjustment forbidden")
	ErrNotFound          = errors.New("stock adjustment not found")
	ErrDecisionConflict  = errors.New("stock adjustment decision conflict")
	ErrRetryConflict     = errors.New("stock adjustment retry conflict")
	ErrInsufficientStock = errors.New("insufficient stock adjustment")
	ErrUnavailable       = errors.New("stock adjustment store unavailable")
)

const (
	// Only the warehouse account (id 1) assigned to location 1 registers an
	// adjustment, exactly like the stock ingress.
	warehouseAccountID  = 1
	warehouseLocationID = 1
	maxLines            = 190
	maxCounted          = 1_000_000
	maxReason           = 500
	maxDetail           = 500
	maxSearch           = 128
)

const (
	// MaxPage and the admitted page sizes are the frozen read contract.
	MaxPage         = 1_000_000
	DefaultPageSize = 25
)

// Line is one counted variant. The client never supplies the expected quantity
// nor a difference: the database derives both under the balance row lock.
type Line struct {
	VariantID int64 `json:"variant_id"`
	Counted   int64 `json:"counted_quantity"`
}

type CreateInput struct {
	OperationKey string
	Reason       string
	Detail       string
	Lines        []Line
}

// AdjustmentLine is one persisted line of a document: the expected snapshot the
// database took, the counted quantity the warehouse declared, and the applied
// difference. A counter-entry has counted and expected swapped.
type AdjustmentLine struct {
	VariantID  int64 `json:"variant_id"`
	Expected   int64 `json:"expected_quantity"`
	Counted    int64 `json:"counted_quantity"`
	Difference int64 `json:"difference"`
}

// Adjustment is the persisted document exactly as the frozen HTTP contract
// exposes it. Lines are always ordered by variant id.
type Adjustment struct {
	ID                 int64            `json:"id"`
	LocationID         int              `json:"location_id"`
	Reason             string           `json:"reason"`
	Detail             string           `json:"detail"`
	CreatedByAccountID int64            `json:"created_by_account_id"`
	CreatedAt          time.Time        `json:"created_at"`
	Lines              []AdjustmentLine `json:"lines"`
	TotalDifference    int64            `json:"total_difference"`
	// ReversesAdjustmentID is the document this one counters, or nil for an
	// original adjustment.
	ReversesAdjustmentID *int64 `json:"reverses_adjustment_id"`
}

// DetailLine is one persisted line together with the catalogue identity of its
// variant. The difference is the applied counted minus expected, so a historical
// document keeps its own arithmetic even after the current stock has changed.
type DetailLine struct {
	VariantID      int64           `json:"variant_id"`
	CatalogEntryID int64           `json:"catalog_entry_id"`
	Brand          string          `json:"brand"`
	Model          string          `json:"model"`
	Capacity       catalog.Decimal `json:"capacity_ah"`
	Polarity       string          `json:"polarity"`
	Expected       int64           `json:"expected_quantity"`
	Counted        int64           `json:"counted_quantity"`
	Difference     int64           `json:"difference"`
}

// Detail is one persisted document with its catalogue-resolved lines and its
// reversal cross-references. ReversesAdjustmentID is the original document when
// this one is a counter-entry, and ReversedBy is the counter-entry that reverses
// this document, if any.
type Detail struct {
	ID                   int64
	LocationID           int
	Reason               string
	Detail               string
	CreatedAt            time.Time
	CreatedByAccountID   int64
	ReversesAdjustmentID *int64
	ReversedBy           *int64
	Lines                []DetailLine
	TotalDifference      int64
}

// Summary is one row of the read-only adjustment history. The per-line detail
// stays out of this projection; only the line count and the exact difference are
// exposed.
type Summary struct {
	ID                   int64
	Reason               string
	Detail               string
	CreatedAt            time.Time
	Lines                int
	TotalDifference      int64
	ReversesAdjustmentID *int64
	ReversedBy           *int64
}

// Page is one newest-first page of persisted documents plus the total.
type Page struct {
	Page             int
	PageSize         int
	TotalAdjustments int64
	Adjustments      []Summary
}

// CatalogQuery is the blind capture query: searching the catalogue never carries
// a stock quantity, only the catalogue identity of a variant.
type CatalogQuery struct {
	Search   string
	Brand    string
	Polarity string
	Page     int
	PageSize int
}

// CatalogItem is the catalogue identity of one variant of this warehouse. It
// deliberately has no stock field: the capture screen cannot reveal the expected
// quantity, the difference or any other stock number.
type CatalogItem struct {
	VariantID      int64           `json:"variant_id"`
	CatalogEntryID int64           `json:"catalog_entry_id"`
	Brand          string          `json:"brand"`
	Model          string          `json:"model"`
	Capacity       catalog.Decimal `json:"capacity_ah"`
	Polarity       string          `json:"polarity"`
}

// CatalogPage is one admitted page of the capture catalogue plus the total.
type CatalogPage struct {
	Page          int
	PageSize      int
	TotalVariants int64
	Items         []CatalogItem
}

var operationKeyPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)

// ValidOperationKey is the database regex, checked before any database work.
func ValidOperationKey(key string) bool { return operationKeyPattern.MatchString(key) }

// warehouseAdmin admits only the completed warehouse administrator identity.
func warehouseAdmin(actor auth.Identity) bool {
	return actor.AccountID == warehouseAccountID && actor.Location.ID == warehouseLocationID && !actor.MustChangePassword
}

// ValidPage admits only the page and page size of the frozen read contract, so
// every other value is refused before the database is touched.
func ValidPage(page, pageSize int) bool {
	return page >= 1 && page <= MaxPage && (pageSize == 10 || pageSize == DefaultPageSize || pageSize == 50)
}

// CanonicalReason admits the mandatory motive and returns the exact text that is
// persisted and compared on a replay: valid UTF-8, no NUL, at most 500
// characters, and never blank once trimmed.
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

// validDetail matches the database bound in characters. The optional detail is
// persisted verbatim, so it is compared verbatim on a replay.
func validDetail(detail string) bool {
	return utf8.ValidString(detail) && !strings.ContainsRune(detail, 0) && utf8.RuneCountInString(detail) <= maxDetail
}

// Validate returns the canonical payload used to persist and to detect a
// conflicting replay. Lines are copied and sorted by variant id, which is also the
// database's balance-row lock order; the caller's slice is never modified.
func Validate(input CreateInput) (CreateInput, error) {
	if !ValidOperationKey(input.OperationKey) || !validDetail(input.Detail) {
		return CreateInput{}, ErrInvalid
	}
	reason, ok := CanonicalReason(input.Reason)
	if !ok {
		return CreateInput{}, ErrInvalid
	}
	if len(input.Lines) < 1 || len(input.Lines) > maxLines {
		return CreateInput{}, ErrInvalid
	}
	seen := make(map[int64]bool, len(input.Lines))
	lines := make([]Line, 0, len(input.Lines))
	for _, line := range input.Lines {
		// A count of zero is a legitimate result of a physical count; a negative
		// one, a count beyond the admitted bound and a repeated variant are not.
		if line.VariantID < 1 || line.VariantID > math.MaxInt32 || line.Counted < 0 ||
			line.Counted > maxCounted || seen[line.VariantID] {
			return CreateInput{}, ErrInvalid
		}
		seen[line.VariantID] = true
		lines = append(lines, line)
	}
	sort.Slice(lines, func(i, j int) bool { return lines[i].VariantID < lines[j].VariantID })
	return CreateInput{OperationKey: input.OperationKey, Reason: reason, Detail: input.Detail, Lines: lines}, nil
}

// sameLines compares two variant-ordered line sets, never counts across unrelated
// variants.
func sameLines(a []AdjustmentLine, b []Line) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].VariantID != b[i].VariantID || a[i].Counted != b[i].Counted {
			return false
		}
	}
	return true
}
