// Package sales owns the branch point of sale: an immutable sale document with one
// or more lines that decrements the stock of the branch that sold it. Only a branch
// sells, and only the branch's own provisioned account registers a sale there; the
// warehouse (location 1) is refused. The database owns the price rules: the charged
// price is no lower than the branch's stored minimum, the frozen minimum comes from
// branch_prices, and a variant without a price in the branch is not sellable.
//
// The line stays commercial and the unit is physical: a line states the variant, the sold
// quantity and the price, and every one of those pieces is a unit of its own, carrying the
// serial number the seller reads at the counter and, optionally, the warranty term stated
// for that battery. There is no zero months: a battery sold without warranty carries no
// term at all, and that absence is stored data, never missing data. The serial is written
// down, never resolved against stock, and it is unique in the installation after trimming
// and case folding, because one physical battery cannot be sold twice.
//
// Money is a canonical decimal string with exactly two decimals and is never a
// binary float, so no rounding is invented between the database and the client. The
// subtotal of a line and the total of the document are computed here in integer
// cents, and the database derives them again and refuses a document that does not
// add up.
//
// A sale also records how much was paid with each admitted method -- cash, card, transfer
// and QR -- so one document can be settled partly in cash and partly by transfer, or leave
// the branch with electronic money it never holds in its drawer. The payments must close
// against the total exactly, and the payment label is derived by the database from the
// amounts instead of being chosen by a client.
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
	ErrSerialAlreadySold = errors.New("serial number was already sold")
	ErrUnavailable       = errors.New("sale store unavailable")
)

// SerialAlreadySold is the refusal of a sale that repeats the serial number of a battery
// that was already sold. Serial is the serial the database reported, which is the one the
// sale tried to sell; a refusal that could not read it keeps the empty text, so the
// refusal still names its class without inventing a battery.
type SerialAlreadySold struct{ Serial SerialNumber }

func (e *SerialAlreadySold) Error() string {
	if e.Serial == "" {
		return ErrSerialAlreadySold.Error()
	}
	return "serial number " + string(e.Serial) + " was already sold"
}

// Unwrap keeps errors.Is(err, ErrSerialAlreadySold) true.
func (e *SerialAlreadySold) Unwrap() error { return ErrSerialAlreadySold }

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

// PaymentsMismatch is the refusal of a document whose payments do not close against its
// own total. Exactly one side is set: Missing when the payments fall short of the total,
// Excess when they overshoot it, so a client can say how much is left to pay or how much
// was charged too much instead of only reporting that the document is wrong.
type PaymentsMismatch struct {
	Missing Money
	Excess  Money
}

func (e *PaymentsMismatch) Error() string {
	switch {
	case e.Missing != "":
		return "payments are " + string(e.Missing) + " short of the sale total"
	case e.Excess != "":
		return "payments exceed the sale total by " + string(e.Excess)
	}
	return "payments do not close against the sale total"
}

// Unwrap keeps errors.Is(err, ErrInvalid) true: an open settlement is part of the
// document contract, not a separate class of failure.
func (e *PaymentsMismatch) Unwrap() error { return ErrInvalid }

const (
	// The warehouse (location 1) never sells: branches start at id 2.
	warehouseLocationID = 1
	// MaxLines, MaxQuantity, MaxCustomerName, MaxCustomerPhone, MaxCustomerDocument,
	// MaxCustomerAddress, MaxUnits, MaxSerialLength, MaxPage and DefaultPageSize are the
	// frozen bounds of this contract, and the database checks say the same.
	MaxLines            = 190
	MaxQuantity         = 1_000_000
	MaxCustomerName     = 120
	MaxCustomerPhone    = 40
	MaxCustomerDocument = 40
	MaxCustomerAddress  = 200
	MaxPage             = 1_000_000
	DefaultPageSize     = 25
	// MaxUnits is the number of physical batteries one sale carries. The database refuses
	// a sale above it at commit, so the documented body limit stays reachable.
	MaxUnits = 1_000
	// MaxSerialLength is the bound of the serial the seller reads at the counter, after
	// trimming.
	MaxSerialLength = 64
	// MinWarrantyMonths and MaxWarrantyMonths are the bounds of the term a seller may state
	// for one unit, which the sale then freezes. The absence of a warranty is not a term: it
	// is a nil term, never zero.
	MinWarrantyMonths   = 1
	MaxWarrantyMonths   = 120
	maxBranchLocationID = math.MaxInt16
	maxSearch           = 128
	// maxPayments is the number of admitted methods: one payment per method at most.
	maxPayments = 4
	// maxCents is the whole range of numeric(12,2) expressed in cents.
	maxCents = int64(999_999_999_999)
)

