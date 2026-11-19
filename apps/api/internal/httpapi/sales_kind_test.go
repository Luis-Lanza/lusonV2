package httpapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"luson/api/internal/catalog"
	"luson/api/internal/sales"
)

// saleHTTPProduct seeds one other product exactly like the catalog screen writes it, prices
// it in one branch and stocks it, returning its catalogue entry and its one variant.
func saleHTTPProduct(t *testing.T, f *saleHTTPFixture, branch int64, minimum, suggested string,
	stock int64, name string) (entry, variant int64) {
	t.Helper()
	if err := f.p.QueryRow(f.ctx,
		"INSERT INTO catalog_entries(kind,name) VALUES('other',$1) RETURNING id", name).Scan(&entry); err != nil {
		t.Fatalf("product fixture setup failed: %v", err)
	}
	if _, err := f.p.Exec(f.ctx, "INSERT INTO catalog_variants(catalog_entry_id) VALUES($1)", entry); err != nil {
		t.Fatalf("product variant fixture setup failed: %v", err)
	}
	if _, err := f.p.Exec(f.ctx, `INSERT INTO catalog_entry_fields(catalog_entry_id,name,kind,unit,number_value)
 VALUES($1,'volumen en L','number','L',5)`, entry); err != nil {
		t.Fatalf("product field fixture setup failed: %v", err)
	}
	if err := f.p.QueryRow(f.ctx, "SELECT id FROM catalog_variants WHERE catalog_entry_id=$1",
		entry).Scan(&variant); err != nil {
		t.Fatalf("product variant read failed: %v", err)
	}
	f.price(t, entry, minimum, suggested, branch)
	if _, err := f.p.Exec(f.ctx, `UPDATE inventory_balances SET existing=$3,reserved=0
 WHERE location_id=$1 AND variant_id=$2`, int16(branch), int32(variant), stock); err != nil {
		t.Fatalf("product stock fixture failed: %v", err)
	}
	return entry, variant
}

// saleSum adds canonical amounts exactly, so a fixture body always closes against its own
// lines instead of an invented total.
func saleSum(amounts ...string) string {
	var cents int64
	for _, amount := range amounts {
		whole, fraction, _ := strings.Cut(amount, ".")
		units, err := strconv.ParseInt(whole, 10, 64)
		if err != nil {
			panic("fixture amount is not canonical: " + amount)
		}
		decimals, err := strconv.ParseInt(fraction, 10, 64)
		if err != nil {
			panic("fixture amount is not canonical: " + amount)
		}
		cents += units*100 + decimals
	}
	return fmt.Sprintf("%d.%02d", cents/100, cents%100)
}

// saleLineTotal is the exact subtotal of a fixture line.
func saleLineTotal(unit string, quantity int64) string {
	total, err := sales.LineTotal(sales.Money(unit), quantity)
	if err != nil {
		panic("fixture amount is not canonical: " + unit)
	}
	return string(total)
}

// saleProductBody is one admitted product sale body: a cash payment that closes against the
// line and no unit at all, because a product is counted and never serialized.
func saleProductBody(variant, quantity int64, unit string) string {
	return fmt.Sprintf(`{"payments":[{"method":"cash","amount":%q}],`+
		`"customer":{"name":"Cliente Mostrador","phone":"700-00000","document":"V-123","address":"Av. Colón 1234"},`+
		`"lines":[{"variant_id":%d,"quantity":%d,"unit_price":%q,"units":[]}]}`,
		saleLineTotal(unit, quantity), variant, quantity, unit)
}

// saleMixedKindsBody is one sale of a battery and a product: the battery line carries one unit
// per sold piece and the product line carries none.
func saleMixedKindsBody(battery, product, quantity int64, unit, productUnit string) string {
	total := saleSum(saleLineTotal(unit, quantity), saleLineTotal(productUnit, 2))
	return fmt.Sprintf(`{"payments":[{"method":"cash","amount":%q}],`+
		`"customer":{"name":"Cliente Mostrador","phone":"700-00000","document":"V-123","address":"Av. Colón 1234"},`+
		`"lines":[{"variant_id":%d,"quantity":%d,"unit_price":%q,"units":%s},`+
		`{"variant_id":%d,"quantity":2,"unit_price":%q,"units":[]}]}`,
		total, battery, quantity, unit, saleUnitsJSON(quantity, 6), product, productUnit)
}

