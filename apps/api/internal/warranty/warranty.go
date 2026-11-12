// Package warranty renders the warranty of one branch sale as a PDF document.
//
// The warranty is a printable presentation of a sale that was already persisted:
// every amount and every text field arrives from the stored document and is rendered
// unchanged, so printing never recalculates a price, a subtotal or a total. Money
// crosses the package boundary as the canonical decimal string of the database
// ("85000.00", two decimals, no symbol) and leaves it in the presentation format
// chosen for the product ("Bs 85.000,00"): symbol, a space, thousands separated by a
// dot and decimals separated by a comma. Formatting works on integer cents, so no
// binary float ever touches an amount.
//
// A sale states its promise per physical battery, so the table has one row per unit with
// the serial number the seller read and the term stated for it, or "Sin garantía" when the
// client took that battery without warranty. The row amount is the amount the unit
// contributes to the sale, so the rows add up to the stored total.
//
// The package owns its own input types on purpose: it does not import the sale store,
// the HTTP layer or the price list, so the document can be rendered from any source
// that can fill Document. A sale may be paid with more than one method, so the payment
// arrives as the persisted amounts, one per method, and the renderer prints them
// without ever adding them up: the total is the stored total of the document. Customer
// text is sanitized (control characters are removed) and translated to cp1252, so
// accents render with the core font and arbitrary text cannot break the PDF structure.
//
// Compression is deliberately disabled (SetCompression(false)): a warranty is small
// (a 190-line sale stays under a few hundred kilobytes) and an uncompressed document
// stays greppable and structurally testable, which is what the tests of this package
// assert on.
package warranty

import (
	"bytes"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-pdf/fpdf"
)

// ErrInvalidDocument rejects a document that cannot be rendered faithfully. It is the
// only error Render returns: transport and library failures are reported wrapped with
// their own context.
var ErrInvalidDocument = errors.New("invalid warranty document")

// Money is a canonical amount with exactly two decimals, e.g. "85000.00". It is the
// representation the database stores (numeric(12,2)) and the HTTP contract speaks; it
// is never a float and never carries a currency symbol or a thousands separator.
type Money string

// Customer is the buyer of the sale. Phone and Document are optional: an empty value
// renders as an empty value, never as a zero.
type Customer struct {
	Name     string
	Phone    string
	Document string
}

// Line is one physical battery of the sale: the catalogue identity of its variant, the
// serial number the seller read at the counter and the term stated for that battery, or no
// term at all. Subtotal is the amount this one unit contributes to the sale, frozen on the
// sale and printed as it was stored, so the rows add up to the document total.
type Line struct {
	Brand          string
	Model          string
	Capacity       string
	Polarity       string
	SerialNumber   string
	WarrantyMonths *int
	Subtotal       Money
}

// Document is one warranty: the persisted sale header, its lines and the payments that
// make up its total. Total is the stored document total, not a sum computed here.
// IssuedAt is rendered in its own location (date and time), so the caller passes the
// sale timestamp already expressed in the time zone the document must show.
type Document struct {
	WarrantyNumber string
	IssuedAt       time.Time
	BranchName     string
	Customer       Customer
	Lines          []Line
	Total          Money
	Payments       []Payment
}

// Payment is one amount of the sale paid with one method, as it was stored. Method is
// the persisted code ("cash", "card", "transfer" or "qr") and Amount is the canonical
// amount paid with it; a sale paid with two methods carries two payments. Methods are never
// repeated, so the same money is never printed twice.
type Payment struct {
	Method string
	Amount Money
}

