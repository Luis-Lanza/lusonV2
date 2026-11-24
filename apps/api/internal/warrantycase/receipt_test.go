package warrantycase_test

import (
	"bytes"
	"errors"
	"regexp"
	"strings"
	"testing"
	"time"

	"luson/api/internal/warrantycase"
)

// receiptAt is the instant the counter handed the used battery over, so the document's
// date is stated by value.
var receiptAt = time.Date(2026, 11, 23, 10, 42, 0, 0, time.UTC)

func smallReceipt() warrantycase.Receipt {
	return warrantycase.Receipt{
		// The number the database persists (S20), never the letter form of the mockup.
		CaseNumber:      "C-2-000001",
		BranchName:      "Sucursal A",
		IssuedAt:        receiptAt,
		ClaimedSerial:   "WL-8842137",
		WarrantyNumber:  "2-000012",
		DeclaredFailure: "No arranca en frío",
		CustomerName:    "Marta Ferreyra",
		CustomerPhone:   "11 4457-2210",
		Loans: []warrantycase.ReceiptLoan{
			{Ordinal: 1, Model: "YUASA NP7-12", Quantity: 1, Source: "Almacén", GivenAt: receiptAt},
		},
	}
}

// receiptPages matches the page dictionaries of a PDF: "s" distinguishes /Type /Pages.
var receiptPages = regexp.MustCompile(`/Type\s*/Page[^s]`)

func renderReceiptOK(t *testing.T, doc warrantycase.Receipt) []byte {
	t.Helper()
	data, err := warrantycase.RenderReceipt(doc)
	if err != nil {
		t.Fatalf("RenderReceipt returned error: %v", err)
	}
	if len(data) == 0 {
		t.Fatal("RenderReceipt returned no bytes")
	}
	return data
}

// receiptTextOp captures the literal strings of the text-showing operators, which are the
// words this document actually draws.
var receiptTextOp = regexp.MustCompile(`\(([^()]*)\)\s*Tj`)

// receiptDrawn is the drawn text of the document in one line: wrapping and truncation of a
// cell never hide a word from an assertion, and a phrase split by a line break is still
// read as the phrase it is.
func receiptDrawn(data []byte) string {
	matches := receiptTextOp.FindAllSubmatch(data, -1)
	lines := make([]string, 0, len(matches))
	for _, match := range matches {
		lines = append(lines, string(match[1]))
	}
	return strings.Join(strings.Fields(strings.Join(lines, " ")), " ")
}

// TestRenderReceiptPinsThePersistedExchange pins the shape of the receipt (S8): one A4
// portrait page that states the case, the battery the client left, the sale it came from,
// the used battery that was lent, the date, the branch and the client -- every value as it
// was persisted, and the conditions of the exchange.
func TestRenderReceiptPinsThePersistedExchange(t *testing.T) {
	data := renderReceiptOK(t, smallReceipt())

	if !bytes.HasPrefix(data, []byte("%PDF-")) {
		t.Fatalf("document does not start with %%PDF-: %q", string(data[:min(16, len(data))]))
	}
	if !bytes.HasSuffix(bytes.TrimSpace(data), []byte("%%EOF")) {
		t.Fatal("document does not end with the PDF EOF marker")
	}
	if got := len(receiptPages.FindAll(data, -1)); got != 1 {
		t.Fatalf("the receipt is one page, got %d", got)
	}
	if !bytes.Contains(data, []byte("/MediaBox [0 0 595.28 841.89]")) {
		t.Fatal("the receipt is not A4 portrait")
	}
	if !bytes.Contains(data, []byte("COMPROBANTE DE PR")) {
		t.Fatal("the receipt does not name itself")
	}

	text := receiptDrawn(data)
	for _, want := range []string{
		"C-2-000001",       // the persisted case number (S20)
		"Sucursal A",       // the branch that owes the client the answer
		"WL-8842137",       // the serial of the battery the client brought back
		"2-000012",         // the warranty number of the sale it came from
		"No arranca en fr", // what failed, in the words of the counter
		"YUASA NP7-12",     // the model of the used battery lent
		"Almac",            // where the used battery came from (S6)
		"Marta Ferreyra",   // the client the receipt is issued to
		"11 4457-2210",     // the client's phone
		"23/11/2026 10:42", // the date of the handover
		"CONDICIONES DEL CANJE",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("the receipt does not draw %q:\n%s", want, text)
		}
	}
	// The quantity of the loan is drawn as the counter stated it, never converted.
	if !strings.Contains(text, "1") {
		t.Fatalf("the receipt does not draw the quantity of the loan:\n%s", text)
	}
}

