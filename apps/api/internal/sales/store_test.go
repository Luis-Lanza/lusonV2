package sales_test

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/bootstrap"
	"luson/api/internal/catalog"
	"luson/api/internal/config"
	"luson/api/internal/pricing"
	"luson/api/internal/sales"
	"luson/api/internal/testpg"
)

// env is one isolated database with the branch price list and the point of sale on
// top of it. Without an admitted LUSON_TEST_PG_MANIFEST every database test below
// fails closed at testpg.Open and that is the expected local outcome.
type env struct {
	ctx    context.Context
	pool   *pgxpool.Pool
	store  *sales.Store
	prices *pricing.Store
}

func fixture(t *testing.T) *env {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	if bootstrap.Initialize(ctx, p, config.LocalTrial) != nil {
		t.Fatal("test initialization failed")
	}
	credentials := make([]bootstrap.Credentials, 3)
	for i := range credentials {
		credentials[i] = bootstrap.Credentials{Username: "u" + testpg.Random(t)[:20], Password: testpg.Random(t)}
	}
	if bootstrap.Provision(ctx, p, credentials) != nil {
		t.Fatal("test account provisioning failed")
	}
	return &env{ctx: ctx, pool: p, store: sales.New(p), prices: pricing.New(p)}
}

// warehouse is the Almacén session: it administers prices but never sells.
func warehouse() auth.Identity {
	return auth.Identity{AccountID: 1, Location: auth.Location{ID: 1}}
}

// clerk is the provisioned session of one branch: bootstrap assigns account N to
// location N.
func clerk(location int) auth.Identity {
	return auth.Identity{AccountID: location, Location: auth.Location{ID: location}}
}

// price writes one branch pair, reusing the price store so the fixture writes exactly
// what the Catálogo writes. The value of the write is the battery, so this prices the
// catalogue entry and therefore both of its polarities. No product warranty term is
// written: the term is the seller's at the counter, so the sale must not need one
// stored anywhere.
func (e *env) price(t *testing.T, entryID int64, min, suggested string, branches ...int64) {
	t.Helper()
	if _, err := e.prices.Write(e.ctx, warehouse(), pricing.WriteInput{
		CatalogEntryID: entryID,
		MinPrice:       pricing.Money(min),
		SuggestedPrice: pricing.Money(suggested),
		BranchIDs:      branches,
	}); err != nil {
		t.Fatalf("price fixture for battery %d failed: %v", entryID, err)
	}
}

// entryOf reads the battery of a seed variant from the catalogue, so a test never
// guesses which entry a polarity belongs to.
func (e *env) entryOf(t *testing.T, variantID int64) int64 {
	t.Helper()
	var entry int64
	if e.pool.QueryRow(e.ctx, "SELECT catalog_entry_id FROM catalog_variants WHERE id=$1",
		int32(variantID)).Scan(&entry) != nil {
		t.Fatal("catalogue entry read failed")
	}
	return entry
}

// polaritiesOf reads the polarities of one battery, so the L/R assertions below are
// derived from the catalogue instead of being hardcoded.
func (e *env) polaritiesOf(t *testing.T, entryID int64) []string {
	t.Helper()
	rows, err := e.pool.Query(e.ctx, "SELECT polarity FROM catalog_variants WHERE catalog_entry_id=$1 ORDER BY polarity",
		int32(entryID))
	if err != nil {
		t.Fatal("polarity read failed")
	}
	defer rows.Close()
	result := []string{}
	for rows.Next() {
		var polarity string
		if rows.Scan(&polarity) != nil {
			t.Fatal("polarity read failed")
		}
		result = append(result, polarity)
	}
	if rows.Err() != nil {
		t.Fatal("polarity read failed")
	}
	return result
}

// stock reads the branch's own balance row straight from the database.
func (e *env) stock(t *testing.T, locationID, variantID int64) (existing, reserved int64) {
	t.Helper()
	if e.pool.QueryRow(e.ctx, "SELECT existing,reserved FROM inventory_balances WHERE location_id=$1 AND variant_id=$2",
		int16(locationID), int32(variantID)).Scan(&existing, &reserved) != nil {
		t.Fatal("balance read failed")
	}
	return existing, reserved
}

// setStock places a balance the sale must respect: reserved is never written by a
// sale, so the fixture sets it.
func (e *env) setStock(t *testing.T, locationID, variantID, existing, reserved int64) {
	t.Helper()
	if _, err := e.pool.Exec(e.ctx, "UPDATE inventory_balances SET existing=$3,reserved=$4 WHERE location_id=$1 AND variant_id=$2",
		int16(locationID), int32(variantID), existing, reserved); err != nil {
		t.Fatalf("balance fixture failed: %v", err)
	}
}

// zeroStockVariant is a variant the branch holds no stock of, so an exhausted sale is
// proven against the seed rather than against an invented number.
func (e *env) zeroStockVariant(t *testing.T, locationID int64) int64 {
	t.Helper()
	var variant int64
	err := e.pool.QueryRow(e.ctx, "SELECT variant_id FROM inventory_balances WHERE location_id=$1 AND existing=0 ORDER BY variant_id LIMIT 1",
		int16(locationID)).Scan(&variant)
	if err != nil {
		t.Fatal("no zero-stock variant in this branch")
	}
	return variant
}

// snapshot captures every table a sale writes, so a refused sale is proven to leave
// nothing behind, stock included.
func (e *env) snapshot(t *testing.T) string {
	t.Helper()
	var data string
	err := e.pool.QueryRow(e.ctx, `SELECT jsonb_build_object(
  'sales',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]'::jsonb) FROM sales s),
  'lines',(SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.sale_id,l.variant_id),'[]'::jsonb) FROM sale_lines l),
  'balances',(SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.location_id,b.variant_id),'[]'::jsonb) FROM inventory_balances b))::text`).Scan(&data)
	if err != nil {
		t.Fatal("sale snapshot failed")
	}
	return data
}

func (e *env) scalar(t *testing.T, query string, args ...any) int64 {
	t.Helper()
	var n int64
	if e.pool.QueryRow(e.ctx, query, args...).Scan(&n) != nil {
		t.Fatal("scalar query failed")
	}
	return n
}

// createBranch reuses the branch allocation entrypoint, so a fixture branch carries
// the same zero-stock matrix a created branch has and no provisioned account.
func (e *env) createBranch(t *testing.T, name string) int64 {
	t.Helper()
	var id int64
	if err := e.pool.QueryRow(e.ctx, "SELECT create_branch($1)", name).Scan(&id); err != nil {
		t.Fatal("branch fixture creation failed")
	}
	return id
}

// sale is the canonical shape of a one-line sale used by most tests: one cash payment
// for exactly the total of the document. The warranty term is the seller's own input of
// the sale.
func sale(variantID, quantity int64, unit string) sales.CreateInput {
	total, err := sales.LineTotal(sales.Money(unit), quantity)
	if err != nil {
		panic("fixture sale amount is not canonical: " + err.Error())
	}
	return sales.CreateInput{
		Payments: []sales.Payment{{Method: sales.PaymentCash, Amount: total}},
		Customer: sales.Customer{Name: "Cliente Mostrador"},
		Lines: []sales.LineInput{{VariantID: variantID, Quantity: quantity,
			UnitPrice: sales.Money(unit), WarrantyMonths: 6}},
	}
}

// cashPayment is one cash payment that pays the whole document, the shape the pure
// contract's refusals are written in.
func cashPayment(amount string) []sales.Payment {
	return []sales.Payment{{Method: sales.PaymentCash, Amount: sales.Money(amount)}}
}

// TestSaleMoneyArithmetic pins the money contract: the subtotal of a line and the
// total of a document are exact integer-cent arithmetic, never a binary float, and
// nothing outside numeric(12,2) is ever produced.
func TestSaleMoneyArithmetic(t *testing.T) {
	for name, tc := range map[string]struct {
		unit     sales.Money
		quantity int64
		want     string
	}{
		"single":       {"85000.00", 1, "85000.00"},
		"multiple":     {"85000.00", 2, "170000.00"},
		"cents":        {"0.01", 1, "0.01"},
		"fractional":   {"85000.50", 3, "255001.50"},
		"carry":        {"0.10", 3, "0.30"},
		"large_qty":    {"1000.00", 1000, "1000000.00"},
		"max_quantity": {"1.00", sales.MaxQuantity, "1000000.00"},
	} {
		got, err := sales.LineTotal(tc.unit, tc.quantity)
		if err != nil || string(got) != tc.want || got.String() != tc.want {
			t.Fatalf("%s must total %s, got %q (%v)", name, tc.want, got, err)
		}
	}
	for name, tc := range map[string]struct {
		unit     sales.Money
		quantity int64
	}{
		"zero_quantity":    {"85000.00", 0},
		"negative":         {"85000.00", -1},
		"above_bound":      {"85000.00", sales.MaxQuantity + 1},
		"not_canonical":    {"85000", 1},
		"three_decimals":   {"85000.001", 1},
		"zero_amount":      {"0.00", 1},
		"empty":            {"", 1},
		"overflow_numeric": {"9999999999.99", 2},
		"overflow_int64":   {"9999999999.99", sales.MaxQuantity},
	} {
		if _, err := sales.LineTotal(tc.unit, tc.quantity); !errors.Is(err, sales.ErrInvalid) {
			t.Fatalf("%s must be refused", name)
		}
	}
}

