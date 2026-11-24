// This file is the loan receipt of a battery case: the one-page paper the client leaves
// with when the branch hands over a used battery in exchange for the claim.
//
// It is a printable presentation of a case that was already persisted, exactly like the
// warranty of a sale: every text arrives from the stored document and is drawn unchanged,
// so printing never recalculates anything -- not the number of the case, not the quantity of
// the loan, not the date. The package owns its own input type on purpose and imports neither
// the store's reader nor the HTTP layer, so the page can be rendered from any source that can
// fill Receipt; the store fills it from the persisted case (receipt_store.go).
//
// The case is named by the number the database writes, `C-<location>-<sequence>` (S20), and
// never by a letter form: a number outside that shape is a document this renderer refuses
// instead of printing a label the database does not own. The conditions of the exchange are
// product copy and not this file's invention either: they state what the specifications
// decide (S3, S8, S11, S13, S14) and they are frozen here as the words the client reads.
//
// Compression is deliberately disabled (SetCompression(false)): the paper is one page and an
// uncompressed page stays greppable and structurally testable, which is what the tests of
// this file assert on.

package warrantycase

import (
	"bytes"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-pdf/fpdf"
)

// ErrInvalidReceipt rejects a receipt that cannot be printed faithfully. It is the only
// error RenderReceipt returns: library failures are reported wrapped with their own context.
var ErrInvalidReceipt = errors.New("invalid loan receipt")

// Receipt is the loan receipt of one case: the branch that owes the client the answer, the
// case as the database numbered it, the battery the client brought back and the sale it came
// from, the used battery that was lent and the client the paper is issued to. Every value is
// the persisted value; the renderer prints, it does not derive.
type Receipt struct {
	// CaseNumber is the number the database allocated, `C-<location>-<sequence>` (S20).
	CaseNumber string
	// BranchName is the branch that owns the case and answers to the client (S19).
	BranchName string
	// IssuedAt is the persisted instant of the handover the paper documents: the moment the
	// database stamped on the loan it receipts, never the moment of printing.
	IssuedAt time.Time
	// ClaimedSerial is the serial of the battery the client brought back (S2).
	ClaimedSerial string
	// WarrantyNumber is the printed number of the sale the claimed battery came from (S8).
	WarrantyNumber string
	// DeclaredFailure is what failed, in the words of whoever registered the case.
	DeclaredFailure string
	// CustomerName and CustomerPhone are the client of the claimed sale (S8).
	CustomerName  string
	CustomerPhone string
	// Loans are the used batteries the case handed over, in the order the counter handed
	// them: a case that had to lend twice prints both rows (S7).
	Loans []ReceiptLoan
}

// ReceiptLoan is one used battery lent to the client. It names a model and a quantity and
// the location the battery came from, never a serial: a used battery is not identified that
// way when it is lent (S5, S6).
type ReceiptLoan struct {
	// Ordinal is the database's own sequence inside the case.
	Ordinal int
	Model   string
	// Quantity is how many used batteries of that model were handed over.
	Quantity int64
	// Source is the name of the location the used battery came from.
	Source string
	// GivenAt is the persisted instant the database stamped on the loan.
	GivenAt time.Time
}

// exchangeConditions is the copy of the exchange, frozen here because it is the product's
// promise and not the printer's invention. Each condition states one decision of the
// specifications: the claimed battery stays in the branch for its review (S9, S13), the used
// one is a free loan (S8), the exchange happens when the battery comes back from the factory
// (S9, S11), a client who does not come when told keeps the loan and the replacement is
// released (S14, S15), a factory that does not cover the damage leaves the loan with the
// client (S11), and the original term neither extends nor restarts (S3).
var exchangeConditions = []string{
	"La batería reclamada queda en poder de Luson y se envía al Almacén y a la fábrica para su revisión.",
	"La batería usada se entrega en préstamo, sin cargo, para que el cliente pueda seguir usando su vehículo mientras se resuelve la garantía.",
	"Cuando la batería reclamada regrese de fábrica, el canje se realiza en esta sucursal: se entrega la batería resultante y se devuelve la usada prestada.",
	"Si el cliente no se presenta dentro de los días que se le informen al ser avisado, el préstamo queda como definitivo y la batería resultante se libera.",
	"Si la fábrica no cubre la garantía, el cliente conserva la batería usada prestada y la batería reclamada queda en poder de Luson.",
	"El plazo de garantía original no se extiende ni se reinicia por este préstamo.",
}