// saleDetailLines decodes the answered lines of one document read, so a test asserts the wire
// shape of each line by its own keys instead of a Go struct that would hide an extra key.
func saleDetailLines(t *testing.T, w *httptest.ResponseRecorder) []map[string]json.RawMessage {
	t.Helper()
	if w.Code != 200 || w.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("the document must be served: %d %s", w.Code, w.Body.String())
	}
	var document map[string]json.RawMessage
	if json.Unmarshal(w.Body.Bytes(), &document) != nil {
		t.Fatalf("the document is not an object: %s", w.Body.String())
	}
	var lines []map[string]json.RawMessage
	if json.Unmarshal(document["lines"], &lines) != nil || lines == nil {
		t.Fatalf("the document lines are not an array: %s", document["lines"])
	}
	return lines
}

// expectSaleLineRefusal admits only the published refusal of one line: a 400 that names the
// rule and the variant the counter must point at.
func expectSaleLineRefusal(t *testing.T, w *httptest.ResponseRecorder, code string, variant int64) {
	t.Helper()
	var body map[string]json.RawMessage
	if w.Code != 400 || json.Unmarshal(w.Body.Bytes(), &body) != nil || len(body) != 2 ||
		string(body["error"]) != `"`+code+`"` ||
		string(body["variant_id"]) != fmt.Sprintf("%d", variant) {
		t.Fatalf("%s must name variant %d: %d %s", code, variant, w.Code, w.Body.String())
	}
}

// saleCreatedLines admits the created document of a sale whose lines are not all batteries:
// the eleven document keys and the six line keys are the ones the battery wire always had,
// and the units of a line are the ones its own catalogue kind requires, so this reader never
// invents a battery unit for a product.
func saleCreatedLines(t *testing.T, w *httptest.ResponseRecorder) (saleDTO, []map[string]json.RawMessage) {
	t.Helper()
	if w.Code != 201 || w.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("creation response mismatch: status=%d body=%s", w.Code, w.Body.String())
	}
	var top map[string]json.RawMessage
	if json.Unmarshal(w.Body.Bytes(), &top) != nil || len(top) != 1 {
		t.Fatal("creation whitelist changed")
	}
	var document map[string]json.RawMessage
	if json.Unmarshal(top["sale"], &document) != nil || len(document) != 11 {
		t.Fatal("document whitelist changed")
	}
	for _, key := range []string{"id", "branch_location_id", "branch_sequence", "warranty_number",
		"payment_method", "payments", "customer", "total", "created_by_account_id", "created_at", "lines"} {
		if _, ok := document[key]; !ok {
			t.Fatalf("document whitelist incomplete: %s", key)
		}
	}
	var lines []map[string]json.RawMessage
	if json.Unmarshal(document["lines"], &lines) != nil || lines == nil {
		t.Fatal("document lines are not an array")
	}
	for _, line := range lines {
		if len(line) != 6 {
			t.Fatalf("line whitelist changed: %v", line)
		}
		for _, key := range []string{"variant_id", "quantity", "unit_price", "min_price",
			"units", "subtotal"} {
			if _, ok := line[key]; !ok {
				t.Fatalf("line whitelist incomplete: %s", key)
			}
		}
		for _, key := range []string{"unit_price", "min_price", "subtotal"} {
			if !saleMoneyWire.MatchString(string(line[key])) {
				t.Fatalf("%s must be canonical money text", key)
			}
		}
	}
	var record saleDTO
	if json.Unmarshal(top["sale"], &record) != nil || len(record.Lines) != len(lines) {
		t.Fatal("created sale is not decodable")
	}
	return record, lines
}