// TestSaleValidate covers the pure document contract: the payments, the client bounds,
// unique variants, bounded quantities, canonical amounts and the exact total.
func TestSaleValidate(t *testing.T) {
	// A mixed sale: the payments are stated transfer-first and come back in the frozen
	// order cash, card, transfer, with the sum closing exactly against the total.
	payload, err := sales.Validate(sales.CreateInput{
		Payments: []sales.Payment{
			{Method: sales.PaymentTransfer, Amount: "200000.00"},
			{Method: sales.PaymentCash, Amount: "77001.00"},
		},
		Customer: sales.Customer{Name: "  Ana Pérez  ", Phone: "700-00000", Document: "V-123"},
		Lines: []sales.LineInput{
			{VariantID: 4, Quantity: 2, UnitPrice: "96000.5", WarrantyMonths: 12},
			{VariantID: 2, Quantity: 1, UnitPrice: "85000.00", WarrantyMonths: 6},
		},
	})
	if err != nil {
		t.Fatalf("a valid sale must be admitted: %v", err)
	}
	if payload.Customer.Name != "Ana Pérez" {
		t.Fatalf("the client name must be canonical: %q", payload.Customer.Name)
	}
	if len(payload.Lines) != 2 || payload.Lines[0].VariantID != 2 || payload.Lines[1].VariantID != 4 {
		t.Fatalf("lines must be in ascending variant order: %+v", payload.Lines)
	}
	if payload.Lines[1].UnitPrice != "96000.50" || payload.Lines[1].Subtotal != "192001.00" {
		t.Fatalf("the line must be canonical and exact: %+v", payload.Lines[1])
	}
	// The warranty term is the seller's own datum of the line, kept per line.
	if payload.Lines[0].WarrantyMonths != 6 || payload.Lines[1].WarrantyMonths != 12 {
		t.Fatalf("each line must keep the term the seller stated: %+v", payload.Lines)
	}
	if payload.Total != "277001.00" {
		t.Fatalf("the total must be the exact sum of the lines: %q", payload.Total)
	}
	// The payments are the frozen order cash, card, transfer, whatever order the client
	// stated them in, and only the methods that actually paid.
	if len(payload.Payments) != 2 ||
		payload.Payments[0] != (sales.Payment{Method: sales.PaymentCash, Amount: "77001.00"}) ||
		payload.Payments[1] != (sales.Payment{Method: sales.PaymentTransfer, Amount: "200000.00"}) {
		t.Fatalf("payments must come back in the frozen order: %+v", payload.Payments)
	}
	// Every admitted method pays a document on its own, and an absent phone or document
	// is legal: the warranty is issued to a name.
	for _, method := range sales.PaymentMethods() {
		valid, err := sales.Validate(sales.CreateInput{
			Payments: []sales.Payment{{Method: method, Amount: "1.00"}},
			Customer: sales.Customer{Name: "Cliente"},
			Lines:    []sales.LineInput{{VariantID: 1, Quantity: 1, UnitPrice: "1.00", WarrantyMonths: 6}},
		})
		if err != nil {
			t.Fatalf("%s must be admitted: %v", method, err)
		}
		if len(valid.Payments) != 1 || valid.Payments[0].Method != method {
			t.Fatalf("%s must be the only payment of the document: %+v", method, valid.Payments)
		}
	}
	// The caller's slice is never reordered by validation.
	input := []sales.LineInput{
		{VariantID: 3, Quantity: 1, UnitPrice: "1.00", WarrantyMonths: 6},
		{VariantID: 1, Quantity: 1, UnitPrice: "1.00", WarrantyMonths: 6},
	}
	if _, err := sales.Validate(sales.CreateInput{Payments: cashPayment("2.00"),
		Customer: sales.Customer{Name: "Cliente"}, Lines: input}); err != nil {
		t.Fatal("a valid sale must be admitted")
	}
	if input[0].VariantID != 3 || input[1].VariantID != 1 {
		t.Fatal("validation must not reorder the caller's lines")
	}
	for name, in := range map[string]sales.CreateInput{
		"no_payments":      {Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 1, UnitPrice: "1.00", WarrantyMonths: 6}}},
		"unknown_method":   {Payments: []sales.Payment{{Method: "cheque", Amount: "1.00"}}, Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 1, UnitPrice: "1.00", WarrantyMonths: 6}}},
		"method_case":      {Payments: []sales.Payment{{Method: "CASH", Amount: "1.00"}}, Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 1, UnitPrice: "1.00", WarrantyMonths: 6}}},
		"derived_label":    {Payments: []sales.Payment{{Method: sales.PaymentMixed, Amount: "1.00"}}, Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 1, UnitPrice: "1.00", WarrantyMonths: 6}}},
		"repeated_method":  {Payments: []sales.Payment{{Method: sales.PaymentCash, Amount: "1.00"}, {Method: sales.PaymentCash, Amount: "1.00"}}, Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 1, UnitPrice: "1.00", WarrantyMonths: 6}}},
		"zero_amount":      {Payments: []sales.Payment{{Method: sales.PaymentCash, Amount: "0.00"}}, Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 1, UnitPrice: "1.00", WarrantyMonths: 6}}},
		"negative_amount":  {Payments: []sales.Payment{{Method: sales.PaymentCash, Amount: "-1.00"}}, Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 1, UnitPrice: "1.00", WarrantyMonths: 6}}},
		"three_decimals":   {Payments: []sales.Payment{{Method: sales.PaymentCash, Amount: "1.000"}}, Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 1, UnitPrice: "1.00", WarrantyMonths: 6}}},
		"one_decimal":      {Payments: []sales.Payment{{Method: sales.PaymentCash, Amount: "1.0"}}, Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 1, UnitPrice: "1.00", WarrantyMonths: 6}}},
		"integer_amount":   {Payments: []sales.Payment{{Method: sales.PaymentCash, Amount: "1"}}, Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 1, UnitPrice: "1.00", WarrantyMonths: 6}}},
		"padded_amount":    {Payments: []sales.Payment{{Method: sales.PaymentCash, Amount: "001.00"}}, Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 1, UnitPrice: "1.00", WarrantyMonths: 6}}},
		"text_amount":      {Payments: []sales.Payment{{Method: sales.PaymentCash, Amount: "abc"}}, Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 1, UnitPrice: "1.00", WarrantyMonths: 6}}},
		"empty_amount":     {Payments: []sales.Payment{{Method: sales.PaymentCash, Amount: ""}}, Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 1, UnitPrice: "1.00", WarrantyMonths: 6}}},
		"no_customer":      {Payments: cashPayment("1.00"), Lines: []sales.LineInput{{VariantID: 1, Quantity: 1, UnitPrice: "1.00", WarrantyMonths: 6}}},
		"blank_customer":   {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "   "}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 1, UnitPrice: "1.00", WarrantyMonths: 6}}},
		"long_customer":    {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: strings.Repeat("ñ", sales.MaxCustomerName+1)}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 1, UnitPrice: "1.00", WarrantyMonths: 6}}},
		"nul_customer":     {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "a\x00b"}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 1, UnitPrice: "1.00", WarrantyMonths: 6}}},
		"long_phone":       {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "Cliente", Phone: strings.Repeat("7", sales.MaxCustomerPhone+1)}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 1, UnitPrice: "1.00", WarrantyMonths: 6}}},
		"long_document":    {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "Cliente", Document: strings.Repeat("7", sales.MaxCustomerDocument+1)}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 1, UnitPrice: "1.00", WarrantyMonths: 6}}},
		"no_lines":         {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "Cliente"}},
		"zero_variant":     {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: 0, Quantity: 1, UnitPrice: "1.00", WarrantyMonths: 6}}},
		"negative_variant": {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: -1, Quantity: 1, UnitPrice: "1.00", WarrantyMonths: 6}}},
		"variant_bound":    {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: 2147483648, Quantity: 1, UnitPrice: "1.00", WarrantyMonths: 6}}},
		"duplicate":        {Payments: cashPayment("3.00"), Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 1, UnitPrice: "1.00", WarrantyMonths: 6}, {VariantID: 1, Quantity: 2, UnitPrice: "1.00", WarrantyMonths: 6}}},
		"zero_quantity":    {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 0, UnitPrice: "1.00", WarrantyMonths: 6}}},
		"quantity_bound":   {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: 1, Quantity: sales.MaxQuantity + 1, UnitPrice: "1.00", WarrantyMonths: 6}}},
		"price_precision":  {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 1, UnitPrice: "85000.001", WarrantyMonths: 6}}},
		"price_negative":   {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 1, UnitPrice: "-1.00", WarrantyMonths: 6}}},
		"price_zero":       {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 1, UnitPrice: "0.00", WarrantyMonths: 6}}},
		"price_empty":      {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 1, UnitPrice: "", WarrantyMonths: 6}}},
		"price_text":       {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 1, UnitPrice: "abc", WarrantyMonths: 6}}},
		"no_term":          {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 1, UnitPrice: "1.00"}}},
		"negative_term":    {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 1, UnitPrice: "1.00", WarrantyMonths: -1}}},
		"term_above_bound": {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 1, UnitPrice: "1.00", WarrantyMonths: sales.MaxWarrantyMonths + 1}}},
	} {
		if _, err := sales.Validate(in); !errors.Is(err, sales.ErrInvalid) {
			t.Fatalf("%s must be refused by validation", name)
		}
	}
	// The line bound is the number of catalogue variants.
	tooMany := make([]sales.LineInput, 0, sales.MaxLines+1)
	for i := 0; i <= sales.MaxLines; i++ {
		tooMany = append(tooMany, sales.LineInput{VariantID: int64(i + 1), Quantity: 1, UnitPrice: "1.00", WarrantyMonths: 6})
	}
	if _, err := sales.Validate(sales.CreateInput{Payments: cashPayment("191.00"),
		Customer: sales.Customer{Name: "Cliente"}, Lines: tooMany}); !errors.Is(err, sales.ErrInvalid) {
		t.Fatal("a document above the line bound must be refused")
	}
	full := tooMany[:sales.MaxLines]
	if _, err := sales.Validate(sales.CreateInput{Payments: cashPayment("190.00"),
		Customer: sales.Customer{Name: "Cliente"}, Lines: full}); err != nil {
		t.Fatalf("a full-width document must be admitted: %v", err)
	}
}

