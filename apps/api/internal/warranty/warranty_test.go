package warranty_test

import (
	"bytes"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"testing"
	"time"

	"luson/api/internal/warranty"
)

var issuedAt = time.Date(2026, 11, 4, 17, 19, 0, 0, time.UTC)

// pagePattern matches the page dictionaries of a PDF document. The trailing "s"
// distinguishes /Type /Pages (the page tree root) from /Type /Page (one sheet).
var pagePattern = regexp.MustCompile(`/Type\s*/Page[^s]`)

func pageCount(data []byte) int {
	return len(pagePattern.FindAll(data, -1))
}

func renderOK(t *testing.T, doc warranty.Document) []byte {
	t.Helper()
	data, err := warranty.Render(doc)
	if err != nil {
		t.Fatalf("Render returned error: %v", err)
	}
	if len(data) == 0 {
		t.Fatal("Render returned no bytes")
	}
	return data
}

// months is the warranty term of one fixture unit, so a term can be stated by value.
func months(value int) *int { return &value }

func smallDocument() warranty.Document {
	return warranty.Document{
		WarrantyNumber: "2-000007",
		IssuedAt:       issuedAt,
		BranchName:     "Sucursal Centro",
		Customer: warranty.Customer{
			Name:     "Maria Nandu",
			Phone:    "77412345",
			Document: "V-12345678",
		},
		// One row per physical battery: each one carries its own serial and its own term.
		Lines: []warranty.Line{
			{
				Brand:          "YUASA",
				Model:          "YTX7A-BS",
				Capacity:       "12.0",
				Polarity:       "L",
				SerialNumber:   "YTX-0001",
				WarrantyMonths: months(12),
				Subtotal:       "75000.00",
			},
		},
		Total: "85000.00",
		Payments: []warranty.Payment{
			{Method: "cash", Amount: "85000.00"},
		},
	}
}

// S10/S11: the rendered document is a real PDF that carries the persisted fields of
// the sale exactly as they were stored.
func TestRenderPinsPersistedFields(t *testing.T) {
	data := renderOK(t, smallDocument())

	if !bytes.HasPrefix(data, []byte("%PDF-")) {
		t.Fatalf("document does not start with %%PDF-: %q", data[:min(16, len(data))])
	}
	if !bytes.HasSuffix(bytes.TrimSpace(data), []byte("%%EOF")) {
		t.Fatalf("document does not end with the PDF EOF marker: %q", tail(data, 24))
	}

	for _, want := range []string{
		"2-000007",         // warranty number
		"04/11/2026 17:19", // date and time
		"Sucursal Centro",  // branch
		"Maria Nandu",      // customer name
		"77412345",         // customer phone
		"V-12345678",       // customer document
		"YUASA",            // unit brand
		"YTX7A-BS",         // unit model
		"12.0",             // unit capacity
		"YTX-0001",         // serial the seller read at the counter
		"12 meses",         // term of that unit
		"Bs 75.000,00",     // row amount, L20 format
		"Bs 85.000,00",     // document total, L20 format
		"Formas de pago",   // heading of the payment block, S16
		"Efectivo",         // readable payment method of the only payment
	} {
		if !bytes.Contains(data, []byte(want)) {
			t.Errorf("document does not contain %q", want)
		}
	}
}

