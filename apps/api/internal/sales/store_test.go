package sales_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
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

// availability reads the branch balance of one variant the way the catalogue publishes
// it: a missing row is the honest zero, because the counter must still show the variant.
func (e *env) availability(t *testing.T, locationID, variantID int64) (existing, reserved, available int64) {
	t.Helper()
	if e.pool.QueryRow(e.ctx, `SELECT coalesce(max(existing),0),coalesce(max(reserved),0),
  coalesce(max(available),0) FROM inventory_balances WHERE location_id=$1 AND variant_id=$2`,
		int16(locationID), int32(variantID)).Scan(&existing, &reserved, &available) != nil {
		t.Fatal("balance read failed")
	}
	return existing, reserved, available
}

// snapshot captures every table a sale writes, so a refused sale is proven to leave
// nothing behind, stock included.
func (e *env) snapshot(t *testing.T) string {
	t.Helper()
	var data string
	err := e.pool.QueryRow(e.ctx, `SELECT jsonb_build_object(
  'sales',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]'::jsonb) FROM sales s),
  'lines',(SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.sale_id,l.variant_id),'[]'::jsonb) FROM sale_lines l),
  'units',(SELECT coalesce(jsonb_agg(to_jsonb(u) ORDER BY u.sale_id,u.variant_id,u.unit_ordinal),'[]'::jsonb) FROM sale_units u),
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

// serialSeq numbers every fixture serial: one physical battery is sold once per
// installation, and one test database is one installation.
var serialSeq atomic.Int64

// months is the warranty term of a fixture unit, so a term can be stated by value.
func months(value int) *int { return &value }

// units builds one unit per sold piece, each with its own serial and the stated term.
// A nil term is a battery the client took without warranty, which is a decision and
// never a zero.
func units(quantity int64, term *int) []sales.Unit {
	result := make([]sales.Unit, 0, quantity)
	for i := int64(0); i < quantity; i++ {
		var stated *int
		if term != nil {
			value := *term
			stated = &value
		}
		result = append(result, sales.Unit{
			SerialNumber:   sales.SerialNumber(fmt.Sprintf("SN-%d", serialSeq.Add(1))),
			WarrantyMonths: stated,
		})
	}
	return result
}

// onePiece is one fixture line of a single battery: the shape most refusals below are
// written against.
func onePiece(variantID int64, unit string, term *int) []sales.LineInput {
	return []sales.LineInput{{VariantID: variantID, Quantity: 1,
		UnitPrice: sales.Money(unit), Units: units(1, term)}}
}

// sale is the canonical shape of a one-line sale used by most tests: one cash payment
// for exactly the total of the document, one unit per sold piece and the term the seller
// stated for each one.
func sale(variantID, quantity int64, unit string) sales.CreateInput {
	total, err := sales.LineTotal(sales.Money(unit), quantity)
	if err != nil {
		panic("fixture sale amount is not canonical: " + err.Error())
	}
	return sales.CreateInput{
		Payments: []sales.Payment{{Method: sales.PaymentCash, Amount: total}},
		Customer: sales.Customer{Name: "Cliente Mostrador"},
		Lines: []sales.LineInput{{VariantID: variantID, Quantity: quantity,
			UnitPrice: sales.Money(unit), Units: units(quantity, months(6))}},
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
		Customer: sales.Customer{Name: "  Ana Pérez  ", Phone: "700-00000", Document: "V-123",
			Address: "  Av. Colón 1234, Barrio Norte  "},
		Lines: []sales.LineInput{
			{VariantID: 4, Quantity: 2, UnitPrice: "96000.5", Units: []sales.Unit{
				{SerialNumber: "ABC-001", WarrantyMonths: months(12)},
				{SerialNumber: "ABC-002", WarrantyMonths: nil},
			}},
			{VariantID: 2, Quantity: 1, UnitPrice: "85000.00", Units: units(1, months(6))},
		},
	})
	if err != nil {
		t.Fatalf("a valid sale must be admitted: %v", err)
	}
	if payload.Customer.Name != "Ana Pérez" {
		t.Fatalf("the client name must be canonical: %q", payload.Customer.Name)
	}
	// The address is one free field on the sale header: canonical text, never restructured.
	if payload.Customer.Address != "Av. Colón 1234, Barrio Norte" {
		t.Fatalf("the client address must be canonical: %q", payload.Customer.Address)
	}
	if len(payload.Lines) != 2 || payload.Lines[0].VariantID != 2 || payload.Lines[1].VariantID != 4 {
		t.Fatalf("lines must be in ascending variant order: %+v", payload.Lines)
	}
	if payload.Lines[1].UnitPrice != "96000.50" || payload.Lines[1].Subtotal != "192001.00" {
		t.Fatalf("the line must be canonical and exact: %+v", payload.Lines[1])
	}
	// The term belongs to the unit and is optional: the stated months and the absence of
	// warranty are both kept, in the order the seller registered them.
	for name, tc := range map[string]struct {
		units []sales.Unit
		want  []*int
	}{
		"first":  {payload.Lines[0].Units, []*int{months(6)}},
		"second": {payload.Lines[1].Units, []*int{months(12), nil}},
	} {
		if len(tc.units) != len(tc.want) {
			t.Fatalf("%s must keep one unit per sold piece: %+v", name, tc.units)
		}
		for i, unit := range tc.units {
			if (unit.WarrantyMonths == nil) != (tc.want[i] == nil) ||
				(unit.WarrantyMonths != nil && *unit.WarrantyMonths != *tc.want[i]) {
				t.Fatalf("%s must keep the term the seller stated per unit: %+v", name, tc.units)
			}
		}
	}
	if payload.Lines[1].Units[0].SerialNumber != "ABC-001" || payload.Lines[1].Units[1].SerialNumber != "ABC-002" {
		t.Fatalf("each unit must keep its own serial: %+v", payload.Lines[1].Units)
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
			Lines:    onePiece(1, "1.00", months(6)),
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
		{VariantID: 3, Quantity: 1, UnitPrice: "1.00", Units: units(1, months(6))},
		{VariantID: 1, Quantity: 1, UnitPrice: "1.00", Units: units(1, months(6))},
	}
	if _, err := sales.Validate(sales.CreateInput{Payments: cashPayment("2.00"),
		Customer: sales.Customer{Name: "Cliente"}, Lines: input}); err != nil {
		t.Fatal("a valid sale must be admitted")
	}
	if input[0].VariantID != 3 || input[1].VariantID != 1 {
		t.Fatal("validation must not reorder the caller's lines")
	}
	for name, in := range map[string]sales.CreateInput{
		"no_payments":      {Customer: sales.Customer{Name: "Cliente"}, Lines: onePiece(1, "1.00", months(6))},
		"unknown_method":   {Payments: []sales.Payment{{Method: "cheque", Amount: "1.00"}}, Customer: sales.Customer{Name: "Cliente"}, Lines: onePiece(1, "1.00", months(6))},
		"method_case":      {Payments: []sales.Payment{{Method: "CASH", Amount: "1.00"}}, Customer: sales.Customer{Name: "Cliente"}, Lines: onePiece(1, "1.00", months(6))},
		"derived_label":    {Payments: []sales.Payment{{Method: sales.PaymentMixed, Amount: "1.00"}}, Customer: sales.Customer{Name: "Cliente"}, Lines: onePiece(1, "1.00", months(6))},
		"repeated_method":  {Payments: []sales.Payment{{Method: sales.PaymentCash, Amount: "1.00"}, {Method: sales.PaymentCash, Amount: "1.00"}}, Customer: sales.Customer{Name: "Cliente"}, Lines: onePiece(1, "1.00", months(6))},
		"zero_amount":      {Payments: []sales.Payment{{Method: sales.PaymentCash, Amount: "0.00"}}, Customer: sales.Customer{Name: "Cliente"}, Lines: onePiece(1, "1.00", months(6))},
		"negative_amount":  {Payments: []sales.Payment{{Method: sales.PaymentCash, Amount: "-1.00"}}, Customer: sales.Customer{Name: "Cliente"}, Lines: onePiece(1, "1.00", months(6))},
		"three_decimals":   {Payments: []sales.Payment{{Method: sales.PaymentCash, Amount: "1.000"}}, Customer: sales.Customer{Name: "Cliente"}, Lines: onePiece(1, "1.00", months(6))},
		"one_decimal":      {Payments: []sales.Payment{{Method: sales.PaymentCash, Amount: "1.0"}}, Customer: sales.Customer{Name: "Cliente"}, Lines: onePiece(1, "1.00", months(6))},
		"integer_amount":   {Payments: []sales.Payment{{Method: sales.PaymentCash, Amount: "1"}}, Customer: sales.Customer{Name: "Cliente"}, Lines: onePiece(1, "1.00", months(6))},
		"padded_amount":    {Payments: []sales.Payment{{Method: sales.PaymentCash, Amount: "001.00"}}, Customer: sales.Customer{Name: "Cliente"}, Lines: onePiece(1, "1.00", months(6))},
		"text_amount":      {Payments: []sales.Payment{{Method: sales.PaymentCash, Amount: "abc"}}, Customer: sales.Customer{Name: "Cliente"}, Lines: onePiece(1, "1.00", months(6))},
		"empty_amount":     {Payments: []sales.Payment{{Method: sales.PaymentCash, Amount: ""}}, Customer: sales.Customer{Name: "Cliente"}, Lines: onePiece(1, "1.00", months(6))},
		"no_customer":      {Payments: cashPayment("1.00"), Lines: onePiece(1, "1.00", months(6))},
		"blank_customer":   {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "   "}, Lines: onePiece(1, "1.00", months(6))},
		"long_customer":    {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: strings.Repeat("ñ", sales.MaxCustomerName+1)}, Lines: onePiece(1, "1.00", months(6))},
		"nul_customer":     {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "a\x00b"}, Lines: onePiece(1, "1.00", months(6))},
		"long_phone":       {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "Cliente", Phone: strings.Repeat("7", sales.MaxCustomerPhone+1)}, Lines: onePiece(1, "1.00", months(6))},
		"long_document":    {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "Cliente", Document: strings.Repeat("7", sales.MaxCustomerDocument+1)}, Lines: onePiece(1, "1.00", months(6))},
		"long_address":     {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "Cliente", Address: strings.Repeat("ñ", sales.MaxCustomerAddress+1)}, Lines: onePiece(1, "1.00", months(6))},
		"nul_address":      {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "Cliente", Address: "a\x00b"}, Lines: onePiece(1, "1.00", months(6))},
		"no_lines":         {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "Cliente"}},
		"zero_variant":     {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "Cliente"}, Lines: onePiece(0, "1.00", months(6))},
		"negative_variant": {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "Cliente"}, Lines: onePiece(-1, "1.00", months(6))},
		"variant_bound":    {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "Cliente"}, Lines: onePiece(2147483648, "1.00", months(6))},
		"duplicate":        {Payments: cashPayment("3.00"), Customer: sales.Customer{Name: "Cliente"}, Lines: append(onePiece(1, "1.00", months(6)), onePiece(1, "1.00", months(6))...)},
		"zero_quantity":    {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 0, UnitPrice: "1.00", Units: units(0, months(6))}}},
		"price_precision":  {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "Cliente"}, Lines: onePiece(1, "85000.001", months(6))},
		"price_negative":   {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "Cliente"}, Lines: onePiece(1, "-1.00", months(6))},
		"price_zero":       {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "Cliente"}, Lines: onePiece(1, "0.00", months(6))},
		"price_empty":      {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "Cliente"}, Lines: onePiece(1, "", months(6))},
		"price_text":       {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "Cliente"}, Lines: onePiece(1, "abc", months(6))},
		// D3: the units are exactly as many as the line's quantity, so a line of two
		// with one serial or with three serials is refused as a whole.
		"unit_short":  {Payments: cashPayment("2.00"), Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 2, UnitPrice: "1.00", Units: units(1, months(6))}}},
		"unit_long":   {Payments: cashPayment("2.00"), Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 2, UnitPrice: "1.00", Units: units(3, months(6))}}},
		"no_units":    {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 1, UnitPrice: "1.00"}}},
		"units_alone": {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 0, UnitPrice: "1.00", Units: units(1, months(6))}}},
		// S2: the serial is free text between one and sixty-four characters after
		// trimming, without a NUL.
		"blank_serial":  {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 1, UnitPrice: "1.00", Units: []sales.Unit{{SerialNumber: "   ", WarrantyMonths: months(6)}}}}},
		"empty_serial":  {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 1, UnitPrice: "1.00", Units: []sales.Unit{{SerialNumber: "", WarrantyMonths: months(6)}}}}},
		"long_serial":   {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 1, UnitPrice: "1.00", Units: []sales.Unit{{SerialNumber: sales.SerialNumber(strings.Repeat("S", sales.MaxSerialLength+1)), WarrantyMonths: months(6)}}}}},
		"nul_serial":    {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 1, UnitPrice: "1.00", Units: []sales.Unit{{SerialNumber: "a\x00b", WarrantyMonths: months(6)}}}}},
		"negative_term": {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "Cliente"}, Lines: onePiece(1, "1.00", months(-1))},
		// S3: there is no zero months. Absence is a nil term, never zero.
		"zero_term":        {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "Cliente"}, Lines: onePiece(1, "1.00", months(0))},
		"term_above_bound": {Payments: cashPayment("1.00"), Customer: sales.Customer{Name: "Cliente"}, Lines: onePiece(1, "1.00", months(sales.MaxWarrantyMonths+1))},
		// D6: one sale carries at most one thousand units in total, so the documented
		// body limit stays reachable.
		"units_bound": {Payments: cashPayment("1001.00"), Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: 1, Quantity: sales.MaxUnits + 1, UnitPrice: "1.00", Units: units(sales.MaxUnits+1, months(6))}}},
		"units_split_bound": {Payments: cashPayment("1200.00"), Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{
			{VariantID: 1, Quantity: 600, UnitPrice: "1.00", Units: units(600, months(6))},
			{VariantID: 2, Quantity: 600, UnitPrice: "1.00", Units: units(600, months(6))},
		}},
	} {
		if _, err := sales.Validate(in); !errors.Is(err, sales.ErrInvalid) {
			t.Fatalf("%s must be refused by validation", name)
		}
	}
	// The bounds of the admitted document are exactly the frozen ones: one thousand units
	// and a two-hundred character address are admitted.
	if _, err := sales.Validate(sales.CreateInput{Payments: cashPayment("1000.00"),
		Customer: sales.Customer{Name: "Cliente", Address: strings.Repeat("ñ", sales.MaxCustomerAddress)},
		Lines:    []sales.LineInput{{VariantID: 1, Quantity: sales.MaxUnits, UnitPrice: "1.00", Units: units(sales.MaxUnits, months(6))}}}); err != nil {
		t.Fatalf("a document of the frozen bounds must be admitted: %v", err)
	}
	// The line bound is the number of catalogue variants.
	tooMany := make([]sales.LineInput, 0, sales.MaxLines+1)
	for i := 0; i <= sales.MaxLines; i++ {
		tooMany = append(tooMany, sales.LineInput{VariantID: int64(i + 1), Quantity: 1, UnitPrice: "1.00", Units: units(1, months(6))})
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
	line := onePiece(1, "1000.00", months(6))
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
		"unknown_method": {Payments: []sales.Payment{{Method: "cheque", Amount: "85000.00"}}, Customer: sales.Customer{Name: "Cliente"}, Lines: onePiece(1, "85000.00", months(6))},
		"no_payments":    {Customer: sales.Customer{Name: "Cliente"}, Lines: onePiece(1, "85000.00", months(6))},
		"open_sum":       {Payments: cashPayment("84999.99"), Customer: sales.Customer{Name: "Cliente"}, Lines: onePiece(1, "85000.00", months(6))},
		"no_lines":       {Payments: cashPayment("85000.00"), Customer: sales.Customer{Name: "Cliente"}},
		"bad_price":      {Payments: cashPayment("85000.00"), Customer: sales.Customer{Name: "Cliente"}, Lines: onePiece(1, "85000.001", months(6))},
		"unit_short":     {Payments: cashPayment("85000.00"), Customer: sales.Customer{Name: "Cliente"}, Lines: []sales.LineInput{{VariantID: 1, Quantity: 2, UnitPrice: "85000.00", Units: units(1, months(6))}}},
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
	// The counter catalogue of the branch lists both polarities of the priced battery as
	// sellable and the polarities of the unpriced battery as blocked rows, so the counter
	// can disable them instead of hiding them (S7).
	page, err := e.store.Sellable(e.ctx, clerk(2), sales.SellableQuery{Page: 1, PageSize: 10})
	if err != nil {
		t.Fatalf("catalogue read failed: %v", err)
	}
	if len(page.Items) != 10 || page.Items[0].VariantID != 1 || page.Items[1].VariantID != 2 {
		t.Fatalf("the catalogue must start with the priced battery: %+v", page)
	}
	for _, item := range page.Items {
		priced := item.CatalogEntryID == e.entryOf(t, 1)
		if item.Sellable != priced {
			t.Fatalf("the catalogue must block exactly the unpriced battery: %+v", item)
		}
		if item.VariantID > 4 {
			continue
		}
		existing, reserved, available := e.availability(t, 2, item.VariantID)
		if item.Existing != existing || item.Reserved != reserved || item.Available != available {
			t.Fatalf("every row must carry the branch balance: %+v", item)
		}
		if !priced && (item.SuggestedPrice != "" || item.MinPrice != "") {
			t.Fatalf("an unpriced battery must carry no pair: %+v", item)
		}
		if priced && (item.SuggestedPrice != "96000.00" || item.MinPrice != "85000.00") {
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
	if len(page.Items) != 10 {
		t.Fatalf("the catalogue must list the whole first page: %+v", page)
	}
	for _, item := range page.Items {
		if item.CatalogEntryID != entry {
			if item.Sellable || item.SuggestedPrice != "" || item.MinPrice != "" {
				t.Fatalf("only the priced battery is sellable: %+v", item)
			}
			continue
		}
		if !item.Sellable || item.MinPrice != "95000.00" || item.SuggestedPrice != "99000.00" {
			t.Fatalf("both polarities must carry the same battery pair: %+v", item)
		}
	}
}

// TestSaleUnitTermsAreSoldData pins the term model: the term belongs to the physical unit,
// the seller states it at the counter, it is optional, and nothing about a sale depends on
// a product warranty table.
func TestSaleUnitTermsAreSoldData(t *testing.T) {
	e := fixture(t)
	e.price(t, e.entryOf(t, 3), "85000", "96000", 2)
	if n := e.scalar(t, "SELECT count(*) FROM variant_warranties"); n != 0 {
		t.Fatalf("the fixture must not store a product term, got %d", n)
	}
	// A unit term of zero is not the absence of a warranty: absence is nil, and a zero is
	// an invalid request instead of a stored promise of nothing.
	before := e.snapshot(t)
	zeroTerm := sale(3, 1, "85000.00")
	zeroTerm.Lines[0].Units[0].WarrantyMonths = months(0)
	if _, err := e.store.Create(e.ctx, clerk(2), zeroTerm); !errors.Is(err, sales.ErrInvalid) {
		t.Fatalf("a zero-month term must be an invalid request: %v", err)
	}
	if e.snapshot(t) != before {
		t.Fatal("a refused term must not write a sale nor touch stock")
	}
	// The seller's own term is stored and returned by every read path, and no product
	// term is needed for the sale to exist.
	input := sale(3, 1, "85000.00")
	input.Lines[0].Units[0].WarrantyMonths = months(3)
	emitted, err := e.store.Create(e.ctx, clerk(2), input)
	if err != nil {
		t.Fatalf("a sale with a seller-stated term must be applied: %v", err)
	}
	if len(emitted.Lines[0].Units) != 1 || emitted.Lines[0].Units[0].WarrantyMonths == nil ||
		*emitted.Lines[0].Units[0].WarrantyMonths != 3 {
		t.Fatalf("the sale must return the seller's term: %+v", emitted.Lines[0])
	}
	detail, err := e.store.Read(e.ctx, clerk(2), emitted.ID)
	if err != nil || len(detail.Lines) != 1 || len(detail.Lines[0].Units) != 1 ||
		detail.Lines[0].Units[0].WarrantyMonths == nil || *detail.Lines[0].Units[0].WarrantyMonths != 3 {
		t.Fatalf("the read path must return the seller's term: %+v %v", detail, err)
	}
	// Two lines of one sale may state different terms, and the units of one line may state
	// a different term each: that is what the unit is for. Each line is a different
	// battery, because the price of a battery is shared by its two polarities.
	other := e.entryOf(t, 5)
	if other == e.entryOf(t, 3) {
		t.Fatal("the fixture needs two different batteries")
	}
	e.price(t, other, "10000", "12000", 2)
	if existing, _ := e.stock(t, 2, 5); existing < 2 {
		t.Fatalf("fixture expects stock to sell, got %d", existing)
	}
	mixed := sales.CreateInput{
		Payments: cashPayment("182000.00"),
		Customer: sales.Customer{Name: "Cliente"},
		Lines: []sales.LineInput{
			{VariantID: 3, Quantity: 2, UnitPrice: "85000.00", Units: []sales.Unit{
				{SerialNumber: "UNIT-A", WarrantyMonths: months(sales.MinWarrantyMonths)},
				{SerialNumber: "UNIT-B", WarrantyMonths: nil},
			}},
			{VariantID: 5, Quantity: 1, UnitPrice: "12000.00", Units: []sales.Unit{
				{SerialNumber: "UNIT-C", WarrantyMonths: months(sales.MaxWarrantyMonths)},
			}},
		},
	}
	mixedSale, err := e.store.Create(e.ctx, clerk(2), mixed)
	if err != nil {
		t.Fatalf("a sale with per-unit terms must be applied: %v", err)
	}
	if len(mixedSale.Lines) != 2 || len(mixedSale.Lines[0].Units) != 2 || len(mixedSale.Lines[1].Units) != 1 {
		t.Fatalf("each sold piece must be its own unit: %+v", mixedSale.Lines)
	}
	first := mixedSale.Lines[0].Units
	if first[0].WarrantyMonths == nil || *first[0].WarrantyMonths != sales.MinWarrantyMonths ||
		first[1].WarrantyMonths != nil {
		t.Fatalf("each unit must freeze its own term: %+v", first)
	}
	if term := mixedSale.Lines[1].Units[0].WarrantyMonths; term == nil || *term != sales.MaxWarrantyMonths {
		t.Fatalf("the widest term must be frozen with its unit: %+v", mixedSale.Lines[1])
	}
	// The absence of warranty is stored data, not a missing value: the row is there with a
	// NULL term, and the history counts it as a unit without warranty (S5).
	var stored *int16
	if err := e.pool.QueryRow(e.ctx, `SELECT warranty_months FROM sale_units
 WHERE sale_id=$1 AND variant_id=3 AND unit_ordinal=2`, mixedSale.ID).Scan(&stored); err != nil {
		t.Fatalf("the unit without warranty must be stored: %v", err)
	}
	if stored != nil {
		t.Fatalf("a unit sold without warranty must keep a NULL term, got %d", *stored)
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
			{VariantID: 3, Quantity: 1, UnitPrice: "85000.00", Units: units(1, months(6))},
			{VariantID: 5, Quantity: 1, UnitPrice: "10000.00", Units: units(1, months(6))},
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
	input.Lines[1] = sales.LineInput{VariantID: 5, Quantity: 200, UnitPrice: "10000.00", Units: units(200, months(6))}
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
	input.Lines[1].Units = units(1, months(6))
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

// TestSaleDetailCarriesTheBranchName pins the branch the warranty is printed for: the
// detail resolves the name of the selling branch from locations, each branch reads its
// own, and a sale of another branch is still not found.
func TestSaleDetailCarriesTheBranchName(t *testing.T) {
	e := fixture(t)
	e.price(t, e.entryOf(t, 1), "1000", "1200", 2, 3)
	first, err := e.store.Create(e.ctx, clerk(2), sale(1, 1, "1000.00"))
	if err != nil {
		t.Fatalf("the sale of the first branch failed: %v", err)
	}
	other, err := e.store.Create(e.ctx, clerk(3), sale(1, 1, "1000.00"))
	if err != nil {
		t.Fatalf("the sale of the second branch failed: %v", err)
	}
	for _, tc := range []struct {
		actor auth.Identity
		id    int64
		name  string
	}{
		{clerk(2), first.ID, "Sucursal A"},
		{clerk(3), other.ID, "Sucursal B"},
	} {
		detail, err := e.store.Read(e.ctx, tc.actor, tc.id)
		if err != nil {
			t.Fatalf("the emitted sale must stay readable: %v", err)
		}
		var stored string
		if err := e.pool.QueryRow(e.ctx, `SELECT l.name FROM sales s
 JOIN locations l ON l.id=s.branch_location_id WHERE s.id=$1`, tc.id).Scan(&stored); err != nil {
			t.Fatal("the branch name could not be read")
		}
		if detail.BranchName != tc.name || detail.BranchName != stored {
			t.Fatalf("the detail must carry the name of the selling branch: %q want %q", detail.BranchName, stored)
		}
	}
	// The name of another branch's sale is not readable, because the sale is not.
	if _, err := e.store.Read(e.ctx, clerk(2), other.ID); !errors.Is(err, sales.ErrNotFound) {
		t.Fatalf("another branch's document must not be found: %v", err)
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
// caller cannot choose the document numbers, the floor or the subtotal, while the serial
// and the term it writes on each unit are stored exactly as stated.
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
	if _, err := tx.Exec(e.ctx, `INSERT INTO sale_lines(sale_id,variant_id,quantity,unit_price,min_price,subtotal)
 VALUES($1,5,2,'90000.00',1,1)`, id); err != nil {
		t.Fatalf("raw line insert failed: %v", err)
	}
	// The line lost its term: the unit is the only authority for the promise now.
	var removed int64
	if err := tx.QueryRow(e.ctx, `SELECT count(*) FROM information_schema.columns
 WHERE table_name='sale_lines' AND column_name='warranty_months'`).Scan(&removed); err != nil {
		t.Fatalf("the sale line shape could not be read: %v", err)
	}
	if removed != 0 {
		t.Fatal("the sale line must no longer carry a warranty term")
	}
	if _, err := tx.Exec(e.ctx, `INSERT INTO sale_units(sale_id,variant_id,unit_ordinal,serial_number,warranty_months)
 VALUES($1,5,1,'RAW-001',30),($1,5,2,'RAW-002',NULL)`, id); err != nil {
		t.Fatalf("raw unit insert failed: %v", err)
	}
	var sequence int64
	var warranty, minPrice, subtotalMoney string
	if err := tx.QueryRow(e.ctx, `SELECT branch_sequence,warranty_number,min_price::text,subtotal::text
 FROM sales s JOIN sale_lines l ON l.sale_id=s.id WHERE s.id=$1`, id).Scan(&sequence, &warranty, &minPrice, &subtotalMoney); err != nil {
		t.Fatalf("persisted document read failed: %v", err)
	}
	if sequence != 1 || warranty != "2-000001" {
		t.Fatalf("the caller's document numbers must be overwritten: %d/%q", sequence, warranty)
	}
	if minPrice != "85000.00" || subtotalMoney != "180000.00" {
		t.Fatalf("the frozen floor and the derived subtotal must be the database's: %s/%s", minPrice, subtotalMoney)
	}
	// The seller's data is sale data: the serial and the term are frozen as stated, and the
	// absence of a warranty stays a NULL instead of a zero.
	var serial string
	var months *int16
	if err := tx.QueryRow(e.ctx, `SELECT serial_number,warranty_months FROM sale_units
 WHERE sale_id=$1 AND unit_ordinal=1`, id).Scan(&serial, &months); err != nil {
		t.Fatalf("the first unit could not be read: %v", err)
	}
	if serial != "RAW-001" || months == nil || *months != 30 {
		t.Fatalf("the seller's unit data must be frozen as stated: %q/%v", serial, months)
	}
	if err := tx.QueryRow(e.ctx, `SELECT warranty_months FROM sale_units
 WHERE sale_id=$1 AND unit_ordinal=2`, id).Scan(&months); err != nil {
		t.Fatalf("the second unit could not be read: %v", err)
	}
	if months != nil {
		t.Fatalf("a unit sold without warranty must keep a NULL term, got %d", *months)
	}
	// The transaction is released before the next one: the admission trigger holds the
	// branch row for the rest of it.
	if err := tx.Rollback(context.WithoutCancel(e.ctx)); err != nil {
		t.Fatalf("the raw sale transaction could not be released: %v", err)
	}
	// The document completeness is the database's too: a line of two with one unit is
	// refused as a whole at commit.
	short, err := e.pool.Begin(e.ctx)
	if err != nil {
		t.Fatal("fixture transaction failed")
	}
	defer short.Rollback(context.WithoutCancel(e.ctx))
	var shortID int64
	if err := short.QueryRow(e.ctx, `INSERT INTO sales(branch_location_id,cash_amount,customer_name,total,created_by_account_id)
 VALUES(2,170000.00,'Cliente',170000.00,2) RETURNING id`).Scan(&shortID); err != nil {
		t.Fatalf("raw header insert failed: %v", err)
	}
	if _, err := short.Exec(e.ctx, `INSERT INTO sale_lines(sale_id,variant_id,quantity,unit_price)
 VALUES($1,5,2,'85000.00')`, shortID); err != nil {
		t.Fatalf("raw line insert failed: %v", err)
	}
	if _, err := short.Exec(e.ctx, `INSERT INTO sale_units(sale_id,variant_id,unit_ordinal,serial_number)
 VALUES($1,5,1,'SHORT-RAW')`, shortID); err != nil {
		t.Fatalf("raw unit insert failed: %v", err)
	}
	if err := short.Commit(e.ctx); err == nil {
		t.Fatal("a line of two with one unit must be refused by the database")
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
	if line.UnitPrice != "90000.00" || line.MinPrice != "85000.00" || len(line.Units) != 2 ||
		line.Subtotal != "180000.00" || line.Capacity == "" || line.Brand == "" || line.Model == "" {
		t.Fatalf("the emitted line must keep the prices of the sale: %+v", line)
	}
	if detail.Total != "180000.00" || detail.WarrantyNumber != emitted.WarrantyNumber {
		t.Fatalf("the emitted document must keep its own numbers: %+v", detail)
	}
	// The branch that sold is resolved from locations, so the warranty can be printed with
	// the branch it belongs to (S11).
	if detail.BranchName != "Sucursal A" {
		t.Fatalf("the detail must carry the name of the selling branch: %q", detail.BranchName)
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
		summary.CustomerName != "Cliente Mostrador" || summary.Total != "1000.00" || summary.Lines != 1 ||
		summary.UnitsTotal != 1 || summary.UnitsWithWarranty != 1 {
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

// TestSaleSellableCatalogue pins the catalogue the counter reads: every variant of the
// catalogue comes back once with the stock of the branch and whether the branch can sell it
// right now, so an unpriced variant is a blocked row instead of an absent one (S7). The
// price is the battery's, so the two polarities of one battery always carry the same pair,
// and the warranty term is deliberately absent: the seller states it on the sale.
func TestSaleSellableCatalogue(t *testing.T) {
	e := fixture(t)
	e.price(t, e.entryOf(t, 1), "85000", "96000.5", 2, 3)
	e.price(t, e.entryOf(t, 3), "10000", "12000", 2)
	e.price(t, e.entryOf(t, 5), "5000", "6000", 2)
	total := e.scalar(t, "SELECT count(*) FROM catalog_variants")
	page, err := e.store.Sellable(e.ctx, clerk(2), sales.SellableQuery{Page: 1, PageSize: 50})
	if err != nil {
		t.Fatalf("catalogue read failed: %v", err)
	}
	// The page lists the catalogue in order and counts every variant, priced or not.
	if page.Page != 1 || page.PageSize != 50 || page.TotalVariants != total || len(page.Items) != 50 {
		t.Fatalf("the catalogue must page every variant and count them all: %+v", page)
	}
	for i := 1; i < len(page.Items); i++ {
		if page.Items[i].VariantID <= page.Items[i-1].VariantID {
			t.Fatalf("the catalogue order must be deterministic: %+v", page.Items[i-1])
		}
	}
	// The three priced batteries are the batteries of variants 1, 3 and 5, so their six
	// polarities are the sellable rows and the rest of the catalogue is blocked.
	sellable := map[int64]bool{1: true, 2: true, 3: true, 4: true, 5: true, 6: true}
	for _, item := range page.Items {
		if item.VariantID > 6 {
			continue
		}
		if item.Brand == "" || item.Model == "" || item.Capacity == "" ||
			(item.Polarity != "L" && item.Polarity != "R") {
			t.Fatalf("the catalogue item must carry the catalogue identity: %+v", item)
		}
		if item.Sellable != sellable[item.VariantID] {
			t.Fatalf("variant %d must be sellable=%v: %+v", item.VariantID, sellable[item.VariantID], item)
		}
	}
	// The first two rows are the two polarities of the first priced battery, at its pair.
	if first := page.Items[0]; !first.Sellable || first.SuggestedPrice != "96000.50" ||
		first.MinPrice != "85000.00" {
		t.Fatalf("the item must carry the prices in force: %+v", first)
	}
	if second := page.Items[1]; !second.Sellable || second.SuggestedPrice != "96000.50" ||
		second.MinPrice != "85000.00" {
		t.Fatalf("both polarities must carry the pair of their battery: %+v", second)
	}
	// A variant whose battery has no price in the branch is still a row: blocked, with no
	// pair at all and with the branch's real availability.
	for _, blocked := range []int64{7, 8} {
		item := page.Items[blocked-1]
		existing, reserved, available := e.availability(t, 2, blocked)
		if item.VariantID != blocked || item.Sellable || item.SuggestedPrice != "" ||
			item.MinPrice != "" || item.Existing != existing || item.Reserved != reserved ||
			item.Available != available {
			t.Fatalf("an unpriced variant must be published blocked: %+v want %d/%d/%d",
				item, existing, reserved, available)
		}
	}
	// A priced variant carries the balance of the branch, which is the counter's own datum.
	existing, reserved, available := e.availability(t, 2, 1)
	if got := page.Items[0]; got.Existing != existing || got.Reserved != reserved ||
		got.Available != available {
		t.Fatalf("a sellable variant must carry the branch balance: %+v want %d/%d/%d",
			got, existing, reserved, available)
	}
	// Branch 3 only prices the first battery, so its catalogue is the same size and only
	// those two polarities are sellable.
	other, err := e.store.Sellable(e.ctx, clerk(3), sales.SellableQuery{Page: 1, PageSize: 10})
	if err != nil || other.TotalVariants != total || len(other.Items) != 10 {
		t.Fatalf("each branch must see the whole catalogue: %+v %v", other, err)
	}
	for i, item := range other.Items {
		want := i < 2
		if item.Sellable != want {
			t.Fatalf("branch 3 must sell only the priced battery: %+v", item)
		}
		if want && (item.SuggestedPrice != "96000.50" || item.MinPrice != "85000.00") {
			t.Fatalf("the sellable pair of branch 3 is wrong: %+v", item)
		}
	}
	// Every filter is derived from the source catalogue instead of being guessed, and each
	// counts every matching variant, priced or not.
	source, err := catalog.Load()
	if err != nil {
		t.Fatal("catalogue source load failed")
	}
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
		for variantID := int64(1); variantID <= total; variantID++ {
			if matches(query, source.Entries[(variantID-1)/2], variantID) {
				want++
			}
		}
		query.Page, query.PageSize = 1, 50
		result, err := e.store.Sellable(e.ctx, clerk(2), query)
		if err != nil {
			t.Fatalf("%s filter failed: %v", name, err)
		}
		if int64(result.TotalVariants) != int64(want) {
			t.Fatalf("%s counted %d variants, want %d", name, result.TotalVariants, want)
		}
		if want <= 50 && len(result.Items) != want {
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
		// The document needs its line and one unit per sold piece, so the header is inserted
		// the same way a writer would and the deferred guards are satisfied.
		if _, err := tx.Exec(e.ctx, `INSERT INTO sale_lines(sale_id,variant_id,quantity,unit_price)
 VALUES($1,5,2,'90000.00')`, id); err != nil {
			return err
		}
		if _, err := tx.Exec(e.ctx, `INSERT INTO sale_units(sale_id,variant_id,unit_ordinal,serial_number,warranty_months)
 VALUES($1,5,1,$2,6),($1,5,2,$3,6)`, id, fmt.Sprintf("PAY-%d-1", id), fmt.Sprintf("PAY-%d-2", id)); err != nil {
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

// TestSaleQRPayment pins S13 in the point of sale: QR is the fourth amount of a sale. A
// document paid only by QR is admitted and reports 'qr', a document where QR pays together
// with cash reports 'mixed', all four methods together are still one sale, and the amounts
// must close against the total exactly -- a settlement that does not close is refused with
// the open side named and writes nothing.
func TestSaleQRPayment(t *testing.T) {
	e := fixture(t)
	e.price(t, e.entryOf(t, 3), "1000", "1200", 2)
	e.setStock(t, 2, 3, 10, 0)
	// The fourth method is stated by the text the database stores and derives.
	const qr = sales.PaymentMethod("qr")
	// A sale paid only by QR.
	only := sale(3, 1, "1000.00")
	only.Payments = []sales.Payment{{Method: qr, Amount: "1000.00"}}
	emitted, err := e.store.Create(e.ctx, clerk(2), only)
	if err != nil {
		t.Fatalf("a sale settled by QR must be applied: %v", err)
	}
	if emitted.PaymentMethod != qr || len(emitted.Payments) != 1 ||
		emitted.Payments[0] != (sales.Payment{Method: qr, Amount: "1000.00"}) {
		t.Fatalf("a sale paid only by QR must read back as qr: %+v", emitted)
	}
	// The amount lives under its own column and the label is the database's own.
	var cash, card, transfer, qrAmount, label string
	if err := e.pool.QueryRow(e.ctx, `SELECT cash_amount::text,card_amount::text,
  transfer_amount::text,qr_amount::text,payment_method FROM sales WHERE id=$1`,
		emitted.ID).Scan(&cash, &card, &transfer, &qrAmount, &label); err != nil {
		t.Fatal("the persisted QR settlement could not be read")
	}
	if cash != "0.00" || card != "0.00" || transfer != "0.00" || qrAmount != "1000.00" ||
		label != "qr" {
		t.Fatalf("the QR amount must live under its own method: %s/%s/%s/%s/%s", cash, card,
			transfer, qrAmount, label)
	}
	// QR plus cash is a mixed sale, and both amounts come back in the frozen order.
	mixed := sale(3, 1, "1000.00")
	mixed.Payments = []sales.Payment{{Method: qr, Amount: "600.00"},
		{Method: sales.PaymentCash, Amount: "400.00"}}
	paired, err := e.store.Create(e.ctx, clerk(2), mixed)
	if err != nil {
		t.Fatalf("a sale settled in cash and QR must be applied: %v", err)
	}
	if paired.PaymentMethod != sales.PaymentMixed || len(paired.Payments) != 2 ||
		paired.Payments[0] != (sales.Payment{Method: sales.PaymentCash, Amount: "400.00"}) ||
		paired.Payments[1] != (sales.Payment{Method: qr, Amount: "600.00"}) {
		t.Fatalf("cash and QR must be a mixed sale in the frozen order: %+v", paired)
	}
	// Every admitted method at once is still one sale and still mixed.
	all := sale(3, 1, "1000.00")
	all.Payments = []sales.Payment{{Method: sales.PaymentCash, Amount: "100.00"},
		{Method: sales.PaymentCard, Amount: "200.00"},
		{Method: sales.PaymentTransfer, Amount: "300.00"},
		{Method: qr, Amount: "400.00"}}
	full, err := e.store.Create(e.ctx, clerk(2), all)
	if err != nil {
		t.Fatalf("a sale settled with all four methods must be applied: %v", err)
	}
	if full.PaymentMethod != sales.PaymentMixed || len(full.Payments) != 4 ||
		full.Payments[3] != (sales.Payment{Method: qr, Amount: "400.00"}) {
		t.Fatalf("four paying methods must be one mixed sale: %+v", full)
	}
	// The detail and the history report the same derived label, so the QR sale is legible
	// and filterable like any other.
	detail, err := e.store.Read(e.ctx, clerk(2), emitted.ID)
	if err != nil || detail.PaymentMethod != qr || len(detail.Payments) != 1 ||
		detail.Payments[0] != emitted.Payments[0] {
		t.Fatalf("the detail of a QR sale must keep its label and its payment: %+v %v", detail, err)
	}
	page, err := e.store.List(e.ctx, clerk(2), sales.ListQuery{PaymentMethod: "qr", Page: 1,
		PageSize: 25})
	if err != nil || page.TotalSales != 1 || len(page.Sales) != 1 ||
		page.Sales[0].PaymentMethod != qr {
		t.Fatalf("the history must filter the QR sale by its label: %+v %v", page, err)
	}
	// The exact sum is the document rule, with QR as one more side of it.
	existing, reserved := e.stock(t, 2, 3)
	before := e.snapshot(t)
	broken := sale(3, 1, "1000.00")
	broken.Payments = []sales.Payment{{Method: qr, Amount: "900.00"},
		{Method: sales.PaymentCash, Amount: "50.00"}}
	_, err = e.store.Create(e.ctx, clerk(2), broken)
	var mismatch *sales.PaymentsMismatch
	if !errors.As(err, &mismatch) || mismatch.Missing != "50.00" || mismatch.Excess != "" {
		t.Fatalf("a settlement that does not close must name the open side: %v", err)
	}
	if !errors.Is(err, sales.ErrInvalid) {
		t.Fatalf("the refused settlement must stay the invalid-document refusal: %v", err)
	}
	if e.snapshot(t) != before {
		t.Fatal("a settlement that does not close must not write a sale nor touch stock")
	}
	if got, gotReserved := e.stock(t, 2, 3); got != existing || gotReserved != reserved {
		t.Fatalf("the refused sale must leave the balance untouched: %d/%d", got, gotReserved)
	}
}

// TestSaleUnitsAreStoredPerUnit pins S2, S3 and S4: the line stays commercial and every
// physical battery is its own unit, with the serial the seller read at the counter and the
// term stated for that battery, which may differ from the term of its siblings.
func TestSaleUnitsAreStoredPerUnit(t *testing.T) {
	e := fixture(t)
	e.price(t, e.entryOf(t, 3), "85000", "96000", 2)
	if existing, _ := e.stock(t, 2, 3); existing < 3 {
		t.Fatalf("fixture expects stock to sell, got %d", existing)
	}
	input := sales.CreateInput{
		Payments: cashPayment("255000.00"),
		Customer: sales.Customer{Name: "Cliente"},
		Lines: []sales.LineInput{{VariantID: 3, Quantity: 3, UnitPrice: "85000.00", Units: []sales.Unit{
			// The serial is trimmed when it is stored, because a padded spelling is the
			// same battery the seller read.
			{SerialNumber: "  ABC-001  ", WarrantyMonths: months(12)},
			{SerialNumber: "ABC-002", WarrantyMonths: nil},
			{SerialNumber: "ABC-003", WarrantyMonths: months(6)},
		}}},
	}
	emitted, err := e.store.Create(e.ctx, clerk(2), input)
	if err != nil {
		t.Fatalf("a sale of three batteries must be applied: %v", err)
	}
	if len(emitted.Lines) != 1 || len(emitted.Lines[0].Units) != 3 {
		t.Fatalf("the sale must answer one unit per sold piece: %+v", emitted.Lines)
	}
	want := []struct {
		serial string
		term   *int
	}{{"ABC-001", months(12)}, {"ABC-002", nil}, {"ABC-003", months(6)}}
	for i, unit := range emitted.Lines[0].Units {
		if string(unit.SerialNumber) != want[i].serial ||
			(unit.WarrantyMonths == nil) != (want[i].term == nil) ||
			(unit.WarrantyMonths != nil && *unit.WarrantyMonths != *want[i].term) {
			t.Fatalf("unit %d does not match what the seller registered: %+v", i+1, unit)
		}
	}
	// The units are persisted rows of their own, one ordinal per piece, so the sale is
	// legible without unfolding a line count.
	rows, err := e.pool.Query(e.ctx, `SELECT unit_ordinal,serial_number,warranty_months FROM sale_units
 WHERE sale_id=$1 AND variant_id=3 ORDER BY unit_ordinal`, emitted.ID)
	if err != nil {
		t.Fatal("the units could not be read")
	}
	defer rows.Close()
	ordinal := 0
	for rows.Next() {
		var stored int
		var serial string
		var term *int16
		if err := rows.Scan(&stored, &serial, &term); err != nil {
			t.Fatal("the unit row could not be read")
		}
		ordinal++
		if stored != ordinal || serial != want[ordinal-1].serial ||
			(term == nil) != (want[ordinal-1].term == nil) {
			t.Fatalf("the stored unit %d is not what was sold: %d %q %v", ordinal, stored, serial, term)
		}
	}
	if rows.Err() != nil || ordinal != 3 {
		t.Fatalf("three units must be persisted, got %d", ordinal)
	}
	// Every read path answers the same units, so the detail and the history agree with the
	// creation answer.
	detail, err := e.store.Read(e.ctx, clerk(2), emitted.ID)
	if err != nil || len(detail.Lines) != 1 || len(detail.Lines[0].Units) != 3 {
		t.Fatalf("the detail must carry the units: %+v %v", detail, err)
	}
	for i, unit := range detail.Lines[0].Units {
		if string(unit.SerialNumber) != want[i].serial {
			t.Fatalf("the detail must keep the serial order of the sale: %+v", detail.Lines[0].Units)
		}
	}
	page, err := e.store.List(e.ctx, clerk(2), sales.ListQuery{Page: 1, PageSize: 25})
	if err != nil || len(page.Sales) != 1 {
		t.Fatalf("the history read failed: %+v %v", page, err)
	}
	if row := page.Sales[0]; row.Lines != 1 || row.UnitsTotal != 3 || row.UnitsWithWarranty != 2 {
		t.Fatalf("the history row must count the units and their warranties: %+v", row)
	}
}

// TestSaleSerialCannotBeSoldTwice pins D2: one physical battery is sold once, and the
// comparison is the one the counter makes -- trimmed and case folded -- so a typo is caught
// while the battery is in hand. A repeated serial refuses the whole document.
func TestSaleSerialCannotBeSoldTwice(t *testing.T) {
	e := fixture(t)
	e.price(t, e.entryOf(t, 3), "85000", "96000", 2)
	if _, err := e.store.Create(e.ctx, clerk(2), sale(3, 1, "85000.00")); err != nil {
		t.Fatalf("the first sale failed: %v", err)
	}
	var firstSerial string
	if err := e.pool.QueryRow(e.ctx, "SELECT serial_number FROM sale_units").Scan(&firstSerial); err != nil {
		t.Fatal("the first serial could not be read")
	}
	before := e.snapshot(t)
	for name, serial := range map[string]string{
		"same":       firstSerial,
		"case_fold":  strings.ToLower(firstSerial),
		"padded":     "  " + strings.ToUpper(firstSerial) + "  ",
		"padded_mix": " " + firstSerial + "\t",
	} {
		second := sale(3, 1, "85000.00")
		second.Lines[0].Units[0].SerialNumber = sales.SerialNumber(serial)
		_, err := e.store.Create(e.ctx, clerk(2), second)
		var refused *sales.SerialAlreadySold
		if !errors.As(err, &refused) {
			t.Fatalf("%s must be named as an already sold serial: %v", name, err)
		}
		if !errors.Is(err, sales.ErrSerialAlreadySold) {
			t.Fatalf("%s must stay the already-sold refusal", name)
		}
		if refused.Serial == "" || strings.ToUpper(strings.TrimSpace(string(refused.Serial))) != strings.ToUpper(firstSerial) {
			t.Fatalf("%s must name the serial it refused: %q", name, refused.Serial)
		}
		if e.snapshot(t) != before {
			t.Fatalf("%s must not write a sale, a unit nor touch stock", name)
		}
	}
	// Two units of one sale cannot share a serial either: the whole document is refused.
	doubled := sale(3, 2, "85000.00")
	doubled.Lines[0].Units[1].SerialNumber = doubled.Lines[0].Units[0].SerialNumber
	if _, err := e.store.Create(e.ctx, clerk(2), doubled); !errors.Is(err, sales.ErrSerialAlreadySold) {
		t.Fatalf("a serial repeated inside one sale must be refused: %v", err)
	}
	if e.snapshot(t) != before {
		t.Fatal("a sale with a repeated serial must write nothing at all")
	}
}

// TestSaleConcurrentSellersOfOneSerialAdmitOne pins D2 under contention: several sellers
// charge the same physical battery at the same moment, exactly one sale is admitted, every
// other document is refused as already sold and names the serial, one unit row exists and
// the branch stock moved exactly once.
func TestSaleConcurrentSellersOfOneSerialAdmitOne(t *testing.T) {
	e := fixture(t)
	e.price(t, e.entryOf(t, 3), "85000", "96000", 2)
	const sellers = 8
	// The branch must hold a battery for each seller, so an admitted sale is never refused
	// for stock and the refusal being counted is only the serial's.
	if existing, _ := e.stock(t, 2, 3); existing < sellers {
		e.setStock(t, 2, 3, sellers, 0)
	}
	existing, reserved := e.stock(t, 2, 3)
	serial := sales.SerialNumber(fmt.Sprintf("CONCURRENT-%d", serialSeq.Add(1)))
	admitted := make([]bool, sellers)
	failures := make([]error, sellers)
	var wg sync.WaitGroup
	for i := 0; i < sellers; i++ {
		charge := sale(3, 1, "85000.00")
		charge.Lines[0].Units[0].SerialNumber = serial
		wg.Add(1)
		go func(index int, input sales.CreateInput) {
			defer wg.Done()
			_, err := e.store.Create(e.ctx, clerk(2), input)
			admitted[index] = err == nil
			failures[index] = err
		}(i, charge)
	}
	wg.Wait()
	admittedCount := 0
	for i := range failures {
		if admitted[i] {
			admittedCount++
			continue
		}
		var refused *sales.SerialAlreadySold
		if !errors.As(failures[i], &refused) || !errors.Is(failures[i], sales.ErrSerialAlreadySold) {
			t.Fatalf("seller %d must be refused as an already sold serial: %v", i, failures[i])
		}
		if refused.Serial != serial {
			t.Fatalf("seller %d must be refused naming the serial, got %q", i, refused.Serial)
		}
	}
	if admittedCount != 1 {
		t.Fatalf("exactly one simultaneous sale of one battery must be admitted, got %d", admittedCount)
	}
	if n := e.scalar(t, "SELECT count(*) FROM sales"); n != 1 {
		t.Fatalf("the refused documents must store no sale, got %d", n)
	}
	if n := e.scalar(t, "SELECT count(*) FROM sale_units WHERE upper(btrim(serial_number))=upper($1)", string(serial)); n != 1 {
		t.Fatalf("one physical battery is one unit row, got %d", n)
	}
	if after, held := e.stock(t, 2, 3); after != existing-1 || held != reserved {
		t.Fatalf("stock must move exactly once: %d/%d, want %d/%d", after, held, existing-1, reserved)
	}
}

// TestSaleUnitsMustMatchQuantity pins D3: the units are exactly as many as the line's
// quantity and the sale is atomic, so a document with a short or a long line stores
// nothing.
func TestSaleUnitsMustMatchQuantity(t *testing.T) {
	e := fixture(t)
	e.price(t, e.entryOf(t, 3), "85000", "96000", 2)
	before := e.snapshot(t)
	for name, line := range map[string]sales.LineInput{
		"short": {VariantID: 3, Quantity: 3, UnitPrice: "85000.00", Units: units(2, months(6))},
		"long":  {VariantID: 3, Quantity: 2, UnitPrice: "85000.00", Units: units(3, months(6))},
		"none":  {VariantID: 3, Quantity: 1, UnitPrice: "85000.00"},
		"blank_serial": {VariantID: 3, Quantity: 1, UnitPrice: "85000.00",
			Units: []sales.Unit{{SerialNumber: "   ", WarrantyMonths: months(6)}}},
		"long_serial": {VariantID: 3, Quantity: 1, UnitPrice: "85000.00",
			Units: []sales.Unit{{SerialNumber: sales.SerialNumber(strings.Repeat("S", sales.MaxSerialLength+1))}}},
		"zero_term": {VariantID: 3, Quantity: 1, UnitPrice: "85000.00",
			Units: []sales.Unit{{SerialNumber: "ZERO-TERM", WarrantyMonths: months(0)}}},
		"term_above": {VariantID: 3, Quantity: 1, UnitPrice: "85000.00",
			Units: []sales.Unit{{SerialNumber: "ABOVE-TERM", WarrantyMonths: months(sales.MaxWarrantyMonths + 1)}}},
	} {
		total, err := sales.LineTotal(sales.Money("85000.00"), line.Quantity)
		if err != nil {
			t.Fatal("the fixture amount is not canonical")
		}
		if _, err := e.store.Create(e.ctx, clerk(2), sales.CreateInput{
			Payments: cashPayment(string(total)), Customer: sales.Customer{Name: "Cliente"},
			Lines: []sales.LineInput{line},
		}); !errors.Is(err, sales.ErrInvalid) {
			t.Fatalf("%s must be an invalid document: %v", name, err)
		}
		if e.snapshot(t) != before {
			t.Fatalf("%s must not write a sale, a unit nor touch stock", name)
		}
	}
	// One thousand units is the widest admitted sale, and the whole line is stored.
	if n := e.scalar(t, "SELECT existing FROM inventory_balances WHERE location_id=2 AND variant_id=3"); n < 1000 {
		e.setStock(t, 2, 3, 2000, 0)
	}
	wide := sale(3, sales.MaxUnits, "85000.00")
	emitted, err := e.store.Create(e.ctx, clerk(2), wide)
	if err != nil {
		t.Fatalf("a sale of one thousand units must be admitted: %v", err)
	}
	if n := e.scalar(t, "SELECT count(*) FROM sale_units WHERE sale_id=$1", emitted.ID); n != sales.MaxUnits {
		t.Fatalf("one thousand units must be stored, got %d", n)
	}
	// One unit above the bound is refused before any database work.
	tooMany := sale(3, sales.MaxUnits+1, "85000.00")
	if _, err := e.store.Create(e.ctx, clerk(2), tooMany); !errors.Is(err, sales.ErrInvalid) {
		t.Fatalf("a sale above one thousand units must be refused: %v", err)
	}
}

// TestSaleHistoryNamesUnitsWithoutWarranty pins S5 on the read side: the history row tells
// how many units the sale holds and how many of them were sold without warranty, so the
// branch can see an unwarranted battery without unfolding the document.
func TestSaleHistoryNamesUnitsWithoutWarranty(t *testing.T) {
	e := fixture(t)
	e.price(t, e.entryOf(t, 3), "85000", "96000", 2)
	// Two batteries without warranty and one with it.
	withTerms := sale(3, 3, "85000.00")
	withTerms.Lines[0].Units[0].WarrantyMonths = months(12)
	withTerms.Lines[0].Units[1].WarrantyMonths = nil
	withTerms.Lines[0].Units[2].WarrantyMonths = nil
	first, err := e.store.Create(e.ctx, clerk(2), withTerms)
	if err != nil {
		t.Fatalf("the sale of three batteries failed: %v", err)
	}
	// A sale where no battery carries a warranty is still registered and named as such.
	noWarranty := sale(3, 2, "85000.00")
	noWarranty.Lines[0].Units[0].WarrantyMonths = nil
	noWarranty.Lines[0].Units[1].WarrantyMonths = nil
	second, err := e.store.Create(e.ctx, clerk(2), noWarranty)
	if err != nil {
		t.Fatalf("a sale without warranty must be admitted: %v", err)
	}
	page, err := e.store.List(e.ctx, clerk(2), sales.ListQuery{Page: 1, PageSize: 25})
	if err != nil || len(page.Sales) != 2 {
		t.Fatalf("the history read failed: %+v %v", page, err)
	}
	byID := map[int64]sales.Summary{}
	for _, row := range page.Sales {
		byID[row.ID] = row
	}
	if row := byID[first.ID]; row.Lines != 1 || row.UnitsTotal != 3 || row.UnitsWithWarranty != 1 {
		t.Fatalf("the mixed row must count one warranted unit of three: %+v", row)
	}
	if row := byID[second.ID]; row.UnitsTotal != 2 || row.UnitsWithWarranty != 0 {
		t.Fatalf("the row without warranty must count zero warranted units: %+v", row)
	}
}

// TestSaleAddressIsSaleData pins S1: the address is one optional free field of the sale
// header, bounded at two hundred characters, visible in the detail and empty when absent.
func TestSaleAddressIsSaleData(t *testing.T) {
	e := fixture(t)
	e.price(t, e.entryOf(t, 3), "85000", "96000", 2)
	plain, err := e.store.Create(e.ctx, clerk(2), sale(3, 1, "85000.00"))
	if err != nil {
		t.Fatalf("a sale without an address must be admitted: %v", err)
	}
	if plain.Customer.Address != "" {
		t.Fatalf("an absent address must be empty: %q", plain.Customer.Address)
	}
	addressed := sale(3, 1, "85000.00")
	addressed.Customer.Address = "  Av. Colón 1234, Barrio Norte  "
	emitted, err := e.store.Create(e.ctx, clerk(2), addressed)
	if err != nil {
		t.Fatalf("a sale with an address must be admitted: %v", err)
	}
	detail, err := e.store.Read(e.ctx, clerk(2), emitted.ID)
	if err != nil {
		t.Fatalf("the emitted sale must stay readable: %v", err)
	}
	if detail.Customer.Address != "Av. Colón 1234, Barrio Norte" {
		t.Fatalf("the detail must carry the address as written: %q", detail.Customer.Address)
	}
	var stored string
	if err := e.pool.QueryRow(e.ctx, "SELECT customer_address FROM sales WHERE id=$1", emitted.ID).Scan(&stored); err != nil {
		t.Fatal("the stored address could not be read")
	}
	if stored != detail.Customer.Address {
		t.Fatalf("the address must be stored as the sale answered it: %q", stored)
	}
	// The bound is the database's own: one character above two hundred writes nothing.
	before := e.snapshot(t)
	tooLong := sale(3, 1, "85000.00")
	tooLong.Customer.Address = strings.Repeat("ñ", sales.MaxCustomerAddress+1)
	if _, err := e.store.Create(e.ctx, clerk(2), tooLong); !errors.Is(err, sales.ErrInvalid) {
		t.Fatalf("an address above the bound must be refused: %v", err)
	}
	if e.snapshot(t) != before {
		t.Fatal("a refused address must not write a sale nor touch stock")
	}
	// The widest admitted address is stored whole.
	widest := sale(3, 1, "85000.00")
	widest.Customer.Address = strings.Repeat("ñ", sales.MaxCustomerAddress)
	wide, err := e.store.Create(e.ctx, clerk(2), widest)
	if err != nil {
		t.Fatalf("the widest address must be admitted: %v", err)
	}
	if len([]rune(wide.Customer.Address)) != sales.MaxCustomerAddress {
		t.Fatalf("the address must be kept whole: %d", len([]rune(wide.Customer.Address)))
	}
}

// TestSaleValidatePersisted pins the two contracts the reader needs apart (S5, S7, T12).
// The write contract still requires exactly one unit per sold piece, so a sale is never
// registered without the series the counter reads. The persisted contract admits one more
// shape: a document that carries no unit at all was stored before the sold unit existed,
// so it is recoverable history with empty units, never corruption. A document carrying
// some units but fewer than its sold pieces is corrupt under both contracts.
func TestSaleValidatePersisted(t *testing.T) {
	preVertical := func() sales.CreateInput {
		return sales.CreateInput{
			Payments: cashPayment("192000.00"),
			Customer: sales.Customer{Name: "Cliente Mostrador"},
			Lines:    []sales.LineInput{{VariantID: 1, Quantity: 2, UnitPrice: "96000.00"}},
		}
	}
	if _, err := sales.Validate(preVertical()); !errors.Is(err, sales.ErrInvalid) {
		t.Fatalf("the write contract must still require one unit per sold piece: %v", err)
	}
	payload, err := sales.ValidatePersisted(preVertical())
	if err != nil {
		t.Fatalf("a pre-vertical document must be admitted by the persisted contract: %v", err)
	}
	if len(payload.Lines) != 1 || payload.Lines[0].Quantity != 2 || len(payload.Lines[0].Units) != 0 ||
		payload.Total != "192000.00" {
		t.Fatalf("a pre-vertical document keeps its line and states no unit: %+v", payload)
	}
	// A partially united document is corrupt: some units, fewer than the sold pieces.
	short := preVertical()
	short.Lines[0].Units = units(1, months(6))
	if _, err := sales.ValidatePersisted(short); !errors.Is(err, sales.ErrInvalid) {
		t.Fatalf("a sale whose units are short of its pieces must fail closed: %v", err)
	}
	// So is one unit too many.
	long := preVertical()
	long.Lines[0].Units = units(3, months(6))
	if _, err := sales.ValidatePersisted(long); !errors.Is(err, sales.ErrInvalid) {
		t.Fatalf("a sale with more units than pieces must fail closed: %v", err)
	}
	// One line without units beside one line with them is not a pre-vertical document: no
	// contract ever stored that, so it fails closed.
	mixed := preVertical()
	mixed.Payments = cashPayment("288000.00")
	mixed.Lines = append(mixed.Lines, sales.LineInput{VariantID: 3, Quantity: 1,
		UnitPrice: "96000.00", Units: units(1, months(6))})
	if _, err := sales.ValidatePersisted(mixed); !errors.Is(err, sales.ErrInvalid) {
		t.Fatalf("a partially united document must fail closed: %v", err)
	}
}
