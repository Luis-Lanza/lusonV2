// Package pricing owns the branch price list: the minimum and suggested sale
// price the warehouse administers for one variant in one branch, and the warranty
// term of the variant itself. Money is a canonical decimal string with exactly two
// decimals and is never a binary float, so no rounding is invented between the
// database and the client. Only the warehouse administrator writes prices and only
// active branches keep them; a retired pair is replaced, never deleted.
package pricing

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
	ErrInvalid     = errors.New("invalid branch price")
	ErrForbidden   = errors.New("branch price forbidden")
	ErrUnavailable = errors.New("branch price store unavailable")
)

// RetiredBranch is the rejection of a write that names a branch that was retired.
// The offending branch id is part of the error, so the client can point at the exact
// row it must drop instead of guessing which id was refused. It is an invalid
// request, so every caller that already understands ErrInvalid keeps working.
type RetiredBranch struct{ BranchID int64 }

func (e *RetiredBranch) Error() string {
	return "retired branch " + moneyDigits(e.BranchID)
}

// Unwrap keeps errors.Is(err, ErrInvalid) true for a retired branch.
func (e *RetiredBranch) Unwrap() error { return ErrInvalid }

const (
	// Only the warehouse account (id 1) assigned to location 1 administers prices,
	// exactly like stock ingress and adjustments.
	warehouseAccountID  = 1
	warehouseLocationID = 1
	// The warehouse never keeps a sale price: branches start at id 2.
	firstBranchID = 2
	// MaxBranches, MinWarrantyMonths, MaxWarrantyMonths, MaxPage and
	// DefaultPageSize are the frozen bounds of this contract.
	MaxBranches         = 50
	MinWarrantyMonths   = 1
	MaxWarrantyMonths   = 120
	MaxPage             = 1_000_000
	DefaultPageSize     = 10
	maxBranchLocationID = math.MaxInt16
	maxSearch           = 128
)

// Money is a canonical amount with exactly two decimals, e.g. "85000.00". It is a
// decimal string end to end: the database column is numeric(12,2) and no binary
// float ever touches a price.
type Money string

// moneyPattern admits at most ten integral digits, which is the whole range of
// numeric(12,2), and at most two decimals so an over-precision amount never
// reaches the database.
var moneyPattern = regexp.MustCompile(`^(0|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$`)

// ParseMoney admits a positive amount and returns its canonical two-decimal form.
// A negative, zero, signed, padded, fractional-beyond-two or non-numeric amount is
// rejected: the exact decimal text is the contract, not an approximation of it.
func ParseMoney(text string) (Money, error) {
	if !moneyPattern.MatchString(text) {
		return "", ErrInvalid
	}
	whole, fraction, _ := strings.Cut(text, ".")
	if fraction == "" {
		fraction = "00"
	}
	for len(fraction) < 2 {
		fraction += "0"
	}
	// Neither a minimum nor a suggested price can be zero: a sale price is a
	// positive amount, and the database check says the same.
	if whole == "0" && fraction == "00" {
		return "", ErrInvalid
	}
	return Money(whole + "." + fraction), nil
}

// String renders the canonical amount. A value that is not already canonical
// two-decimal text renders as the empty string, which no record validator admits.
func (m Money) String() string {
	canonical, err := ParseMoney(string(m))
	if err != nil || canonical != m {
		return ""
	}
	return string(canonical)
}

// AtLeast reports whether m is greater than or equal to other. Both sides are
// canonical two-decimal text, so a longer integral part is always the larger
// amount and no number is parsed.
func (m Money) AtLeast(other Money) bool {
	if len(m) != len(other) {
		return len(m) > len(other)
	}
	return m >= other
}

// moneyDigits renders a non-negative integer without a float.
func moneyDigits(value int64) string {
	if value == 0 {
		return "0"
	}
	var digits [20]byte
	index := len(digits)
	for value > 0 {
		index--
		digits[index] = byte('0' + value%10)
		value /= 10
	}
	return string(digits[index:])
}

// Branch is one active branch of the price matrix.
type Branch struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

// Price is the persisted pair of one (branch, variant) with the account that wrote
// it last. Amounts are canonical two-decimal text.
type Price struct {
	BranchLocationID     int64     `json:"branch_location_id"`
	MinPrice             Money     `json:"min_price"`
	SuggestedPrice       Money     `json:"suggested_price"`
	UpdatedAt            time.Time `json:"updated_at"`
	UpdatedByAccountID   int64     `json:"updated_by_account_id"`
	UpdatedByDisplayName string    `json:"updated_by_display_name"`
}

// VariantPrice is one row of the matrix: the catalogue identity of a variant, its
// warranty term when it has one, and the prices of the active branches. Warranty is
// a product datum, so a variant without a term reports nil and the client shows no
// term at all instead of inventing a default.
type VariantPrice struct {
	VariantID      int64
	CatalogEntryID int64
	Brand          string
	Model          string
	Capacity       catalog.Decimal
	Polarity       string
	Cells          []string
	WarrantyMonths *int
	WarrantyAt     *time.Time
	Prices         []Price
}

