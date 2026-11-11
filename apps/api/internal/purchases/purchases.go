// Package purchases owns the branch purchase of used batteries and scrap: the system's
// first money-out document. It is a document of its own, never part of a sale: a sale is
// registered normally at full price and receiving a used battery or a weight of scrap is
// registered afterwards, here. One same document serves a purchase next to a sale and a
// customer who only comes to sell.
//
// A used battery is identified only by its model code -- no brand, no polarity and no
// condition -- and it is never resold: it does not enter the catalogue, the point of sale,
// the price matrix or inventory_balances. Scrap is bought by the kilogram from four
// reference materials. Nothing about the person who brings the material is recorded: the
// document names the model or the material and the price, and nothing else.
//
// Money is a canonical decimal string with exactly two decimals and weight one with
// exactly three; neither is ever parsed into a binary float. The amount of a used line is
// the quantity times the price, exact; the amount of a scrap line is the weight times the
// price per kilogram rounded half up to the cent, computed here in integer arithmetic so
// the rounding is the same one the database applies. The total is the sum of the line
// amounts and the two paid amounts must close against it exactly.
//
// A document is immutable and is corrected only by one counter-document that mirrors it
// exactly. The client never supplies the lines of a counter-document: they are derived
// from the persisted original, so a partial reversal cannot even be expressed.
package purchases

import (
	"errors"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

var (
	ErrInvalid         = errors.New("invalid purchase")
	ErrForbidden       = errors.New("purchase forbidden")
	ErrNotFound        = errors.New("purchase not found")
	ErrRetryConflict   = errors.New("purchase retry conflict")
	ErrAlreadyReversed = errors.New("purchase already reversed")
	ErrUnavailable     = errors.New("purchase store unavailable")
)

// TotalsMismatch is the refusal of a document whose paid amounts do not close against its
// own total. Exactly one side is set: Missing when they fall short, Excess when they
// overshoot it, so the counter can say how much is left to pay instead of only learning
// that the document is wrong. It is an invalid request, exactly like every other broken
// rule of this contract.
type TotalsMismatch struct {
	Missing Money
	Excess  Money
}

func (e *TotalsMismatch) Error() string {
	switch {
	case e.Missing != "":
		return "paid amounts are " + string(e.Missing) + " short of the purchase total"
	case e.Excess != "":
		return "paid amounts exceed the purchase total by " + string(e.Excess)
	}
	return "paid amounts do not close against the purchase total"
}

// Unwrap keeps errors.Is(err, ErrInvalid) true.
func (e *TotalsMismatch) Unwrap() error { return ErrInvalid }

const (
	// warehouseLocationID is the warehouse, which never buys: branches start at id 2.
	warehouseLocationID = 1
	maxBranchLocationID = math.MaxInt16
	// MaxLines, MaxQuantity, MaxNote, MaxReason, MaxPage and DefaultPageSize are the
	// frozen bounds of this contract, and the database checks say the same.
	MaxLines        = 190
	MaxQuantity     = 1_000_000
	MaxNote         = 500
	MaxReason       = 500
	MaxPage         = 1_000_000
	DefaultPageSize = 25
	// maxCents is the whole range of numeric(12,2) expressed in cents, and maxMilli the
	// whole range of numeric(12,3) expressed in thousandths.
	maxCents = int64(999_999_999_999)
	maxMilli = int64(999_999_999_999)
	// maxMaterialID is the widest material id the reference table can hold. Whether the
	// id exists at all is the database's own foreign key.
	maxMaterialID = math.MaxInt16
	// maxCategoryText is the bound of a catalogue or material name this store publishes:
	// the columns carry no stored length, so the read keeps a text it can print.
	maxCategoryText = 200
	// maxCatalogueRows bounds the suggestion lists: a longer answer is not something the
	// counter can show, so it fails closed instead of being truncated.
	maxCatalogueRows = 5000
)

// Money is the contract's canonical amount: a decimal string with exactly two decimals,
// e.g. "25000.00". A persisted amount of a counter-document is negative, but no amount is
// ever parsed into a binary float.
type Money string

// Weight is the canonical weight of a scrap line: a decimal string with exactly three
// decimals, e.g. "12.400". A persisted weight of a counter-document is negative.
type Weight string

var (
	// moneyPattern is the shape of an amount a client states: exactly two decimals, at
	// most ten integral digits, never signed and never padded.
	moneyPattern = regexp.MustCompile(`^(0|[1-9][0-9]{0,9})\.[0-9]{2}$`)
	// moneyText is the shape of a persisted amount: the same, optionally negative for a
	// counter-document.
	moneyText = regexp.MustCompile(`^-?(0|[1-9][0-9]{0,9})\.[0-9]{2}$`)
	// weightPattern is the shape of a weight a client states: at most three decimals, at
	// most nine integral digits. The request may send "12.4"; the answer is "12.400".
	weightPattern = regexp.MustCompile(`^(0|[1-9][0-9]{0,8})(\.[0-9]{1,3})?$`)
	// weightText is the shape of a persisted weight: exactly three decimals, optionally
	// negative for a counter-document.
	weightText = regexp.MustCompile(`^-?(0|[1-9][0-9]{0,8})\.[0-9]{3}$`)
	// modelPattern is the frozen model code: trimmed and upper-cased, no brand, no
	// polarity and no condition. The comma is admitted because the catalogue itself
	// serves codes such as 12N6,5_3B and YB6,5_BS.
	modelPattern = regexp.MustCompile(`^[A-Z0-9][A-Z0-9 .,_/-]{0,39}$`)
	// operationKeyPattern is the database's own idempotency key.
	operationKeyPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)
)