const (
	receiptPageWidthMM  = 210.0
	receiptPageHeightMM = 297.0
	receiptMarginLeft   = 12.0
	receiptMarginRight  = 12.0
	// receiptMarginTop leaves room for the header, which is drawn on every page by the fpdf
	// header function.
	receiptMarginTop    = 42.0
	receiptMarginBottom = 18.0
	receiptContentWidth = receiptPageWidthMM - receiptMarginLeft - receiptMarginRight

	receiptLineHeight = 5.5
	receiptRowHeight  = 5.0
	receiptHeadHeight = 6.0
	// receiptConditionIndent leaves room for the number of a condition, so the paragraph of
	// the conditions starts at the same place on every row.
	receiptConditionIndent = 6.0

	receiptDateLayout = "02/01/2006 15:04"

	// The bounds of the client of a sale, restated from 025 so a value the database could not
	// hold is never printed.
	receiptMaxCustomerName  = 120
	receiptMaxCustomerPhone = 40
	// maxClaimedSerial is the bound of the serial the seller wrote down (031) and maxLoanModel
	// the bound of the model code of a used battery (032).
	maxClaimedSerial = 64
	maxLoanModel     = 40
)

// receiptCaseNumberPattern is the number the database writes for a case (065): the `C-` of the
// case, the branch and the correlative of that branch, and nothing else. A letter form is not
// a number this paper could be named by (S20, L14).
var receiptCaseNumberPattern = regexp.MustCompile(`^C-[1-9][0-9]{0,4}-[0-9]{6,12}$`)

// receiptWarrantyNumberPattern is the number 025 allocates for a sale.
var receiptWarrantyNumberPattern = regexp.MustCompile(`^[1-9][0-9]{0,4}-[0-9]{6,12}$`)

// receiptLoanColumn is one column of the loans table: its frozen width and its heading. The
// widths add up to the content width exactly, so a row never spills outside the page.
type receiptLoanColumn struct {
	width float64
	title string
	align string
}

var receiptLoanColumns = []receiptLoanColumn{
	{width: 72, title: "Modelo", align: "L"},
	{width: 22, title: "Cantidad", align: "R"},
	{width: 56, title: "Origen", align: "L"},
	{width: 36, title: "Fecha", align: "L"},
}