// S11/L20: canonical money renders as `Bs 1.234,56`, thousands with dot and
// decimals with comma, and is never echoed back as the raw canonical string.
func TestRenderFormatsCanonicalMoney(t *testing.T) {
	for _, test := range []struct {
		canonical string
		rendered  string
	}{
		{canonical: "85000.00", rendered: "Bs 85.000,00"},
		{canonical: "1234.56", rendered: "Bs 1.234,56"},
		{canonical: "0.00", rendered: "Bs 0,00"},
		{canonical: "999.99", rendered: "Bs 999,99"},
		{canonical: "1000.00", rendered: "Bs 1.000,00"},
		{canonical: "1234567.89", rendered: "Bs 1.234.567,89"},
		{canonical: "1234567890.12", rendered: "Bs 1.234.567.890,12"},
	} {
		t.Run(test.canonical, func(t *testing.T) {
			doc := smallDocument()
			doc.Total = warranty.Money(test.canonical)
			doc.Lines[0].Subtotal = warranty.Money(test.canonical)

			data := renderOK(t, doc)
			if !bytes.Contains(data, []byte(test.rendered)) {
				t.Fatalf("document does not contain %q", test.rendered)
			}
			// The canonical amount is money, never presentation: it must not be drawn as
			// the closing string of a text operator.
			for _, leaked := range [][]byte{
				[]byte(test.canonical + ")"),
				[]byte("Total: " + test.canonical),
			} {
				if bytes.Contains(data, leaked) {
					t.Fatalf("document still draws the raw canonical amount: found %q", leaked)
				}
			}
		})
	}
}

// S10: a small sale fits on one A4 portrait page.
func TestRenderSmallDocumentUsesOnePage(t *testing.T) {
	data := renderOK(t, smallDocument())
	if got := pageCount(data); got != 1 {
		t.Fatalf("page count = %d, want 1", got)
	}
	if !bytes.Contains(data, []byte("/MediaBox [0 0 595.28 841.89]")) {
		t.Fatalf("page is not A4 portrait: no A4 MediaBox found")
	}
}

// S10/S11: 190 lines paginate without dropping a row, and the document header plus
// the table header are repeated on every page.
func TestRenderLongDocumentKeepsEveryRow(t *testing.T) {
	doc := smallDocument()
	doc.Customer.Name = "Cliente Larga"
	const lines = 190
	doc.Lines = make([]warranty.Line, 0, lines)
	for i := 1; i <= lines; i++ {
		doc.Lines = append(doc.Lines, warranty.Line{
			Brand:          fmt.Sprintf("MARCA-%03d", i),
			Model:          fmt.Sprintf("MODELO-%03d", i),
			Capacity:       "75.0",
			Polarity:       "R",
			SerialNumber:   fmt.Sprintf("SERIE-%03d", i),
			WarrantyMonths: months(6 + i%12),
			Subtotal:       "1234.56",
		})
	}
	// The maximum admitted number of payments, so the block is as tall as it can get.
	doc.Payments = []warranty.Payment{
		{Method: "cash", Amount: "100.00"},
		{Method: "card", Amount: "200.00"},
		{Method: "transfer", Amount: "300.00"},
	}

	data := renderOK(t, doc)
	pages := pageCount(data)
	if pages < 2 {
		t.Fatalf("190 lines rendered on %d page(s), want more than one", pages)
	}

	for i := 1; i <= lines; i++ {
		model := fmt.Sprintf("MODELO-%03d", i)
		if got := bytes.Count(data, []byte(model)); got != 1 {
			t.Fatalf("row %d rendered %d times, want exactly one", i, got)
		}
	}

	// The header of the document and the header of the table are repeated.
	if got := bytes.Count(data, []byte("Sucursal Centro")); got != pages {
		t.Fatalf("branch header rendered %d times on %d page(s)", got, pages)
	}
	if got := bytes.Count(data, []byte("Polaridad")); got != pages {
		t.Fatalf("table header rendered %d times on %d page(s)", got, pages)
	}
	// The footer numbers the pages, so a printed document can be identified.
	for page := 1; page <= pages; page++ {
		want := fmt.Sprintf("P\xe1gina %d de %d", page, pages)
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("document does not contain the footer %q", want)
		}
	}

	// S16: the payments block survives the pagination: it appears exactly once, no row
	// is lost, and it is not split by a page break.
	if got := bytes.Count(data, []byte("Formas de pago")); got != 1 {
		t.Fatalf("payments block rendered %d times, want exactly one", got)
	}
	for _, want := range []string{"Efectivo", "Bs 100,00", "Tarjeta", "Bs 200,00", "Transferencia", "Bs 300,00"} {
		if got := bytes.Count(data, []byte(want)); got != 1 {
			t.Fatalf("payment row %q rendered %d times, want exactly one", want, got)
		}
	}
	blockAt := bytes.Index(data, []byte("Formas de pago"))
	totalAt := bytes.Index(data, []byte("Total: Bs 85.000,00"))
	if blockAt < 0 || totalAt < 0 {
		t.Fatalf("document lost the payments block (%d) or the total (%d)", blockAt, totalAt)
	}
	if blockAt > totalAt {
		t.Fatal("the total is rendered before the payments block")
	}
	lastRowAt := bytes.LastIndex(data, []byte("MODELO-190"))
	if lastRowAt > blockAt {
		t.Fatal("the payments block is rendered before the last line of the sale")
	}
	// A page break inside the block would redraw the document header and the table
	// heading between its heading and the total.
	between := data[blockAt:totalAt]
	for _, split := range []string{"Sucursal Centro", "Polaridad", "GARANT\xcdA"} {
		if bytes.Contains(between, []byte(split)) {
			t.Fatalf("the payments block was split by a page break: found %q inside it", split)
		}
	}
}

