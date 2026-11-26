package httpapi

import (
	"bytes"
	"fmt"
	"regexp"
	"strings"
	"testing"
)

// receiptTextOp captures the literal strings of the text-showing operators of a rendered
// page: the words the paper actually draws.
var receiptTextOp = regexp.MustCompile(`\(([^()]*)\)\s*Tj`)

// TestWarrantyReceiptFilename pins the stable download name of the paper: the case number
// the database wrote, ASCII only, so a client saves the document it is looking at and two
// cases never share a file name.
func TestWarrantyReceiptFilename(t *testing.T) {
	for _, test := range []struct {
		number string
		want   string
	}{
		{"C-2-000001", "comprobante-C-2-000001.pdf"},
		{"C-10-000123", "comprobante-C-10-000123.pdf"},
	} {
		name, ok := warrantyReceiptFilename(test.number)
		if !ok || name != test.want {
			t.Fatalf("%q must name the file %q, got %q %v", test.number, test.want, name, ok)
		}
	}
	// A number that is not the frozen format cannot name a file: the letter form of the
	// mockup, a path, an empty value and an oversized value all fail closed.
	for _, number := range []string{"", " ", "C-A-00043", "C-2-000001/../x", "../C-2-000001",
		"C-2-000001\n", strings.Repeat("9", 33), "comprobante"} {
		if name, ok := warrantyReceiptFilename(number); ok {
			t.Fatalf("%q must not name a file, got %q", number, name)
		}
	}
}

// TestWarrantyReceiptOverPostgreSQL proves the route on the admitted fixture: the branch
// that owns the case downloads the one-page paper of the used battery it lent, with the
// values the database persisted, the stable file name and the headers a download needs --
// and a case that lent nothing is refused without writing anything.
func TestWarrantyReceiptOverPostgreSQL(t *testing.T) {
	f := warrantyFixture(t)
	if w := f.serve(t, f.request(2, "POST", "/api/sales",
		saleBody(f.variant, 1, "96000.00", 12))); w.Code != 201 {
		t.Fatalf("the sale of the fixture must be admitted: %d %s", w.Code, w.Body.String())
	}
	serial := f.lastSerial(t)
	claim := f.caseWire(t, f.serve(t, f.request(2, "POST", "/api/warranty-cases/claims",
		fmt.Sprintf(`{"serial_number":%q,"declared_failure":"No arranca el motor"}`, serial))), 201)
	receiptPath := fmt.Sprintf("/api/warranty-cases/%d/receipt.pdf", claim.ID)

	// A claim that has not lent its used battery has no paper to hand over: the refusal is
	// its own and it writes nothing.
	f.refused(t, f.request(2, "GET", receiptPath, ""), 409, "no_loan")
	if w := f.serve(t, f.request(2, "POST", fmt.Sprintf("/api/warranty-cases/%d/loans", claim.ID),
		`{"model":"NS60L","quantity":1,"serial_number":"","source_location_id":1}`)); w.Code != 201 {
		t.Fatalf("the branch lends a used battery: %d %s", w.Code, w.Body.String())
	}

	w := f.serve(t, f.request(2, "GET", receiptPath, ""))
	if w.Code != 200 {
		t.Fatalf("the branch downloads the receipt of its case: %d %s", w.Code, w.Body.String())
	}
	if got := w.Header().Get("Content-Type"); got != "application/pdf" {
		t.Fatalf("the receipt is a PDF, got %q", got)
	}
	if got := w.Header().Get("Content-Disposition"); got !=
		`attachment; filename="comprobante-`+claim.CaseNumber+`.pdf"` {
		t.Fatalf("the receipt has no stable file name, got %q", got)
	}
	if got := w.Header().Get("Content-Length"); got != fmt.Sprint(w.Body.Len()) {
		t.Fatalf("the receipt publishes the wrong length: %q for %d bytes", got, w.Body.Len())
	}
	pdf := w.Body.Bytes()
	if !bytes.HasPrefix(pdf, []byte("%PDF-")) {
		t.Fatalf("the receipt is not a PDF: %q", string(pdf[:min(16, len(pdf))]))
	}
	// The paper is named by the persisted case number, never by a letter form (S20).
	if bytes.Contains(pdf, []byte("C-A-")) {
		t.Fatal("the receipt printed a letter form of the case number")
	}
	text := receiptDrawn(pdf)
	for _, want := range []string{claim.CaseNumber, serial, "No arranca el motor",
		"Cliente Mostrador", "700-00000", "NS60L", "Almac", "CONDICIONES DEL CANJE"} {
		if !strings.Contains(text, want) {
			t.Fatalf("the downloaded receipt does not draw %q:\n%s", want, text)
		}
	}

	// The authority is the case's own: the warehouse reads the cases it moves, another branch
	// owns nothing here, and the route admits one method with no query string.
	if w := f.serve(t, f.request(1, "GET", receiptPath, "")); w.Code != 200 {
		t.Fatalf("the warehouse reads the case it moves: %d %s", w.Code, w.Body.String())
	}
	f.refused(t, f.request(3, "GET", receiptPath, ""), 403, "forbidden")
	f.refused(t, f.request(2, "GET", receiptPath+"?copy=branch", ""), 400, "invalid_request")
	f.refused(t, f.request(2, "POST", receiptPath, "{}"), 405, "method_not_allowed")
	f.refused(t, f.request(0, "GET", receiptPath, ""), 401, "unauthenticated")
	f.refused(t, f.request(2, "GET", "/api/warranty-cases/999999/receipt.pdf", ""), 404, "not_found")
	f.refused(t, f.request(2, "GET", "/api/warranty-cases/01/receipt.pdf", ""), 400, "invalid_request")

	// A finding on the shelf has no client to hand a paper to: its units are the branch's own
	// and it lent no battery, so the receipt is the claim's fact.
	finding := f.caseWire(t, f.serve(t, f.request(2, "POST", "/api/warranty-cases/stock-defects",
		fmt.Sprintf(`{"variant_id":%d,"quantity":1,"declared_failure":"No retiene carga",`+
			`"reason":"Probada en mostrador"}`, f.variant))), 201)
	f.refused(t, f.request(2, "GET",
		fmt.Sprintf("/api/warranty-cases/%d/receipt.pdf", finding.ID), ""), 409, "claim_only")
}

// receiptDrawn is the drawn text of a rendered PDF in one line, so an assertion is about the
// words of the paper and never about where a cell happened to wrap. It is the same reader
// the warranty and the receipt tests use.
func receiptDrawn(data []byte) string {
	matches := receiptTextOp.FindAllSubmatch(data, -1)
	lines := make([]string, 0, len(matches))
	for _, match := range matches {
		lines = append(lines, string(match[1]))
	}
	return strings.Join(strings.Fields(strings.Join(lines, " ")), " ")
}
