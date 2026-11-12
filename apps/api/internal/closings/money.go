package closings

import (
	"regexp"
	"strconv"
	"strings"

	"luson/api/internal/pricing"
)

// Money is the money contract this vertical reuses instead of inventing another one: the
// price list's canonical amount with exactly two decimals, never a binary float. It
// differs from a price in one respect only: an amount of cash is legitimately zero, while
// a price is never, so this package canonicalizes its input with ParseAmount and always
// writes string(amount) — Money.String() renders zero as empty and is not used here.
type Money = pricing.Money

// Percent is a canonical commission percentage with exactly two decimals between 0 and
// 100, e.g. "12.50". It is decimal text end to end: the database column is numeric(5,2)
// and no binary float ever touches a rate.
type Percent string

// Signed is a canonical signed amount with two decimals, e.g. "-12.50". The money this
// vertical persists is never negative, but the numbers derived from it are: a cash
// difference can be a shortage and S8 requires showing its sign. It exists only for
// values computed on read and is never written back.
type Signed string

// maxCents is the whole range of numeric(12,2) expressed in cents.
const maxCents = int64(999_999_999_999)

// amountPattern admits at most ten integral digits, which is the whole range of
// numeric(12,2), and at most two decimals, so an over-precision amount never reaches the
// database. The integral part is never padded with a leading zero.
var amountPattern = regexp.MustCompile(`^(0|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$`)

// percentPattern admits at most three integral digits and at most two decimals: the whole
// range of numeric(5,2) as a percentage.
var percentPattern = regexp.MustCompile(`^(0|[1-9][0-9]{0,2})(\.[0-9]{1,2})?$`)

// ParseAmount canonicalizes an amount the caller typed. A negative, signed, padded or
// fractional-beyond-two amount is refused: the exact decimal text is the contract, not an
// approximation of it.
func ParseAmount(text string) (Money, error) {
	if !amountPattern.MatchString(text) {
		return "", ErrInvalid
	}
	whole, fraction, _ := strings.Cut(text, ".")
	return Money(whole + "." + twoDecimals(fraction)), nil
}

// ParsePercent canonicalizes a commission percentage between 0 and 100 with at most two
// decimals (S20). A rate above the whole percentage is refused, exactly like the
// database's own check.
func ParsePercent(text string) (Percent, error) {
	if !percentPattern.MatchString(text) {
		return "", ErrInvalid
	}
	whole, fraction, _ := strings.Cut(text, ".")
	fraction = twoDecimals(fraction)
	canonical := Percent(whole + "." + fraction)
	// The bound is the percentage itself, not its text: 101 and 100.01 are both refused.
	if hundredths, ok := percentHundredths(canonical); !ok || hundredths > 10000 {
		return "", ErrInvalid
	}
	return canonical, nil
}

// twoDecimals pads an optional fractional part to the canonical two digits.
func twoDecimals(fraction string) string {
	switch len(fraction) {
	case 0:
		return "00"
	case 1:
		return fraction + "0"
	}
	return fraction
}