// S10: identical input renders identical bytes, so the PDF is structurally testable
// and reproducible.
func TestRenderIsDeterministic(t *testing.T) {
	first := renderOK(t, smallDocument())
	second := renderOK(t, smallDocument())
	if !bytes.Equal(first, second) {
		t.Fatalf("two renders of the same document differ (%d vs %d bytes)", len(first), len(second))
	}
}

// S10: invalid input is refused instead of producing a broken document.
func TestRenderRefusesInvalidDocument(t *testing.T) {
	base := smallDocument()
	noLines := base
	noLines.Lines = nil
	badTotal := base
	badTotal.Total = "85.000,00"
	badSubtotal := base
	badSubtotal.Lines = []warranty.Line{base.Lines[0]}
	badSubtotal.Lines[0].Subtotal = "75000"
	zeroTerm := base
	zeroTerm.Lines = []warranty.Line{base.Lines[0]}
	zeroTerm.Lines[0].WarrantyMonths = months(0)
	negativeTerm := base
	negativeTerm.Lines = []warranty.Line{base.Lines[0]}
	negativeTerm.Lines[0].WarrantyMonths = months(-1)
	tooLongTerm := base
	tooLongTerm.Lines = []warranty.Line{base.Lines[0]}
	tooLongTerm.Lines[0].WarrantyMonths = months(121)
	noSerial := base
	noSerial.Lines = []warranty.Line{base.Lines[0]}
	noSerial.Lines[0].SerialNumber = "   "
	longSerial := base
	longSerial.Lines = []warranty.Line{base.Lines[0]}
	longSerial.Lines[0].SerialNumber = strings.Repeat("S", 65)
	noNumber := base
	noNumber.WarrantyNumber = " "
	noBranch := base
	noBranch.BranchName = ""
	noDate := base
	noDate.IssuedAt = time.Time{}
	noCustomer := base
	noCustomer.Customer.Name = ""
	noPayments := base
	noPayments.Payments = nil
	tooManyPayments := base
	tooManyPayments.Payments = []warranty.Payment{
		{Method: "cash", Amount: "100.00"},
		{Method: "card", Amount: "100.00"},
		{Method: "transfer", Amount: "100.00"},
		{Method: "credit", Amount: "100.00"},
	}
	repeatedPayment := base
	repeatedPayment.Payments = []warranty.Payment{
		{Method: "cash", Amount: "100.00"},
		{Method: "cash", Amount: "200.00"},
	}
	zeroPayment := base
	zeroPayment.Payments = []warranty.Payment{{Method: "cash", Amount: "0.00"}}
	shortPayment := base
	shortPayment.Payments = []warranty.Payment{{Method: "cash", Amount: "100.5"}}
	commaPayment := base
	commaPayment.Payments = []warranty.Payment{{Method: "cash", Amount: "100,50"}}
	negativePayment := base
	negativePayment.Payments = []warranty.Payment{{Method: "cash", Amount: "-100.00"}}
	emptyPaymentMethod := base
	emptyPaymentMethod.Payments = []warranty.Payment{{Method: "  ", Amount: "100.00"}}

	for name, doc := range map[string]warranty.Document{
		"empty lines":      noLines,
		"invalid total":    badTotal,
		"invalid subtotal": badSubtotal,
		"zero term":        zeroTerm,
		"negative term":    negativeTerm,
		"term above 120":   tooLongTerm,
		"blank serial":     noSerial,
		"long serial":      longSerial,
		"empty number":     noNumber,
		"empty branch":     noBranch,
		"zero date":        noDate,
		"empty customer":   noCustomer,
		"no payments":      noPayments,
		"four payments":    tooManyPayments,
		"repeated method":  repeatedPayment,
		"zero payment":     zeroPayment,
		"short payment":    shortPayment,
		"comma payment":    commaPayment,
		"negative payment": negativePayment,
		"empty method":     emptyPaymentMethod,
	} {
		t.Run(name, func(t *testing.T) {
			data, err := warranty.Render(doc)
			if err == nil {
				t.Fatalf("Render accepted invalid document and returned %d bytes", len(data))
			}
			if !errors.Is(err, warranty.ErrInvalidDocument) {
				t.Fatalf("Render returned %v, want an error wrapping ErrInvalidDocument", err)
			}
			if len(data) != 0 {
				t.Fatalf("Render returned %d bytes together with the error", len(data))
			}
		})
	}
}