// TestSaleHTTPProductSaleIsReadable is T2 over the wire: the same request answers 201 and its
// detail, its history row and its printed document, and the product line publishes the shared
// catalogue identity instead of the battery columns it does not have.
func TestSaleHTTPProductSaleIsReadable(t *testing.T) {
	f := saleFixture(t)
	_, variant := saleHTTPProduct(t, f, 2, "1500", "1900", 10, "Agua acidulada")
	created, createdLines := saleCreatedLines(t, f.serve(t, f.request(2, "POST", "/api/sales",
		saleProductBody(variant, 3, "1900.00"))))
	if len(created.Lines) != 1 || created.Lines[0].VariantID != variant ||
		created.Lines[0].Quantity != 3 || len(created.Lines[0].Units) != 0 {
		t.Fatalf("the created product line must carry its quantity and no unit: %+v", created.Lines)
	}
	if string(createdLines[0]["units"]) != "[]" {
		t.Fatalf("the created product line must publish an empty units array: %s", createdLines[0]["units"])
	}
	if created.Total != "5700.00" {
		t.Fatalf("the created product sale must keep its total: %q", created.Total)
	}

	// The detail: the product line carries the shared identity and never a battery column.
	lines := saleDetailLines(t, f.serve(t, f.request(2, "GET", fmt.Sprintf("/api/sales/%d", created.ID), "")))
	if len(lines) != 1 {
		t.Fatalf("the product detail must keep its line: %v", lines)
	}
	line := lines[0]
	for _, absent := range []string{"brand", "model", "capacity_ah", "polarity"} {
		if _, ok := line[absent]; ok {
			t.Fatalf("a product line must not publish the battery column %q: %v", absent, line)
		}
	}
	var identity catalog.Identity
	if json.Unmarshal(line["identity"], &identity) != nil {
		t.Fatalf("the product line must publish the shared identity: %v", line)
	}
	if identity.VariantID != int(variant) || identity.Kind != catalog.OtherKind ||
		identity.Name != "Agua acidulada" || identity.Detail != "volumen en L: 5 L" ||
		identity.Battery != nil {
		t.Fatalf("the product line must carry its own catalogue identity: %+v", identity)
	}
	if string(line["units"]) != "[]" {
		t.Fatalf("a product line carries no unit: %s", line["units"])
	}

	// The history row: a product sale is a legible row with its line and no unit.
	page := salePageWire(t, f.serve(t, f.request(2, "GET", "/api/sales", "")))
	if page.TotalSales != 1 || len(page.Sales) != 1 {
		t.Fatalf("the history must hold the one sale: %+v", page)
	}
	if row := page.Sales[0]; row.ID != created.ID || row.Lines != 1 || row.UnitsTotal != 0 ||
		row.UnitsWithWarranty != 0 || row.Total != "5700.00" {
		t.Fatalf("the history row must describe a product sale: %+v", row)
	}

	// The document: the warranty PDF prints the product identity with an empty term.
	pdf := f.serve(t, f.request(2, "GET", fmt.Sprintf("/api/sales/%d/warranty.pdf", created.ID), ""))
	if pdf.Code != 200 || pdf.Header().Get("Content-Type") != "application/pdf" {
		t.Fatalf("the product warranty must download: %d %s", pdf.Code, pdf.Body.String())
	}
	body := pdf.Body.Bytes()
	if !bytes.HasPrefix(body, []byte("%PDF-")) {
		t.Fatalf("the product warranty must be a PDF: %q", body[:min(len(body), 16)])
	}
	for _, want := range []string{"Agua acidulada", "volumen en L: 5 L", "Bs 5.700,00",
		"Total: Bs 5.700,00"} {
		if !bytes.Contains(body, []byte(want)) {
			t.Fatalf("the product warranty must print %q", want)
		}
	}
	if got := bytes.Count(body, []byte("meses")); got != 0 {
		t.Fatalf("a product line must print no term, got %d", got)
	}
	if got := bytes.Count(body, []byte("Sin garant\xeda")); got != 0 {
		t.Fatalf("a product line must print no absence of warranty, got %d", got)
	}
}

// TestSaleHTTPMixedSaleIsReadable pins S3 over the wire: one sale carries a battery and a
// product, answers 201, and is read back line by line with its own identity.
func TestSaleHTTPMixedSaleIsReadable(t *testing.T) {
	f := saleFixture(t)
	f.price(t, f.entryOf(t, 1), "85000", "96000", 2)
	_, product := saleHTTPProduct(t, f, 2, "1500", "1900", 10, "Agua acidulada")
	if existing, _ := f.stock(t, 2, 1); existing < 1 {
		t.Fatalf("the fixture expects battery stock to sell, got %d", existing)
	}
	created, createdLines := saleCreatedLines(t, f.serve(t, f.request(2, "POST", "/api/sales",
		saleMixedKindsBody(1, product, 1, "96000.00", "1900.00"))))
	if len(created.Lines) != 2 || len(createdLines) != 2 {
		t.Fatalf("the mixed sale must keep both lines: %+v", created.Lines)
	}
	// The battery line keeps one unit per sold piece and the product line keeps none.
	saleUnitsWire(t, createdLines[0]["units"], 1)
	if string(createdLines[1]["units"]) != "[]" {
		t.Fatalf("the product line must publish an empty units array: %s", createdLines[1]["units"])
	}
	if created.Total != "99800.00" {
		t.Fatalf("the mixed sale must keep the exact total: %q", created.Total)
	}
	lines := saleDetailLines(t, f.serve(t, f.request(2, "GET", fmt.Sprintf("/api/sales/%d", created.ID), "")))
	if len(lines) != 2 {
		t.Fatalf("the mixed detail must keep both lines: %v", lines)
	}
	// The battery line keeps its battery columns and its unit; the product line carries its
	// own identity and no unit.
	var brand string
	if json.Unmarshal(lines[0]["brand"], &brand) != nil || brand != "CAR" {
		t.Fatalf("the battery line must keep its battery columns: %v", lines[0])
	}
	if _, ok := lines[0]["identity"]; ok {
		t.Fatalf("the battery line must keep its own wire: %v", lines[0])
	}
	var identity catalog.Identity
	if json.Unmarshal(lines[1]["identity"], &identity) != nil ||
		identity.Kind != catalog.OtherKind || identity.Name != "Agua acidulada" {
		t.Fatalf("the product line must carry its own identity: %v", lines[1])
	}
	// Both lines moved the stock of the branch.
	if existing, _ := f.stock(t, 2, product); existing != 8 {
		t.Fatalf("the product stock must fall by two: %d", existing)
	}
	// The history row is legible with one unit for two lines.
	page := salePageWire(t, f.serve(t, f.request(2, "GET", "/api/sales", "")))
	if row := page.Sales[0]; row.Lines != 2 || row.UnitsTotal != 1 || row.UnitsWithWarranty != 1 {
		t.Fatalf("the mixed history row must describe both kinds: %+v", row)
	}
}

