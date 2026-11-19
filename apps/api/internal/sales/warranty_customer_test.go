package sales_test

import (
	"testing"

	"luson/api/internal/catalog"
	"luson/api/internal/sales"
)

// completeCustomer is the client a sale that issues a warranty names: exactly the three data
// the printed paper carries. The address is deliberately absent, because the paper never
// prints it and a rule nobody can satisfy from the paper is not a rule.
func completeCustomer() sales.Customer {
	return sales.Customer{Name: "Cliente Mostrador", Phone: "700-00000", Document: "V-123"}
}

// batterySale is one admitted battery sale carrying the customer the caller states, so a test
// pins the customer rule without restating the line, the settlement or the price.
func batterySale(variant int64, customer sales.Customer) sales.CreateInput {
	return sales.CreateInput{
		Payments: cashPayment("85000.00"),
		Customer: customer,
		Lines:    onePiece(variant, "85000.00", months(6)),
	}
}

// persistedInput rebuilds the canonical input of one persisted sale, so a test can judge the
// stored form with the reader's own contract.
func persistedInput(sale sales.Sale) sales.CreateInput {
	input := sales.CreateInput{Payments: sale.Payments, Customer: sale.Customer}
	for _, line := range sale.Lines {
		input.Lines = append(input.Lines, sales.LineInput{VariantID: line.VariantID,
			Quantity: line.Quantity, UnitPrice: line.UnitPrice, Units: line.Units})
	}
	return input
}

// saleKinds reads the catalogue kind of every line of one persisted sale, which is what the
// reader judges the document by.
func saleKinds(t *testing.T, sale sales.Sale) map[int64]catalog.Kind {
	t.Helper()
	kinds := make(map[int64]catalog.Kind, len(sale.Lines))
	for _, line := range sale.Lines {
		kinds[line.VariantID] = line.Kind
	}
	return kinds
}

// TestProductSaleNeedsNoCustomer pins S9 on the write and read sides of a sale that issues no
// warranty: products alone name nobody, so all three customer data may be empty, the document
// is written, and every read returns it with an empty client. The stored form agrees with the
// created one, because a product-only document is not a warranty.
func TestProductSaleNeedsNoCustomer(t *testing.T) {
	e := fixture(t)
	_, variant := pricedProduct(t, e, 2, "1500", "1900", 10)
	in := productSale(variant, 3, "1900.00")
	in.Customer = sales.Customer{}

	created, err := e.store.Create(e.ctx, clerk(2), in)
	if err != nil {
		t.Fatalf("a sale of products alone must not require a customer: %v", err)
	}
	if created.Customer != (sales.Customer{}) {
		t.Fatalf("a product-only sale must be stored with no client: %+v", created.Customer)
	}
	if _, err := sales.ValidateByKind(persistedInput(created), saleKinds(t, created)); err != nil {
		t.Fatalf("the created product-only document must pass the write contract: %v", err)
	}
	if _, err := sales.ValidatePersistedByKind(persistedInput(created), saleKinds(t, created)); err != nil {
		t.Fatalf("the stored product-only document must pass the read contract: %v", err)
	}

	detail, err := e.store.Read(e.ctx, clerk(2), created.ID)
	if err != nil {
		t.Fatalf("a product-only sale must be readable: %v", err)
	}
	if detail.Customer != (sales.Customer{}) {
		t.Fatalf("the detail must keep the absence of a client: %+v", detail.Customer)
	}
	page, err := e.store.List(e.ctx, clerk(2), sales.ListQuery{Page: 1, PageSize: 25})
	if err != nil {
		t.Fatalf("a product-only sale must be a legible history row: %v", err)
	}
	if len(page.Sales) != 1 || page.Sales[0].CustomerName != "" {
		t.Fatalf("the history row must name nobody: %+v", page.Sales)
	}
}

// TestWarrantySaleWithCompleteCustomerIsReadable pins the admitted side of S9: a battery sale
// with the three data the paper carries is written, read back with its client whole and judged
// by the reader's own contract. The battery line is what makes it a warranty.
func TestWarrantySaleWithCompleteCustomerIsReadable(t *testing.T) {
	e := fixture(t)
	const variant = int64(3)
	e.price(t, e.entryOf(t, variant), "85000", "96000", 2)
	customer := completeCustomer()
	created, err := e.store.Create(e.ctx, clerk(2), batterySale(variant, customer))
	if err != nil {
		t.Fatalf("a battery sale with its complete client must be admitted: %v", err)
	}
	if created.Customer != customer {
		t.Fatalf("the sale must keep the client it was written with: %+v", created.Customer)
	}
	detail, err := e.store.Read(e.ctx, clerk(2), created.ID)
	if err != nil {
		t.Fatalf("a battery sale must be readable: %v", err)
	}
	if detail.Customer != customer || len(detail.Lines) != 1 || len(detail.Lines[0].Units) != 1 {
		t.Fatalf("the detail must keep the client and the battery it sold: %+v", detail)
	}
	if _, err := sales.ValidatePersistedByKind(persistedInput(created), saleKinds(t, created)); err != nil {
		t.Fatalf("a stored warranty sale must pass the read contract: %v", err)
	}
}

// TestWarrantyAddressIsNeverRequired pins the boundary of S9: the address is stored and never
// printed, so it is not one of the three data a warranty demands. A complete client without an
// address is admitted and read back with an empty address.
func TestWarrantyAddressIsNeverRequired(t *testing.T) {
	e := fixture(t)
	const variant = int64(3)
	e.price(t, e.entryOf(t, variant), "85000", "96000", 2)
	customer := completeCustomer()
	if customer.Address != "" {
		t.Fatalf("the fixture must state a client without an address: %+v", customer)
	}
	created, err := e.store.Create(e.ctx, clerk(2), batterySale(variant, customer))
	if err != nil {
		t.Fatalf("the address must never be required by a warranty: %v", err)
	}
	if created.Customer.Address != "" {
		t.Fatalf("the sale must not invent an address: %q", created.Customer.Address)
	}
	detail, err := e.store.Read(e.ctx, clerk(2), created.ID)
	if err != nil || detail.Customer.Address != "" {
		t.Fatalf("the detail must keep the empty address: %+v %v", detail.Customer, err)
	}
}

// A sale written before the client rule existed is still a document. The rule governs what
// this application writes; the sale tables are immutable, so refusing to read history would
// not protect the ledger, it would hide a sale that really happened. What is written now is
// still held to the rule, and that is the difference this test pins.
func TestPersistedSaleKeepsItsHistoricalCustomer(t *testing.T) {
	historical := batterySale(1, sales.Customer{Name: "Cliente Viejo"})
	kinds := map[int64]catalog.Kind{1: catalog.BatteryKind}
	if _, err := sales.ValidatePersistedByKind(historical, kinds); err != nil {
		t.Fatalf("a sale written before the client rule must still be readable: %v", err)
	}
	if _, err := sales.ValidateByKind(historical, kinds); err == nil {
		t.Fatal("a warranty sale written now must still require the complete customer")
	}
}
