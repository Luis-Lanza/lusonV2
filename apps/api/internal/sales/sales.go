// Package sales owns the branch point of sale: an immutable sale document with one
// or more lines that decrements the stock of the branch that sold it. Only a branch
// sells, and only the branch's own provisioned account registers a sale there; the
// warehouse (location 1) is refused. The database owns the price rules: the charged
// price is no lower than the branch's stored minimum, the frozen minimum comes from
// branch_prices, and a variant without a price in the branch is not sellable. The
// warranty term is not a product datum: the seller states it at the counter, it is
// required on every line and it is frozen there, so a sale always congeals the term
// that was actually promised.
//
// Money is a canonical decimal string with exactly two decimals and is never a
// binary float, so no rounding is invented between the database and the client. The
// subtotal of a line and the total of the document are computed here in integer
// cents, and the database derives them again and refuses a document that does not
// add up.
package sales

import (
	"errors"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"luson/api/internal/auth"
	"luson/api/internal/catalog"
	"luson/api/internal/pricing"
)

var (
	ErrInvalid           = errors.New("invalid sale")
	ErrForbidden         = errors.New("sale forbidden")
	ErrNotFound          = errors.New("sale not found")
	ErrNotSellable       = errors.New("variant not sellable")
	ErrBelowMinimum      = errors.New("sale price below the branch minimum")
	ErrInsufficientStock = errors.New("insufficient stock for the sale")
	ErrUnavailable       = errors.New("sale store unavailable")
)

// NotSellable is the refusal of a line whose variant the branch cannot sell: no
// price in that branch, or no warranty term to congeal. The variant is named, so the
// point of sale can point at the exact row it must block instead of guessing.
type NotSellable struct{ VariantID int64 }

func (e *NotSellable) Error() string {
	return "variant " + digits(e.VariantID) + " is not sellable in this branch"
}

// Unwrap keeps errors.Is(err, ErrNotSellable) true.
func (e *NotSellable) Unwrap() error { return ErrNotSellable }

// BelowMinimum is the refusal of a line that charges less than the branch's stored
// minimum for that variant. The variant is named, so the counter can show which line
// hit the floor.
type BelowMinimum struct{ VariantID int64 }

func (e *BelowMinimum) Error() string {
	return "variant " + digits(e.VariantID) + " is priced below the minimum of this branch"
}

// Unwrap keeps errors.Is(err, ErrBelowMinimum) true.
func (e *BelowMinimum) Unwrap() error { return ErrBelowMinimum }

// InsufficientStock is the refusal of a line the branch cannot cover: existing stock
// would fall below zero, or below what the branch already reserved.
type InsufficientStock struct{ VariantID int64 }

func (e *InsufficientStock) Error() string {
	return "variant " + digits(e.VariantID) + " is not covered by the stock of this branch"
}

// Unwrap keeps errors.Is(err, ErrInsufficientStock) true.
func (e *InsufficientStock) Unwrap() error { return ErrInsufficientStock }

const (
	// The warehouse (location 1) never sells: branches start at id 2.
	warehouseLocationID = 1
	// MaxLines, MaxQuantity, MaxCustomerName, MaxCustomerPhone,
	// MaxCustomerDocument, MaxPage and DefaultPageSize are the frozen bounds of this
	// contract, and the database checks say the same.
	MaxLines            = 190
	MaxQuantity         = 1_000_000
	MaxCustomerName     = 120
	MaxCustomerPhone    = 40
	MaxCustomerDocument = 40
	MaxPage             = 1_000_000
	DefaultPageSize     = 25
	// MinWarrantyMonths and MaxWarrantyMonths are the bounds of the term the seller
	// states for a line, which the sale then freezes.
	MinWarrantyMonths   = 1
	MaxWarrantyMonths   = 120
	maxBranchLocationID = math.MaxInt16
	maxSearch           = 128
	// maxCents is the whole range of numeric(12,2) expressed in cents.
	maxCents = int64(999_999_999_999)
)

