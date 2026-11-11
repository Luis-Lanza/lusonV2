package purchases

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

// validInput is one document that closes: a used battery at a typed price and a
// weight of copper at a typed price per kilogram, paid in cash. Its total is the
// contract's own example, 25000.00 + 12.400 * 8000.00 = 124200.00.
func validInput() CreateInput {
	return CreateInput{
		OperationKey: "5f0b1c2d3e4f5a6b",
		Note:         "",
		UsedLines:    []UsedLineInput{{Model: " ns60zl ", Quantity: 1, UnitPrice: "25000.00"}},
		ScrapLines:   []ScrapLineInput{{MaterialID: 1, Kg: "12.4", PricePerKg: "8000.00"}},
		PaidCash:     "124200.00",
		PaidTransfer: "0.00",
	}
}

// TestCanonicalModel pins the model code of the contract: trimmed, upper-cased and
// matching its frozen pattern, with no brand, no polarity and no condition.
func TestCanonicalModel(t *testing.T) {
	for text, want := range map[string]string{
		"NS60ZL":      "NS60ZL",
		" ns60zl ":    "NS60ZL",
		"55b24l":      "55B24L",
		"12N5-3B":     "12N5-3B",
		"12n6,5_3b":   "12N6,5_3B",
		"L2 400 ._/-": "L2 400 ._/-",
	} {
		got, ok := CanonicalModel(text)
		if !ok || got != want {
			t.Fatalf("model %q canonicalizes to %q, want %q (ok %v)", text, got, want, ok)
		}
	}
	for name, text := range map[string]string{
		"empty":        "",
		"blank":        "   ",
		"leading_dot":  ".NS60",
		"leading_dash": "-NS60",
		"too_long":     strings.Repeat("A", 41),
		// The pattern is ASCII only and admits no accent, no colon, no quote, no
		// bang and no semicolon: the comma is the only widening.
		"accent":    "ÑANDU",
		"colon":     "NS60:ZL",
		"quote":     "NS60'ZL",
		"bang":      "NS60ZL!",
		"semicolon": "NS60ZL;",
	} {
		if got, ok := CanonicalModel(text); ok {
			t.Errorf("a %s model must be refused, got %q", name, got)
		}
	}
	// Forty characters are admitted: the bound is the pattern's own.
	if _, ok := CanonicalModel(strings.Repeat("A", 40)); !ok {
		t.Error("a model of forty characters must be admitted")
	}
}

// TestMoneyText pins the money contract: exactly two decimals, at most ten integral
// digits, and never a binary float. A price is above zero; a paid amount may be zero.
func TestMoneyText(t *testing.T) {
	for text, want := range map[string]string{
		"25000.00":      "25000.00",
		"0.01":          "0.01",
		"9999999999.99": "9999999999.99",
	} {
		got, ok := ParseMoney(text)
		if !ok || string(got) != want {
			t.Fatalf("price %q parses to %q, want %q (ok %v)", text, got, want, ok)
		}
	}
	for name, text := range map[string]string{
		"zero":         "0.00",
		"missing_frac": "25000",
		"one_decimal":  "25000.0",
		"three_dec":    "25000.001",
		"negative":     "-1.00",
		"padded":       "025000.00",
		"space":        " 25000.00",
		"exponent":     "1e3",
		"comma":        "25000,00",
		"empty":        "",
		"too_wide":     "10000000000.00",
		"nan":          "NaN",
	} {
		if got, ok := ParseMoney(text); ok {
			t.Errorf("a %s price must be refused, got %q", name, got)
		}
	}
	// A paid amount may be the canonical zero: a document settled by transfer only
	// carries 0.00 in cash.
	for text, want := range map[string]string{"0.00": "0.00", "124200.00": "124200.00"} {
		got, ok := ParseAmount(text)
		if !ok || string(got) != want {
			t.Fatalf("amount %q parses to %q, want %q (ok %v)", text, got, want, ok)
		}
	}
	for name, text := range map[string]string{
		"missing_frac": "0",
		"one_decimal":  "0.0",
		"negative":     "-0.01",
		"three_dec":    "0.001",
	} {
		if got, ok := ParseAmount(text); ok {
			t.Errorf("a %s amount must be refused, got %q", name, got)
		}
	}
}