// ParseMoney admits the price of one line: canonical two-decimal text above zero, at most
// ten integral digits. A missing fraction, a third decimal, a padded, signed or
// non-numeric amount and a JSON number are all refused.
func ParseMoney(text string) (Money, bool) {
	if !moneyPattern.MatchString(text) {
		return "", false
	}
	cents, ok := centsOf(text)
	if !ok || cents < 1 {
		return "", false
	}
	return Money(text), true
}

// ParseAmount admits one side of the settlement: the same canonical two-decimal text,
// which may be zero because a document settled only by transfer carries 0.00 in cash.
func ParseAmount(text string) (Money, bool) {
	if !moneyPattern.MatchString(text) {
		return "", false
	}
	if _, ok := centsOf(text); !ok {
		return "", false
	}
	return Money(text), true
}

// ParseWeight admits the weight of one scrap line and answers its canonical three-decimal
// form: the request may send "12.4" and the answer is always "12.400". A weight is above
// zero; zero, a fourth decimal and a signed or padded value are refused.
func ParseWeight(text string) (Weight, bool) {
	if !weightPattern.MatchString(text) {
		return "", false
	}
	whole, fraction, _ := strings.Cut(text, ".")
	for len(fraction) < 3 {
		fraction += "0"
	}
	canonical := Weight(whole + "." + fraction)
	milli, ok := milliOf(string(canonical))
	if !ok || milli < 1 {
		return "", false
	}
	return canonical, true
}

// CanonicalModel trims and upper-cases the model code and refuses a value outside the
// frozen pattern. The code is what the counter types: " ns60zl " is the battery NS60ZL.
func CanonicalModel(code string) (string, bool) {
	canonical := strings.ToUpper(strings.TrimSpace(code))
	if !modelPattern.MatchString(canonical) {
		return "", false
	}
	return canonical, true
}

// centsOf reads canonical two-decimal text as integer cents. A value that is not canonical
// text is refused, so no amount is ever approximated.
func centsOf(text string) (int64, bool) {
	if !moneyText.MatchString(text) {
		return 0, false
	}
	return scaledOf(strings.TrimPrefix(text, "-"), 2, strings.HasPrefix(text, "-"))
}

// milliOf reads canonical three-decimal text as integer thousandths. The sign of a
// counter-document's weight is admitted here.
func milliOf(text string) (int64, bool) {
	if !weightText.MatchString(text) {
		return 0, false
	}
	return scaledOf(strings.TrimPrefix(text, "-"), 3, strings.HasPrefix(text, "-"))
}

// scaledOf turns canonical decimal text with the given scale into an integer, without a
// float and without an allocation per digit.
func scaledOf(text string, scale int, negative bool) (int64, bool) {
	whole, fraction, ok := strings.Cut(text, ".")
	if !ok || len(fraction) != scale || len(whole) < 1 || len(whole) > 10 {
		return 0, false
	}
	var value int64
	for _, ch := range whole + fraction {
		if ch < '0' || ch > '9' {
			return 0, false
		}
		value = value*10 + int64(ch-'0')
	}
	if negative {
		value = -value
	}
	return value, true
}