// Matrix is one page of the price list together with the active branches it is read
// against.
type Matrix struct {
	Branches      []Branch
	Variants      []VariantPrice
	Page          int
	PageSize      int
	TotalVariants int64
}

// BranchQuery is the frozen read filter. Capacity is a canonical catalogue decimal
// and an empty value means no capacity filter.
type BranchQuery struct {
	Search   string
	Brand    string
	Capacity catalog.Decimal
	Polarity string
	Page     int
	PageSize int
}

// WriteInput is one price assignment: the pair of amounts, an optional warranty term
// and the branches that receive the pair. A nil warranty leaves the stored term
// untouched; a present one is written with the same transaction.
type WriteInput struct {
	VariantID      int64
	MinPrice       Money
	SuggestedPrice Money
	WarrantyMonths *int
	BranchIDs      []int64
}

// WriteResult is the applied assignment: the canonical pair, the branches that
// received it in ascending order and the warranty term in force afterwards.
type WriteResult struct {
	VariantID      int64
	BranchIDs      []int64
	MinPrice       Money
	SuggestedPrice Money
	WarrantyMonths *int
}

// warehouseAdmin admits only the completed warehouse administrator identity.
func warehouseAdmin(actor auth.Identity) bool {
	return actor.AccountID == warehouseAccountID && actor.Location.ID == warehouseLocationID && !actor.MustChangePassword
}

// The admitted page sizes of the frozen read contract.
const (
	pageSizeSmall  = 10
	pageSizeMedium = 25
	pageSizeLarge  = 50
)

// ValidPage admits only the page and page size of the frozen read contract, so
// every other value is refused before the database is touched.
func ValidPage(page, pageSize int) bool {
	return page >= 1 && page <= MaxPage &&
		(pageSize == pageSizeSmall || pageSize == pageSizeMedium || pageSize == pageSizeLarge)
}

// validText keeps an optional filter inside the database's own text bounds.
func validText(text string) bool {
	return utf8.ValidString(text) && !strings.ContainsRune(text, 0) && utf8.RuneCountInString(text) <= maxSearch
}

// ValidQuery admits the read filter. The capacity is a catalogue decimal, so a
// value the catalogue cannot hold never becomes a SQL parameter.
func ValidQuery(q BranchQuery) bool {
	if !ValidPage(q.Page, q.PageSize) || !validText(q.Search) || !validText(q.Brand) {
		return false
	}
	if q.Polarity != "" && q.Polarity != "L" && q.Polarity != "R" {
		return false
	}
	if q.Capacity != "" {
		if _, err := catalog.ParseDecimal(string(q.Capacity)); err != nil {
			return false
		}
	}
	return true
}

// ValidateWrite returns the canonical assignment used to persist and to answer.
// The amounts are canonicalized, the branches are copied and sorted ascending
// (which is also the database's lock order) and the caller's slice is never
// modified.
func ValidateWrite(input WriteInput) (WriteInput, error) {
	if input.VariantID < 1 || input.VariantID > math.MaxInt32 {
		return WriteInput{}, ErrInvalid
	}
	min, err := ParseMoney(string(input.MinPrice))
	if err != nil {
		return WriteInput{}, ErrInvalid
	}
	suggested, err := ParseMoney(string(input.SuggestedPrice))
	if err != nil {
		// An amount below the minimum, including a zero or negative one expressed as
		// such, is the same refusal: the pair must be a sellable range.
		return WriteInput{}, ErrInvalid
	}
	// The suggested price is never below the minimum: the minimum is the floor the
	// point of sale is blocked under.
	if !suggested.AtLeast(min) {
		return WriteInput{}, ErrInvalid
	}
	warranty := input.WarrantyMonths
	if warranty != nil && (*warranty < MinWarrantyMonths || *warranty > MaxWarrantyMonths) {
		return WriteInput{}, ErrInvalid
	}
	if len(input.BranchIDs) < 1 || len(input.BranchIDs) > MaxBranches {
		return WriteInput{}, ErrInvalid
	}
	seen := make(map[int64]bool, len(input.BranchIDs))
	branches := make([]int64, 0, len(input.BranchIDs))
	for _, id := range input.BranchIDs {
		// The warehouse never keeps sale prices, so id 1 is not a branch here; a
		// repeated id and an id outside smallint are refused as well.
		if id < firstBranchID || id > maxBranchLocationID || seen[id] {
			return WriteInput{}, ErrInvalid
		}
		seen[id] = true
		branches = append(branches, id)
	}
	sort.Slice(branches, func(i, j int) bool { return branches[i] < branches[j] })
	return WriteInput{
		VariantID:      input.VariantID,
		MinPrice:       min,
		SuggestedPrice: suggested,
		WarrantyMonths: warranty,
		BranchIDs:      branches,
	}, nil
}
