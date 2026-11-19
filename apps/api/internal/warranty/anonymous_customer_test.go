package warranty_test

import (
	"bytes"
	"testing"

	"luson/api/internal/warranty"
)

// TestRenderNamesAnAnonymousSale pins S9 on the printed side: a sale that issues no warranty
// names nobody, so the document says "Consumidor final" where the name would go instead of
// refusing the document or leaving the line dangling. The phone and the document stay empty:
// the renderer never invents a value the sale does not have.
func TestRenderNamesAnAnonymousSale(t *testing.T) {
	doc := smallDocument()
	doc.Customer = warranty.Customer{}

	data := renderOK(t, doc)
	if !bytes.Contains(data, []byte("Cliente: Consumidor final")) {
		t.Fatal("an anonymous sale must print Consumidor final where the name would go")
	}
	// The two data the sale does not have are printed as nothing at all, exactly as they were
	// before: the label stays and no value follows it.
	for _, want := range [][]byte{
		[]byte("Tel\xe9fono:"),
		[]byte("Documento:"),
	} {
		if !bytes.Contains(data, want) {
			t.Fatalf("the document lost the label %q", want)
		}
	}
	for _, leaked := range []string{"77412345", "V-12345678", "Consumidor final 7"} {
		if bytes.Contains(data, []byte(leaked)) {
			t.Fatalf("an anonymous sale must not print an invented customer value: %q", leaked)
		}
	}
	// The rest of the document is untouched: the battery row and the total still print.
	for _, want := range []string{"YUASA", "YTX-0001", "Total: Bs 85.000,00"} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("an anonymous sale lost %q", want)
		}
	}
}

// TestRenderKeepsTheCompleteCustomer pins the other side of S9: a sale that names its client
// keeps printing that name, word for word, and never the anonymous placeholder.
func TestRenderKeepsTheCompleteCustomer(t *testing.T) {
	data := renderOK(t, smallDocument())
	if !bytes.Contains(data, []byte("Cliente: Maria Nandu")) {
		t.Fatal("a named sale must print its client")
	}
	if bytes.Contains(data, []byte("Consumidor final")) {
		t.Fatal("a named sale must not be printed as anonymous")
	}
}