// TestSalePaymentsMustClose pins S16's refusal of a settlement that does not close: the
// error says which side is open -- how much is missing or how much is left over -- and it
// is still the invalid-document refusal, so a caller can treat both the same way.
func TestSalePaymentsMustClose(t *testing.T) {
	line := []sales.LineInput{{VariantID: 1, Quantity: 1, UnitPrice: "1000.00", WarrantyMonths: 6}}
	for name, tc := range map[string]struct {
		payments []sales.Payment
		missing  sales.Money
		excess   sales.Money
	}{
		"short":        {[]sales.Payment{{Method: sales.PaymentCash, Amount: "400.00"}, {Method: sales.PaymentTransfer, Amount: "500.00"}}, "100.00", ""},
		"over":         {[]sales.Payment{{Method: sales.PaymentCash, Amount: "400.00"}, {Method: sales.PaymentTransfer, Amount: "900.00"}}, "", "300.00"},
		"short_single": {[]sales.Payment{{Method: sales.PaymentCard, Amount: "999.99"}}, "0.01", ""},
		"over_single":  {[]sales.Payment{{Method: sales.PaymentCard, Amount: "1000.01"}}, "", "0.01"},
	} {
		_, err := sales.Validate(sales.CreateInput{Payments: tc.payments,
			Customer: sales.Customer{Name: "Cliente"}, Lines: line})
		var mismatch *sales.PaymentsMismatch
		if !errors.As(err, &mismatch) {
			t.Fatalf("%s must be named as a payments mismatch: %v", name, err)
		}
		if !errors.Is(err, sales.ErrInvalid) {
			t.Fatalf("%s must stay the invalid-document refusal", name)
		}
		if mismatch.Missing != tc.missing || mismatch.Excess != tc.excess {
			t.Fatalf("%s must name missing %q and excess %q, got %q/%q", name, tc.missing, tc.excess,
				mismatch.Missing, mismatch.Excess)
		}
		// Exactly one side is ever set, so a client never has to guess which one to show.
		if (mismatch.Missing == "") == (mismatch.Excess == "") {
			t.Fatalf("%s must set exactly one side of the mismatch", name)
		}
		// The message names the amount, so the counter can say what is left to pay or what
		// was charged too much without re-deriving it.
		side := string(tc.missing) + string(tc.excess)
		if !strings.Contains(mismatch.Error(), side) {
			t.Fatalf("%s message must name %q: %q", name, side, mismatch.Error())
		}
	}
}

// TestSaleValidQueries pins the read filters before any SQL is sent.
func TestSaleValidQueries(t *testing.T) {
	for name, tc := range map[string]struct {
		query sales.ListQuery
		ok    bool
	}{
		"defaults": {sales.ListQuery{Page: 1, PageSize: 25}, true},
		"filters":  {sales.ListQuery{Search: "2-000001", PaymentMethod: "card", Page: 2, PageSize: 10}, true},
		// A mixed sale is a real row of the history, so its derived label is a filter a
		// branch can use, even though no client can ever state it as an input.
		"mixed":       {sales.ListQuery{PaymentMethod: "mixed", Page: 1, PageSize: 10}, true},
		"cash":        {sales.ListQuery{PaymentMethod: "cash", Page: 1, PageSize: 10}, true},
		"bound_page":  {sales.ListQuery{Page: 1_000_000, PageSize: 50}, true},
		"zero_page":   {sales.ListQuery{Page: 0, PageSize: 10}, false},
		"over_page":   {sales.ListQuery{Page: 1_000_001, PageSize: 10}, false},
		"bad_size":    {sales.ListQuery{Page: 1, PageSize: 15}, false},
		"bad_method":  {sales.ListQuery{PaymentMethod: "cheque", Page: 1, PageSize: 10}, false},
		"long_search": {sales.ListQuery{Search: strings.Repeat("a", 129), Page: 1, PageSize: 10}, false},
		"nul_search":  {sales.ListQuery{Search: "a\x00b", Page: 1, PageSize: 10}, false},
	} {
		if got := sales.ValidListQuery(tc.query); got != tc.ok {
			t.Fatalf("%s must be %v", name, tc.ok)
		}
	}
	for name, tc := range map[string]struct {
		query sales.SellableQuery
		ok    bool
	}{
		"defaults":    {sales.SellableQuery{Page: 1, PageSize: 10}, true},
		"all_filters": {sales.SellableQuery{Search: "ns60", Brand: "TOYO", Capacity: "45", Polarity: "L", Page: 2, PageSize: 25}, true},
		"fractional":  {sales.SellableQuery{Capacity: "6.5", Page: 1, PageSize: 50}, true},
		"polarity":    {sales.SellableQuery{Polarity: "X", Page: 1, PageSize: 10}, false},
		"capacity":    {sales.SellableQuery{Capacity: "6,5", Page: 1, PageSize: 10}, false},
		"long_brand":  {sales.SellableQuery{Brand: strings.Repeat("ñ", 129), Page: 1, PageSize: 10}, false},
		"bad_size":    {sales.SellableQuery{Page: 1, PageSize: 20}, false},
	} {
		if got := sales.ValidSellableQuery(tc.query); got != tc.ok {
			t.Fatalf("%s must be %v", name, tc.ok)
		}
	}
}

// TestSaleStoreGuards proves the actor resolution: the warehouse never sells, a
// session that is not provisioned to the branch it claims is refused, and no refused
// call writes anything.
func TestSaleStoreGuards(t *testing.T) {
	e := fixture(t)
	e.price(t, e.entryOf(t, 1), "85000", "96000", 2)
	in := sale(1, 1, "85000.00")
	list := sales.ListQuery{Page: 1, PageSize: 25}
	catalogue := sales.SellableQuery{Page: 1, PageSize: 25}
	nilPool := sales.New(nil)
	var nilStore *sales.Store
	// Every entry point fails closed on a missing context, pool or store.
	for name, call := range map[string]func() error{
		"create_nil_pool":    func() error { _, err := nilPool.Create(e.ctx, clerk(2), in); return err },
		"create_nil_ctx":     func() error { _, err := nilPool.Create(nil, clerk(2), in); return err },
		"create_nil_store":   func() error { _, err := nilStore.Create(e.ctx, clerk(2), in); return err },
		"list_nil_pool":      func() error { _, err := nilPool.List(e.ctx, clerk(2), list); return err },
		"list_nil_store":     func() error { _, err := nilStore.List(e.ctx, clerk(2), list); return err },
		"read_nil_pool":      func() error { _, err := nilPool.Read(e.ctx, clerk(2), 1); return err },
		"read_nil_store":     func() error { _, err := nilStore.Read(e.ctx, clerk(2), 1); return err },
		"sellable_nil_pool":  func() error { _, err := nilPool.Sellable(e.ctx, clerk(2), catalogue); return err },
		"sellable_nil_store": func() error { _, err := nilStore.Sellable(e.ctx, clerk(2), catalogue); return err },
	} {
		if err := call(); !errors.Is(err, sales.ErrUnavailable) {
			t.Fatalf("%s must fail closed", name)
		}
	}
	pending := clerk(2)
	pending.MustChangePassword = true
	unprovisioned := e.createBranch(t, "Sucursal Sin Cuenta")
	before := e.snapshot(t)
	for name, actor := range map[string]auth.Identity{
		"warehouse":             warehouse(),
		"warehouse_of_branch":   {AccountID: 2, Location: auth.Location{ID: 1}},
		"clerk_of_other_branch": {AccountID: 2, Location: auth.Location{ID: 3}},
		"unprovisioned_branch":  {AccountID: 2, Location: auth.Location{ID: int(unprovisioned)}},
		"unknown_account":       {AccountID: 99, Location: auth.Location{ID: 2}},
		"no_identity":           {},
		"password_change":       pending,
	} {
		if _, err := e.store.Create(e.ctx, actor, in); !errors.Is(err, sales.ErrForbidden) {
			t.Fatalf("%s create must be forbidden", name)
		}
		if _, err := e.store.List(e.ctx, actor, list); !errors.Is(err, sales.ErrForbidden) {
			t.Fatalf("%s list must be forbidden", name)
		}
		if _, err := e.store.Read(e.ctx, actor, 1); !errors.Is(err, sales.ErrForbidden) {
			t.Fatalf("%s read must be forbidden", name)
		}
		if _, err := e.store.Sellable(e.ctx, actor, catalogue); !errors.Is(err, sales.ErrForbidden) {
			t.Fatalf("%s catalogue must be forbidden", name)
		}
	}
	if e.snapshot(t) != before {
		t.Fatal("a refused actor must not change any stored value")
	}
	// A pure request shape is refused before the first statement.
	for name, bad := range map[string]sales.CreateInput{
		"unknown_method": {Payments: []sales.Payment{{Method: "cheque", Amount: "85000.00"}}, Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 1, UnitPrice: "85000.00", WarrantyMonths: 6}}},
		"no_payments":    {Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 1, UnitPrice: "85000.00", WarrantyMonths: 6}}},
		"open_sum":       {Payments: cashPayment("84999.99"), Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 1, UnitPrice: "85000.00", WarrantyMonths: 6}}},
		"no_lines":       {Payments: cashPayment("85000.00"), Customer: sales.Customer{Name: "Cliente"}},
		"bad_price":      {Payments: cashPayment("85000.00"), Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 1, UnitPrice: "85000.001", WarrantyMonths: 6}}},
	} {
		if _, err := e.store.Create(e.ctx, clerk(2), bad); !errors.Is(err, sales.ErrInvalid) {
			t.Fatalf("%s must be an invalid request", name)
		}
	}
	for name, query := range map[string]sales.ListQuery{
		"bad_page":   {Page: 0, PageSize: 25},
		"bad_method": {PaymentMethod: "cheque", Page: 1, PageSize: 25},
	} {
		if _, err := e.store.List(e.ctx, clerk(2), query); !errors.Is(err, sales.ErrInvalid) {
			t.Fatalf("%s must be an invalid request", name)
		}
	}
	if _, err := e.store.Sellable(e.ctx, clerk(2), sales.SellableQuery{Page: 1, PageSize: 20}); !errors.Is(err, sales.ErrInvalid) {
		t.Fatal("an inadmissible catalogue page must be refused")
	}
	if e.snapshot(t) != before {
		t.Fatal("an invalid request must not change any stored value")
	}
	// A branch without any sale has no document to read.
	if _, err := e.store.Read(e.ctx, clerk(2), 0); !errors.Is(err, sales.ErrNotFound) {
		t.Fatal("an impossible sale id must be not found")
	}
	if _, err := e.store.Read(e.ctx, clerk(2), 1); !errors.Is(err, sales.ErrNotFound) {
		t.Fatal("an unknown sale must be not found")
	}
}

