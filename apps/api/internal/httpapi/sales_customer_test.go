package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"testing"

	"luson/api/internal/sales"
)

// saleCount reads how many documents the branch holds, so a refused sale is proven to have
// written no header at all beside the snapshot of every table it would have touched.
func saleCount(t *testing.T, f *saleHTTPFixture) int64 {
	t.Helper()
	var n int64
	if f.p.QueryRow(f.ctx, "SELECT count(*) FROM sales").Scan(&n) != nil {
		t.Fatal("sale count read failed")
	}
	return n
}

// saleCustomerFields renders the client of a fixture body exactly as the caller states it, so
// a test pins the four frozen keys without inventing a value it did not set.
func saleCustomerFields(name, phone, document, address string) string {
	return fmt.Sprintf(`{"name":%q,"phone":%q,"document":%q,"address":%q}`,
		name, phone, document, address)
}

// anonymousCustomer is the client of a sale that names nobody: the four keys are still present
// in the wire, and every one of them is empty.
func anonymousCustomer() string { return saleCustomerFields("", "", "", "") }

// saleBatteryCustomerBody is one battery sale body carrying the stated client: a cash payment
// that closes against the line and one unit per sold piece.
func saleBatteryCustomerBody(variant, quantity int64, unit, customer string) string {
	return fmt.Sprintf(`{"payments":[{"method":"cash","amount":%q}],"customer":%s,`+
		`"lines":[{"variant_id":%d,"quantity":%d,"unit_price":%q,"units":%s}]}`,
		saleLineTotal(unit, quantity), customer, variant, quantity, unit,
		saleUnitsJSON(quantity, 6))
}

// saleProductCustomerBody is one product sale body carrying the stated client: a product is
// counted, so its line carries no unit at all.
func saleProductCustomerBody(variant, quantity int64, unit, customer string) string {
	return fmt.Sprintf(`{"payments":[{"method":"cash","amount":%q}],"customer":%s,`+
		`"lines":[{"variant_id":%d,"quantity":%d,"unit_price":%q,"units":[]}]}`,
		saleLineTotal(unit, quantity), customer, variant, quantity, unit)
}

// saleMixedCustomerBody is one sale of a battery and a product carrying the stated client: the
// battery line carries one unit per sold piece and the product line carries none.
func saleMixedCustomerBody(battery, product int64, unit, productUnit, customer string) string {
	total := saleSum(saleLineTotal(unit, 1), saleLineTotal(productUnit, 2))
	return fmt.Sprintf(`{"payments":[{"method":"cash","amount":%q}],"customer":%s,`+
		`"lines":[{"variant_id":%d,"quantity":1,"unit_price":%q,"units":%s},`+
		`{"variant_id":%d,"quantity":2,"unit_price":%q,"units":[]}]}`,
		total, customer, battery, unit, saleUnitsJSON(1, 6), product, productUnit)
}

// expectSaleCustomerRefusal admits only the published refusal of a warranty sale without its
// complete client: a 400 that names the rule and, in the paper's own order, every field the
// document does not have.
func expectSaleCustomerRefusal(t *testing.T, w *httptest.ResponseRecorder, missing ...string) {
	t.Helper()
	want, err := json.Marshal(map[string]any{"error": "warranty_customer_incomplete",
		"missing": missing})
	if err != nil {
		t.Fatal("the expected refusal is not encodable")
	}
	if w.Code != 400 || w.Body.String() != string(want)+"\n" ||
		w.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("the incomplete-warranty-client refusal mismatch: %d %s", w.Code, w.Body.String())
	}
}