// RenderReceipt draws the loan receipt of one case and returns the PDF bytes: one A4 portrait
// page with the case, the battery that stayed, the used battery that was handed over, the
// client and the conditions of the exchange, each value as it was persisted.
func RenderReceipt(doc Receipt) ([]byte, error) {
	if err := doc.validate(); err != nil {
		return nil, err
	}

	pdf := fpdf.New("P", "mm", "A4", "")
	// Uncompressed on purpose: see the file comment.
	pdf.SetCompression(false)
	translate := pdf.UnicodeTranslatorFromDescriptor("") // "" is cp1252, the core-font code page
	if err := pdf.Error(); err != nil {
		return nil, fmt.Errorf("warrantycase: code page: %w", err)
	}
	// Every drawn text goes through sanitize first and through the cp1252 translator second.
	text := func(value string) string { return translate(receiptSanitize(value)) }
	fit := func(value string, width float64) string { return receiptFitText(pdf, text, value, width) }

	pdf.SetMargins(receiptMarginLeft, receiptMarginTop, receiptMarginRight)
	pdf.SetAutoPageBreak(true, receiptMarginBottom)
	pdf.SetTitle(text("Comprobante de préstamo "+doc.CaseNumber), false)
	pdf.SetAuthor("Luson", false)
	pdf.SetCreator("Luson", false)
	// The dates of the PDF come from the document, so identical input renders identical bytes.
	pdf.SetCreationDate(doc.IssuedAt)
	pdf.SetModificationDate(doc.IssuedAt)
	// fpdf walks its font and resource catalogs as Go maps, whose iteration order is
	// randomized. Sorting them keeps the bytes of two equal documents identical.
	pdf.SetCatalogSort(true)
	pdf.AliasNbPages("{nb}")

	pdf.SetHeaderFunc(func() {
		pdf.SetXY(receiptMarginLeft, 12)
		pdf.SetTextColor(0x7A, 0x1F, 0x2B)
		pdf.SetFont("Arial", "B", 15)
		pdf.CellFormat(receiptContentWidth, 9, text("COMPROBANTE DE PRÉSTAMO"), "", 1, "L", false, 0, "")
		pdf.SetTextColor(0, 0, 0)
		pdf.SetFont("Arial", "", 10)
		pdf.CellFormat(receiptContentWidth, receiptLineHeight,
			fit("Sucursal: "+doc.BranchName, receiptContentWidth), "", 1, "L", false, 0, "")
		pdf.CellFormat(receiptContentWidth, receiptLineHeight,
			fit("Caso N° "+doc.CaseNumber, receiptContentWidth), "", 1, "L", false, 0, "")
		pdf.CellFormat(receiptContentWidth, receiptLineHeight,
			text("Fecha: "+doc.IssuedAt.Format(receiptDateLayout)), "", 1, "L", false, 0, "")
		pdf.SetDrawColor(0x7A, 0x1F, 0x2B)
		pdf.SetLineWidth(0.4)
		rule := pdf.GetY() + 1
		pdf.Line(receiptMarginLeft, rule, receiptMarginLeft+receiptContentWidth, rule)
		pdf.SetDrawColor(0, 0, 0)
		pdf.SetLineWidth(0.2)
	})

	pdf.SetFooterFunc(func() {
		pdf.SetY(-14)
		pdf.SetTextColor(90, 90, 90)
		pdf.SetFont("Arial", "I", 8)
		pdf.CellFormat(receiptContentWidth, 5, fit("Caso "+doc.CaseNumber+" · Comprobante sin valor fiscal",
			receiptContentWidth), "", 0, "L", false, 0, "")
		pdf.CellFormat(0, 5, text(fmt.Sprintf("Página %d de {nb}", pdf.PageNo())), "", 0, "R", false, 0, "")
		pdf.SetTextColor(0, 0, 0)
	})

	// drawTableHead draws the heading of the loans table.
	drawTableHead := func() {
		pdf.SetFont("Arial", "B", 8)
		pdf.SetFillColor(0xF2, 0xEC, 0xE6)
		pdf.SetX(receiptMarginLeft)
		for i, col := range receiptLoanColumns {
			last := 0
			if i == len(receiptLoanColumns)-1 {
				last = 1
			}
			pdf.CellFormat(col.width, receiptHeadHeight, text(col.title), "B", last, col.align, true, 0, "")
		}
		pdf.SetFillColor(255, 255, 255)
	}

	// newPage starts one page: the header function already ran, the table heading is redrawn
	// so the rows of every page stay readable on their own.
	newPage := func() {
		pdf.AddPage()
		pdf.SetY(receiptMarginTop)
		drawTableHead()
	}

	// section draws the heading of one block of the paper.
	section := func(title string) {
		pdf.SetY(pdf.GetY() + 3)
		pdf.SetFont("Arial", "B", 10)
		pdf.CellFormat(receiptContentWidth, receiptLineHeight, text(title), "", 1, "L", false, 0, "")
		pdf.SetFont("Arial", "", 10)
	}

	// field draws one label and its value on its own line.
	field := func(label, value string) {
		pdf.CellFormat(receiptContentWidth, receiptLineHeight, fit(label+value, receiptContentWidth),
			"", 1, "L", false, 0, "")
	}

	// paragraph draws a text that may take more than one line, so a declared failure or a
	// condition is never cut off.
	paragraph := func(value string) {
		pdf.MultiCell(receiptContentWidth, receiptLineHeight, text(value), "", "L", false)
	}

	pdf.AddPage()
	pdf.SetY(receiptMarginTop)

	section("CLIENTE")
	field("Nombre: ", doc.CustomerName)
	field("Teléfono: ", doc.CustomerPhone)

	section("BATERÍA RECLAMADA, QUE QUEDA EN REVISIÓN")
	field("Número de serie: ", doc.ClaimedSerial)
	field("Garantía de la venta: ", doc.WarrantyNumber)
	pdf.SetFont("Arial", "", 10)
	pdf.CellFormat(receiptContentWidth, receiptLineHeight, text("Falla declarada:"), "", 1, "L", false, 0, "")
	paragraph(doc.DeclaredFailure)

	section("BATERÍA USADA ENTREGADA EN PRÉSTAMO")
	drawTableHead()
	for _, loan := range doc.Loans {
		if pdf.GetY()+receiptRowHeight > receiptPageHeightMM-receiptMarginBottom {
			newPage()
		}
		pdf.SetFont("Arial", "", 8)
		pdf.SetX(receiptMarginLeft)
		cells := []string{loan.Model, strconv.FormatInt(loan.Quantity, 10), loan.Source,
			loan.GivenAt.Format(receiptDateLayout)}
		for c, col := range receiptLoanColumns {
			last := 0
			if c == len(receiptLoanColumns)-1 {
				last = 1
			}
			pdf.CellFormat(col.width, receiptRowHeight, fit(cells[c], col.width-2), "B", last,
				col.align, false, 0, "")
		}
	}

	section("CONDICIONES DEL CANJE")
	pdf.SetFont("Arial", "", 9)
	for i, condition := range exchangeConditions {
		if pdf.GetY()+receiptLineHeight > receiptPageHeightMM-receiptMarginBottom {
			newPage()
			pdf.SetFont("Arial", "", 9)
		}
		// The number of the condition is drawn in the margin of its own paragraph, so the
		// list reads as a list even when a condition takes three lines.
		y := pdf.GetY()
		pdf.SetFont("Arial", "B", 9)
		pdf.SetTextColor(0x7A, 0x1F, 0x2B)
		pdf.CellFormat(receiptConditionIndent, receiptLineHeight,
			text(strconv.Itoa(i+1)+"."), "", 0, "L", false, 0, "")
		pdf.SetTextColor(0, 0, 0)
		pdf.SetFont("Arial", "", 9)
		pdf.SetXY(receiptMarginLeft+receiptConditionIndent, y)
		pdf.MultiCell(receiptContentWidth-receiptConditionIndent, receiptLineHeight, text(condition),
			"", "L", false)
		pdf.SetY(pdf.GetY() + 1)
	}

	var buf bytes.Buffer
	if err := pdf.Output(&buf); err != nil {
		return nil, fmt.Errorf("warrantycase: write receipt: %w", err)
	}
	return buf.Bytes(), nil
}