// TestWeightText pins the weight contract: the request may send "12.4" and the answer
// is always "12.400"; a weight is above zero.
func TestWeightText(t *testing.T) {
	for text, want := range map[string]string{
		"12.4":          "12.400",
		"12.400":        "12.400",
		"12":            "12.000",
		"0.001":         "0.001",
		"999999999":     "999999999.000",
		"999999999.999": "999999999.999",
	} {
		got, ok := ParseWeight(text)
		if !ok || string(got) != want {
			t.Fatalf("weight %q parses to %q, want %q (ok %v)", text, got, want, ok)
		}
	}
	for name, text := range map[string]string{
		"zero":        "0",
		"zero_scaled": "0.000",
		"negative":    "-1.000",
		"four_dec":    "12.4005",
		"trailing":    "12.",
		"leading":     ".5",
		"padded":      "012.4",
		"comma":       "12,4",
		"empty":       "",
		"too_wide":    "1000000000.000",
		"space":       " 12.4",
	} {
		if got, ok := ParseWeight(text); ok {
			t.Errorf("a %s weight must be refused, got %q", name, got)
		}
	}
}

// TestValidateDocument proves the admitted document: the model is canonical, the weight
// has three decimals, both amounts are derived and the total is the sum of the lines.
func TestValidateDocument(t *testing.T) {
	payload, err := Validate(validInput())
	if err != nil {
		t.Fatalf("a complete purchase must be admitted: %v", err)
	}
	if payload.Total != Money("124200.00") || payload.PaidCash != "124200.00" ||
		payload.PaidTransfer != "0.00" {
		t.Fatalf("the document does not add up: %+v", payload)
	}
	if len(payload.UsedLines) != 1 || payload.UsedLines[0] != (UsedLine{Model: "NS60ZL",
		Quantity: 1, UnitPrice: "25000.00", Amount: "25000.00"}) {
		t.Fatalf("the used line was not derived exactly: %+v", payload.UsedLines)
	}
	if len(payload.ScrapLines) != 1 || payload.ScrapLines[0] != (ScrapLine{MaterialID: 1,
		Kg: "12.400", PricePerKg: "8000.00", Amount: "99200.00"}) {
		t.Fatalf("the scrap line was not derived exactly: %+v", payload.ScrapLines)
	}
	// The canonical lines are ordered by model code and by material id, and the
	// caller's slice is never modified.
	shuffled := validInput()
	shuffled.UsedLines = []UsedLineInput{{"M2", 1, "100.00"}, {"M1", 1, "100.00"}}
	shuffled.ScrapLines = []ScrapLineInput{{2, "1", "100.00"}, {1, "1", "100.00"}}
	shuffled.PaidCash = "400.00"
	shuffled.PaidTransfer = "0.00"
	ordered, err := Validate(shuffled)
	if err != nil {
		t.Fatalf("the ordered document must be admitted: %v", err)
	}
	if ordered.UsedLines[0].Model != "M1" || ordered.UsedLines[1].Model != "M2" ||
		ordered.ScrapLines[0].MaterialID != 1 || ordered.ScrapLines[1].MaterialID != 2 {
		t.Fatalf("the canonical lines are not ordered: %+v %+v", ordered.UsedLines, ordered.ScrapLines)
	}
	if shuffled.UsedLines[0].Model != "M2" {
		t.Fatal("the caller's slice must never be reordered")
	}
	// One kind alone is a purchase too: a customer who only comes to sell.
	usedOnly := validInput()
	usedOnly.ScrapLines = nil
	usedOnly.PaidCash = "25000.00"
	if _, err := Validate(usedOnly); err != nil {
		t.Fatalf("a used purchase alone must be admitted: %v", err)
	}
	scrapOnly := validInput()
	scrapOnly.UsedLines = nil
	scrapOnly.PaidCash = "0.00"
	scrapOnly.PaidTransfer = "99200.00"
	if _, err := Validate(scrapOnly); err != nil {
		t.Fatalf("a scrap purchase alone must be admitted: %v", err)
	}
}