// Money is the price list's canonical amount: a decimal string with exactly two
// decimals, e.g. "85000.00". It is reused, not redefined, so both domains share one
// money contract and no binary float ever touches an amount.
type Money = pricing.Money

// PaymentMethod is the admitted way a sale was paid.
type PaymentMethod string

const (
	PaymentCash     PaymentMethod = "cash"
	PaymentCard     PaymentMethod = "card"
	PaymentTransfer PaymentMethod = "transfer"
)

// Valid reports whether the method is one of the frozen three.
func (p PaymentMethod) Valid() bool {
	return p == PaymentCash || p == PaymentCard || p == PaymentTransfer
}

// PaymentMethods lists the admitted methods in their frozen order.
func PaymentMethods() []PaymentMethod {
	return []PaymentMethod{PaymentCash, PaymentCard, PaymentTransfer}
}

// Customer is the client the warranty is issued to. The name is mandatory; the phone
// and the document are optional and bounded.
type Customer struct {
	Name     string `json:"name"`
	Phone    string `json:"phone"`
	Document string `json:"document"`
}

// CanonicalCustomer trims the mandatory name and refuses a value outside the
// database's own bounds.
func CanonicalCustomer(customer Customer) (Customer, bool) {
	name := strings.TrimSpace(customer.Name)
	if !boundedText(name, 1, MaxCustomerName) ||
		!boundedText(customer.Phone, 0, MaxCustomerPhone) ||
		!boundedText(customer.Document, 0, MaxCustomerDocument) {
		return Customer{}, false
	}
	return Customer{Name: name, Phone: customer.Phone, Document: customer.Document}, true
}

// LineInput is one line the client asks to sell. The client supplies the variant, the
// quantity, the price it wants to charge and the warranty term it offers: the floor and
// the frozen minimum are the database's, never the caller's.
type LineInput struct {
	VariantID      int64
	Quantity       int64
	UnitPrice      Money
	WarrantyMonths int
}

// CreateInput is one sale to register in the actor's own branch.
type CreateInput struct {
	PaymentMethod PaymentMethod
	Customer      Customer
	Lines         []LineInput
}

// Line is one canonical line: the charged price, the seller's warranty term and the
// exact subtotal of that line. MinPrice is deliberately absent: the database freezes it
// and the store reports what it persisted.
type Line struct {
	VariantID      int64
	Quantity       int64
	UnitPrice      Money
	WarrantyMonths int
	Subtotal       Money
}

// Payload is the canonical document used to persist and to answer: the admitted
// method, the canonical customer, the lines in ascending variant order (also the
// database's lock order) and the exact total.
type Payload struct {
	PaymentMethod PaymentMethod
	Customer      Customer
	Lines         []Line
	Total         Money
}

// SaleLine is one persisted line: the price that was charged, the minimum frozen at
// write time, the warranty term the seller stated and the derived subtotal.
type SaleLine struct {
	VariantID      int64
	Quantity       int64
	UnitPrice      Money
	MinPrice       Money
	WarrantyMonths int
	Subtotal       Money
}

// Sale is one persisted sale document. Both the branch correlative and the warranty
// number are the database's own allocation.
type Sale struct {
	ID                 int64
	BranchLocationID   int64
	BranchSequence     int64
	WarrantyNumber     string
	PaymentMethod      PaymentMethod
	Customer           Customer
	Total              Money
	CreatedByAccountID int64
	CreatedAt          time.Time
	Lines              []SaleLine
}

// DetailLine is one persisted line together with the catalogue identity of its
// variant, so the document stays legible with the prices of the sale.
type DetailLine struct {
	SaleLine
	CatalogEntryID int64
	Brand          string
	Model          string
	Capacity       catalog.Decimal
	Polarity       string
}