// S11: an empty phone or document renders as an empty value, never as "0".
func TestRenderLeavesEmptyCustomerFieldsEmpty(t *testing.T) {
	doc := smallDocument()
	doc.Customer.Phone = ""
	doc.Customer.Document = ""

	data := renderOK(t, doc)
	for _, leaked := range []string{"fono: 0", "Documento: 0", "fono:0", "Documento:0"} {
		if bytes.Contains(data, []byte(leaked)) {
			t.Fatalf("empty customer field rendered as a zero: found %q", leaked)
		}
	}
	if !bytes.Contains(data, []byte("Tel\xe9fono:")) {
		t.Fatal("document lost the phone label")
	}
	if !bytes.Contains(data, []byte("Documento:")) {
		t.Fatal("document lost the document label")
	}
	if bytes.Contains(data, []byte("77412345")) || bytes.Contains(data, []byte("V-12345678")) {
		t.Fatal("document rendered a customer value that was empty")
	}

	onlyDocument := smallDocument()
	onlyDocument.Customer.Phone = ""
	data = renderOK(t, onlyDocument)
	if !bytes.Contains(data, []byte("V-12345678")) {
		t.Fatal("document dropped the persisted customer document")
	}
}

// S11: accents render through the cp1252 translator (single-byte codes, not UTF-8),
// and arbitrary customer text with quotes and control characters cannot break the PDF.
func TestRenderTranslatesAccentsAndSurvivesArbitraryText(t *testing.T) {
	doc := smallDocument()
	doc.Customer.Name = "María Ñandú Peña"
	doc.Customer.Phone = "s/n\r\n\"casa\" (lote) \\ 7"
	doc.Customer.Document = "C.I. 12.345.678 \x00\x01\x1b\x7f"
	doc.BranchName = "Sucursal Ñuñoa"

	data := renderOK(t, doc)

	if !bytes.HasPrefix(data, []byte("%PDF-")) || !bytes.HasSuffix(bytes.TrimSpace(data), []byte("%%EOF")) {
		t.Fatal("document is not a complete PDF")
	}
	for _, want := range [][]byte{
		[]byte("Mar\xeda \xd1and\xfa Pe\xf1a"), // María Ñandú Peña in cp1252
		[]byte("Sucursal \xd1u\xf1oa"),         // Sucursal Ñuñoa in cp1252
	} {
		if !bytes.Contains(data, want) {
			t.Errorf("document does not contain the cp1252 bytes %q", want)
		}
	}
	// No control character survives in the drawn text, so the content stream stays
	// valid no matter what the customer typed.
	drawn := drawnStrings(data)
	if len(drawn) == 0 {
		t.Fatal("no drawn text found in the document")
	}
	for _, value := range drawn {
		for _, b := range []byte(value) {
			if b < 0x20 || b == 0x7f {
				t.Errorf("drawn text %q contains the control byte 0x%02x", value, b)
			}
		}
	}
}