// TestSaleHTTPProductSaleNamesNoCustomer pins S9 over the wire for a sale that issues no
// warranty: the same request that names nobody answers 201, its detail and its history row are
// legible with an empty client, and the printed document says "Consumidor final" where the name
// would go without inventing a phone or a document.
func TestSaleHTTPProductSaleNamesNoCustomer(t *testing.T) {
	f := saleFixture(t)
	_, variant := saleHTTPProduct(t, f, 2, "1500", "1900", 10, "Agua acidulada")
	created := saleCreatedWire(t, f.serve(t, f.request(2, "POST", "/api/sales",
		saleProductCustomerBody(variant, 3, "1900.00", anonymousCustomer()))))
	if created.Customer != (saleCustomerDTO{}) {
		t.Fatalf("a product-only sale must answer no client: %+v", created.Customer)
	}

	// The detail read and the history row keep naming nobody instead of failing closed.
	detail := saleDetailWire(t, f.serve(t, f.request(2, "GET",
		fmt.Sprintf("/api/sales/%d", created.ID), "")))
	if detail.Customer != (saleCustomerDTO{}) || detail.CustomerName != "" {
		t.Fatalf("the product detail must keep the absence of a client: %+v", detail)
	}
	page := salePageWire(t, f.serve(t, f.request(2, "GET", "/api/sales", "")))
	if page.TotalSales != 1 || len(page.Sales) != 1 || page.Sales[0].CustomerName != "" {
		t.Fatalf("the history row must name nobody: %+v", page.Sales)
	}

	// The printed document names the absence: "Consumidor final" where the name would go, and
	// nothing at all for the phone and the document.
	pdf := f.serve(t, f.request(2, "GET", fmt.Sprintf("/api/sales/%d/warranty.pdf", created.ID), ""))
	if pdf.Code != 200 || pdf.Header().Get("Content-Type") != "application/pdf" {
		t.Fatalf("the anonymous warranty must download: %d %s", pdf.Code, pdf.Body.String())
	}
	body := pdf.Body.Bytes()
	if !bytes.HasPrefix(body, []byte("%PDF-")) {
		t.Fatalf("the anonymous warranty must be a PDF: %q", body[:min(len(body), 16)])
	}
	if !bytes.Contains(body, []byte("Cliente: Consumidor final")) {
		t.Fatal("an anonymous sale must print Consumidor final where the name would go")
	}
	for _, label := range [][]byte{[]byte("Tel\xe9fono:"), []byte("Documento:")} {
		if !bytes.Contains(body, label) {
			t.Fatalf("the document lost the label %q", label)
		}
	}
	for _, want := range []string{"Agua acidulada", "Bs 5.700,00", "Total: Bs 5.700,00"} {
		if !bytes.Contains(body, []byte(want)) {
			t.Fatalf("the anonymous warranty lost %q", want)
		}
	}
}

// TestSaleHTTPWarrantySaleRequiresTheCompleteCustomer pins S9 over the wire: a sale that issues
// a warranty demands the three data the paper carries, its own 400 names every missing field,
// and the refusal is atomic -- no header, no line, no unit and not one balance moves.
func TestSaleHTTPWarrantySaleRequiresTheCompleteCustomer(t *testing.T) {
	f := saleFixture(t)
	f.price(t, f.entryOf(t, 1), "85000", "96000", 2)
	before := f.snapshot(t)
	for _, tc := range []struct {
		name     string
		customer string
		missing  []string
	}{
		{"nobody", anonymousCustomer(),
			[]string{"customer_name", "customer_phone", "customer_document"}},
		{"no_phone", saleCustomerFields("Cliente Mostrador", "", "V-123", ""),
			[]string{"customer_phone"}},
		{"no_document", saleCustomerFields("Cliente Mostrador", "700-00000", "", ""),
			[]string{"customer_document"}},
		{"no_name", saleCustomerFields("", "700-00000", "V-123", ""),
			[]string{"customer_name"}},
	} {
		w := f.serve(t, f.request(2, "POST", "/api/sales",
			saleBatteryCustomerBody(1, 1, "96000.00", tc.customer)))
		expectSaleCustomerRefusal(t, w, tc.missing...)
		if n := saleCount(t, f); n != 0 {
			t.Fatalf("%s: a refused warranty sale wrote a header, got %d", tc.name, n)
		}
		if f.snapshot(t) != before {
			t.Fatalf("%s: a refused warranty sale must not write a line, a unit or move a balance",
				tc.name)
		}
	}

	// The admitted side: the same sale with the complete client answers 201, is read back with
	// its client whole and prints the three data the warranty names.
	complete := saleCustomerFields("Cliente Mostrador", "700-00000", "V-123", "")
	created := saleCreatedWire(t, f.serve(t, f.request(2, "POST", "/api/sales",
		saleBatteryCustomerBody(1, 1, "96000.00", complete))))
	if created.Customer.Name != "Cliente Mostrador" || created.Customer.Phone != "700-00000" ||
		created.Customer.Document != "V-123" || created.Customer.Address != "" {
		t.Fatalf("the created sale must keep the client it named: %+v", created.Customer)
	}
	detail := saleDetailWire(t, f.serve(t, f.request(2, "GET",
		fmt.Sprintf("/api/sales/%d", created.ID), "")))
	if detail.Customer != created.Customer || detail.CustomerName != "Cliente Mostrador" {
		t.Fatalf("the detail must keep the client of the warranty: %+v", detail.Customer)
	}
	pdf := f.serve(t, f.request(2, "GET", fmt.Sprintf("/api/sales/%d/warranty.pdf", created.ID), ""))
	if pdf.Code != 200 {
		t.Fatalf("the warranty of a complete sale must download: %d %s", pdf.Code, pdf.Body.String())
	}
	for _, want := range []string{"Cliente: Cliente Mostrador", "700-00000", "V-123"} {
		if !bytes.Contains(pdf.Body.Bytes(), []byte(want)) {
			t.Fatalf("the warranty lost %q", want)
		}
	}
	if bytes.Contains(pdf.Body.Bytes(), []byte("Consumidor final")) {
		t.Fatal("a named warranty sale must not be printed as anonymous")
	}
}