// Detail is one persisted sale with its catalogue-resolved lines.
type Detail struct {
	ID                 int64
	BranchLocationID   int64
	BranchSequence     int64
	WarrantyNumber     string
	PaymentMethod      PaymentMethod
	Customer           Customer
	Total              Money
	CreatedByAccountID int64
	CreatedAt          time.Time
	Lines              []DetailLine
}

// Summary is one row of the read-only sales history of a branch.
type Summary struct {
	ID             int64
	BranchSequence int64
	WarrantyNumber string
	PaymentMethod  PaymentMethod
	CustomerName   string
	Total          Money
	CreatedAt      time.Time
	Lines          int
}

// ListQuery is the frozen history filter: a literal search over the warranty number
// and the customer name, an optional payment method and one page.
type ListQuery struct {
	Search        string
	PaymentMethod string
	Page          int
	PageSize      int
}

// Page is one newest-first page of the branch history plus the total.
type Page struct {
	Page       int
	PageSize   int
	TotalSales int64
	Sales      []Summary
}

// SellableQuery is the frozen filter of the point-of-sale catalogue.
type SellableQuery struct {
	Search   string
	Brand    string
	Capacity catalog.Decimal
	Polarity string
	Page     int
	PageSize int
}

// SellableItem is one variant the branch can sell right now: the catalogue identity,
// the suggested price the counter starts from and the minimum it can never go under.
// The warranty term is not part of the catalogue: the seller states it on the sale.
type SellableItem struct {
	VariantID      int64
	CatalogEntryID int64
	Brand          string
	Model          string
	Capacity       catalog.Decimal
	Polarity       string
	SuggestedPrice Money
	MinPrice       Money
}

// SellablePage is one admitted page of the sellable catalogue plus the total.
type SellablePage struct {
	Page          int
	PageSize      int
	TotalVariants int64
	Items         []SellableItem
}

// digits renders a non-negative integer without a float.
func digits(value int64) string {
	if value < 0 {
		return "0"
	}
	return strconv.FormatInt(value, 10)
}

// boundedText keeps a text inside the database's own character bounds.
func boundedText(text string, minimum, maximum int) bool {
	if !utf8.ValidString(text) || strings.ContainsRune(text, 0) {
		return false
	}
	length := utf8.RuneCountInString(text)
	return length >= minimum && length <= maximum
}

// centsOf reads a canonical amount as integer cents. A value that is not canonical
// two-decimal text is refused, so nothing is approximated.
func centsOf(amount Money) (int64, bool) {
	text := amount.String()
	if text == "" {
		return 0, false
	}
	whole, fraction, ok := strings.Cut(text, ".")
	if !ok || len(fraction) != 2 {
		return 0, false
	}
	var value int64
	for _, ch := range whole {
		if ch < '0' || ch > '9' {
			return 0, false
		}
		value = value*10 + int64(ch-'0')
	}
	for _, ch := range fraction {
		if ch < '0' || ch > '9' {
			return 0, false
		}
		value = value*10 + int64(ch-'0')
	}
	return value, true
}

// moneyFromCents renders integer cents as the canonical amount, refusing anything
// outside numeric(12,2).
func moneyFromCents(cents int64) (Money, error) {
	if cents < 1 || cents > maxCents {
		return "", ErrInvalid
	}
	fraction := cents % 100
	text := strconv.FormatInt(cents/100, 10) + "." + string([]byte{byte('0' + fraction/10), byte('0' + fraction%10)})
	amount, err := pricing.ParseMoney(text)
	if err != nil || string(amount) != text {
		return "", ErrInvalid
	}
	return amount, nil
}

// LineTotal is the exact subtotal of one line: the canonical amount times a whole
// quantity, multiplied in integer cents so no binary float ever touches money.
func LineTotal(unit Money, quantity int64) (Money, error) {
	if quantity < 1 || quantity > MaxQuantity {
		return "", ErrInvalid
	}
	cents, ok := centsOf(unit)
	if !ok || cents > maxCents/quantity {
		return "", ErrInvalid
	}
	return moneyFromCents(cents * quantity)
}