// TestRenderReceiptNamesTheCaseByThePersistedNumber pins S20 and L14(d): the document is
// named by the number the database writes, so a letter form -- the label of the mockup --
// is a document this renderer refuses instead of printing.
func TestRenderReceiptNamesTheCaseByThePersistedNumber(t *testing.T) {
	data := renderReceiptOK(t, smallReceipt())
	text := receiptDrawn(data)
	if got := strings.Count(text, "C-2-000001"); got == 0 {
		t.Fatal("the receipt does not print the persisted case number")
	}
	for _, absent := range []string{"C-A-", "C-Sucursal", "Caso A"} {
		if strings.Contains(text, absent) {
			t.Fatalf("the receipt printed a letter form of the case number: found %q", absent)
		}
	}
	letterForm := smallReceipt()
	letterForm.CaseNumber = "C-A-00043"
	if data, err := warrantycase.RenderReceipt(letterForm); !errors.Is(err, warrantycase.ErrInvalidReceipt) {
		t.Fatalf("a letter-form case number must be refused, got %v with %d bytes", err, len(data))
	}
}

// TestRenderReceiptCarriesTheConditionsOfTheExchange pins the copy of the exchange (S3,
// S8, S11, S14): the six conditions the specifications decide, each one stated, in order,
// and the two of them a test can hold mechanically -- the factory does not cover the
// damage and the client keeps the lent battery, and the original term neither extends nor
// restarts.
func TestRenderReceiptCarriesTheConditionsOfTheExchange(t *testing.T) {
	text := receiptDrawn(renderReceiptOK(t, smallReceipt()))

	conditions := []string{
		"La bater\xeda reclamada queda en poder de Luson", // stays here for review
		"La bater\xeda usada se entrega en pr\xe9stamo, sin cargo",
		"Cuando la bater\xeda reclamada regrese de f\xe1brica, el canje se realiza en esta sucursal",
		"el pr\xe9stamo queda como definitivo y la bater\xeda resultante se libera",
		"Si la f\xe1brica no cubre la garant\xeda, el cliente conserva la bater\xeda usada prestada",
		"El plazo de garant\xeda original no se extiende ni se reinicia por este pr\xe9stamo.",
	}
	previous := -1
	for _, condition := range conditions {
		at := strings.Index(text, condition)
		if at < 0 {
			t.Fatalf("the receipt does not state %q:\n%s", condition, text)
		}
		if at < previous {
			t.Fatalf("the condition %q is printed out of order", condition)
		}
		previous = at
	}
	// The two conditions a test can hold mechanically, named on their own so a rewrite of
	// the copy that lost either of them fails here.
	for _, mechanical := range []string{
		"no cubre la garant",            // S11: the client keeps the lent battery
		"no se extiende ni se reinicia", // S3: the original term never restarts
	} {
		if !strings.Contains(text, mechanical) {
			t.Fatalf("the receipt lost the condition %q:\n%s", mechanical, text)
		}
	}
}

// TestRenderReceiptPrintsOneRowPerLoan pins S7 on the document: a case that lent more than
// one used battery prints each one with its own model, quantity and source, in the order
// the counter handed them over, and never as one merged row.
func TestRenderReceiptPrintsOneRowPerLoan(t *testing.T) {
	doc := smallReceipt()
	doc.Loans = []warrantycase.ReceiptLoan{
		{Ordinal: 1, Model: "YUASA NP7-12", Quantity: 2, Source: "Almacén", GivenAt: receiptAt},
		{Ordinal: 2, Model: "WILLARD NS60L", Quantity: 1, Source: "Sucursal B",
			GivenAt: receiptAt.Add(48 * time.Hour)},
	}
	text := receiptDrawn(renderReceiptOK(t, doc))
	for _, want := range []string{"YUASA NP7-12", "WILLARD NS60L", "Sucursal B"} {
		if got := strings.Count(text, want); got != 1 {
			t.Fatalf("%q rendered %d times, want exactly one row:\n%s", want, got, text)
		}
	}
	if strings.Index(text, "YUASA NP7-12") > strings.Index(text, "WILLARD NS60L") {
		t.Fatal("the loans of the case are printed out of their own order")
	}
	if !strings.Contains(text, "25/11/2026 10:42") {
		t.Fatalf("the receipt does not date the loan it handed over:\n%s", text)
	}
}

