package warranty_test

import (
	"bytes"
	"errors"
	"testing"

	"luson/api/internal/warranty"
)

// productDocument is one sale that carries a battery and one other product: the battery is
// the row this document always printed, and the product is the row it must print now.
func productDocument() warranty.Document {
	doc := smallDocument()
	doc.Lines = append(doc.Lines, warranty.Line{
		Kind:     warranty.ProductLine,
		Name:     "Agua acidulada",
		Detail:   "volumen en L: 5 L",
		Subtotal: "5700.00",
	})
	doc.Total = "80700.00"
	doc.Payments = []warranty.Payment{{Method: "cash", Amount: "80700.00"}}
	return doc
}

// TestRenderPrintsProductLineWithoutTerm pins S2: the printed document of a product sale is
// the warranty of today, not a new one. The product row prints its own identity, the name and
// the detail, with the term empty, and the battery row of the same document keeps printing
// what it printed word for word.
func TestRenderPrintsProductLineWithoutTerm(t *testing.T) {
	data := renderOK(t, productDocument())

	// The battery row keeps its own columns, word for word.
	for _, want := range []string{
		"YUASA", "YTX7A-BS", "12.0", "YTX-0001", "12 meses", "Bs 75.000,00",
	} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("the battery row lost %q", want)
		}
	}
	// The product row prints its identity and its amount, and nothing of the battery.
	for _, want := range []string{"Agua acidulada", "volumen en L: 5 L", "Bs 5.700,00"} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("the product row does not print %q", want)
		}
	}
	// The term of a product is empty: the only term of the document is the battery's, and no
	// product is ever named as sold without warranty, because a product never promises one.
	if got := bytes.Count(data, []byte("meses")); got != 1 {
		t.Fatalf("the only printed term must be the battery's, got %d", got)
	}
	if got := bytes.Count(data, []byte("Sin garant\xeda")); got != 0 {
		t.Fatalf("a product row must not print an absence of warranty, got %d", got)
	}
	if !bytes.Contains(data, []byte("Total: Bs 80.700,00")) {
		t.Fatal("the document lost the stored total")
	}
}

// TestRenderRefusesInventedProductRow pins the other side of S2: a product row states its own
// identity and nothing of the battery, so a row that invents a serial or a term, a row without
// a name, or a row of a kind this document does not have is refused instead of printed.
func TestRenderRefusesInventedProductRow(t *testing.T) {
	for name, mutate := range map[string]func(*warranty.Line){
		"serial": func(line *warranty.Line) { line.SerialNumber = "SERIE-1" },
		"term":   func(line *warranty.Line) { line.WarrantyMonths = months(6) },
		"name":   func(line *warranty.Line) { line.Name = "  " },
		"detail": func(line *warranty.Line) { line.Detail = "" },
		"kind":   func(line *warranty.Line) { line.Kind = "gift" },
	} {
		doc := productDocument()
		mutate(&doc.Lines[1])
		data, err := warranty.Render(doc)
		if err == nil {
			t.Fatalf("%s: a product row outside its rule must be refused, rendered %d bytes", name, len(data))
		}
		if !errors.Is(err, warranty.ErrInvalidDocument) {
			t.Fatalf("%s: the refusal must be the document's own: %v", name, err)
		}
		if len(data) != 0 {
			t.Fatalf("%s: a refused document must render no bytes", name)
		}
	}
}