// TestSaleVariantWithoutPrice pins S7 in the store: a variant without a pair in the
// branch is not sellable, and nothing is written.
func TestSaleVariantWithoutPrice(t *testing.T) {
	e := fixture(t)
	// Only the battery of variant 1 is priced in branch 2, so variant 3 (another
	// battery) is not sellable while both polarities of variant 1's battery are.
	e.price(t, e.entryOf(t, 1), "85000", "96000", 2)
	unpriced := e.entryOf(t, 3)
	if priced := e.entryOf(t, 1); priced == unpriced {
		t.Fatal("the fixture needs two different batteries")
	}
	before := e.snapshot(t)
	_, err := e.store.Create(e.ctx, clerk(2), sale(3, 1, "85000.00"))
	var refused *sales.NotSellable
	if !errors.As(err, &refused) || refused.VariantID != 3 {
		t.Fatalf("a polarity of an unpriced battery must be named as not sellable: %v", err)
	}
	if !errors.Is(err, sales.ErrNotSellable) {
		t.Fatal("a variant without a price is not sellable")
	}
	if e.snapshot(t) != before {
		t.Fatal("a not sellable variant must not write a sale nor touch stock")
	}
	// The sellable catalogue of the branch lists both polarities of the priced battery
	// and nothing of the unpriced one, so the blocked row never reaches the counter.
	page, err := e.store.Sellable(e.ctx, clerk(2), sales.SellableQuery{Page: 1, PageSize: 10})
	if err != nil {
		t.Fatalf("catalogue read failed: %v", err)
	}
	if page.TotalVariants != 2 || len(page.Items) != 2 ||
		page.Items[0].VariantID != 1 || page.Items[1].VariantID != 2 {
		t.Fatalf("the catalogue must expose only the sellable battery: %+v", page)
	}
	for _, item := range page.Items {
		if item.CatalogEntryID != e.entryOf(t, 1) || item.SuggestedPrice != "96000.00" ||
			item.MinPrice != "85000.00" {
			t.Fatalf("both polarities must be offered at the battery pair: %+v", item)
		}
	}
	// Both polarities of the priced battery are sellable, one by one.
	for _, variant := range []int64{1, 2} {
		if _, err := e.store.Create(e.ctx, clerk(2), sale(variant, 1, "85000.00")); err != nil {
			t.Fatalf("polarity %d of the priced battery must be sellable: %v", variant, err)
		}
	}
}

// TestSalePriceIsPerBattery proves S2 on the counter: the battery's pair covers both of
// its polarities, so a sale of the L variant and a sale of the R variant of the same
// battery use the same price and the same floor, and a price change of the battery
// applies to both at once.
func TestSalePriceIsPerBattery(t *testing.T) {
	e := fixture(t)
	entry := e.entryOf(t, 1)
	polarities := e.polaritiesOf(t, entry)
	if len(polarities) != 2 || polarities[0] != "L" || polarities[1] != "R" {
		t.Fatalf("the fixture battery must have both polarities: %v", polarities)
	}
	left, right := int64(1), int64(2)
	e.price(t, entry, "85000", "96000", 2)
	// One write is one row per (branch, battery): never one row per polarity.
	if n := e.scalar(t, "SELECT count(*) FROM branch_prices WHERE branch_location_id=2 AND catalog_entry_id=$1", int32(entry)); n != 1 {
		t.Fatalf("the battery must hold exactly one pair, got %d rows", n)
	}
	// The L variant and the R variant are both sold at the battery's price and frozen
	// against the battery's floor.
	for _, variant := range []int64{left, right} {
		sold, err := e.store.Create(e.ctx, clerk(2), sale(variant, 1, "96000.00"))
		if err != nil {
			t.Fatalf("the polarity %d of the battery must be sellable: %v", variant, err)
		}
		if sold.Lines[0].UnitPrice != "96000.00" || sold.Lines[0].MinPrice != "85000.00" ||
			sold.Lines[0].VariantID != variant {
			t.Fatalf("the polarity %d must freeze the battery's pair: %+v", variant, sold.Lines[0])
		}
	}
	// Under the battery floor both polarities are refused, and the refusal names the
	// polarity the counter tried to sell.
	for _, variant := range []int64{left, right} {
		before := e.snapshot(t)
		_, err := e.store.Create(e.ctx, clerk(2), sale(variant, 1, "84999.99"))
		var refused *sales.BelowMinimum
		if !errors.As(err, &refused) || refused.VariantID != variant {
			t.Fatalf("the polarity %d must be refused under the battery floor: %v", variant, err)
		}
		if e.snapshot(t) != before {
			t.Fatalf("a refused polarity %d must not write anything", variant)
		}
	}
	// A price change of the battery applies to both polarities: the new floor is the
	// one the other polarity is judged against without any second write.
	e.price(t, entry, "95000", "99000", 2)
	if n := e.scalar(t, "SELECT count(*) FROM branch_prices WHERE branch_location_id=2 AND catalog_entry_id=$1", int32(entry)); n != 1 {
		t.Fatalf("a price change must replace the single battery row, got %d", n)
	}
	for _, variant := range []int64{left, right} {
		before := e.snapshot(t)
		_, err := e.store.Create(e.ctx, clerk(2), sale(variant, 1, "94000.00"))
		var refused *sales.BelowMinimum
		if !errors.As(err, &refused) || refused.VariantID != variant {
			t.Fatalf("the changed floor must cover the polarity %d: %v", variant, err)
		}
		if e.snapshot(t) != before {
			t.Fatalf("the refused polarity %d must not write anything", variant)
		}
		if _, err := e.store.Create(e.ctx, clerk(2), sale(variant, 1, "95000.00")); err != nil {
			t.Fatalf("the changed floor must admit the polarity %d at the new minimum: %v", variant, err)
		}
	}
	// Both polarities share the same pair in the counter catalogue.
	page, err := e.store.Sellable(e.ctx, clerk(2), sales.SellableQuery{Page: 1, PageSize: 10})
	if err != nil {
		t.Fatalf("catalogue read failed: %v", err)
	}
	if page.TotalVariants != 2 || len(page.Items) != 2 {
		t.Fatalf("both polarities of the battery must be sellable: %+v", page)
	}
	for _, item := range page.Items {
		if item.MinPrice != "95000.00" || item.SuggestedPrice != "99000.00" {
			t.Fatalf("both polarities must carry the same battery pair: %+v", item)
		}
	}
}