// Money is the price list's canonical amount: a decimal string with exactly two
// decimals, e.g. "85000.00". It is reused, not redefined, so both domains share one
// money contract and no binary float ever touches an amount.
type Money = pricing.Money

// zeroAmount is the canonical text of a method that was not used. It is the database's
// own representation of "nothing paid with this method", so a read accepts it as zero
// and it is never a payment entry of a document.
const zeroAmount Money = "0.00"

// PaymentMethod is the admitted way a sale was paid.
type PaymentMethod string

const (
	PaymentCash     PaymentMethod = "cash"
	PaymentCard     PaymentMethod = "card"
	PaymentTransfer PaymentMethod = "transfer"
	// PaymentQR is the fourth admitted method: money the branch collected electronically
	// and never holds in its drawer (S13).
	PaymentQR PaymentMethod = "qr"
	// PaymentMixed is the label of a sale settled with more than one method. The database
	// derives it from the four amounts, so it is never an input and no client chooses it.
	PaymentMixed PaymentMethod = "mixed"
)

// Valid reports whether the method is one of the frozen four a client may state. The
// derived 'mixed' is deliberately not one of them: it is a consequence of the amounts.
func (p PaymentMethod) Valid() bool {
	return p == PaymentCash || p == PaymentCard || p == PaymentTransfer || p == PaymentQR
}

// Recorded reports whether the method is a label a persisted sale can carry: the four
// admitted inputs plus the derived 'mixed'. Reads and the history filter use this
// predicate, so a mixed sale is legible and filterable, while an input still has to name
// one real method.
func (p PaymentMethod) Recorded() bool { return p.Valid() || p == PaymentMixed }

// PaymentMethods lists the admitted input methods in their frozen order.
func PaymentMethods() []PaymentMethod {
	return []PaymentMethod{PaymentCash, PaymentCard, PaymentTransfer, PaymentQR}
}

// Payment is one way a sale was paid and the amount paid with it. A sale admits at most
// one payment per method, so one document can be settled partly in cash and partly by
// transfer, and the amounts must close against the total exactly.
type Payment struct {
	Method PaymentMethod
	Amount Money
}

// Customer is the client the warranty is issued to. The name is mandatory; the phone, the
// document and the address are optional and bounded. The address is one free field, the
// neighbourhood or street the client gave at the counter, never structured into parts.
type Customer struct {
	Name     string `json:"name"`
	Phone    string `json:"phone"`
	Document string `json:"document"`
	Address  string `json:"address"`
}

// CanonicalCustomer trims the mandatory name and the optional address, and refuses a value
// outside the database's own bounds.
func CanonicalCustomer(customer Customer) (Customer, bool) {
	name := strings.TrimSpace(customer.Name)
	address := strings.TrimSpace(customer.Address)
	if !boundedText(name, 1, MaxCustomerName) ||
		!boundedText(customer.Phone, 0, MaxCustomerPhone) ||
		!boundedText(customer.Document, 0, MaxCustomerDocument) ||
		!boundedText(address, 0, MaxCustomerAddress) {
		return Customer{}, false
	}
	return Customer{Name: name, Phone: customer.Phone, Document: customer.Document,
		Address: address}, true
}

// SerialNumber is the serial number the seller reads on the physical battery and writes
// down at the counter. It tracks the battery the client left with; it is never a stock
// identity and it is never resolved against inventory_balances.
type SerialNumber string

// CanonicalSerial trims the serial and refuses a value outside the database's own bounds:
// one to sixty-four characters, valid UTF-8, without a NUL.
func CanonicalSerial(serial SerialNumber) (SerialNumber, bool) {
	trimmed := SerialNumber(strings.TrimSpace(string(serial)))
	if !boundedText(string(trimmed), 1, MaxSerialLength) {
		return "", false
	}
	return trimmed, true
}