// validate rejects a receipt whose stored values cannot be printed faithfully: a case without
// its number, a loan without a model or a source, a value outside the bounds the database
// writes, and a document with no lent battery at all, which is not a receipt.
func (doc Receipt) validate() error {
	// The paper is named by the number the database writes and by nothing else (S20), so a
	// letter form or an abbreviated label is refused instead of being printed.
	if !receiptCaseNumberPattern.MatchString(doc.CaseNumber) {
		return receiptInvalid("número de caso %q fuera de la forma persistida", doc.CaseNumber)
	}
	if strings.TrimSpace(doc.BranchName) == "" {
		return receiptInvalid("sucursal vacía")
	}
	if doc.IssuedAt.IsZero() {
		return receiptInvalid("fecha de emisión vacía")
	}
	if serial := strings.TrimSpace(doc.ClaimedSerial); serial == "" ||
		len([]rune(serial)) > maxClaimedSerial {
		return receiptInvalid("número de serie de la batería reclamada vacío o demasiado largo")
	}
	if !receiptWarrantyNumberPattern.MatchString(doc.WarrantyNumber) {
		return receiptInvalid("número de garantía %q fuera de la forma persistida", doc.WarrantyNumber)
	}
	if failure := strings.TrimSpace(doc.DeclaredFailure); !receiptBounded(failure, 1, maxDeclaredFailure) {
		return receiptInvalid("falla declarada vacía o demasiado larga")
	}
	if name := strings.TrimSpace(doc.CustomerName); !receiptBounded(name, 1, receiptMaxCustomerName) {
		return receiptInvalid("nombre del cliente vacío o demasiado largo")
	}
	if !receiptBounded(doc.CustomerPhone, 0, receiptMaxCustomerPhone) {
		return receiptInvalid("teléfono del cliente fuera de los límites")
	}
	if len(doc.Loans) == 0 {
		return receiptInvalid("el comprobante no tiene préstamo que imprimir")
	}
	previous := 0
	for i, loan := range doc.Loans {
		if loan.Ordinal < 1 || loan.Ordinal <= previous {
			return receiptInvalid("préstamo %d: ordinal fuera de orden", i+1)
		}
		previous = loan.Ordinal
		if model := strings.TrimSpace(loan.Model); !receiptBounded(model, 1, maxLoanModel) {
			return receiptInvalid("préstamo %d: modelo vacío o demasiado largo", i+1)
		}
		if loan.Quantity < MinLoanQuantity || loan.Quantity > MaxLoanQuantity {
			return receiptInvalid("préstamo %d: cantidad %d fuera de rango", i+1, loan.Quantity)
		}
		if strings.TrimSpace(loan.Source) == "" {
			return receiptInvalid("préstamo %d: origen vacío", i+1)
		}
		if loan.GivenAt.IsZero() {
			return receiptInvalid("préstamo %d: fecha vacía", i+1)
		}
	}
	return nil
}