// TestRenderReceiptIsDeterministic keeps the document greppable and reproducible, exactly
// as the warranty is: identical input renders identical bytes.
func TestRenderReceiptIsDeterministic(t *testing.T) {
	if !bytes.Equal(renderReceiptOK(t, smallReceipt()), renderReceiptOK(t, smallReceipt())) {
		t.Fatal("two renders of the same receipt differ")
	}
}

// TestRenderReceiptRefusesWhatItCannotPrint pins the refusals of the document: a receipt
// without a lent battery, a case without its number, a loan without a model or a source,
// and a value outside the bounds the database writes are never printed as a broken page.
func TestRenderReceiptRefusesWhatItCannotPrint(t *testing.T) {
	base := smallReceipt()
	withoutLoans := base
	withoutLoans.Loans = nil
	letterNumber := base
	letterNumber.CaseNumber = "C-A-00043"
	blankNumber := base
	blankNumber.CaseNumber = " "
	lowerNumber := base
	lowerNumber.CaseNumber = "c-2-000001"
	blankBranch := base
	blankBranch.BranchName = ""
	zeroDate := base
	zeroDate.IssuedAt = time.Time{}
	blankSerial := base
	blankSerial.ClaimedSerial = "  "
	longSerial := base
	longSerial.ClaimedSerial = strings.Repeat("S", 65)
	blankWarranty := base
	blankWarranty.WarrantyNumber = ""
	letterWarranty := base
	letterWarranty.WarrantyNumber = "GAR-A-00042"
	blankFailure := base
	blankFailure.DeclaredFailure = ""
	longFailure := base
	longFailure.DeclaredFailure = strings.Repeat("F", 501)
	blankCustomer := base
	blankCustomer.CustomerName = " "
	longPhone := base
	longPhone.CustomerPhone = strings.Repeat("7", 41)
	zeroQuantity := base
	zeroQuantity.Loans = []warrantycase.ReceiptLoan{
		{Ordinal: 1, Model: "YUASA NP7-12", Quantity: 0, Source: "Almacén", GivenAt: receiptAt}}
	tooMany := base
	tooMany.Loans = []warrantycase.ReceiptLoan{
		{Ordinal: 1, Model: "YUASA NP7-12", Quantity: 10001, Source: "Almacén", GivenAt: receiptAt}}
	blankModel := base
	blankModel.Loans = []warrantycase.ReceiptLoan{
		{Ordinal: 1, Model: " ", Quantity: 1, Source: "Almacén", GivenAt: receiptAt}}
	blankSource := base
	blankSource.Loans = []warrantycase.ReceiptLoan{
		{Ordinal: 1, Model: "YUASA NP7-12", Quantity: 1, Source: "", GivenAt: receiptAt}}
	undatedLoan := base
	undatedLoan.Loans = []warrantycase.ReceiptLoan{
		{Ordinal: 1, Model: "YUASA NP7-12", Quantity: 1, Source: "Almacén"}}
	unordered := base
	unordered.Loans = []warrantycase.ReceiptLoan{
		{Ordinal: 2, Model: "YUASA NP7-12", Quantity: 1, Source: "Almacén", GivenAt: receiptAt},
		{Ordinal: 1, Model: "YUASA NP7-12", Quantity: 1, Source: "Almacén", GivenAt: receiptAt}}

	for name, doc := range map[string]warrantycase.Receipt{
		"no loans":          withoutLoans,
		"letter number":     letterNumber,
		"blank number":      blankNumber,
		"lower-case number": lowerNumber,
		"blank branch":      blankBranch,
		"zero date":         zeroDate,
		"blank serial":      blankSerial,
		"long serial":       longSerial,
		"blank warranty":    blankWarranty,
		"letter warranty":   letterWarranty,
		"blank failure":     blankFailure,
		"long failure":      longFailure,
		"blank customer":    blankCustomer,
		"long phone":        longPhone,
		"zero quantity":     zeroQuantity,
		"quantity above":    tooMany,
		"blank model":       blankModel,
		"blank source":      blankSource,
		"undated loan":      undatedLoan,
		"unordered loans":   unordered,
	} {
		t.Run(name, func(t *testing.T) {
			data, err := warrantycase.RenderReceipt(doc)
			if err == nil {
				t.Fatalf("RenderReceipt accepted a document it cannot print and returned %d bytes", len(data))
			}
			if !errors.Is(err, warrantycase.ErrInvalidReceipt) {
				t.Fatalf("RenderReceipt returned %v, want an error wrapping ErrInvalidReceipt", err)
			}
			if len(data) != 0 {
				t.Fatalf("RenderReceipt returned %d bytes together with the error", len(data))
			}
		})
	}
}