// TestSaleWarrantyTermIsSoldData pins the term model: the seller states the term at the
// counter, the sale freezes it per line, and nothing about a sale depends on a product
// warranty table.
func TestSaleWarrantyTermIsSoldData(t *testing.T) {
	e := fixture(t)
	e.price(t, e.entryOf(t, 3), "85000", "96000", 2)
	if n := e.scalar(t, "SELECT count(*) FROM variant_warranties"); n != 0 {
		t.Fatalf("the fixture must not store a product term, got %d", n)
	}
	// A line without a term is an invalid request, not a not-sellable variant.
	before := e.snapshot(t)
	noTerm := sale(3, 1, "85000.00")
	noTerm.Lines[0].WarrantyMonths = 0
	if _, err := e.store.Create(e.ctx, clerk(2), noTerm); !errors.Is(err, sales.ErrInvalid) {
		t.Fatalf("a line without a warranty term must be an invalid request: %v", err)
	}
	if e.snapshot(t) != before {
		t.Fatal("a line without a term must not write a sale nor touch stock")
	}
	// The seller's own term is stored and returned by every read path, and no product
	// term is needed for the sale to exist.
	input := sale(3, 1, "85000.00")
	input.Lines[0].WarrantyMonths = 3
	emitted, err := e.store.Create(e.ctx, clerk(2), input)
	if err != nil {
		t.Fatalf("a sale with a seller-stated term must be applied: %v", err)
	}
	if emitted.Lines[0].WarrantyMonths != 3 {
		t.Fatalf("the sale must return the seller's term: %+v", emitted.Lines[0])
	}
	detail, err := e.store.Read(e.ctx, clerk(2), emitted.ID)
	if err != nil || len(detail.Lines) != 1 || detail.Lines[0].WarrantyMonths != 3 {
		t.Fatalf("the read path must return the seller's term: %+v %v", detail, err)
	}
	// Two lines of one sale may state different terms, because each one is a datum of
	// its own line. Each line is a different battery, because the price of a battery is
	// shared by its two polarities.
	other := e.entryOf(t, 5)
	if other == e.entryOf(t, 3) {
		t.Fatal("the fixture needs two different batteries")
	}
	e.price(t, other, "10000", "12000", 2)
	mixed := sales.CreateInput{
		Payments: cashPayment("97000.00"),
		Customer: sales.Customer{Name: "Cliente"},
		Lines: []sales.LineInput{
			{VariantID: 3, Quantity: 1, UnitPrice: "85000.00", WarrantyMonths: 1},
			{VariantID: 5, Quantity: 1, UnitPrice: "12000.00", WarrantyMonths: sales.MaxWarrantyMonths},
		},
	}
	mixedSale, err := e.store.Create(e.ctx, clerk(2), mixed)
	if err != nil {
		t.Fatalf("a sale with per-line terms must be applied: %v", err)
	}
	if len(mixedSale.Lines) != 2 || mixedSale.Lines[0].WarrantyMonths != 1 ||
		mixedSale.Lines[1].WarrantyMonths != sales.MaxWarrantyMonths {
		t.Fatalf("each line must freeze its own term: %+v", mixedSale.Lines)
	}
	if n := e.scalar(t, "SELECT count(*) FROM variant_warranties"); n != 0 {
		t.Fatalf("selling must never write a product term, got %d", n)
	}
}

// TestSaleBelowMinimum pins S6: the branch's stored minimum is a floor the database
// enforces, and a line under it writes nothing and decrements nothing.
func TestSaleBelowMinimum(t *testing.T) {
	e := fixture(t)
	e.price(t, e.entryOf(t, 3), "85000", "96000", 2)
	existing, reserved := e.stock(t, 2, 3)
	if existing < 2 {
		t.Fatalf("fixture expects stock to sell, got %d", existing)
	}
	before := e.snapshot(t)
	_, err := e.store.Create(e.ctx, clerk(2), sale(3, 1, "84999.99"))
	var refused *sales.BelowMinimum
	if !errors.As(err, &refused) || refused.VariantID != 3 {
		t.Fatalf("a price under the frozen minimum must be named as below the minimum: %v", err)
	}
	if !errors.Is(err, sales.ErrBelowMinimum) {
		t.Fatal("a price under the minimum is a floor refusal")
	}
	if e.snapshot(t) != before {
		t.Fatal("a refused price must not write a sale nor touch stock")
	}
	if got, gotReserved := e.stock(t, 2, 3); got != existing || gotReserved != reserved {
		t.Fatalf("stock must be untouched: %d/%d", got, gotReserved)
	}
	// The suggested price is above the minimum and is accepted with the same floor.
	result, err := e.store.Create(e.ctx, clerk(2), sale(3, 1, "96000.00"))
	if err != nil {
		t.Fatalf("the suggested price must be accepted: %v", err)
	}
	if result.Lines[0].UnitPrice != "96000.00" || result.Lines[0].MinPrice != "85000.00" {
		t.Fatalf("the sale must freeze the charged price and the floor: %+v", result.Lines[0])
	}
}

// TestSaleTwoLinesOneInvalidIsAtomic pins S8: one invalid line leaves the stock and
// the sale tables exactly as they were, so a sale is applied completely or not at all.
func TestSaleTwoLinesOneInvalidIsAtomic(t *testing.T) {
	e := fixture(t)
	if e.entryOf(t, 4) == e.entryOf(t, 5) {
		t.Fatal("the two lines must belong to different batteries")
	}
	e.price(t, e.entryOf(t, 3), "85000", "96000", 2)
	e.price(t, e.entryOf(t, 5), "10000", "12000", 2)
	before := e.snapshot(t)
	input := sales.CreateInput{
		Payments: []sales.Payment{{Method: sales.PaymentCard, Amount: "95000.00"}},
		Customer: sales.Customer{Name: "Cliente"},
		Lines: []sales.LineInput{
			{VariantID: 3, Quantity: 1, UnitPrice: "85000.00", WarrantyMonths: 6},
			{VariantID: 5, Quantity: 1, UnitPrice: "10000.00", WarrantyMonths: 6},
		},
	}
	// The second line is under its floor while the first one is perfectly valid. The
	// settlement follows the document it pays, so the line -- and not an open sum -- is what
	// the refusal comes from.
	input.Lines[1].UnitPrice = "9999.99"
	input.Payments = cashPayment("94999.99")
	_, err := e.store.Create(e.ctx, clerk(2), input)
	var refused *sales.BelowMinimum
	if !errors.As(err, &refused) || refused.VariantID != 5 {
		t.Fatalf("the invalid line must name its variant: %v", err)
	}
	if e.snapshot(t) != before {
		t.Fatal("one invalid line must leave stock and the sale tables untouched")
	}
	if n := e.scalar(t, "SELECT count(*) FROM sales"); n != 0 {
		t.Fatal("a refused sale must not persist a header")
	}
	// An uncovered line mid-document behaves the same way.
	input.Lines[1] = sales.LineInput{VariantID: 5, Quantity: 200, UnitPrice: "10000.00", WarrantyMonths: 6}
	input.Payments = cashPayment("2085000.00")
	var shortage *sales.InsufficientStock
	if _, err := e.store.Create(e.ctx, clerk(2), input); !errors.As(err, &shortage) || shortage.VariantID != 5 {
		t.Fatalf("the second line must hit the stock bound: %v", err)
	}
	if e.snapshot(t) != before {
		t.Fatal("a refused second line must leave everything untouched")
	}
	// The very same document is applied once both lines are valid, which proves the
	// two refusals came from the lines and not from the document.
	input.Lines[1].Quantity = 1
	input.Payments = cashPayment("95000.00")
	sold, err := e.store.Create(e.ctx, clerk(2), input)
	if err != nil {
		t.Fatalf("the valid document must be applied: %v", err)
	}
	if len(sold.Lines) != 2 || sold.Total != "95000.00" {
		t.Fatalf("both lines must be persisted: %+v", sold)
	}
}

// TestSaleDecrementsOnlyItsBranch pins S8 for the ledger: a sale decrements the
// selling branch's existing stock only, never reserved, and never another branch.
func TestSaleDecrementsOnlyItsBranch(t *testing.T) {
	e := fixture(t)
	e.price(t, e.entryOf(t, 3), "85000", "96000", 2, 3)
	e.setStock(t, 2, 3, 20, 4)
	siblingExisting, siblingReserved := e.stock(t, 3, 3)
	result, err := e.store.Create(e.ctx, clerk(2), sale(3, 5, "85000.00"))
	if err != nil {
		t.Fatalf("a valid sale must be applied: %v", err)
	}
	if existing, reserved := e.stock(t, 2, 3); existing != 15 || reserved != 4 {
		t.Fatalf("the selling branch must lose exactly the sold quantity and keep reserved: %d/%d", existing, reserved)
	}
	if existing, reserved := e.stock(t, 3, 3); existing != siblingExisting || reserved != siblingReserved {
		t.Fatalf("another branch's stock must not change: %d/%d", existing, reserved)
	}
	if result.BranchLocationID != 2 || result.PaymentMethod != sales.PaymentCash || result.Total != "425000.00" {
		t.Fatalf("the persisted sale does not match the sold document: %+v", result)
	}
	if len(result.Lines) != 1 || result.Lines[0].Quantity != 5 || result.Lines[0].Subtotal != "425000.00" {
		t.Fatalf("the persisted line does not match the sold line: %+v", result.Lines)
	}
	// reserved is never written by a sale, not even when it is the whole balance.
	e.setStock(t, 2, 3, 5, 5)
	before := e.snapshot(t)
	_, err = e.store.Create(e.ctx, clerk(2), sale(3, 1, "85000.00"))
	var refused *sales.InsufficientStock
	if !errors.As(err, &refused) || refused.VariantID != 3 {
		t.Fatalf("a sale would leave existing under reserved and must be refused: %v", err)
	}
	if e.snapshot(t) != before {
		t.Fatal("a refused sale must leave stock and the sale tables untouched")
	}
	if existing, reserved := e.stock(t, 2, 3); existing != 5 || reserved != 5 {
		t.Fatalf("a refused sale must not change the balance: %d/%d", existing, reserved)
	}
}

// TestSaleExhaustedStock pins the exhausted branch: nothing to sell is a refusal, not
// a negative balance.
func TestSaleExhaustedStock(t *testing.T) {
	e := fixture(t)
	empty := e.zeroStockVariant(t, 2)
	e.price(t, e.entryOf(t, empty), "85000", "96000", 2)
	before := e.snapshot(t)
	_, err := e.store.Create(e.ctx, clerk(2), sale(empty, 1, "85000.00"))
	var refused *sales.InsufficientStock
	if !errors.As(err, &refused) || refused.VariantID != empty {
		t.Fatalf("exhausted stock must be named by its variant: %v", err)
	}
	if e.snapshot(t) != before {
		t.Fatal("an exhausted sale must leave stock and the sale tables untouched")
	}
	if existing, _ := e.stock(t, 2, empty); existing != 0 {
		t.Fatalf("existing stock must never become negative, got %d", existing)
	}
	// Selling exactly the whole balance is admitted: the bound is zero, not one.
	e.setStock(t, 2, empty, 2, 0)
	if _, err := e.store.Create(e.ctx, clerk(2), sale(empty, 2, "85000.00")); err != nil {
		t.Fatalf("selling the whole balance must be admitted: %v", err)
	}
	if existing, _ := e.stock(t, 2, empty); existing != 0 {
		t.Fatalf("the whole balance must leave zero, got %d", existing)
	}
}