// TestScrapRoundingIsHalfUp pins the rounding the contract accepts: kg * price_per_kg
// rounded half up to the cent, computed in integer arithmetic and never with a float.
func TestScrapRoundingIsHalfUp(t *testing.T) {
	for _, tc := range []struct{ kg, price, amount string }{
		{"12.400", "8000.00", "99200.00"},
		{"1.005", "1.00", "1.01"},
		{"2.005", "1.00", "2.01"},
		{"0.005", "1.00", "0.01"},
		{"0.004", "1.00", "0.00"},
		{"0.001", "0.01", "0.00"},
		{"3.333", "0.03", "0.10"},
		{"0.500", "0.01", "0.01"},
		{"0.499", "0.01", "0.00"},
		{"999999999.999", "1000000000.00", ""},
	} {
		kg, ok := ParseWeight(tc.kg)
		if !ok {
			t.Fatalf("the weight fixture %q must be admitted", tc.kg)
		}
		price, ok := ParseMoney(tc.price)
		if !ok {
			t.Fatalf("the price fixture %q must be admitted", tc.price)
		}
		amount, ok := scrapAmount(kg, price)
		if tc.amount == "" {
			// A product outside numeric(12,2) is refused, never wrapped or truncated.
			if ok {
				t.Fatalf("%s kg at %s must be refused, got %s", tc.kg, tc.price, amount)
			}
			continue
		}
		if !ok || string(amount) != tc.amount {
			t.Fatalf("%s kg at %s gives %q, want %q (ok %v)", tc.kg, tc.price, amount, tc.amount, ok)
		}
		// A negative weight is the counter-document's own line: the amount is exactly
		// the negation of the positive one, so the pair nets out to zero.
		negated, ok := scrapAmount(Weight("-"+string(kg)), price)
		if !ok || string(negated) != negatedText(string(amount)) {
			t.Fatalf("the counter amount of %s kg at %s is %q, want %q (ok %v)",
				tc.kg, tc.price, negated, negatedText(string(amount)), ok)
		}
	}
}

// TestUsedAmountIsExact proves the used line amount: the quantity times the price,
// exact, with the money range refused instead of wrapped.
func TestUsedAmountIsExact(t *testing.T) {
	for _, tc := range []struct {
		quantity int64
		price    string
		amount   string
	}{
		{1, "25000.00", "25000.00"},
		{3, "25000.00", "75000.00"},
		{1_000_000, "100.00", "100000000.00"},
		{2, "4999999999.99", "9999999999.98"},
		{1_000_000, "1000000000.00", ""},
	} {
		price, ok := ParseMoney(tc.price)
		if !ok {
			t.Fatalf("the price fixture %q must be admitted", tc.price)
		}
		amount, ok := usedAmount(tc.quantity, price)
		if tc.amount == "" {
			if ok {
				t.Fatalf("%d at %s must be refused, got %s", tc.quantity, tc.price, amount)
			}
			continue
		}
		if !ok || string(amount) != tc.amount {
			t.Fatalf("%d at %s gives %q, want %q (ok %v)", tc.quantity, tc.price, amount, tc.amount, ok)
		}
		// The counter-document negates the quantity and gets exactly the negation.
		if got, ok := usedAmount(-tc.quantity, price); !ok || string(got) != negatedText(tc.amount) {
			t.Fatalf("the counter amount of %d at %s gives %q (ok %v)", tc.quantity, tc.price, got, ok)
		}
	}
}

// negatedText renders the negation of a canonical amount without a float. Zero has no
// sign, exactly like a counter-document of a zero paid side.
func negatedText(amount string) string {
	if strings.HasPrefix(amount, "-") {
		return amount[1:]
	}
	if amount == "0.00" {
		return amount
	}
	return "-" + amount
}