// Unit is one physical battery of a line: the serial the seller read and, optionally, the
// warranty term stated for that battery. A nil term is the recorded absence of warranty,
// which is sold data and never a zero.
type Unit struct {
	SerialNumber   SerialNumber
	WarrantyMonths *int
}

// inputUnits counts the units an asked document states, so the whole shape is judged once
// instead of line by line.
func inputUnits(lines []LineInput) int {
	total := 0
	for _, line := range lines {
		total += len(line.Units)
	}
	return total
}

// canonicalUnit trims the serial, refuses a value outside the frozen bounds and copies the
// stated term, so the canonical document never shares a term with the caller's slice.
func canonicalUnit(unit Unit) (Unit, bool) {
	serial, ok := CanonicalSerial(unit.SerialNumber)
	if !ok {
		return Unit{}, false
	}
	if unit.WarrantyMonths == nil {
		return Unit{SerialNumber: serial}, true
	}
	term := *unit.WarrantyMonths
	if term < MinWarrantyMonths || term > MaxWarrantyMonths {
		return Unit{}, false
	}
	return Unit{SerialNumber: serial, WarrantyMonths: &term}, true
}

// canonicalUnits canonicalizes the units of one line and refuses a line that does not
// carry exactly one unit per sold piece.
func canonicalUnits(units []Unit, quantity int64) ([]Unit, bool) {
	if quantity < 1 || int64(len(units)) != quantity {
		return nil, false
	}
	canonical := make([]Unit, 0, len(units))
	for _, unit := range units {
		admitted, ok := canonicalUnit(unit)
		if !ok {
			return nil, false
		}
		canonical = append(canonical, admitted)
	}
	return canonical, true
}

// LineInput is one line the client asks to sell. The client supplies the variant, the
// quantity, the price it wants to charge and one unit per sold piece: the floor, the frozen
// minimum and the term of every battery are never derived from the catalogue.
type LineInput struct {
	VariantID int64
	Quantity  int64
	UnitPrice Money
	Units     []Unit
}

// CreateInput is one sale to register in the actor's own branch. Payments state how the
// total was settled: one to four entries, each method at most once, in any order.
type CreateInput struct {
	Payments []Payment
	Customer Customer
	Lines    []LineInput
}

// Line is one canonical line: the charged price, one canonical unit per sold piece and the
// exact subtotal of that line. MinPrice is deliberately absent: the database freezes it and
// the store reports what it persisted.
type Line struct {
	VariantID int64
	Quantity  int64
	UnitPrice Money
	Units     []Unit
	Subtotal  Money
}

// Payload is the canonical document used to persist and to answer: the canonical client,
// the lines in ascending variant order (also the database's lock order), the payments in
// the frozen order cash, card, transfer, QR with only the methods that paid, and the exact
// total those payments must close against.
type Payload struct {
	Payments []Payment
	Customer Customer
	Lines    []Line
	Total    Money
}

// SaleLine is one persisted line: the price that was charged, the minimum frozen at
// write time, the units the seller registered and the derived subtotal.
type SaleLine struct {
	VariantID int64
	Quantity  int64
	UnitPrice Money
	MinPrice  Money
	Units     []Unit
	Subtotal  Money
}