// amountCents reads a canonical amount as integer cents. A value that is not canonical
// two-decimal text is refused, so nothing is approximated.
func amountCents(amount Money) (int64, bool) {
	text := string(amount)
	whole, fraction, ok := strings.Cut(text, ".")
	if !ok || len(fraction) != 2 || whole == "" || (len(whole) > 1 && whole[0] == '0') {
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

// amountFromCents renders integer cents as the canonical amount, admitting the zero a
// price never admits and refusing anything outside numeric(12,2).
func amountFromCents(cents int64) (Money, error) {
	if cents < 0 || cents > maxCents {
		return "", ErrInvalid
	}
	fraction := cents % 100
	text := strconv.FormatInt(cents/100, 10) + "." +
		string([]byte{byte('0' + fraction/10), byte('0' + fraction%10)})
	amount, err := ParseAmount(text)
	if err != nil || string(amount) != text {
		return "", ErrInvalid
	}
	return amount, nil
}

// percentHundredths reads a canonical percentage as integer hundredths of a percent, so
// the commission is one integer multiplication and never a float.
func percentHundredths(rate Percent) (int64, bool) {
	text := string(rate)
	whole, fraction, ok := strings.Cut(text, ".")
	if !ok || len(fraction) != 2 || whole == "" || len(whole) > 3 {
		return 0, false
	}
	var value int64
	for _, ch := range whole + fraction {
		if ch < '0' || ch > '9' {
			return 0, false
		}
		value = value*10 + int64(ch-'0')
	}
	if value > 10000 {
		return 0, false
	}
	return value, true
}

// Commission is the commission of one period: the frozen rate times the sales total of the
// period, rounded exactly once to two decimals (S6, S20). Rounding once on the total — never
// per sold line — is the whole point: the rate and the total are read as integers, so no
// intermediate amount is ever approximated, and the tie-break is half-up: a fraction of a
// cent below the half rounds down, exactly at the half rounds away from zero (an amount here
// is never negative, so that is up), and above the half rounds up. The rule is pinned by
// TestCommissionRoundsAnExactHalfUp, so a later reader finds the decision and not an
// accident of the arithmetic.
func Commission(total Money, rate Percent) (Money, error) {
	cents, ok := amountCents(canonicalAmount(total))
	if !ok {
		return "", ErrInvalid
	}
	canonicalRate, err := ParsePercent(string(rate))
	if err != nil {
		return "", err
	}
	hundredths, ok := percentHundredths(canonicalRate)
	if !ok {
		return "", ErrInvalid
	}
	// The total is bounded by numeric(12,2) and the rate by 10000 hundredths, so the
	// product stays inside int64 (9.99e15) and no step of the computation wraps.
	return amountFromCents((cents*hundredths + 5000) / 10000)
}

// canonicalAmount returns the canonical text of an amount, or the amount untouched when it
// is not canonical, so amountCents refuses it instead of approximating it.
func canonicalAmount(amount Money) Money {
	canonical, err := ParseAmount(string(amount))
	if err != nil {
		return amount
	}
	return canonical
}

// ExpectedCash derives the cash the drawer should hold at the cut: the fund inherited from
// the previous settlement plus the cash sales of the period minus its cash expenses (S8).
// The commission is in no part of this identity (S9). The three amounts are the canonical
// text the database stores: anything else is a defect of this store, not a number to
// approximate, so it is refused.
func ExpectedCash(opening, cashSales, cashExpenses Money) (Signed, error) {
	openingCents, ok := amountCents(opening)
	if !ok {
		return "", ErrInvalid
	}
	salesCents, ok := amountCents(cashSales)
	if !ok {
		return "", ErrInvalid
	}
	expensesCents, ok := amountCents(cashExpenses)
	if !ok {
		return "", ErrInvalid
	}
	// Every term is bounded by numeric(12,2), so the sum stays inside int64.
	return signedFromCents(openingCents + salesCents - expensesCents), nil
}

// CashDifference is the counted cash against the expected one: negative is a shortage and
// positive a surplus, and the closure is admitted either way (S8). Both sides are canonical
// amounts, so the difference is exact.
func CashDifference(counted Money, expected Signed) (Signed, error) {
	countedCents, ok := amountCents(counted)
	if !ok {
		return "", ErrInvalid
	}
	expectedCents, ok := expected.Cents()
	if !ok {
		return "", ErrInvalid
	}
	return signedFromCents(countedCents - expectedCents), nil
}

// TakenCash is what the warehouse takes out of the branch till: the cash counted plus the
// contribution the warehouse made, minus the fund left behind. The S10 bound keeps it
// non-negative, so the movement of the ledger always has one direction (S10, L13).
func TakenCash(counted, contributed, closing Money) (Signed, error) {
	countedCents, ok := amountCents(counted)
	if !ok {
		return "", ErrInvalid
	}
	contributedCents, ok := amountCents(contributed)
	if !ok {
		return "", ErrInvalid
	}
	closingCents, ok := amountCents(closing)
	if !ok {
		return "", ErrInvalid
	}
	return signedFromCents(countedCents + contributedCents - closingCents), nil
}

// signedFromCents renders a signed amount from integer cents. A value outside
// numeric(12,2) renders as the empty text, which no caller stores.
func signedFromCents(cents int64) Signed {
	if cents < 0 {
		magnitude, err := amountFromCents(-cents)
		if err != nil {
			return ""
		}
		return Signed("-" + string(magnitude))
	}
	magnitude, err := amountFromCents(cents)
	if err != nil {
		return ""
	}
	return Signed(magnitude)
}

// Cents reads a signed amount back as integer cents, refusing text that is not canonical.
func (s Signed) Cents() (int64, bool) {
	text := string(s)
	negative := strings.HasPrefix(text, "-")
	if negative {
		text = text[1:]
	}
	cents, ok := amountCents(Money(text))
	if !ok {
		return 0, false
	}
	if negative {
		return -cents, true
	}
	return cents, true
}

// Negative reports whether the derived amount is below zero, which is what the surface
// shows as a shortage instead of a surplus.
func (s Signed) Negative() bool {
	cents, ok := s.Cents()
	return ok && cents < 0
}

// String renders the derived amount, or the empty text when it is not canonical.
func (s Signed) String() string {
	if _, ok := s.Cents(); !ok {
		return ""
	}
	return string(s)
}