// TestSaleNumbersArePerBranch pins the numeration: every branch allocates its own
// correlative and its own warranty number, and no two sales of a branch share either.
func TestSaleNumbersArePerBranch(t *testing.T) {
	e := fixture(t)
	e.price(t, e.entryOf(t, 1), "1000", "1200", 2, 3)
	first, err := e.store.Create(e.ctx, clerk(2), sale(1, 1, "1000.00"))
	if err != nil {
		t.Fatalf("the first sale failed: %v", err)
	}
	second, err := e.store.Create(e.ctx, clerk(2), sale(1, 1, "1000.00"))
	if err != nil {
		t.Fatalf("the second sale failed: %v", err)
	}
	other, err := e.store.Create(e.ctx, clerk(3), sale(1, 1, "1000.00"))
	if err != nil {
		t.Fatalf("the sale of the other branch failed: %v", err)
	}
	if first.BranchSequence != 1 || second.BranchSequence != 2 || other.BranchSequence != 1 {
		t.Fatalf("each branch must have its own correlative: %d/%d/%d",
			first.BranchSequence, second.BranchSequence, other.BranchSequence)
	}
	if first.WarrantyNumber != "2-000001" || second.WarrantyNumber != "2-000002" || other.WarrantyNumber != "3-000001" {
		t.Fatalf("each branch must have its own warranty numeration: %q/%q/%q",
			first.WarrantyNumber, second.WarrantyNumber, other.WarrantyNumber)
	}
	if n := e.scalar(t, "SELECT count(DISTINCT warranty_number) FROM sales"); n != 3 {
		t.Fatalf("warranty numbers must be distinct, got %d", n)
	}
	// The uniqueness of a branch pair is a database constraint, not only a promise of
	// the allocation above.
	if n := e.scalar(t, `SELECT count(*) FROM pg_constraint WHERE conname IN ('sales_branch_location_id_branch_sequence_key','sales_branch_location_id_warranty_number_key')`); n != 2 {
		t.Fatalf("both per-branch unique constraints must exist, got %d", n)
	}
}

// TestSaleFreezesDocumentInDatabase proves the frozen facts are the database's: a raw
// caller cannot choose the document numbers, the floor or the subtotal, while the term
// it states is stored exactly as an input of the sale.
func TestSaleFreezesDocumentInDatabase(t *testing.T) {
	e := fixture(t)
	e.price(t, e.entryOf(t, 5), "85000", "96000", 2)
	tx, err := e.pool.Begin(e.ctx)
	if err != nil {
		t.Fatal("fixture transaction failed")
	}
	defer tx.Rollback(context.WithoutCancel(e.ctx))
	var id int64
	// The caller supplies placeholder numbers and a subtotal of its own: the
	// admission trigger and the line trigger overwrite every one of them.
	if err := tx.QueryRow(e.ctx, `INSERT INTO sales(branch_location_id,branch_sequence,warranty_number,cash_amount,
  customer_name,total,created_by_account_id) VALUES(2,99,'9-999999',180000.00,'Cliente',180000.00,2) RETURNING id`).Scan(&id); err != nil {
		t.Fatalf("raw header insert failed: %v", err)
	}
	if _, err := tx.Exec(e.ctx, `INSERT INTO sale_lines(sale_id,variant_id,quantity,unit_price,min_price,warranty_months,subtotal)
 VALUES($1,5,2,'90000.00',1,30,1)`, id); err != nil {
		t.Fatalf("raw line insert failed: %v", err)
	}
	var sequence, months int64
	var warranty, minPrice, subtotalMoney string
	if err := tx.QueryRow(e.ctx, `SELECT branch_sequence,warranty_number,min_price::text,warranty_months,subtotal::text
 FROM sales s JOIN sale_lines l ON l.sale_id=s.id WHERE s.id=$1`, id).Scan(&sequence, &warranty, &minPrice, &months, &subtotalMoney); err != nil {
		t.Fatalf("persisted document read failed: %v", err)
	}
	if sequence != 1 || warranty != "2-000001" {
		t.Fatalf("the caller's document numbers must be overwritten: %d/%q", sequence, warranty)
	}
	if minPrice != "85000.00" || subtotalMoney != "180000.00" {
		t.Fatalf("the frozen floor and the derived subtotal must be the database's: %s/%s", minPrice, subtotalMoney)
	}
	// The seller's term is sale data: it is stored exactly as stated, not looked up.
	if months != 30 {
		t.Fatalf("the seller's term must be frozen as stated, got %d", months)
	}
	// A line without a term is refused by the database too, so the term is always a
	// real datum of the emitted document.
	if _, err := tx.Exec(e.ctx, `INSERT INTO sale_lines(sale_id,variant_id,quantity,unit_price,warranty_months)
 VALUES($1,6,1,'90000.00',0)`, id); err == nil {
		t.Fatal("a line without a warranty term must be refused by the database")
	}
}

// TestSaleKeepsFrozenFacts pins S9: a later price change never edits an emitted sale.
func TestSaleKeepsFrozenFacts(t *testing.T) {
	e := fixture(t)
	e.price(t, e.entryOf(t, 3), "85000", "96000", 2)
	emitted, err := e.store.Create(e.ctx, clerk(2), sale(3, 2, "90000.00"))
	if err != nil {
		t.Fatalf("the sale failed: %v", err)
	}
	// The Catálogo changes the battery's pair afterwards.
	e.price(t, e.entryOf(t, 3), "95000", "99000", 2)
	detail, err := e.store.Read(e.ctx, clerk(2), emitted.ID)
	if err != nil {
		t.Fatalf("the emitted sale must stay readable: %v", err)
	}
	if len(detail.Lines) != 1 {
		t.Fatalf("the emitted sale must keep its line: %+v", detail.Lines)
	}
	line := detail.Lines[0]
	if line.UnitPrice != "90000.00" || line.MinPrice != "85000.00" || line.WarrantyMonths != 6 ||
		line.Subtotal != "180000.00" || line.Capacity == "" || line.Brand == "" || line.Model == "" {
		t.Fatalf("the emitted line must keep the prices of the sale: %+v", line)
	}
	if detail.Total != "180000.00" || detail.WarrantyNumber != emitted.WarrantyNumber {
		t.Fatalf("the emitted document must keep its own numbers: %+v", detail)
	}
}