// moneyOfCents renders integer cents as the canonical amount, refusing anything outside
// numeric(12,2). Zero is never rendered as a negative zero.
func moneyOfCents(cents int64) (Money, bool) {
	if cents > maxCents || cents < -maxCents {
		return "", false
	}
	if cents == 0 {
		return Money("0.00"), true
	}
	negative := cents < 0
	if negative {
		cents = -cents
	}
	text := strconv.FormatInt(cents/100, 10) + "." +
		string([]byte{byte('0' + (cents%100)/10), byte('0' + cents%10)})
	if negative {
		text = "-" + text
	}
	if _, ok := centsOf(text); !ok {
		return "", false
	}
	return Money(text), true
}

// weightOfMilli renders integer thousandths as the canonical weight, refusing anything
// outside numeric(12,3). Zero is never rendered as a negative zero.
func weightOfMilli(milli int64) (Weight, bool) {
	if milli > maxMilli || milli < -maxMilli {
		return "", false
	}
	if milli == 0 {
		return Weight("0.000"), true
	}
	negative := milli < 0
	if negative {
		milli = -milli
	}
	text := strconv.FormatInt(milli/1000, 10) + "." +
		string([]byte{byte('0' + (milli/100)%10), byte('0' + (milli/10)%10), byte('0' + milli%10)})
	if negative {
		text = "-" + text
	}
	if _, ok := milliOf(text); !ok {
		return "", false
	}
	return Weight(text), true
}

// usedAmount is the exact amount of one used line: the quantity times the price, in
// integer cents. The product is bounded before it is multiplied, so an amount outside
// numeric(12,2) is a refusal and never a wrapped number.
func usedAmount(quantity int64, unitPrice Money) (Money, bool) {
	cents, ok := centsOf(string(unitPrice))
	if !ok || cents < 1 {
		return "", false
	}
	magnitude := quantity
	if magnitude < 0 {
		magnitude = -magnitude
	}
	if magnitude < 1 || magnitude > MaxQuantity {
		return "", false
	}
	if cents > maxCents/magnitude {
		return "", false
	}
	total := cents * magnitude
	if quantity < 0 {
		total = -total
	}
	return moneyOfCents(total)
}

// scrapAmount is the amount of one scrap line: the weight times the price per kilogram,
// rounded half up to the cent in integer arithmetic. The rounding is applied to the
// magnitude and the sign afterwards, which is the same rule as numeric round() (half away
// from zero) and makes a counter-document's amount the exact negation of its original's.
func scrapAmount(kg Weight, pricePerKg Money) (Money, bool) {
	milli, ok := milliOf(string(kg))
	if !ok || milli == 0 {
		return "", false
	}
	cents, ok := centsOf(string(pricePerKg))
	if !ok || cents < 1 {
		return "", false
	}
	magnitude := milli
	negative := magnitude < 0
	if negative {
		magnitude = -magnitude
	}
	if magnitude > maxMilli {
		return "", false
	}
	// The product is in hundred-thousandths of one unit of money; the cent is reached by
	// dividing by one thousand. Bound before multiplying so it cannot overflow.
	if cents > (maxCents*1000)/magnitude {
		return "", false
	}
	rounded := (magnitude*cents + 500) / 1000
	if negative {
		rounded = -rounded
	}
	return moneyOfCents(rounded)
}

// ReservedOperation reports whether an operation key shape is admitted. It is the
// database's own pattern, checked before any database work.
func ValidOperationKey(key string) bool { return operationKeyPattern.MatchString(key) }

// ValidPage admits only the page and page size of the frozen read contract, so every other
// value is refused before the database is touched.
func ValidPage(page, pageSize int) bool {
	return page >= 1 && page <= MaxPage && (pageSize == 10 || pageSize == DefaultPageSize || pageSize == 50)
}

// CanonicalReason admits the mandatory reason of a counter-document and returns the exact
// text that is persisted and compared on a replay: valid UTF-8, no NUL, at most 500
// characters, and never blank once trimmed.
func CanonicalReason(reason string) (string, bool) {
	if !boundedText(reason, 1, MaxReason) {
		return "", false
	}
	trimmed := strings.TrimSpace(reason)
	if trimmed == "" {
		return "", false
	}
	return trimmed, true
}