func receiptInvalid(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalidReceipt, fmt.Sprintf(format, args...))
}

// receiptBounded keeps a text inside the database's character bounds.
func receiptBounded(value string, minimum, maximum int) bool {
	if !utf8.ValidString(value) || strings.ContainsRune(value, 0) {
		return false
	}
	length := utf8.RuneCountInString(value)
	return length >= minimum && length <= maximum
}

// receiptSanitize removes the characters that would corrupt the PDF content stream: control
// characters are dropped and the whitespace controls become ordinary spaces.
func receiptSanitize(value string) string {
	if value == "" {
		return ""
	}
	var b strings.Builder
	b.Grow(len(value))
	for _, r := range value {
		switch {
		case r == '\t' || r == '\n' || r == '\r' || r == '\u00a0':
			b.WriteByte(' ')
		case r < 0x20 || r == 0x7f:
			// Dropped: a raw control byte would break the document structure.
		default:
			b.WriteRune(r)
		}
	}
	return strings.TrimSpace(b.String())
}

// receiptFitText truncates a value to the width of its cell, so a long model or a long
// branch name cannot spill over a neighbouring column. Widths are measured on the translated
// cp1252 bytes, which is what the core font actually draws.
func receiptFitText(pdf *fpdf.Fpdf, text func(string) string, value string, width float64) string {
	if width <= 0 {
		return ""
	}
	runes := []rune(value)
	if pdf.GetStringWidth(text(value)) <= width {
		return text(value)
	}
	for len(runes) > 0 {
		runes = runes[:len(runes)-1]
		if pdf.GetStringWidth(text(string(runes))) <= width {
			return text(string(runes))
		}
	}
	return ""
}