// S11/S16: the persisted payment code travels to a readable label, and an unknown code
// is rendered as persisted instead of being dropped.
func TestRenderPaymentMethod(t *testing.T) {
	for _, test := range []struct {
		method string
		want   string
	}{
		{method: "cash", want: "Efectivo"},
		{method: "card", want: "Tarjeta"},
		{method: "transfer", want: "Transferencia"},
		{method: "credit", want: "credit"},
	} {
		t.Run(test.method, func(t *testing.T) {
			doc := smallDocument()
			doc.Payments[0].Method = test.method
			data := renderOK(t, doc)
			if !bytes.Contains(data, []byte(test.want)) {
				t.Fatalf("document does not contain %q", test.want)
			}
		})
	}
}

// S16: a sale paid partly in cash and partly by transfer renders one row per payment,
// with its label and its amount, in the order the payments were stored.
func TestRenderMixedPaymentsRendersOneRowPerMethod(t *testing.T) {
	doc := smallDocument()
	doc.Payments = []warranty.Payment{
		{Method: "cash", Amount: "30000.00"},
		{Method: "transfer", Amount: "55000.00"},
	}

	data := renderOK(t, doc)
	if got := bytes.Count(data, []byte("Formas de pago")); got != 1 {
		t.Fatalf("payments block rendered %d times, want exactly one", got)
	}
	for _, want := range []string{"Efectivo", "Bs 30.000,00", "Transferencia", "Bs 55.000,00"} {
		if got := bytes.Count(data, []byte(want)); got != 1 {
			t.Fatalf("%q rendered %d times, want exactly one row", want, got)
		}
	}
	// Each label is followed by its own amount, and the total closes the block.
	order := []string{"Formas de pago", "Efectivo", "Bs 30.000,00", "Transferencia", "Bs 55.000,00", "Total: Bs 85.000,00"}
	previous := -1
	for _, want := range order {
		at := bytes.Index(data, []byte(want))
		if at < 0 {
			t.Fatalf("document does not contain %q", want)
		}
		if at < previous {
			t.Fatalf("%q is rendered before the previous entry of the payments block", want)
		}
		previous = at
	}
}

// S16: the common case of one payment keeps reading like a single method: exactly one
// row, no other payment row, and the payment amount next to the total.
func TestRenderSinglePaymentRendersOneRow(t *testing.T) {
	data := renderOK(t, smallDocument())

	if got := bytes.Count(data, []byte("Formas de pago")); got != 1 {
		t.Fatalf("payments block rendered %d times, want exactly one", got)
	}
	if got := bytes.Count(data, []byte("Efectivo")); got != 1 {
		t.Fatalf("the only payment rendered %d rows, want exactly one", got)
	}
	// The payment amount and the equal total: one row plus the closing total.
	if got := bytes.Count(data, []byte("Bs 85.000,00")); got != 2 {
		t.Fatalf("payment amount rendered %d times plus the total, want 2", got)
	}
	for _, absent := range []string{"Tarjeta", "Transferencia"} {
		if bytes.Contains(data, []byte(absent)) {
			t.Fatalf("a document with one cash payment rendered %q", absent)
		}
	}
}

// S16: the renderer prints, it does not audit: the drawn total is the stored total even
// when the payments do not add up to it.
func TestRenderPrintsStoredTotalInsteadOfSummingPayments(t *testing.T) {
	doc := smallDocument()
	doc.Total = "85000.00"
	doc.Payments = []warranty.Payment{
		{Method: "cash", Amount: "10000.00"},
		{Method: "card", Amount: "20000.00"},
	}

	data := renderOK(t, doc)
	for _, want := range []string{"Total: Bs 85.000,00", "Bs 10.000,00", "Bs 20.000,00"} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("document does not contain %q", want)
		}
	}
	// A renderer that summed the payments would have printed 30000.00.
	if bytes.Contains(data, []byte("Bs 30.000,00")) {
		t.Fatal("the total was computed from the payments instead of printed from the document")
	}
}