// boundedText keeps a text inside the database's own character bounds.
func boundedText(text string, minimum, maximum int) bool {
	if !utf8.ValidString(text) || strings.ContainsRune(text, 0) {
		return false
	}
	length := utf8.RuneCountInString(text)
	return length >= minimum && length <= maximum
}

// validNote matches the database bound in characters and refuses bytes that a JSON or SQL
// text column cannot represent faithfully.
func validNote(note string) bool { return boundedText(note, 0, MaxNote) }

// UsedLineInput is one used line the counter registers: the model code, how many batteries
// and the price the branch paid for each one.
type UsedLineInput struct {
	Model     string
	Quantity  int64
	UnitPrice Money
}

// ScrapLineInput is one scrap line: the material, the weight in kilograms and the price
// the branch paid per kilogram.
type ScrapLineInput struct {
	MaterialID int64
	Kg         Weight
	PricePerKg Money
}

// CreateInput is one purchase to register in the actor's own branch. Either line slice may
// be empty, but not both, and the two paid amounts must close against the total the lines
// derive.
type CreateInput struct {
	OperationKey string
	Note         string
	UsedLines    []UsedLineInput
	ScrapLines   []ScrapLineInput
	PaidCash     Money
	PaidTransfer Money
}

// UsedLine is one canonical used line: the model code as it is persisted, the quantity,
// the price and the exact amount the line is worth.
type UsedLine struct {
	Model     string
	Quantity  int64
	UnitPrice Money
	Amount    Money
}

// ScrapLine is one canonical scrap line. Name is resolved from the reference table and is
// empty on the write path, where only the material id is known.
type ScrapLine struct {
	MaterialID int64
	Name       string
	Kg         Weight
	PricePerKg Money
	Amount     Money
}

// Payload is the canonical document used to persist and to answer: the used lines in
// ascending model order, the scrap lines in ascending material order, and the exact total
// the paid amounts must close against.
type Payload struct {
	OperationKey string
	Note         string
	UsedLines    []UsedLine
	ScrapLines   []ScrapLine
	PaidCash     Money
	PaidTransfer Money
	Total        Money
}

// Document is one persisted purchase exactly as the contract publishes it. The reversal
// binding is the original document when this one is a counter-document, and ReversedBy is
// the counter-document that reversed this one, if any.
type Document struct {
	ID                 int64
	LocationID         int
	Note               string
	Total              Money
	PaidCash           Money
	PaidTransfer       Money
	CreatedByAccountID int64
	CreatedAt          time.Time
	ReversesPurchaseID *int64
	ReversedBy         *int64
	Reason             string
	UsedLines          []UsedLine
	ScrapLines         []ScrapLine
}

// Summary is one row of the read-only purchase history of a branch: the header, the exact
// unit total of the document (negative for a counter-document) and how many scrap lines it
// carries.
type Summary struct {
	ID                 int64
	CreatedAt          time.Time
	Total              Money
	ReversesPurchaseID *int64
	ReversedBy         *int64
	UsedUnits          int64
	ScrapLines         int
}

// Page is one newest-first page of the branch history plus the total.
type Page struct {
	Page           int
	PageSize       int
	TotalPurchases int64
	Purchases      []Summary
}

// Material is one reference material, bought by the kilogram.
type Material struct {
	ID   int64
	Name string
}

// ModelPrice is the last price the branch paid for one model.
type ModelPrice struct {
	Model       string
	UnitPrice   Money
	PurchasedAt time.Time
}

// MaterialPrice is the last price the branch paid per kilogram of one material.
type MaterialPrice struct {
	MaterialID  int64
	PricePerKg  Money
	PurchasedAt time.Time
}

// LastPrices is the anchor the counter shows next to each input. A model or material never
// bought in this branch is simply absent from its list.
type LastPrices struct {
	Models    []ModelPrice
	Materials []MaterialPrice
}

// ReceivedUsed is what the branch received of one model, with the money it spent.
type ReceivedUsed struct {
	Model    string
	Quantity int64
	Value    Money
}

// ReceivedScrap is what the branch received of one material, with the money it spent.
type ReceivedScrap struct {
	MaterialID int64
	Name       string
	Kg         Weight
	Value      Money
}

// Received is the month-end read: the sum of every persisted line of the branch, so a
// counter-document nets out by construction.
type Received struct {
	Used  []ReceivedUsed
	Scrap []ReceivedScrap
}