// TestSaleReadAndListAreBranchScoped pins S1 for reads: another branch's sale is not
// found and never appears in the other branch's history.
func TestSaleReadAndListAreBranchScoped(t *testing.T) {
	e := fixture(t)
	e.price(t, e.entryOf(t, 1), "1000", "1200", 2, 3)
	first, err := e.store.Create(e.ctx, clerk(2), sale(1, 1, "1000.00"))
	if err != nil {
		t.Fatalf("the sale failed: %v", err)
	}
	own, err := e.store.List(e.ctx, clerk(2), sales.ListQuery{Page: 1, PageSize: 25})
	if err != nil {
		t.Fatalf("the branch history read failed: %v", err)
	}
	if own.TotalSales != 1 || len(own.Sales) != 1 {
		t.Fatalf("the selling branch must see its own sale: %+v", own)
	}
	summary := own.Sales[0]
	if summary.ID != first.ID || summary.WarrantyNumber != first.WarrantyNumber ||
		summary.BranchSequence != first.BranchSequence || summary.PaymentMethod != sales.PaymentCash ||
		summary.CustomerName != "Cliente Mostrador" || summary.Total != "1000.00" || summary.Lines != 1 {
		t.Fatalf("the history row does not match the persisted sale: %+v", summary)
	}
	if _, err := e.store.Read(e.ctx, clerk(3), first.ID); !errors.Is(err, sales.ErrNotFound) {
		t.Fatal("another branch's sale must be not found")
	}
	other, err := e.store.List(e.ctx, clerk(3), sales.ListQuery{Page: 1, PageSize: 25})
	if err != nil || other.TotalSales != 0 || len(other.Sales) != 0 {
		t.Fatalf("another branch's history must be empty: %+v %v", other, err)
	}
	// The filters are literal and scoped to the branch.
	second := sale(1, 1, "1200.00")
	second.Payments = []sales.Payment{{Method: sales.PaymentCard, Amount: "1200.00"}}
	second.Customer = sales.Customer{Name: "Beto 100%"}
	if _, err := e.store.Create(e.ctx, clerk(2), second); err != nil {
		t.Fatalf("the second sale failed: %v", err)
	}
	for name, tc := range map[string]struct {
		query sales.ListQuery
		want  int
	}{
		"all":        {sales.ListQuery{Page: 1, PageSize: 25}, 2},
		"warranty":   {sales.ListQuery{Search: first.WarrantyNumber, Page: 1, PageSize: 25}, 1},
		"customer":   {sales.ListQuery{Search: "Beto", Page: 1, PageSize: 25}, 1},
		"literal":    {sales.ListQuery{Search: "100%", Page: 1, PageSize: 25}, 1},
		"underscore": {sales.ListQuery{Search: "_", Page: 1, PageSize: 25}, 0},
		"card":       {sales.ListQuery{PaymentMethod: "card", Page: 1, PageSize: 25}, 1},
		"cash":       {sales.ListQuery{PaymentMethod: "cash", Page: 1, PageSize: 25}, 1},
		"no_match":   {sales.ListQuery{Search: "zzz", Page: 1, PageSize: 25}, 0},
		"empty_page": {sales.ListQuery{Page: 1_000_000, PageSize: 10}, 0},
	} {
		page, err := e.store.List(e.ctx, clerk(2), tc.query)
		if err != nil {
			t.Fatalf("%s list failed: %v", name, err)
		}
		if len(page.Sales) != tc.want {
			t.Fatalf("%s returned %d sales, want %d", name, len(page.Sales), tc.want)
		}
		if page.Sales == nil {
			t.Fatalf("%s must answer a non-null page", name)
		}
	}
	// Newest first.
	page, err := e.store.List(e.ctx, clerk(2), sales.ListQuery{Page: 1, PageSize: 25})
	if err != nil {
		t.Fatalf("the history read failed: %v", err)
	}
	if page.Sales[0].BranchSequence < page.Sales[1].BranchSequence {
		t.Fatal("the history must be newest first")
	}
	// A sale settled with two methods is labelled 'mixed' by the database, and the history
	// filter finds it by that derived label so a branch can search its mixed sales.
	mixed := sale(1, 1, "1000.00")
	mixed.Payments = []sales.Payment{{Method: sales.PaymentCash, Amount: "400.00"},
		{Method: sales.PaymentTransfer, Amount: "600.00"}}
	if _, err := e.store.Create(e.ctx, clerk(2), mixed); err != nil {
		t.Fatalf("the mixed sale failed: %v", err)
	}
	for name, tc := range map[string]struct {
		query sales.ListQuery
		want  int
		label sales.PaymentMethod
	}{
		"all":   {sales.ListQuery{Page: 1, PageSize: 25}, 3, ""},
		"mixed": {sales.ListQuery{PaymentMethod: "mixed", Page: 1, PageSize: 25}, 1, sales.PaymentMixed},
		"cash":  {sales.ListQuery{PaymentMethod: "cash", Page: 1, PageSize: 25}, 1, sales.PaymentCash},
		"card":  {sales.ListQuery{PaymentMethod: "card", Page: 1, PageSize: 25}, 1, sales.PaymentCard},
	} {
		found, err := e.store.List(e.ctx, clerk(2), tc.query)
		if err != nil {
			t.Fatalf("%s list failed: %v", name, err)
		}
		if len(found.Sales) != tc.want {
			t.Fatalf("%s returned %d sales, want %d", name, len(found.Sales), tc.want)
		}
		for _, summary := range found.Sales {
			if tc.label != "" && summary.PaymentMethod != tc.label {
				t.Fatalf("%s must be labelled %s: %+v", name, tc.label, summary)
			}
		}
	}
}

// TestSaleDocumentIsImmutable pins the immutable document: no update, no delete, no
// truncate.
func TestSaleDocumentIsImmutable(t *testing.T) {
	e := fixture(t)
	e.price(t, e.entryOf(t, 1), "1000", "1200", 2)
	if _, err := e.store.Create(e.ctx, clerk(2), sale(1, 1, "1000.00")); err != nil {
		t.Fatalf("the sale failed: %v", err)
	}
	for name, query := range map[string]string{
		"update_sale":    "UPDATE sales SET total=1.00",
		"delete_sale":    "DELETE FROM sales",
		"update_line":    "UPDATE sale_lines SET quantity=1",
		"delete_line":    "DELETE FROM sale_lines",
		"truncate_lines": "TRUNCATE sale_lines CASCADE",
		"truncate_sales": "TRUNCATE sales CASCADE",
	} {
		if _, err := e.pool.Exec(e.ctx, query); err == nil {
			t.Fatalf("%s must be refused", name)
		}
	}
	if n := e.scalar(t, "SELECT count(*) FROM sales"); n != 1 {
		t.Fatalf("the immutable document must stay persisted, got %d", n)
	}
}

// TestSaleSellableCatalogue pins the counter catalogue: only the variants the branch
// can sell, with the suggested price and the minimum it can never go under. The price
// is the battery's, so the three priced batteries expose their six polarities at the
// price of their battery. The warranty term is deliberately absent: the seller states
// it on the sale.
func TestSaleSellableCatalogue(t *testing.T) {
	e := fixture(t)
	e.price(t, e.entryOf(t, 1), "85000", "96000.5", 2, 3)
	e.price(t, e.entryOf(t, 3), "10000", "12000", 2)
	e.price(t, e.entryOf(t, 5), "5000", "6000", 2)
	page, err := e.store.Sellable(e.ctx, clerk(2), sales.SellableQuery{Page: 1, PageSize: 10})
	if err != nil {
		t.Fatalf("catalogue read failed: %v", err)
	}
	if page.Page != 1 || page.PageSize != 10 || page.TotalVariants != 6 || len(page.Items) != 6 {
		t.Fatalf("the catalogue must expose the sellable variants in order: %+v", page)
	}
	first := page.Items[0]
	if first.VariantID != 1 || first.Brand == "" || first.Model == "" || first.Capacity == "" ||
		(first.Polarity != "L" && first.Polarity != "R") {
		t.Fatalf("the catalogue item must carry the catalogue identity: %+v", first)
	}
	if first.SuggestedPrice != "96000.50" || first.MinPrice != "85000.00" {
		t.Fatalf("the item must carry the prices in force: %+v", first)
	}
	// Branch 3 only carries the battery of variant 1, so it offers both its polarities.
	other, err := e.store.Sellable(e.ctx, clerk(3), sales.SellableQuery{Page: 1, PageSize: 10})
	if err != nil || other.TotalVariants != 2 || len(other.Items) != 2 ||
		other.Items[0].VariantID != 1 || other.Items[1].VariantID != 2 {
		t.Fatalf("each branch must expose only its own sellable variants: %+v %v", other, err)
	}
	// The sellable variants of this fixture are the six polarities of the three priced
	// batteries.
	priced := []int64{1, 2, 3, 4, 5, 6}
	source, err := catalog.Load()
	if err != nil {
		t.Fatal("catalogue source load failed")
	}
	// The priced batteries are the only sellable ones, so every filter expectation is
	// derived from the source catalogue instead of being guessed.
	matches := func(q sales.SellableQuery, entry catalog.Entry, variantID int64) bool {
		polarity := "R"
		if variantID%2 == 1 {
			polarity = "L"
		}
		if q.Brand != "" && q.Brand != entry.Brand {
			return false
		}
		if q.Capacity != "" && q.Capacity != entry.Capacity {
			return false
		}
		if q.Polarity != "" && q.Polarity != polarity {
			return false
		}
		if q.Search != "" &&
			!strings.Contains(strings.ToLower(entry.Brand), strings.ToLower(q.Search)) &&
			!strings.Contains(strings.ToLower(entry.Model), strings.ToLower(q.Search)) {
			return false
		}
		return true
	}
	for name, query := range map[string]sales.SellableQuery{
		"brand":           {Brand: source.Entries[0].Brand},
		"search":          {Search: strings.ToLower(source.Entries[0].Model)},
		"capacity":        {Capacity: catalog.Decimal(source.Entries[0].Capacity)},
		"polarity":        {Polarity: "L"},
		"literal_percent": {Search: "%"},
		"injection":       {Search: "' OR 1=1 --"},
		"no_match":        {Search: "zzz"},
	} {
		want := 0
		for _, variantID := range priced {
			if matches(query, source.Entries[(variantID-1)/2], variantID) {
				want++
			}
		}
		query.Page, query.PageSize = 1, 50
		result, err := e.store.Sellable(e.ctx, clerk(2), query)
		if err != nil {
			t.Fatalf("%s filter failed: %v", name, err)
		}
		if len(result.Items) != want {
			t.Fatalf("%s returned %d items, want %d", name, len(result.Items), want)
		}
		if result.Items == nil {
			t.Fatalf("%s must answer a non-null page", name)
		}
	}
}

// TestSaleConcurrentSalesGetDistinctCorrelatives pins the allocation under contention:
// the branch row is locked for the rest of the transaction, so two sellers of the same
// branch are serialized and each receives its own correlative and warranty number
// instead of colliding on the per-branch unique constraints.
func TestSaleConcurrentSalesGetDistinctCorrelatives(t *testing.T) {
	e := fixture(t)
	// The two concurrent sales must be two documents, so they sell two different
	// batteries: the same battery sold twice would share one pair, which is a different
	// guarantee.
	e.price(t, e.entryOf(t, 1), "1000", "1200", 2)
	e.price(t, e.entryOf(t, 3), "1000", "1200", 2)
	results := make([]sales.Sale, 2)
	failures := make([]error, 2)
	var wg sync.WaitGroup
	for i, variant := range []int64{1, 3} {
		wg.Add(1)
		go func(index int, variantID int64) {
			defer wg.Done()
			results[index], failures[index] = e.store.Create(e.ctx, clerk(2), sale(variantID, 1, "1000.00"))
		}(i, variant)
	}
	wg.Wait()
	sequences := map[int64]bool{}
	for i := range results {
		if failures[i] != nil {
			t.Fatalf("concurrent sale %d failed: %v", i, failures[i])
		}
		if sequences[results[i].BranchSequence] {
			t.Fatalf("two concurrent sales shared the correlative %d", results[i].BranchSequence)
		}
		sequences[results[i].BranchSequence] = true
	}
	if len(sequences) != 2 {
		t.Fatalf("each concurrent sale must receive its own correlative: %v", sequences)
	}
	if n := e.scalar(t, "SELECT count(DISTINCT warranty_number) FROM sales"); n != 2 {
		t.Fatalf("each concurrent sale must receive its own warranty number, got %d", n)
	}
}