// S16: when the payments block does not fit under the last line of the sale it moves to
// the next page as a whole, together with the total, instead of being split.
func TestRenderKeepsPaymentsBlockTogetherAtThePageBottom(t *testing.T) {
	doc := smallDocument()
	// 178 lines leave exactly 44 rows on the fifth page: the block no longer fits under
	// them, so it must open the next page instead of being cut.
	const lines = 178
	doc.Lines = make([]warranty.Line, 0, lines)
	for i := 1; i <= lines; i++ {
		doc.Lines = append(doc.Lines, warranty.Line{
			Brand:          fmt.Sprintf("MARCA-%03d", i),
			Model:          fmt.Sprintf("MODELO-%03d", i),
			Capacity:       "75.0",
			Polarity:       "R",
			SerialNumber:   fmt.Sprintf("SERIE-%03d", i),
			WarrantyMonths: months(12),
			Subtotal:       "1234.56",
		})
	}
	doc.Payments = []warranty.Payment{
		{Method: "cash", Amount: "100.00"},
		{Method: "card", Amount: "200.00"},
		{Method: "transfer", Amount: "300.00"},
	}

	data := renderOK(t, doc)
	if got := bytes.Count(data, []byte("Formas de pago")); got != 1 {
		t.Fatalf("payments block rendered %d times, want exactly one", got)
	}
	blockAt := bytes.Index(data, []byte("Formas de pago"))
	totalAt := bytes.Index(data, []byte("Total: Bs 85.000,00"))
	lastRowAt := bytes.LastIndex(data, []byte("MODELO-178"))
	if blockAt < 0 || totalAt < 0 || lastRowAt < 0 {
		t.Fatalf("document lost the block (%d), the total (%d) or the last row (%d)", blockAt, totalAt, lastRowAt)
	}
	if lastRowAt > blockAt {
		t.Fatal("the payments block is rendered before the last line of the sale")
	}
	// The block opens a new page: the document header of that page sits between the last
	// row and the block.
	if !bytes.Contains(data[lastRowAt:blockAt], []byte("Sucursal Centro")) {
		t.Fatal("the payments block did not move to the next page although it did not fit")
	}
	// Nothing of the page furniture is drawn inside the block, so it was not split.
	between := data[blockAt:totalAt]
	for _, split := range []string{"Sucursal Centro", "Polaridad", "GARANT\xcdA"} {
		if bytes.Contains(between, []byte(split)) {
			t.Fatalf("the payments block was split by a page break: found %q inside it", split)
		}
	}
	for _, want := range []string{"Efectivo", "Bs 100,00", "Tarjeta", "Bs 200,00", "Transferencia", "Bs 300,00"} {
		if got := bytes.Count(data, []byte(want)); got != 1 {
			t.Fatalf("payment row %q rendered %d times, want exactly one", want, got)
		}
	}
}

// textOp captures the literal strings of the text-showing operators of the content
// streams: the words this document actually draws.
var textOp = regexp.MustCompile(`\(([^()]*)\)\s*Tj`)

func drawnStrings(data []byte) []string {
	matches := textOp.FindAllSubmatch(data, -1)
	drawn := make([]string, 0, len(matches))
	for _, match := range matches {
		drawn = append(drawn, string(match[1]))
	}
	return drawn
}

func tail(data []byte, n int) string {
	if len(data) > n {
		data = data[len(data)-n:]
	}
	return strings.ReplaceAll(string(data), "\n", "\\n")
}