// Validate returns the canonical document used to persist and to answer. The model codes
// are canonicalized, the weights normalized, the amounts derived and the total compared
// against the paid amounts, so a document that does not add up is refused before any
// database work. The caller's slices are never modified or reordered.
func Validate(input CreateInput) (Payload, error) {
	if !ValidOperationKey(input.OperationKey) || !validNote(input.Note) {
		return Payload{}, ErrInvalid
	}
	if len(input.UsedLines) > MaxLines || len(input.ScrapLines) > MaxLines ||
		len(input.UsedLines)+len(input.ScrapLines) < 1 {
		return Payload{}, ErrInvalid
	}
	var total int64
	used := make([]UsedLine, 0, len(input.UsedLines))
	models := make(map[string]bool, len(input.UsedLines))
	for _, line := range input.UsedLines {
		model, ok := CanonicalModel(line.Model)
		if !ok || models[model] || line.Quantity < 1 || line.Quantity > MaxQuantity {
			return Payload{}, ErrInvalid
		}
		price, ok := ParseMoney(string(line.UnitPrice))
		if !ok {
			return Payload{}, ErrInvalid
		}
		amount, ok := usedAmount(line.Quantity, price)
		if !ok {
			return Payload{}, ErrInvalid
		}
		cents, ok := centsOf(string(amount))
		if !ok || total > maxCents-cents {
			return Payload{}, ErrInvalid
		}
		total += cents
		models[model] = true
		used = append(used, UsedLine{Model: model, Quantity: line.Quantity, UnitPrice: price, Amount: amount})
	}
	scrap := make([]ScrapLine, 0, len(input.ScrapLines))
	materials := make(map[int64]bool, len(input.ScrapLines))
	for _, line := range input.ScrapLines {
		if line.MaterialID < 1 || line.MaterialID > maxMaterialID || materials[line.MaterialID] {
			return Payload{}, ErrInvalid
		}
		kg, ok := ParseWeight(string(line.Kg))
		if !ok {
			return Payload{}, ErrInvalid
		}
		price, ok := ParseMoney(string(line.PricePerKg))
		if !ok {
			return Payload{}, ErrInvalid
		}
		amount, ok := scrapAmount(kg, price)
		if !ok {
			return Payload{}, ErrInvalid
		}
		cents, ok := centsOf(string(amount))
		if !ok || total > maxCents-cents {
			return Payload{}, ErrInvalid
		}
		total += cents
		materials[line.MaterialID] = true
		scrap = append(scrap, ScrapLine{MaterialID: line.MaterialID, Kg: kg, PricePerKg: price, Amount: amount})
	}
	sort.Slice(used, func(i, j int) bool { return used[i].Model < used[j].Model })
	sort.Slice(scrap, func(i, j int) bool { return scrap[i].MaterialID < scrap[j].MaterialID })
	// A purchase spends money: its total is the sum of its line amounts and it is above
	// zero, exactly like the sign rule the database enforces.
	totalMoney, ok := moneyOfCents(total)
	if !ok || total < 1 {
		return Payload{}, ErrInvalid
	}
	cash, ok := ParseAmount(string(input.PaidCash))
	if !ok {
		return Payload{}, ErrInvalid
	}
	transfer, ok := ParseAmount(string(input.PaidTransfer))
	if !ok {
		return Payload{}, ErrInvalid
	}
	cashCents, _ := centsOf(string(cash))
	transferCents, _ := centsOf(string(transfer))
	if cashCents > maxCents-transferCents {
		return Payload{}, ErrInvalid
	}
	// The settlement must close against the document's own total, compared in integer
	// cents so nothing is rounded. The refusal names the open side.
	if paid := cashCents + transferCents; paid != total {
		if paid < total {
			missing, ok := moneyOfCents(total - paid)
			if !ok {
				return Payload{}, ErrInvalid
			}
			return Payload{}, &TotalsMismatch{Missing: missing}
		}
		excess, ok := moneyOfCents(paid - total)
		if !ok {
			return Payload{}, ErrInvalid
		}
		return Payload{}, &TotalsMismatch{Excess: excess}
	}
	return Payload{OperationKey: input.OperationKey, Note: input.Note, UsedLines: used,
		ScrapLines: scrap, PaidCash: cash, PaidTransfer: transfer, Total: totalMoney}, nil
}