// TestSaleHTTPLineUnitRefusals pins S1 over the wire: a product line that carries a unit and a
// battery line that carries none are two distinct 400 refusals, they name their variant, and
// neither writes anything.
func TestSaleHTTPLineUnitRefusals(t *testing.T) {
	f := saleFixture(t)
	f.price(t, f.entryOf(t, 1), "85000", "96000", 2)
	_, product := saleHTTPProduct(t, f, 2, "1500", "1900", 10, "Agua acidulada")

	// A product line with a unit: the unit the seller would have typed for a battery.
	withUnit := fmt.Sprintf(`{"payments":[{"method":"cash","amount":"1900.00"}],`+
		`"customer":{"name":"Cliente Mostrador","phone":"700-00000","document":"V-123","address":"Av. Colón 1234"},`+
		`"lines":[{"variant_id":%d,"quantity":1,"unit_price":"1900.00","units":%s}]}`,
		product, saleUnitsJSON(1, 6))
	before := f.snapshot(t)
	expectSaleLineRefusal(t, f.serve(t, f.request(2, "POST", "/api/sales", withUnit)),
		"product_line_carries_no_units", product)
	if f.snapshot(t) != before {
		t.Fatal("a refused product line changed stored state")
	}

	// A battery line without any unit: a product is counted, a battery is serialized.
	withoutUnits := fmt.Sprintf(`{"payments":[{"method":"cash","amount":"96000.00"}],` +
		`"customer":{"name":"Cliente Mostrador","phone":"700-00000","document":"V-123","address":"Av. Colón 1234"},` +
		`"lines":[{"variant_id":1,"quantity":1,"unit_price":"96000.00","units":[]}]}`)
	before = f.snapshot(t)
	expectSaleLineRefusal(t, f.serve(t, f.request(2, "POST", "/api/sales", withoutUnits)),
		"battery_line_requires_units", 1)
	if f.snapshot(t) != before {
		t.Fatal("a refused battery line changed stored state")
	}
}