// S6: the document lists one row per physical battery, with the serial the seller read and
// the term stated for that battery or "Sin garantía", and the row amounts still add up to
// the sale total. A unit whose term is absent is a row like any other: it is named, never
// dropped.
func TestRenderNamesEveryUnitAndTheAbsentWarranty(t *testing.T) {
	doc := smallDocument()
	doc.Lines = []warranty.Line{
		{Brand: "YUASA", Model: "YTX7A-BS", Capacity: "12.0", Polarity: "L",
			SerialNumber: "SERIE-A", WarrantyMonths: months(12), Subtotal: "30000.00"},
		{Brand: "YUASA", Model: "YTX7A-BS", Capacity: "12.0", Polarity: "L",
			SerialNumber: "SERIE-B", WarrantyMonths: nil, Subtotal: "30000.00"},
		{Brand: "YUASA", Model: "YTX7A-BS", Capacity: "12.0", Polarity: "L",
			SerialNumber: "SERIE-C", WarrantyMonths: months(6), Subtotal: "25000.00"},
	}
	doc.Total = "85000.00"
	doc.Payments = []warranty.Payment{{Method: "cash", Amount: "85000.00"}}

	data := renderOK(t, doc)
	// One row per battery, in the order of the sale, and every serial is drawn once.
	for i, serial := range []string{"SERIE-A", "SERIE-B", "SERIE-C"} {
		if got := bytes.Count(data, []byte(serial)); got != 1 {
			t.Fatalf("serial %s (%d) rendered %d times, want exactly one row", serial, i+1, got)
		}
	}
	// The stated terms are named and the absent one is named as absent.
	for _, want := range []string{"12 meses", "6 meses"} {
		if got := bytes.Count(data, []byte(want)); got != 1 {
			t.Fatalf("term %q rendered %d times, want exactly one", want, got)
		}
	}
	if got := bytes.Count(data, []byte("Sin garant\xeda")); got != 1 {
		t.Fatalf("the unit without warranty must be named exactly once, got %d", got)
	}
	// The row amounts are drawn as stored and they close against the total.
	for _, want := range []string{"Bs 30.000,00", "Bs 25.000,00"} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("document does not contain the row amount %q", want)
		}
	}
	if got := bytes.Count(data, []byte("Bs 30.000,00")); got != 2 {
		t.Fatalf("both units sold at that amount must be printed, got %d", got)
	}
	if !bytes.Contains(data, []byte("Total: Bs 85.000,00")) {
		t.Fatal("the document lost the stored total")
	}
	// The order of the rows is the order of the units, so two prints of one sale agree with
	// the screen the seller saw.
	previous := -1
	for _, serial := range []string{"SERIE-A", "SERIE-B", "SERIE-C"} {
		at := bytes.Index(data, []byte(serial))
		if at < previous {
			t.Fatalf("the unit %s is printed out of order", serial)
		}
		previous = at
	}
}

// S6/L4: a sale whose every battery was taken without warranty is still always issued, and
// the document says "sin garantía" instead of printing a term or a zero.
func TestRenderIssuesWithoutAnyWarranty(t *testing.T) {
	doc := smallDocument()
	doc.Lines = []warranty.Line{
		{Brand: "YUASA", Model: "YTX7A-BS", Capacity: "12.0", Polarity: "L",
			SerialNumber: "SIN-1", Subtotal: "42500.00"},
		{Brand: "YUASA", Model: "YTX7A-BS", Capacity: "12.0", Polarity: "R",
			SerialNumber: "SIN-2", Subtotal: "42500.00"},
	}
	doc.Total = "85000.00"
	doc.Payments = []warranty.Payment{{Method: "cash", Amount: "85000.00"}}

	data := renderOK(t, doc)
	if got := bytes.Count(data, []byte("Sin garant\xeda")); got != 2 {
		t.Fatalf("both units must be named as without warranty, got %d", got)
	}
	for _, absent := range []string{"0 meses", "0 meses", "null"} {
		if bytes.Contains(data, []byte(absent)) {
			t.Fatalf("a document without warranty must never print %q", absent)
		}
	}
	if !bytes.Contains(data, []byte("Total: Bs 85.000,00")) {
		t.Fatal("the document without warranty must still print its total")
	}
}