// TestSaleHTTPMixedSaleFollowsTheBatteryRule pins S3 beside S9 over the wire: a mixed sale is a
// warranty because one of its lines is a battery, so it names its client in full even though
// the other line is a product that needs nobody; the battery line decides for the document.
func TestSaleHTTPMixedSaleFollowsTheBatteryRule(t *testing.T) {
	f := saleFixture(t)
	f.price(t, f.entryOf(t, 1), "85000", "96000", 2)
	_, product := saleHTTPProduct(t, f, 2, "1500", "1900", 10, "Agua acidulada")
	before := f.snapshot(t)
	expectSaleCustomerRefusal(t, f.serve(t, f.request(2, "POST", "/api/sales",
		saleMixedCustomerBody(1, product, "96000.00", "1900.00", anonymousCustomer()))),
		"customer_name", "customer_phone", "customer_document")
	if f.snapshot(t) != before {
		t.Fatal("a refused mixed sale must not write anything")
	}

	complete := saleCustomerFields("Cliente Mostrador", "700-00000", "V-123", "")
	created := saleCreatedWire(t, f.serve(t, f.request(2, "POST", "/api/sales",
		saleMixedCustomerBody(1, product, "96000.00", "1900.00", complete))))
	if len(created.Lines) != 2 || created.Customer.Name != "Cliente Mostrador" {
		t.Fatalf("the admitted mixed sale must keep both lines and its client: %+v", created)
	}
	pdf := f.serve(t, f.request(2, "GET", fmt.Sprintf("/api/sales/%d/warranty.pdf", created.ID), ""))
	if pdf.Code != 200 {
		t.Fatalf("the mixed warranty must download: %d %s", pdf.Code, pdf.Body.String())
	}
	for _, want := range []string{"Cliente: Cliente Mostrador", "Agua acidulada"} {
		if !bytes.Contains(pdf.Body.Bytes(), []byte(want)) {
			t.Fatalf("the mixed warranty lost %q", want)
		}
	}
}

// TestSaleHTTPWarrantyAddressIsNeverRequired pins the boundary of S9 over the wire: the address
// is stored and never printed, so it is not one of the three data a warranty demands.
func TestSaleHTTPWarrantyAddressIsNeverRequired(t *testing.T) {
	f := saleFixture(t)
	f.price(t, f.entryOf(t, 1), "85000", "96000", 2)
	created := saleCreatedWire(t, f.serve(t, f.request(2, "POST", "/api/sales",
		saleBatteryCustomerBody(1, 1, "96000.00",
			saleCustomerFields("Cliente Mostrador", "700-00000", "V-123", "")))))
	if created.Customer.Address != "" {
		t.Fatalf("the sale must not invent an address: %q", created.Customer.Address)
	}
}

// TestSaleHTTPWarrantyCustomerRefusalMapping pins the published shape of the incomplete-client
// refusal: the same 400 and the same body whatever named the missing fields, the house envelope
// alone when nothing named them, and a fail-closed answer for evidence this contract cannot
// publish. It is the refusal the store derives and the one the database's own LV015 raises.
func TestSaleHTTPWarrantyCustomerRefusalMapping(t *testing.T) {
	refusal := &sales.WarrantyCustomerIncomplete{Missing: []string{"customer_phone"}}
	for _, wrapped := range []error{refusal, fmt.Errorf("wrapped: %w", refusal)} {
		w := httptest.NewRecorder()
		saleFailure(w, wrapped)
		expectSaleCustomerRefusal(t, w, "customer_phone")
	}
	if !errors.Is(refusal, sales.ErrInvalid) {
		t.Fatal("the incomplete-client refusal must stay the invalid-document class")
	}

	// A refusal that named no field is still the same refusal, answered with the house
	// envelope instead of an invented list.
	w := httptest.NewRecorder()
	saleFailure(w, &sales.WarrantyCustomerIncomplete{})
	expectTransferError(t, w, 400, "warranty_customer_incomplete")

	// A field the paper does not carry is not evidence of anything, so it fails closed.
	w = httptest.NewRecorder()
	saleFailure(w, &sales.WarrantyCustomerIncomplete{Missing: []string{"credit_limit"}})
	expectTransferError(t, w, 503, "service_unavailable")
}