const (
	pageWidthMM  = 210.0
	pageHeightMM = 297.0
	marginLeft   = 12.0
	marginRight  = 12.0
	// marginTop leaves room for the document header, which is drawn on every page by
	// the fpdf header function.
	marginTop    = 42.0
	marginBottom = 18.0
	contentWidth = pageWidthMM - marginLeft - marginRight

	lineHeight      = 5.5
	tableHeadHeight = 6.0
	tableRowHeight  = 5.0
	// paymentAmountWidth is the right-aligned column of the amounts of the payments
	// block, wide enough for the largest amount the database can hold.
	paymentAmountWidth = 45.0

	dateLayout = "02/01/2006 15:04"

	// The warranty number is allocated by the database as "<branch>-<sequence>".
	maxWarrantyNumberLen = 32
	// The serial the seller read is bounded by the same rule the sale applies.
	maxSerialLength   = 64
	minWarrantyMonths = 1
	maxWarrantyMonths = 120
	// maxPayments is the number of admitted payment methods: cash, card, transfer and QR.
	// A sale carries at most one amount per method.
	maxPayments = 4
)

// column is one table column of the warranty: the frozen width, its heading and the
// alignment of its cells. The widths add up to contentWidth exactly. A row is one physical
// battery, so the table shows its serial and the term stated for it beside its amount.
// The term column is wide enough for the longest label, "Sin garantía".
type column struct {
	width float64
	title string
	align string
}

var columns = []column{
	{width: 30, title: "Marca", align: "L"},
	{width: 38, title: "Modelo", align: "L"},
	{width: 18, title: "Capacidad", align: "C"},
	{width: 14, title: "Polaridad", align: "C"},
	{width: 26, title: "Serie", align: "L"},
	{width: 32, title: "Plazo", align: "C"},
	{width: 28, title: "Subtotal", align: "R"},
}

// moneyPattern is the canonical amount of the database: at most ten integer digits
// and exactly two decimals, no sign, no separator, no exponent.
var moneyPattern = regexp.MustCompile(`^(0|[1-9][0-9]{0,9})\.[0-9]{2}$`)

var paymentLabels = map[string]string{
	"cash":     "Efectivo",
	"card":     "Tarjeta",
	"transfer": "Transferencia",
	"qr":       "QR",
}