// TestValidateRefusals proves every rule of the contract is refused before any database
// work, and that a refused document says so as an invalid purchase.
func TestValidateRefusals(t *testing.T) {
	broken := map[string]func(*CreateInput){
		"no_lines":            func(in *CreateInput) { in.UsedLines, in.ScrapLines = nil, nil },
		"empty_used_model":    func(in *CreateInput) { in.UsedLines[0].Model = "  " },
		"bad_model":           func(in *CreateInput) { in.UsedLines[0].Model = "-NS60" },
		"duplicate_model":     func(in *CreateInput) { in.UsedLines = append(in.UsedLines, UsedLineInput{"NS60ZL", 1, "25000.00"}) },
		"zero_quantity":       func(in *CreateInput) { in.UsedLines[0].Quantity = 0 },
		"negative_quantity":   func(in *CreateInput) { in.UsedLines[0].Quantity = -1 },
		"quantity_bound":      func(in *CreateInput) { in.UsedLines[0].Quantity = 1_000_001 },
		"price_not_canonical": func(in *CreateInput) { in.UsedLines[0].UnitPrice = "25000" },
		"price_zero":          func(in *CreateInput) { in.UsedLines[0].UnitPrice = "0.00" },
		"price_too_wide":      func(in *CreateInput) { in.UsedLines[0].UnitPrice = "10000000000.00" },
		"amount_too_wide": func(in *CreateInput) {
			in.UsedLines = []UsedLineInput{{"NS60ZL", 1_000_000, "1000000000.00"}}
		},
		"kg_zero":            func(in *CreateInput) { in.ScrapLines[0].Kg = "0.000" },
		"kg_four_decimals":   func(in *CreateInput) { in.ScrapLines[0].Kg = "12.4005" },
		"kg_not_canonical":   func(in *CreateInput) { in.ScrapLines[0].Kg = "12." },
		"material_negative":  func(in *CreateInput) { in.ScrapLines[0].MaterialID = -1 },
		"material_too_wide":  func(in *CreateInput) { in.ScrapLines[0].MaterialID = 1 << 20 },
		"material_zero":      func(in *CreateInput) { in.ScrapLines[0].MaterialID = 0 },
		"material_duplicate": func(in *CreateInput) { in.ScrapLines = append(in.ScrapLines, ScrapLineInput{1, "1.000", "8000.00"}) },
		"settlement_short":   func(in *CreateInput) { in.PaidCash = "124199.99" },
		"settlement_over":    func(in *CreateInput) { in.PaidCash = "124200.01" },
		"paid_not_canonical": func(in *CreateInput) { in.PaidCash = "124200" },
		"paid_negative":      func(in *CreateInput) { in.PaidCash = "-1.00" },
		"paid_absorbed": func(in *CreateInput) {
			in.PaidCash, in.PaidTransfer = "124200.00", "0.01"
		},
		"key_short":     func(in *CreateInput) { in.OperationKey = "short" },
		"key_character": func(in *CreateInput) { in.OperationKey = "5f0b1c2d3e4f5a6!" },
		"note_long":     func(in *CreateInput) { in.Note = strings.Repeat("ñ", 501) },
	}
	for name, transform := range broken {
		input := validInput()
		transform(&input)
		if _, err := Validate(input); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s must be an invalid purchase, got %v", name, err)
		}
	}
	// At most one hundred ninety lines per kind.
	many := validInput()
	many.UsedLines = make([]UsedLineInput, 0, MaxLines)
	for i := 0; i < MaxLines; i++ {
		many.UsedLines = append(many.UsedLines, UsedLineInput{fmt.Sprintf("M%03d", i), 1, "100.00"})
	}
	// The settlement is the sum of the lines, so the fixture closes on 190 lines.
	many.PaidCash = Money(fmt.Sprintf("%d.00", 190*100+99200))
	if _, err := Validate(many); err != nil {
		t.Fatalf("one hundred ninety lines must be admitted: %v", err)
	}
	many.UsedLines = append(many.UsedLines, UsedLineInput{"M999", 1, "100.00"})
	if _, err := Validate(many); !errors.Is(err, ErrInvalid) {
		t.Fatalf("one hundred ninety one lines must be refused, got %v", err)
	}
}

// TestSettlementMismatchNamesTheOpenSide proves the refusal of a document whose paid
// amounts do not close: it names what is missing or left over and stays an invalid
// purchase for every caller that already understands it.
func TestSettlementMismatchNamesTheOpenSide(t *testing.T) {
	short := validInput()
	short.PaidCash, short.PaidTransfer = "120000.00", "0.00"
	_, err := Validate(short)
	var mismatch *TotalsMismatch
	if !errors.As(err, &mismatch) || !errors.Is(err, ErrInvalid) {
		t.Fatalf("a short settlement must be a totals mismatch: %v", err)
	}
	if mismatch.Missing != Money("4200.00") || mismatch.Excess != "" {
		t.Fatalf("the refusal must name what is missing: %+v", mismatch)
	}
	over := validInput()
	over.PaidCash, over.PaidTransfer = "124200.00", "10.00"
	if _, err = Validate(over); !errors.As(err, &mismatch) || mismatch.Excess != "10.00" || mismatch.Missing != "" {
		t.Fatalf("the refusal must name what is left over: %v %+v", err, mismatch)
	}
}