// Sale is one persisted sale document. Both the branch correlative and the warranty
// number are the database's own allocation. PaymentMethod is the label the database
// derived from the amounts -- cash, card, transfer, QR or mixed -- and Payments is how much
// was paid with each method that actually paid.
type Sale struct {
	ID                 int64
	BranchLocationID   int64
	BranchSequence     int64
	WarrantyNumber     string
	PaymentMethod      PaymentMethod
	Payments           []Payment
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

// Detail is one persisted sale with its catalogue-resolved lines. BranchName is the name
// of the branch that sold, resolved from locations, so the warranty can be printed with
// the branch it belongs to without a second lookup by the caller.
type Detail struct {
	ID                 int64
	BranchLocationID   int64
	BranchName         string
	BranchSequence     int64
	WarrantyNumber     string
	PaymentMethod      PaymentMethod
	Payments           []Payment
	Customer           Customer
	Total              Money
	CreatedByAccountID int64
	CreatedAt          time.Time
	Lines              []DetailLine
}

// Summary is one row of the read-only sales history of a branch. PaymentMethod is the
// label the database derived for the settlement, so a mixed sale is filtered by 'mixed'.
// UnitsTotal and UnitsWithWarranty tell the sale's position without unfolding it, so a
// battery sold without warranty is legible from the history itself.
type Summary struct {
	ID                int64
	BranchSequence    int64
	WarrantyNumber    string
	PaymentMethod     PaymentMethod
	CustomerName      string
	Total             Money
	CreatedAt         time.Time
	Lines             int
	UnitsTotal        int
	UnitsWithWarranty int
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

// SellableItem is one variant of the catalogue as the branch sees it at the counter:
// the catalogue identity, whether this branch can sell it right now, the suggested price
// the counter starts from and the minimum it can never go under, and the stock of the
// branch. Sellable is true only when the battery of the variant has a price in this
// branch; SuggestedPrice and MinPrice stay empty in that case, so the counter can show
// the row with its action disabled (S7) instead of hiding it. The warranty term is not
// part of the catalogue: the seller states it on the sale.
type SellableItem struct {
	VariantID      int64
	CatalogEntryID int64
	Brand          string
	Model          string
	Capacity       catalog.Decimal
	Polarity       string
	Sellable       bool
	SuggestedPrice Money
	MinPrice       Money
	Existing       int64
	Reserved       int64
	Available      int64
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

// canonicalPayments admits the settlement of one sale: one to four payments, each method
// at most once, every amount canonical two-decimal text above zero. It answers the
// payments in the frozen order cash, card, transfer, QR together with the amount paid, in
// integer cents, so the sum is compared exactly and never as a float.
func canonicalPayments(input []Payment) ([]Payment, int64, bool) {
	if len(input) < 1 || len(input) > maxPayments {
		return nil, 0, false
	}
	seen := make(map[PaymentMethod]Money, len(input))
	var paid int64
	for _, payment := range input {
		text := string(payment.Amount)
		// The method is one a client may state, and it pays at most once.
		if !payment.Method.Valid() {
			return nil, 0, false
		}
		if _, repeated := seen[payment.Method]; repeated {
			return nil, 0, false
		}
		// The amount is the same canonical money contract as every other amount of this
		// domain: two decimals, above zero, no binary float and nothing approximated.
		amount := Money(text)
		cents, ok := centsOf(amount)
		if !ok || amount.String() != text || cents < 1 || paid > maxCents-cents {
			return nil, 0, false
		}
		seen[payment.Method] = amount
		paid += cents
	}
	payments := make([]Payment, 0, len(seen))
	for _, method := range PaymentMethods() {
		if amount, ok := seen[method]; ok {
			payments = append(payments, Payment{Method: method, Amount: amount})
		}
	}
	return payments, paid, true
}

// amountsOf maps the frozen-order payments of a document onto the four stored amount
// columns, with the canonical zero for a method that was not used.
func amountsOf(payments []Payment) (cash, card, transfer, qr Money) {
	cash, card, transfer, qr = zeroAmount, zeroAmount, zeroAmount, zeroAmount
	for _, payment := range payments {
		switch payment.Method {
		case PaymentCash:
			cash = payment.Amount
		case PaymentCard:
			card = payment.Amount
		case PaymentTransfer:
			transfer = payment.Amount
		case PaymentQR:
			qr = payment.Amount
		}
	}
	return cash, card, transfer, qr
}

// paymentsOf rebuilds the frozen-order payments of a persisted sale from its four amount
// columns: only the methods that actually paid, cash then card then transfer then QR. Each
// amount is read back as canonical text, and a stored shape this domain never wrote is
// refused instead of being described.
func paymentsOf(cash, card, transfer, qr string) ([]Payment, int64, bool) {
	payments := make([]Payment, 0, maxPayments)
	var paid int64
	for _, column := range []struct {
		method PaymentMethod
		text   string
	}{
		{PaymentCash, cash}, {PaymentCard, card}, {PaymentTransfer, transfer}, {PaymentQR, qr},
	} {
		if column.text == string(zeroAmount) {
			continue
		}
		amount := Money(column.text)
		cents, ok := centsOf(amount)
		if !ok || amount.String() != column.text || cents < 1 {
			return nil, 0, false
		}
		payments = append(payments, Payment{Method: column.method, Amount: amount})
		paid += cents
	}
	return payments, paid, true
}

// PreVertical reports whether a persisted document was stored by the contract that had no
// sold unit at all: it carries one or more lines and not one unit between them. Such a
// document is recoverable history -- the series and the term of its batteries were never
// recorded -- so every read path names it instead of failing closed. A document carrying
// some units but fewer than its sold pieces is corrupt, not pre-vertical, and stays refused.
func PreVertical(lines, units int) bool { return lines > 0 && units == 0 }

// Validate returns the canonical document used to persist and to answer. Lines are
// copied and sorted ascending by variant, which is also the database's balance-row
// lock order, and the caller's slice is never modified. An unknown variant, a duplicate
// variant, an impossible quantity, a line without exactly one unit per sold piece, a serial
// outside the frozen bounds, a term that is neither absent nor inside 1..120, a sale above
// MaxUnits batteries, a payment shape no sale admits and an amount that is not canonical
// two-decimal text are refused here, before any database work. A settlement whose amounts
// do not close against the total is refused with the amount that is missing or left over.
func Validate(input CreateInput) (Payload, error) { return validate(input, false) }

// ValidatePersisted revalidates a document read back from the ledger and applies the same
// contract as Validate with one difference: a pre-vertical document (PreVertical) is
// admitted with an empty units array per line, because its absence of units is history and
// not corruption. A document carrying some units is held to exactly one per sold piece, and
// one whose lines disagree about carrying them is refused like any other corrupt shape.
func ValidatePersisted(input CreateInput) (Payload, error) { return validate(input, true) }

func validate(input CreateInput, admitPreVertical bool) (Payload, error) {
	payments, paid, ok := canonicalPayments(input.Payments)
	if !ok {
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
	units := int64(0)
	// A pre-vertical document is judged as a whole: every one of its lines carries no unit.
	// One line without units beside a united one is a shape no contract ever stored.
	preVertical := admitPreVertical && PreVertical(len(input.Lines), inputUnits(input.Lines))
	for _, line := range input.Lines {
		if line.VariantID < 1 || line.VariantID > math.MaxInt32 || seen[line.VariantID] {
			return Payload{}, ErrInvalid
		}
		seen[line.VariantID] = true
		unit, err := pricing.ParseMoney(string(line.UnitPrice))
		if err != nil {
			return Payload{}, ErrInvalid
		}
		// The units are exactly as many as the sold quantity, and one sale carries at most
		// MaxUnits batteries, so the documented body limit stays reachable. A pre-vertical
		// line carries none by definition, so nothing is invented for it here.
		batteries := []Unit{}
		if !preVertical {
			if batteries, ok = canonicalUnits(line.Units, line.Quantity); !ok {
				return Payload{}, ErrInvalid
			}
		}
		units += line.Quantity
		if units > MaxUnits {
			return Payload{}, ErrInvalid
		}
		subtotal, err := LineTotal(unit, line.Quantity)
		if err != nil {
			return Payload{}, err
		}
		lines = append(lines, Line{VariantID: line.VariantID, Quantity: line.Quantity,
			UnitPrice: unit, Units: batteries, Subtotal: subtotal})
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
	// The settlement must close against the document's own total, compared in integer
	// cents so nothing is rounded. The refusal names the open side.
	if paid != cents {
		if paid < cents {
			missing, err := moneyFromCents(cents - paid)
			if err != nil {
				return Payload{}, err
			}
			return Payload{}, &PaymentsMismatch{Missing: missing}
		}
		excess, err := moneyFromCents(paid - cents)
		if err != nil {
			return Payload{}, err
		}
		return Payload{}, &PaymentsMismatch{Excess: excess}
	}
	return Payload{Payments: payments, Customer: customer, Lines: lines, Total: total}, nil
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

// ValidListQuery admits the history filter. An unknown payment method is refused here, so
// it never becomes a SQL parameter, while 'mixed' is admitted because it is a label the
// database derives and the branch must be able to filter.
func ValidListQuery(q ListQuery) bool {
	if !ValidPage(q.Page, q.PageSize) || !validText(q.Search) {
		return false
	}
	return q.PaymentMethod == "" || PaymentMethod(q.PaymentMethod).Recorded()
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