// Render draws the warranty of one sale and returns the PDF bytes. The document is A4
// portrait, the header of the document and the heading of the table are repeated after
// every page break, and no unit of the sale is dropped or reordered: one row per physical
// battery, with its serial and its term or the absence of one.
func Render(doc Document) ([]byte, error) {
	if err := doc.validate(); err != nil {
		return nil, err
	}

	subtotals := make([]string, len(doc.Lines))
	for i, line := range doc.Lines {
		formatted, err := formatMoney(line.Subtotal)
		if err != nil {
			return nil, invalid("línea %d: subtotal: %v", i+1, err)
		}
		subtotals[i] = formatted
	}
	total, err := formatMoney(doc.Total)
	if err != nil {
		return nil, invalid("total: %v", err)
	}
	paymentAmounts := make([]string, len(doc.Payments))
	for i, payment := range doc.Payments {
		formatted, err := formatMoney(payment.Amount)
		if err != nil {
			return nil, invalid("pago %d: monto: %v", i+1, err)
		}
		paymentAmounts[i] = formatted
	}

	pdf := fpdf.New("P", "mm", "A4", "")
	// Uncompressed on purpose: see the package comment.
	pdf.SetCompression(false)
	translate := pdf.UnicodeTranslatorFromDescriptor("") // "" is cp1252, the core-font code page
	if err := pdf.Error(); err != nil {
		return nil, fmt.Errorf("warranty: code page: %w", err)
	}
	// Every drawn text goes through sanitize first (control characters would corrupt
	// the content stream) and through the cp1252 translator second.
	text := func(value string) string { return translate(sanitize(value)) }

	pdf.SetMargins(marginLeft, marginTop, marginRight)
	pdf.SetAutoPageBreak(true, marginBottom)
	pdf.SetTitle(text("Garantía "+doc.WarrantyNumber), false)
	pdf.SetAuthor("Luson", false)
	pdf.SetCreator("Luson", false)
	// The dates of the PDF come from the document, so identical input renders
	// identical bytes.
	pdf.SetCreationDate(doc.IssuedAt)
	pdf.SetModificationDate(doc.IssuedAt)
	// fpdf walks its font and resource catalogs as Go maps, whose iteration order is
	// randomized. Sorting them keeps the bytes of two equal documents identical.
	pdf.SetCatalogSort(true)
	pdf.AliasNbPages("{nb}")

	fit := func(value string, width float64) string { return fitText(pdf, text, value, width) }

	pdf.SetHeaderFunc(func() {
		pdf.SetXY(marginLeft, 12)
		pdf.SetTextColor(0x7A, 0x1F, 0x2B)
		pdf.SetFont("Arial", "B", 15)
		pdf.CellFormat(contentWidth, 9, text("GARANTÍA"), "", 1, "L", false, 0, "")
		pdf.SetTextColor(0, 0, 0)
		pdf.SetFont("Arial", "", 10)
		pdf.CellFormat(contentWidth, lineHeight, fit("Sucursal: "+doc.BranchName, contentWidth), "", 1, "L", false, 0, "")
		pdf.CellFormat(contentWidth, lineHeight, fit("Garantía N° "+doc.WarrantyNumber, contentWidth), "", 1, "L", false, 0, "")
		pdf.CellFormat(contentWidth, lineHeight, text("Fecha y hora: "+doc.IssuedAt.Format(dateLayout)), "", 1, "L", false, 0, "")
		pdf.SetDrawColor(0x7A, 0x1F, 0x2B)
		pdf.SetLineWidth(0.4)
		rule := pdf.GetY() + 1
		pdf.Line(marginLeft, rule, marginLeft+contentWidth, rule)
		pdf.SetDrawColor(0, 0, 0)
		pdf.SetLineWidth(0.2)
	})

	pdf.SetFooterFunc(func() {
		pdf.SetY(-14)
		pdf.SetTextColor(90, 90, 90)
		pdf.SetFont("Arial", "I", 8)
		pdf.CellFormat(contentWidth, 5, text("Garantía "+doc.WarrantyNumber), "", 0, "L", false, 0, "")
		pdf.CellFormat(0, 5, text(fmt.Sprintf("Página %d de {nb}", pdf.PageNo())), "", 0, "R", false, 0, "")
		pdf.SetTextColor(0, 0, 0)
	})

	drawTableHead := func() {
		pdf.SetFont("Arial", "B", 8)
		pdf.SetFillColor(0xF2, 0xEC, 0xE6)
		pdf.SetX(marginLeft)
		for i, col := range columns {
			last := 0
			if i == len(columns)-1 {
				last = 1
			}
			pdf.CellFormat(col.width, tableHeadHeight, text(col.title), "B", last, col.align, true, 0, "")
		}
		pdf.SetFillColor(255, 255, 255)
	}

	// newPage starts one page: the header function already ran, the table heading is
	// redrawn so the rows of every page stay readable on their own.
	newPage := func() {
		pdf.AddPage()
		pdf.SetY(marginTop)
		drawTableHead()
	}

	pdf.AddPage()
	pdf.SetY(marginTop)

	pdf.SetFont("Arial", "", 10)
	for _, row := range []string{
		customerField("Cliente: ", doc.Customer.Name),
		customerField("Teléfono: ", doc.Customer.Phone),
		customerField("Documento: ", doc.Customer.Document),
	} {
		pdf.CellFormat(contentWidth, lineHeight, fit(row, contentWidth), "", 1, "L", false, 0, "")
	}
	pdf.SetY(pdf.GetY() + 2)
	drawTableHead()

	for i, line := range doc.Lines {
		if pdf.GetY()+tableRowHeight > pageHeightMM-marginBottom {
			newPage()
		}
		pdf.SetFont("Arial", "", 8)
		pdf.SetX(marginLeft)
		cells := []string{
			line.Brand,
			line.Model,
			line.Capacity,
			line.Polarity,
			line.SerialNumber,
			lineTerm(line.WarrantyMonths),
			subtotals[i],
		}
		for c, col := range columns {
			last := 0
			if c == len(columns)-1 {
				last = 1
			}
			pdf.CellFormat(col.width, tableRowHeight, fit(cells[c], col.width-2), "B", last, col.align, false, 0, "")
		}
	}

	// The payments block and the total are one unit: how the sale was paid is never
	// separated from the total by a page break, and no payment row is ever lost.
	paymentsHeight := 2 + lineHeight + float64(len(doc.Payments))*lineHeight + lineHeight + 1
	if pdf.GetY()+paymentsHeight > pageHeightMM-marginBottom {
		newPage()
	}
	pdf.SetY(pdf.GetY() + 2)
	pdf.SetFont("Arial", "B", 10)
	pdf.CellFormat(contentWidth, lineHeight, text("Formas de pago"), "", 1, "L", false, 0, "")
	pdf.SetFont("Arial", "", 10)
	for i, payment := range doc.Payments {
		pdf.SetX(marginLeft)
		pdf.CellFormat(contentWidth-paymentAmountWidth, lineHeight, fit(paymentLabel(payment.Method), contentWidth-paymentAmountWidth-2), "", 0, "L", false, 0, "")
		pdf.CellFormat(paymentAmountWidth, lineHeight, paymentAmounts[i], "", 1, "R", false, 0, "")
	}
	pdf.SetFont("Arial", "B", 11)
	pdf.CellFormat(contentWidth, lineHeight+1, text("Total: "+total), "", 1, "R", false, 0, "")

	var buf bytes.Buffer
	if err := pdf.Output(&buf); err != nil {
		return nil, fmt.Errorf("warranty: write document: %w", err)
	}
	return buf.Bytes(), nil
}