// TestCanonicalReason pins the mandatory reason of a counter-document.
func TestCanonicalReason(t *testing.T) {
	for text, want := range map[string]string{
		"pesaje mal tipeado":     "pesaje mal tipeado",
		"  pesaje mal tipeado  ": "pesaje mal tipeado",
		strings.Repeat("ñ", 500): strings.Repeat("ñ", 500),
	} {
		got, ok := CanonicalReason(text)
		if !ok || got != want {
			t.Fatalf("reason %q canonicalizes to %q (ok %v)", text, got, ok)
		}
	}
	for name, text := range map[string]string{
		"empty":    "",
		"blank":    "   ",
		"too_long": strings.Repeat("ñ", 501),
		"nul":      "pesaje\x00",
	} {
		if got, ok := CanonicalReason(text); ok {
			t.Errorf("a %s reason must be refused, got %q", name, got)
		}
	}
}

// TestValidPage pins the frozen read contract of the page.
func TestValidPage(t *testing.T) {
	for _, ok := range [][2]int{{1, 10}, {1, 25}, {1, 50}, {1_000_000, 25}} {
		if !ValidPage(ok[0], ok[1]) {
			t.Fatalf("page %d/%d must be admitted", ok[0], ok[1])
		}
	}
	for _, refused := range [][2]int{{0, 25}, {1_000_001, 25}, {1, 1}, {1, 20}, {1, 100}, {-1, 10}} {
		if ValidPage(refused[0], refused[1]) {
			t.Fatalf("page %d/%d must be refused", refused[0], refused[1])
		}
	}
}

// TestValidOperationKey pins the idempotency key: the database's own pattern, checked
// before any database work.
func TestValidOperationKey(t *testing.T) {
	if !ValidOperationKey("5f0b1c2d3e4f5a6b") || !ValidOperationKey(strings.Repeat("a", 128)) {
		t.Fatal("an admitted operation key was refused")
	}
	for _, refused := range []string{"", "short", strings.Repeat("a", 129), "5f0b1c2d3e4f5a6!", "5f0b1c2d3e4f5a b"} {
		if ValidOperationKey(refused) {
			t.Fatalf("operation key %q must be refused", refused)
		}
	}
}

// TestMapFailure publishes the database's own decision and nothing else: SQLSTATE is the
// only trusted evidence, and cancellation keeps its semantics.
func TestMapFailure(t *testing.T) {
	for code, want := range map[string]error{
		"LP001": ErrForbidden,
		"LP002": ErrInvalid,
		"LP003": ErrInvalid,
		"LP005": ErrInvalid,
		"LP004": ErrAlreadyReversed,
	} {
		if got := mapFailure(context.Background(), &pgconn.PgError{Code: code}); !errors.Is(got, want) {
			t.Fatalf("%s maps to %v, want %v", code, got, want)
		}
	}
	// The unique index is the second producer of the already-reversed refusal, because
	// the admission trigger refuses the duplicate before it ever reaches the index.
	if got := mapFailure(context.Background(), &pgconn.PgError{Code: "23505",
		ConstraintName: "purchases_single_reversal"}); !errors.Is(got, ErrAlreadyReversed) {
		t.Fatalf("the reversal index must publish the already-reversed refusal, got %v", got)
	}
	for name, err := range map[string]error{
		"other_unique": &pgconn.PgError{Code: "23505", ConstraintName: "purchases_operation_key_key"},
		"foreign_key":  &pgconn.PgError{Code: "23503"},
		"check":        &pgconn.PgError{Code: "23502"},
		"unknown":      errors.New("connection reset"),
		"plpgsql":      &pgconn.PgError{Code: "P0001"},
	} {
		if got := mapFailure(context.Background(), err); !errors.Is(got, ErrUnavailable) {
			t.Fatalf("a %s failure must fail closed, got %v", name, got)
		}
	}
	if got := mapFailure(context.Background(), nil); got != nil {
		t.Fatalf("a nil failure stays nil, got %v", got)
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if got := mapFailure(cancelled, &pgconn.PgError{Code: "LP001"}); !errors.Is(got, context.Canceled) {
		t.Fatalf("cancellation keeps its semantics, got %v", got)
	}
}