// TestSaleMixedPayment pins S16: one sale can be settled partly in cash and partly by
// transfer, both amounts are persisted under their own method, and every read path
// reports the kind of payment the database derived instead of a label the counter chose.
func TestSaleMixedPayment(t *testing.T) {
	e := fixture(t)
	e.price(t, e.entryOf(t, 3), "85000", "96000", 2)
	if existing, _ := e.stock(t, 2, 3); existing < 2 {
		t.Fatalf("fixture expects stock to sell, got %d", existing)
	}
	// Two units at 85000.00 are 170000.00, paid as 50000.00 in cash and 120000.00 by
	// transfer.
	input := sale(3, 2, "85000.00")
	input.Payments = []sales.Payment{
		{Method: sales.PaymentTransfer, Amount: "120000.00"},
		{Method: sales.PaymentCash, Amount: "50000.00"},
	}
	emitted, err := e.store.Create(e.ctx, clerk(2), input)
	if err != nil {
		t.Fatalf("a sale settled with two methods must be applied: %v", err)
	}
	if emitted.Total != "170000.00" {
		t.Fatalf("the document total must be the sum of its lines: %q", emitted.Total)
	}
	if emitted.PaymentMethod != sales.PaymentMixed {
		t.Fatalf("a sale paid with two methods must be labelled mixed: %q", emitted.PaymentMethod)
	}
	// The payments come back in the frozen order, only the methods that paid.
	if len(emitted.Payments) != 2 ||
		emitted.Payments[0] != (sales.Payment{Method: sales.PaymentCash, Amount: "50000.00"}) ||
		emitted.Payments[1] != (sales.Payment{Method: sales.PaymentTransfer, Amount: "120000.00"}) {
		t.Fatalf("both paid amounts must be returned in the frozen order: %+v", emitted.Payments)
	}
	// Both amounts, and the derived label, are the database's own columns.
	var cash, card, transfer, label string
	if err := e.pool.QueryRow(e.ctx, `SELECT cash_amount::text,card_amount::text,transfer_amount::text,
  payment_method FROM sales WHERE id=$1`, emitted.ID).Scan(&cash, &card, &transfer, &label); err != nil {
		t.Fatal("the persisted settlement could not be read")
	}
	if cash != "50000.00" || card != "0.00" || transfer != "120000.00" || label != "mixed" {
		t.Fatalf("each amount must live under its own method: %s/%s/%s/%s", cash, card, transfer, label)
	}
	// The detail keeps the same settlement, so the warranty can print one row per method.
	detail, err := e.store.Read(e.ctx, clerk(2), emitted.ID)
	if err != nil {
		t.Fatalf("the emitted sale must stay readable: %v", err)
	}
	if detail.PaymentMethod != sales.PaymentMixed || len(detail.Payments) != 2 ||
		detail.Payments[0] != emitted.Payments[0] || detail.Payments[1] != emitted.Payments[1] {
		t.Fatalf("the detail must carry the same settlement as the emitted sale: %+v", detail)
	}
	// The label is never an input: a client that tries to state it is refused before any
	// database work, and nothing is written.
	before := e.snapshot(t)
	chosen := sale(3, 1, "85000.00")
	chosen.Payments = []sales.Payment{{Method: sales.PaymentMixed, Amount: "85000.00"}}
	if _, err := e.store.Create(e.ctx, clerk(2), chosen); !errors.Is(err, sales.ErrInvalid) {
		t.Fatalf("the payment label must not be an input: %v", err)
	}
	if e.snapshot(t) != before {
		t.Fatal("a label chosen by the client must not write anything")
	}
}

// TestSaleSinglePaymentKeepsItsLabel pins the rest of the label rule: a sale paid with one
// method is labelled with that method, so the common case still reads cash, card or
// transfer and never 'mixed'.
func TestSaleSinglePaymentKeepsItsLabel(t *testing.T) {
	e := fixture(t)
	e.price(t, e.entryOf(t, 3), "1000", "1200", 2)
	for _, method := range sales.PaymentMethods() {
		input := sale(3, 1, "1000.00")
		input.Payments = []sales.Payment{{Method: method, Amount: "1000.00"}}
		emitted, err := e.store.Create(e.ctx, clerk(2), input)
		if err != nil {
			t.Fatalf("a %s sale must be applied: %v", method, err)
		}
		if emitted.PaymentMethod != method || len(emitted.Payments) != 1 ||
			emitted.Payments[0] != (sales.Payment{Method: method, Amount: "1000.00"}) {
			t.Fatalf("a sale paid with %s must read back as %s: %+v", method, method, emitted)
		}
		detail, err := e.store.Read(e.ctx, clerk(2), emitted.ID)
		if err != nil || detail.PaymentMethod != method || len(detail.Payments) != 1 {
			t.Fatalf("the detail of a %s sale must keep its label and its payment: %+v %v", method, detail, err)
		}
	}
}

// TestSalePaymentsMustCloseInStore pins S16's refusal in the store: a settlement that does
// not close is refused before the first statement, the error names how much is missing or
// left over, and nothing is written or decremented.
func TestSalePaymentsMustCloseInStore(t *testing.T) {
	e := fixture(t)
	e.price(t, e.entryOf(t, 3), "85000", "96000", 2)
	existing, reserved := e.stock(t, 2, 3)
	before := e.snapshot(t)
	for name, tc := range map[string]struct {
		payments []sales.Payment
		missing  sales.Money
		excess   sales.Money
	}{
		"below": {[]sales.Payment{{Method: sales.PaymentCash, Amount: "40000.00"},
			{Method: sales.PaymentTransfer, Amount: "30000.00"}}, "15000.00", ""},
		"above": {[]sales.Payment{{Method: sales.PaymentCash, Amount: "90000.00"}}, "", "5000.00"},
	} {
		input := sale(3, 1, "85000.00")
		input.Payments = tc.payments
		_, err := e.store.Create(e.ctx, clerk(2), input)
		var mismatch *sales.PaymentsMismatch
		if !errors.As(err, &mismatch) || mismatch.Missing != tc.missing || mismatch.Excess != tc.excess {
			t.Fatalf("%s must name the open side: %v", name, err)
		}
		if !errors.Is(err, sales.ErrInvalid) {
			t.Fatalf("%s must stay the invalid-document refusal", name)
		}
		if e.snapshot(t) != before {
			t.Fatalf("%s must not write a sale nor touch stock", name)
		}
		if got, gotReserved := e.stock(t, 2, 3); got != existing || gotReserved != reserved {
			t.Fatalf("%s must leave the balance untouched: %d/%d", name, got, gotReserved)
		}
	}
}

// TestSalePaymentSumIsTheDatabaseRule proves the sum is enforced by the database and not
// only by this store: a direct insert whose amounts leave change behind is refused, and a
// settlement that closes is admitted with its label derived from its own amounts.
func TestSalePaymentSumIsTheDatabaseRule(t *testing.T) {
	e := fixture(t)
	e.price(t, e.entryOf(t, 5), "85000", "96000", 2)
	insert := func(header string, args ...any) error {
		t.Helper()
		tx, err := e.pool.Begin(e.ctx)
		if err != nil {
			t.Fatal("the raw sale transaction failed")
		}
		defer tx.Rollback(context.WithoutCancel(e.ctx))
		var id int64
		if err := tx.QueryRow(e.ctx, header, args...).Scan(&id); err != nil {
			return err
		}
		// The document needs its line, so the header is inserted the same way a writer
		// would and the deferred total guard is satisfied.
		if _, err := tx.Exec(e.ctx, `INSERT INTO sale_lines(sale_id,variant_id,quantity,unit_price,warranty_months)
 VALUES($1,5,2,'90000.00',6)`, id); err != nil {
			return err
		}
		return tx.Commit(e.ctx)
	}
	// The amounts do not add up to the total, so the header itself is refused.
	err := insert(`INSERT INTO sales(branch_location_id,cash_amount,card_amount,transfer_amount,
  customer_name,total,created_by_account_id) VALUES(2,90000.01,90000.01,0.00,'Cliente',180000.00,2) RETURNING id`)
	var pg *pgconn.PgError
	if !errors.As(err, &pg) || pg.Code != "23514" {
		t.Fatalf("a settlement that does not close must be refused by the database: %v", err)
	}
	if n := e.scalar(t, "SELECT count(*) FROM sales"); n != 0 {
		t.Fatalf("a refused settlement must not persist a header, got %d", n)
	}
	// The same document with amounts that close is admitted and labelled by the database.
	if err := insert(`INSERT INTO sales(branch_location_id,cash_amount,card_amount,transfer_amount,
  customer_name,total,created_by_account_id) VALUES(2,90000.00,0.00,90000.00,'Cliente',180000.00,2) RETURNING id`); err != nil {
		t.Fatalf("a settlement that closes must be admitted: %v", err)
	}
	var label string
	if err := e.pool.QueryRow(e.ctx, "SELECT payment_method FROM sales").Scan(&label); err != nil {
		t.Fatal("the derived label could not be read")
	}
	if label != "mixed" {
		t.Fatalf("two paying methods must be derived as mixed, got %q", label)
	}
}