// validate rejects a document whose stored values cannot be rendered faithfully.
func (doc Document) validate() error {
	if number := strings.TrimSpace(doc.WarrantyNumber); number == "" || len(number) > maxWarrantyNumberLen {
		return invalid("número de garantía vacío o demasiado largo")
	}
	if strings.TrimSpace(doc.BranchName) == "" {
		return invalid("sucursal vacía")
	}
	if doc.IssuedAt.IsZero() {
		return invalid("fecha de emisión vacía")
	}
	if strings.TrimSpace(doc.Customer.Name) == "" {
		return invalid("cliente sin nombre")
	}
	if err := doc.validatePayments(); err != nil {
		return err
	}
	if len(doc.Lines) == 0 {
		return invalid("la garantía no tiene líneas")
	}
	if _, err := parseCents(doc.Total); err != nil {
		return invalid("total: %v", err)
	}
	for i, line := range doc.Lines {
		if _, err := parseCents(line.Subtotal); err != nil {
			return invalid("unidad %d: subtotal: %v", i+1, err)
		}
		// The serial identifies the battery the client left with, so a row without one
		// cannot be printed: the document would not say which battery it covers.
		serial := strings.TrimSpace(line.SerialNumber)
		if serial == "" || len([]rune(serial)) > maxSerialLength {
			return invalid("unidad %d: número de serie vacío o demasiado largo", i+1)
		}
		// There is no zero months: a unit without warranty carries no term at all and is
		// printed as such, so a term outside 1..120 is a document this renderer refuses.
		if line.WarrantyMonths != nil &&
			(*line.WarrantyMonths < minWarrantyMonths || *line.WarrantyMonths > maxWarrantyMonths) {
			return invalid("unidad %d: plazo %d fuera de rango", i+1, *line.WarrantyMonths)
		}
	}
	return nil
}