// TestSaleHTTPBatteryWireIsUnchanged pins S8 over the wire: a battery sale keeps every field
// it always had, in its created document, in its detail and in the counter catalogue, and no
// field was renamed, dropped or added.
func TestSaleHTTPBatteryWireIsUnchanged(t *testing.T) {
	f := saleFixture(t)
	f.price(t, f.entryOf(t, 1), "85000", "96000", 2)
	created := saleCreatedWire(t, f.serve(t, f.request(2, "POST", "/api/sales",
		saleBody(1, 2, "96000.00", 6))))
	// The created line: variant, quantity, the charged price, the frozen minimum, one unit per
	// sold piece and the subtotal, exactly those six keys.
	if len(created.Lines) != 1 || created.Lines[0].VariantID != 1 || created.Lines[0].Quantity != 2 ||
		created.Lines[0].UnitPrice != "96000.00" || created.Lines[0].MinPrice != "85000.00" ||
		created.Lines[0].Subtotal != "192000.00" || len(created.Lines[0].Units) != 2 {
		t.Fatalf("the battery document changed: %+v", created.Lines)
	}
	for i, unit := range created.Lines[0].Units {
		if unit.SerialNumber == "" || unit.WarrantyMonths == nil || *unit.WarrantyMonths != 6 {
			t.Fatalf("unit %d changed: %+v", i, unit)
		}
	}
	// The detail line: the battery columns, the price pair, the units and the subtotal.
	detail := saleDetailWire(t, f.serve(t, f.request(2, "GET", fmt.Sprintf("/api/sales/%d", created.ID), "")))
	if len(detail.Lines) != 1 {
		t.Fatalf("the battery detail changed: %+v", detail.Lines)
	}
	line := detail.Lines[0]
	if line.VariantID != 1 || line.CatalogEntryID != f.entryOf(t, 1) || line.Brand != "CAR" ||
		line.Model != "NS40ZL" || line.Capacity != "35" || line.Polarity != "L" ||
		line.Quantity != 2 || line.UnitPrice != "96000.00" || line.MinPrice != "85000.00" ||
		line.Subtotal != "192000.00" || len(line.Units) != 2 {
		t.Fatalf("the battery detail line changed: %+v", line)
	}
	// The counter catalogue keeps its twelve battery keys.
	page := saleSellableWire(t, f.serve(t, f.request(2, "GET", "/api/sales/sellable", "")))
	if len(page.Items) == 0 || page.Items[0].Brand != "CAR" || page.Items[0].Model != "NS40ZL" ||
		page.Items[0].Capacity != "35" || page.Items[0].Polarity != "L" {
		t.Fatalf("the battery catalogue item changed: %+v", page.Items)
	}
}

// TestSaleHTTPSellableKind pins S5 over the wire: the counter reads batteries by default, and
// one product kind answers the product card with its name, its detail and its price, never
// with a battery column it does not have.
func TestSaleHTTPSellableKind(t *testing.T) {
	f := saleFixture(t)
	entry, variant := saleHTTPProduct(t, f, 2, "1500", "1900", 6, "Agua acidulada")
	batteries := saleSellableWire(t, f.serve(t, f.request(2, "GET", "/api/sales/sellable", "")))
	for _, item := range batteries.Items {
		if item.CatalogEntryID == entry {
			t.Fatalf("the default catalogue must list batteries only: %+v", item)
		}
	}
	// The product kind, read through the wire of its own card.
	raw := f.serve(t, f.request(2, "GET", "/api/sales/sellable?kind=other", ""))
	if raw.Code != 200 || raw.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("the product catalogue must be served: %d %s", raw.Code, raw.Body.String())
	}
	var page map[string]json.RawMessage
	var items []map[string]json.RawMessage
	if json.Unmarshal(raw.Body.Bytes(), &page) != nil ||
		json.Unmarshal(page["items"], &items) != nil || len(items) != 1 {
		t.Fatalf("the product catalogue must list the one product: %s", raw.Body.String())
	}
	item := items[0]
	for _, absent := range []string{"brand", "model", "capacity_ah", "polarity"} {
		if _, ok := item[absent]; ok {
			t.Fatalf("a product card must not publish the battery column %q: %v", absent, item)
		}
	}
	var identity catalog.Identity
	if json.Unmarshal(item["identity"], &identity) != nil ||
		identity.Kind != catalog.OtherKind || identity.VariantID != int(variant) ||
		identity.Name != "Agua acidulada" || identity.Detail != "volumen en L: 5 L" {
		t.Fatalf("the product card must publish its identity: %v", item)
	}
	for key, want := range map[string]string{
		"catalog_entry_id": fmt.Sprintf("%d", entry),
		"sellable":         "true",
		"suggested_price":  `"1900.00"`,
		"min_price":        `"1500.00"`,
		"existing":         "6",
		"reserved":         "0",
		"available":        "6",
	} {
		if string(item[key]) != want {
			t.Fatalf("the product card must publish %s=%s: %v", key, want, item)
		}
	}
	// Both kinds in one page: every row is still its own identity.
	var all map[string]json.RawMessage
	var rows []map[string]json.RawMessage
	both := f.serve(t, f.request(2, "GET", "/api/sales/sellable?kind=all", ""))
	if both.Code != 200 || json.Unmarshal(both.Body.Bytes(), &all) != nil ||
		json.Unmarshal(all["items"], &rows) != nil || len(rows) == 0 {
		t.Fatalf("the whole catalogue must be served: %d %s", both.Code, both.Body.String())
	}
	// An unknown kind is a framing error, never a silent default.
	f.rejected(t, f.request(2, "GET", "/api/sales/sellable?kind=gift", ""), 400, "invalid_request")
}