// Validate returns the canonical document used to persist and to answer. Lines are
// copied and sorted ascending by variant, which is also the database's balance-row
// lock order, and the caller's slice is never modified. An unknown variant, a
// duplicate variant, an impossible quantity and an amount that is not canonical
// two-decimal text are refused here, before any database work.
func Validate(input CreateInput) (Payload, error) {
	if !input.PaymentMethod.Valid() {
		return Payload{}, ErrInvalid
	}
	customer, admitted := CanonicalCustomer(input.Customer)
	if !admitted {
		return Payload{}, ErrInvalid
	}
	if len(input.Lines) < 1 || len(input.Lines) > MaxLines {
		return Payload{}, ErrInvalid
	}
	seen := make(map[int64]bool, len(input.Lines))
	lines := make([]Line, 0, len(input.Lines))
	for _, line := range input.Lines {
		if line.VariantID < 1 || line.VariantID > math.MaxInt32 || seen[line.VariantID] {
			return Payload{}, ErrInvalid
		}
		seen[line.VariantID] = true
		unit, err := pricing.ParseMoney(string(line.UnitPrice))
		if err != nil {
			return Payload{}, ErrInvalid
		}
		if line.WarrantyMonths < MinWarrantyMonths || line.WarrantyMonths > MaxWarrantyMonths {
			return Payload{}, ErrInvalid
		}
		subtotal, err := LineTotal(unit, line.Quantity)
		if err != nil {
			return Payload{}, err
		}
		lines = append(lines, Line{VariantID: line.VariantID, Quantity: line.Quantity,
			UnitPrice: unit, WarrantyMonths: line.WarrantyMonths, Subtotal: subtotal})
	}
	sort.Slice(lines, func(i, j int) bool { return lines[i].VariantID < lines[j].VariantID })
	var cents int64
	for _, line := range lines {
		part, ok := centsOf(line.Subtotal)
		if !ok || cents > maxCents-part {
			return Payload{}, ErrInvalid
		}
		cents += part
	}
	total, err := moneyFromCents(cents)
	if err != nil {
		return Payload{}, err
	}
	return Payload{PaymentMethod: input.PaymentMethod, Customer: customer, Lines: lines, Total: total}, nil
}

// The admitted page sizes of the frozen read contract.
const (
	pageSizeSmall  = 10
	pageSizeMedium = 25
	pageSizeLarge  = 50
)

// ValidPage admits only the page and page size of the frozen read contract, so every
// other value is refused before the database is touched.
func ValidPage(page, pageSize int) bool {
	return page >= 1 && page <= MaxPage &&
		(pageSize == pageSizeSmall || pageSize == pageSizeMedium || pageSize == pageSizeLarge)
}

// validText keeps an optional filter inside the database's own text bounds.
func validText(text string) bool {
	return boundedText(text, 0, maxSearch)
}

// ValidListQuery admits the history filter. An unknown payment method is refused
// here, so it never becomes a SQL parameter.
func ValidListQuery(q ListQuery) bool {
	if !ValidPage(q.Page, q.PageSize) || !validText(q.Search) {
		return false
	}
	return q.PaymentMethod == "" || PaymentMethod(q.PaymentMethod).Valid()
}

// ValidSellableQuery admits the catalogue filter. The capacity is a catalogue
// decimal, so a value the catalogue cannot hold never becomes a SQL parameter.
func ValidSellableQuery(q SellableQuery) bool {
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

// branchClerk admits only a completed branch session: the warehouse is not a point of
// sale and a session that still must change its password cannot sell.
func branchClerk(actor auth.Identity) bool {
	return actor.AccountID > 1 && actor.Location.ID > warehouseLocationID &&
		actor.Location.ID <= maxBranchLocationID && !actor.MustChangePassword
}