// validatePayments rejects a payment list that cannot be rendered faithfully: a sale
// always has at least one payment, each method appears once, and every amount is a
// canonical amount greater than zero. The sum of the payments is deliberately not
// checked here: the base enforces it, and the renderer prints, it does not audit.
func (doc Document) validatePayments() error {
	if len(doc.Payments) == 0 {
		return invalid("la garantía no tiene formas de pago")
	}
	if len(doc.Payments) > maxPayments {
		return invalid("%d formas de pago, máximo %d", len(doc.Payments), maxPayments)
	}
	seen := make(map[string]struct{}, len(doc.Payments))
	for i, payment := range doc.Payments {
		method := strings.TrimSpace(payment.Method)
		if method == "" {
			return invalid("pago %d: forma de pago vacía", i+1)
		}
		if _, repeated := seen[method]; repeated {
			return invalid("pago %d: forma de pago %q repetida", i+1, method)
		}
		seen[method] = struct{}{}
		cents, err := parseCents(payment.Amount)
		if err != nil {
			return invalid("pago %d: monto: %v", i+1, err)
		}
		if cents <= 0 {
			return invalid("pago %d: el monto %q debe ser mayor que cero", i+1, string(payment.Amount))
		}
	}
	return nil
}

func invalid(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalidDocument, fmt.Sprintf(format, args...))
}

// parseCents turns a canonical amount into integer cents. No float is involved at any
// point, so the rendered amount is exactly the stored amount.
func parseCents(amount Money) (int64, error) {
	canonical := string(amount)
	if !moneyPattern.MatchString(canonical) {
		return 0, fmt.Errorf("monto canónico inválido %q", canonical)
	}
	whole, err := strconv.ParseInt(canonical[:len(canonical)-3], 10, 64)
	if err != nil {
		return 0, fmt.Errorf("monto canónico inválido %q", canonical)
	}
	decimals, err := strconv.ParseInt(canonical[len(canonical)-2:], 10, 64)
	if err != nil {
		return 0, fmt.Errorf("monto canónico inválido %q", canonical)
	}
	return whole*100 + decimals, nil
}

// formatMoney renders one canonical amount in the presentation format of the product,
// e.g. "85000.00" becomes "Bs 85.000,00".
func formatMoney(amount Money) (string, error) {
	cents, err := parseCents(amount)
	if err != nil {
		return "", err
	}
	return "Bs " + formatCents(cents), nil
}

// formatCents renders integer cents as "1.234,56".
func formatCents(cents int64) string {
	whole := cents / 100
	decimals := cents % 100
	digits := strconv.FormatInt(whole, 10)

	var b strings.Builder
	b.Grow(len(digits) + len(digits)/3 + 5)
	for i := 0; i < len(digits); i++ {
		if i > 0 && (len(digits)-i)%3 == 0 {
			b.WriteByte('.')
		}
		b.WriteByte(digits[i])
	}
	b.WriteByte(',')
	b.WriteByte(byte('0' + decimals/10))
	b.WriteByte(byte('0' + decimals%10))
	return b.String()
}

// lineTerm names the term of one unit the way the counter promises it: the stated months or
// the explicit absence of warranty. There is no zero months to print.
func lineTerm(months *int) string {
	if months == nil {
		return "Sin garantía"
	}
	return strconv.Itoa(*months) + " meses"
}

// customerField joins a label and its value. An empty value leaves the label alone, so
// a missing phone or document renders as nothing at all instead of a zero.
func customerField(label, value string) string {
	value = sanitize(value)
	if value == "" {
		return strings.TrimRight(label, " ")
	}
	return label + value
}

// paymentLabel turns the persisted payment method into a readable label. An unknown
// code is rendered as persisted instead of being dropped or replaced.
func paymentLabel(method string) string {
	code := strings.TrimSpace(method)
	if label, ok := paymentLabels[code]; ok {
		return label
	}
	return code
}

// sanitize removes the characters that would corrupt the PDF content stream: control
// characters are dropped and the whitespace controls become ordinary spaces. Invalid
// UTF-8 stays as the replacement rune and is translated to a plain glyph later.
func sanitize(value string) string {
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

// fitText truncates a value to the width of its cell, so a long brand or a long name
// cannot spill over a neighbouring column. Widths are measured on the translated
// cp1252 bytes, which is what the core font actually draws.
func fitText(pdf *fpdf.Fpdf, text func(string) string, value string, width float64) string {
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
