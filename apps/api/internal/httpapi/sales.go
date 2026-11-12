package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"luson/api/internal/auth"
	"luson/api/internal/catalog"
	"luson/api/internal/config"
	"luson/api/internal/pricing"
	"luson/api/internal/sales"
	"luson/api/internal/warranty"
)

// saleBodyLimit bounds decoding work well above any admitted payload: a sale admits at most
// MaxUnits physical units, and a thousand units of the widest admitted framing -- sixty-four
// four-byte UTF-8 characters of serial each, the largest the contract allows -- measure about
// 287 KiB, so the limit sits above that document and still bounds the decode. The check below
// stops reading at the limit instead of buffering the body whole.
const saleBodyLimit = 512 << 10

const (
	// saleCollectionPath and saleSellablePath are the only two literal paths of this
	// contract; the point of sale document and its warranty are read below the collection.
	saleCollectionPath = "/api/sales"
	saleSellablePath   = "/api/sales/sellable"
	// saleWarrantyPath is the printable warranty of one document, a literal suffix of the
	// {id} pattern so the document id is still one segment.
	saleWarrantyPath = "/warranty.pdf"
	// saleMaxSearch is the free-text bound of the history and catalogue filters.
	saleMaxSearch = 128
	// saleMaxVariantID is the catalogue variant bound, restated so an impossible id
	// never reaches the store.
	saleMaxVariantID = math.MaxInt32
	// saleMaxPageSize is the largest admitted page size of the read contract.
	saleMaxPageSize = 50
)

// NewWithSales mounts the branch point of sale on a handler built by the branch price
// factory. The optional store keeps every existing constructor untouched: without it
// the sale routes stay unregistered, exactly like ingress on the legacy factories, and
// every other request is forwarded to the composed handler unchanged.
func NewWithSales(base http.Handler, service *auth.Service, cfg config.Auth, store *sales.Store) (http.Handler, error) {
	if base == nil || service == nil || store == nil {
		return nil, sales.ErrUnavailable
	}
	parsed, err := config.ParseAuth(config.LocalTrial, cfg.Origin, cfg.Listen, cfg.TLSCert, cfg.TLSKey)
	if err != nil || parsed != cfg {
		return nil, sales.ErrUnavailable
	}
	api := &API{service, cfg}
	routes := api.saleRoutes(store)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		// An ambiguous sale path is refused before the handler can set its response
		// headers, exactly like the ingress, adjustment and price routes.
		if !salePath(r) {
			failure(w, 404, "not_found")
			return
		}
		if saleRoute(r.URL.Path) {
			routes.ServeHTTP(w, r)
			return
		}
		base.ServeHTTP(w, r)
	}), nil
}

// saleRoute reports whether this path belongs to the sale contract.
func saleRoute(path string) bool {
	return path == saleCollectionPath || strings.HasPrefix(path, saleCollectionPath+"/")
}

// salePath refuses ambiguous sale paths: a doubled slash, a dot segment, a backslash, a
// NUL or an encoded alias is not_found, never a silent redirect to a different
// resource. Every path outside the collection is admitted here and forwarded as is.
func salePath(r *http.Request) bool {
	p := r.URL.Path
	if !saleRoute(p) {
		return true
	}
	if strings.Contains(p, "//") || strings.ContainsAny(p, "\\\x00") {
		return false
	}
	for _, part := range strings.Split(p, "/") {
		if part == "." || part == ".." {
			return false
		}
	}
	return r.URL.EscapedPath() == p
}

// saleRoutes registers the point of sale. The literal sellable path is registered
// beside the {id} pattern, which is never more specific than it, so the catalogue can
// never be read as a document id, and the warranty is registered beside both as a
// literal suffix of the document. Any other path below the collection is an unknown
// route answered as JSON, never a cleaned or redirected path.
func (a *API) saleRoutes(store *sales.Store) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc(saleCollectionPath, a.sales(store))
	mux.HandleFunc(saleSellablePath, a.saleSellable(store))
	mux.HandleFunc(saleCollectionPath+"/{id}", a.saleDetail(store))
	mux.HandleFunc(saleCollectionPath+"/{id}"+saleWarrantyPath, a.saleWarranty(store))
	mux.HandleFunc(saleCollectionPath+"/", func(w http.ResponseWriter, r *http.Request) {
		failure(w, 404, "not_found")
	})
	return mux
}

// saleFailure publishes the domain's own decision and nothing else. A refused line
// names the variant the counter must point at, so it is answered with that id beside
// the error code; a refusal without a reusable id fails closed instead of publishing a
// meaningless zero. A settlement that does not close is its own refusal: it names the
// side that is open, which the counter needs to say how much is left to pay. A serial that
// was already sold is its own refusal too, and it names the battery it refused.
func saleFailure(w http.ResponseWriter, err error) {
	var notSellable *sales.NotSellable
	var belowMinimum *sales.BelowMinimum
	var insufficient *sales.InsufficientStock
	var mismatch *sales.PaymentsMismatch
	var duplicated *sales.SerialAlreadySold
	switch {
	// The open settlement is checked before the generic invalid document, because it is
	// itself a refusal of that class and carries the amount that is missing or over.
	case errors.As(err, &mismatch):
		salePaymentsMismatch(w, mismatch)
	case errors.As(err, &notSellable):
		saleVariantFailure(w, "variant_not_sellable", notSellable.VariantID)
	case errors.As(err, &belowMinimum):
		saleVariantFailure(w, "below_minimum", belowMinimum.VariantID)
	case errors.As(err, &insufficient):
		saleVariantFailure(w, "insufficient_stock", insufficient.VariantID)
	case errors.As(err, &duplicated):
		saleSerialFailure(w, duplicated.Serial)
	case errors.Is(err, sales.ErrInvalid):
		failure(w, 400, "invalid_request")
	case errors.Is(err, sales.ErrForbidden):
		failure(w, 403, "forbidden")
	case errors.Is(err, sales.ErrNotFound):
		failure(w, 404, "not_found")
	default:
		failure(w, 503, "service_unavailable")
	}
}

// saleSerialFailure answers a sale refused because one of its serials was already sold. The
// serial is published beside the code when the database named it, so the counter can point
// at the exact battery; a refusal that lost it is still the same refusal, so it is answered
// with the house envelope instead of an invented serial.
func saleSerialFailure(w http.ResponseWriter, serial sales.SerialNumber) {
	canonical, ok := sales.CanonicalSerial(serial)
	if !ok || canonical != serial {
		failure(w, 409, "serial_already_sold")
		return
	}
	respond(w, 409, map[string]string{"error": "serial_already_sold", "serial_number": string(serial)})
}

// saleVariantFailure answers a refusal that names one variant. The id is the database's
// own evidence, so a refusal that lost it is never published as variant zero.
func saleVariantFailure(w http.ResponseWriter, code string, variantID int64) {
	if variantID < 1 || variantID > saleMaxVariantID {
		failure(w, 503, "service_unavailable")
		return
	}
	respond(w, 409, map[string]any{"error": code, "variant_id": variantID})
}

// salePaymentsMismatch answers a settlement that does not close against the total of its
// own document: exactly one side is published, with the canonical amount the client still
// has to pay or was charged too much. The client can then say "faltan Bs 15.000,00"
// instead of only learning that the document is wrong. A refusal that carries both sides,
// neither of them, or an amount this contract cannot publish is not evidence of anything,
// so it fails closed rather than describing an empty difference.
func salePaymentsMismatch(w http.ResponseWriter, mismatch *sales.PaymentsMismatch) {
	missing, hasMissing := saleMoneyText(mismatch.Missing)
	excess, hasExcess := saleMoneyText(mismatch.Excess)
	switch {
	case hasMissing && !hasExcess:
		respond(w, 400, map[string]string{"error": "payments_mismatch", "missing": missing})
	case hasExcess && !hasMissing:
		respond(w, 400, map[string]string{"error": "payments_mismatch", "excess": excess})
	default:
		failure(w, 503, "service_unavailable")
	}
}

// saleMoney is the strict money reader: the amount must already be the canonical
// two-decimal text this contract publishes. More than two decimals, a missing
// fraction, a negative or empty amount, a padded integer and a JSON number are all
// invalid.
func saleMoney(d *json.Decoder) (sales.Money, error) {
	text, err := transferString(d)
	if err != nil {
		return "", sales.ErrInvalid
	}
	canonical, err := pricing.ParseMoney(text)
	if err != nil || string(canonical) != text {
		return "", sales.ErrInvalid
	}
	return canonical, nil
}

// salePayment reads one amount of the settlement: exactly the method it was paid with
// and the canonical amount paid with it. The derived 'mixed' is never a method a client
// states, so it is refused here exactly like an unknown one.
func salePayment(d *json.Decoder) (sales.Payment, error) {
	var payment sales.Payment
	if !transferDelimiter(d, '{') {
		return payment, sales.ErrInvalid
	}
	seen := map[string]bool{}
	for d.More() {
		key, err := transferString(d)
		if err != nil || seen[key] {
			return sales.Payment{}, sales.ErrInvalid
		}
		seen[key] = true
		switch key {
		case "method":
			var method string
			method, err = transferString(d)
			payment.Method = sales.PaymentMethod(method)
			// Only the four admitted methods are inputs of a settlement.
			if err == nil && !payment.Method.Valid() {
				err = sales.ErrInvalid
			}
		case "amount":
			payment.Amount, err = saleMoney(d)
		default:
			return sales.Payment{}, sales.ErrInvalid
		}
		if err != nil {
			return sales.Payment{}, sales.ErrInvalid
		}
	}
	if len(seen) != 2 || !transferDelimiter(d, '}') {
		return sales.Payment{}, sales.ErrInvalid
	}
	return payment, nil
}

// salePayments reads the settlement of one sale: one payment per admitted method at most,
// each method once, and each amount canonical two-decimal text. Whether the amounts close
// against the total is the store's rule, so a settlement that does not add up is admitted
// here and refused there, with the amount that is missing or left over.
func salePayments(d *json.Decoder) ([]sales.Payment, error) {
	if !transferDelimiter(d, '[') {
		return nil, sales.ErrInvalid
	}
	payments := make([]sales.Payment, 0, len(sales.PaymentMethods()))
	seen := make(map[sales.PaymentMethod]bool, len(sales.PaymentMethods()))
	for d.More() {
		if len(payments) >= len(sales.PaymentMethods()) {
			return nil, sales.ErrInvalid
		}
		payment, err := salePayment(d)
		if err != nil || seen[payment.Method] {
			return nil, sales.ErrInvalid
		}
		seen[payment.Method] = true
		payments = append(payments, payment)
	}
	if len(payments) == 0 || !transferDelimiter(d, ']') {
		return nil, sales.ErrInvalid
	}
	return payments, nil
}

// saleCustomer reads the client of the warranty: exactly the four frozen keys. The name is
// mandatory, the phone, the document and the address are optional and may be empty; their
// bounds are the store's own rule, so a text outside them is still refused there. The
// address is one free field of the sale header, never structured into parts.
func saleCustomer(d *json.Decoder) (sales.Customer, error) {
	var customer sales.Customer
	if !transferDelimiter(d, '{') {
		return customer, sales.ErrInvalid
	}
	seen := map[string]bool{}
	for d.More() {
		key, err := transferString(d)
		if err != nil || seen[key] {
			return sales.Customer{}, sales.ErrInvalid
		}
		seen[key] = true
		switch key {
		case "name":
			customer.Name, err = transferString(d)
		case "phone":
			customer.Phone, err = transferString(d)
		case "document":
			customer.Document, err = transferString(d)
		case "address":
			customer.Address, err = transferString(d)
		default:
			return sales.Customer{}, sales.ErrInvalid
		}
		if err != nil {
			return sales.Customer{}, sales.ErrInvalid
		}
	}
	if len(seen) != 4 || !transferDelimiter(d, '}') {
		return sales.Customer{}, sales.ErrInvalid
	}
	return customer, nil
}

// saleWarrantyTerm reads the term of one physical unit: a canonical integer from 1 to 120
// or the explicit absence of warranty, which is JSON null. There is no zero months, and the
// key is never absent: the decoder refuses both.
func saleWarrantyTerm(d *json.Decoder) (*int, error) {
	token, err := d.Token()
	if err != nil {
		return nil, sales.ErrInvalid
	}
	// A JSON null is the absence of warranty, which is sold data and never a zero.
	if token == nil {
		return nil, nil
	}
	number, ok := token.(json.Number)
	if !ok {
		return nil, sales.ErrInvalid
	}
	months, err := canonicalAdjustmentInteger(string(number), sales.MaxWarrantyMonths)
	if err != nil {
		return nil, sales.ErrInvalid
	}
	term := int(months)
	return &term, nil
}

// saleUnit reads one physical battery of a line: exactly the serial the seller read at the
// counter and the term stated for that battery, or its explicit absence.
func saleUnit(d *json.Decoder) (sales.Unit, error) {
	var unit sales.Unit
	if !transferDelimiter(d, '{') {
		return unit, sales.ErrInvalid
	}
	seen := map[string]bool{}
	for d.More() {
		key, err := transferString(d)
		if err != nil || seen[key] {
			return sales.Unit{}, sales.ErrInvalid
		}
		seen[key] = true
		switch key {
		case "serial_number":
			var serial string
			serial, err = transferString(d)
			unit.SerialNumber = sales.SerialNumber(serial)
		case "warranty_months":
			unit.WarrantyMonths, err = saleWarrantyTerm(d)
		default:
			return sales.Unit{}, sales.ErrInvalid
		}
		if err != nil {
			return sales.Unit{}, sales.ErrInvalid
		}
	}
	// Both keys are mandatory, and warranty_months is present even when it is null.
	if len(seen) != 2 || !transferDelimiter(d, '}') {
		return sales.Unit{}, sales.ErrInvalid
	}
	return unit, nil
}

// saleUnits reads the units of one line. The count against the quantity is the document's
// rule and the store's, so it is judged there; the bound here keeps the decoding work
// inside the admitted size of one sale.
func saleUnits(d *json.Decoder) ([]sales.Unit, error) {
	if !transferDelimiter(d, '[') {
		return nil, sales.ErrInvalid
	}
	units := make([]sales.Unit, 0, 4)
	for d.More() {
		if len(units) >= sales.MaxUnits {
			return nil, sales.ErrInvalid
		}
		unit, err := saleUnit(d)
		if err != nil {
			return nil, sales.ErrInvalid
		}
		units = append(units, unit)
	}
	if len(units) == 0 || !transferDelimiter(d, ']') {
		return nil, sales.ErrInvalid
	}
	return units, nil
}

// saleLine reads one line: the variant, the sold quantity, the charged price and one unit
// per sold piece, each with its serial and its term. The frozen minimum is not part of the
// body at all, because the branch's stored floor is the database's.
func saleLine(d *json.Decoder) (sales.LineInput, error) {
	var line sales.LineInput
	if !transferDelimiter(d, '{') {
		return line, sales.ErrInvalid
	}
	seen := map[string]bool{}
	for d.More() {
		key, err := transferString(d)
		if err != nil || seen[key] {
			return sales.LineInput{}, sales.ErrInvalid
		}
		seen[key] = true
		switch key {
		case "variant_id":
			line.VariantID, err = branchPriceNumber(d, saleMaxVariantID)
		case "quantity":
			line.Quantity, err = branchPriceNumber(d, sales.MaxQuantity)
		case "unit_price":
			line.UnitPrice, err = saleMoney(d)
		case "units":
			line.Units, err = saleUnits(d)
		default:
			return sales.LineInput{}, sales.ErrInvalid
		}
		if err != nil {
			return sales.LineInput{}, sales.ErrInvalid
		}
	}
	if len(seen) != 4 || !transferDelimiter(d, '}') {
		return sales.LineInput{}, sales.ErrInvalid
	}
	return line, nil
}

// saleLines reads the document lines: one to MaxLines lines, each variant exactly once,
// so a document that repeats a variant is refused before any database work.
func saleLines(d *json.Decoder) ([]sales.LineInput, error) {
	if !transferDelimiter(d, '[') {
		return nil, sales.ErrInvalid
	}
	lines := make([]sales.LineInput, 0, 4)
	seen := make(map[int64]bool, 4)
	for d.More() {
		if len(lines) >= sales.MaxLines {
			return nil, sales.ErrInvalid
		}
		line, err := saleLine(d)
		if err != nil || seen[line.VariantID] {
			return nil, sales.ErrInvalid
		}
		seen[line.VariantID] = true
		lines = append(lines, line)
	}
	if len(lines) == 0 || !transferDelimiter(d, ']') {
		return nil, sales.ErrInvalid
	}
	return lines, nil
}

// decodeSale reads tokens rather than structs: exact names, presence, types and
// duplicate keys (including escaped-equivalent keys) are enforced at every object
// level, and the terminal EOF rejects trailing input. The actor, the branch and the
// frozen prices are never part of the body.
func decodeSale(r *http.Request) (sales.CreateInput, error) {
	var in sales.CreateInput
	if r == nil || r.Body == nil || len(r.Header.Values("Content-Type")) != 1 {
		return in, sales.ErrInvalid
	}
	contentType := r.Header.Get("Content-Type")
	media, params, err := mime.ParseMediaType(contentType)
	// MIME parsing collapses identical duplicate parameters and admits a trailing
	// separator; neither is an unambiguous framing here.
	if err != nil || media != "application/json" || len(params) > 1 || strings.Count(contentType, ";") != len(params) {
		return in, sales.ErrInvalid
	}
	for key, value := range params {
		if key != "charset" || !strings.EqualFold(value, "utf-8") {
			return in, sales.ErrInvalid
		}
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, saleBodyLimit+1))
	if err != nil || len(body) > saleBodyLimit || !utf8.Valid(body) {
		return in, sales.ErrInvalid
	}
	d := json.NewDecoder(bytes.NewReader(body))
	d.UseNumber()
	if !transferDelimiter(d, '{') {
		return in, sales.ErrInvalid
	}
	seen := map[string]bool{}
	for d.More() {
		key, err := transferString(d)
		if err != nil || seen[key] {
			return sales.CreateInput{}, sales.ErrInvalid
		}
		seen[key] = true
		switch key {
		case "payments":
			in.Payments, err = salePayments(d)
		case "customer":
			in.Customer, err = saleCustomer(d)
		case "lines":
			in.Lines, err = saleLines(d)
		default:
			return sales.CreateInput{}, sales.ErrInvalid
		}
		if err != nil {
			return sales.CreateInput{}, sales.ErrInvalid
		}
	}
	if !seen["payments"] || !seen["customer"] || !seen["lines"] || len(seen) > 3 ||
		!transferDelimiter(d, '}') {
		return sales.CreateInput{}, sales.ErrInvalid
	}
	if _, err := d.Token(); err != io.EOF {
		return sales.CreateInput{}, sales.ErrInvalid
	}
	// The client, the amounts and the lines are revalidated by the store with the
	// authenticated identity, so nothing below derives authority from JSON.
	return in, nil
}

// saleListQuery reads the frozen history query: the literal search, the optional payment
// method, the page and the page size, each exactly once. Order is irrelevant;
// duplicates, empty values, unknown keys and encoding aliases are rejections, never
// defaults. The numeric parameters stay canonical on their raw spelling while the free
// text is percent-decoded once.
func saleListQuery(raw string) (sales.ListQuery, error) {
	query := sales.ListQuery{Page: 1, PageSize: sales.DefaultPageSize}
	values, err := stockAdjustmentQueryValues(raw)
	if err != nil {
		return query, sales.ErrInvalid
	}
	for key, value := range values {
		switch key {
		case "search":
			if len(value.decoded) > saleMaxSearch {
				return query, sales.ErrInvalid
			}
			query.Search = value.decoded
		case "payment_method":
			query.PaymentMethod = value.decoded
		case "page":
			n, err := canonicalAdjustmentInteger(value.raw, sales.MaxPage)
			if err != nil {
				return query, sales.ErrInvalid
			}
			query.Page = int(n)
		case "page_size":
			n, err := canonicalAdjustmentInteger(value.raw, saleMaxPageSize)
			if err != nil {
				return query, sales.ErrInvalid
			}
			query.PageSize = int(n)
		default:
			return query, sales.ErrInvalid
		}
	}
	// The store's own query contract is the final word: only the frozen page sizes and
	// the recorded labels are admitted, which are the four methods a client may state
	// plus the 'mixed' the database derives for a settlement with more than one.
	if !sales.ValidListQuery(query) {
		return query, sales.ErrInvalid
	}
	return query, nil
}

// saleSellableQuery reads the point-of-sale catalogue query: the literal search, the
// brand, the capacity, the polarity, the page and the page size, each exactly once.
// The capacity is a catalogue decimal, so a value the catalogue cannot hold never
// becomes a SQL parameter.
func saleSellableQuery(raw string) (sales.SellableQuery, error) {
	query := sales.SellableQuery{Page: 1, PageSize: sales.DefaultPageSize}
	values, err := stockAdjustmentQueryValues(raw)
	if err != nil {
		return query, sales.ErrInvalid
	}
	for key, value := range values {
		switch key {
		case "search":
			if len(value.decoded) > saleMaxSearch {
				return query, sales.ErrInvalid
			}
			query.Search = value.decoded
		case "brand":
			if len(value.decoded) > saleMaxSearch {
				return query, sales.ErrInvalid
			}
			query.Brand = value.decoded
		case "capacity":
			capacity, err := catalog.ParseDecimal(value.decoded)
			if err != nil {
				return query, sales.ErrInvalid
			}
			query.Capacity = capacity
		case "polarity":
			query.Polarity = value.decoded
		case "page":
			n, err := canonicalAdjustmentInteger(value.raw, sales.MaxPage)
			if err != nil {
				return query, sales.ErrInvalid
			}
			query.Page = int(n)
		case "page_size":
			n, err := canonicalAdjustmentInteger(value.raw, saleMaxPageSize)
			if err != nil {
				return query, sales.ErrInvalid
			}
			query.PageSize = int(n)
		default:
			return query, sales.ErrInvalid
		}
	}
	if !sales.ValidSellableQuery(query) {
		return query, sales.ErrInvalid
	}
	return query, nil
}

// salePaymentDTO is one amount of the settlement: the method that paid and the canonical
// amount paid with it, in the frozen order cash, card, transfer, QR and never a method that
// did not pay.
type salePaymentDTO struct {
	Method string `json:"method"`
	Amount string `json:"amount"`
}

// saleCustomerDTO is the client the warranty is issued to, exactly as it was persisted.
// The address is one free field of the sale header, empty when the sale carries none.
type saleCustomerDTO struct {
	Name     string `json:"name"`
	Phone    string `json:"phone"`
	Document string `json:"document"`
	Address  string `json:"address"`
}

// saleUnitDTO is one physical battery of a line: the serial the seller read at the counter
// and the term stated for that battery, which is JSON null when the client took it without
// warranty. The key is always present and the absence is never a zero.
type saleUnitDTO struct {
	SerialNumber   string `json:"serial_number"`
	WarrantyMonths *int   `json:"warranty_months"`
}

// saleLineDTO is one persisted line of the created document: the charged price, the
// minimum frozen at write time, the units the seller registered and the exact subtotal.
type saleLineDTO struct {
	VariantID int64         `json:"variant_id"`
	Quantity  int64         `json:"quantity"`
	UnitPrice string        `json:"unit_price"`
	MinPrice  string        `json:"min_price"`
	Units     []saleUnitDTO `json:"units"`
	Subtotal  string        `json:"subtotal"`
}

// saleDTO is the created sale: the database's own document numbers, the branch, the
// actor, how the total was settled and the frozen lines. PaymentMethod is the label the
// database derived from the amounts; Payments is the settlement itself.
type saleDTO struct {
	ID                 int64            `json:"id"`
	BranchLocationID   int64            `json:"branch_location_id"`
	BranchSequence     int64            `json:"branch_sequence"`
	WarrantyNumber     string           `json:"warranty_number"`
	PaymentMethod      string           `json:"payment_method"`
	Payments           []salePaymentDTO `json:"payments"`
	Customer           saleCustomerDTO  `json:"customer"`
	Total              string           `json:"total"`
	CreatedByAccountID int64            `json:"created_by_account_id"`
	CreatedAt          string           `json:"created_at"`
	Lines              []saleLineDTO    `json:"lines"`
}

// saleCreatedDTO is the frozen creation response: the document under its own key.
type saleCreatedDTO struct {
	Sale saleDTO `json:"sale"`
}

// saleSummaryDTO is one row of the branch history: the document header, how many lines it
// holds and how many physical units, of which how many were sold with a warranty. The counts
// tell the sale's position without unfolding it.
type saleSummaryDTO struct {
	ID                int64  `json:"id"`
	BranchSequence    int64  `json:"branch_sequence"`
	WarrantyNumber    string `json:"warranty_number"`
	PaymentMethod     string `json:"payment_method"`
	CustomerName      string `json:"customer_name"`
	Total             string `json:"total"`
	CreatedAt         string `json:"created_at"`
	Lines             int    `json:"lines"`
	UnitsTotal        int    `json:"units_total"`
	UnitsWithWarranty int    `json:"units_with_warranty"`
}

// salePageDTO is one newest-first page of the branch history plus the total.
type salePageDTO struct {
	Page       int              `json:"page"`
	PageSize   int              `json:"page_size"`
	TotalSales int64            `json:"total_sales"`
	Sales      []saleSummaryDTO `json:"sales"`
}

// saleDetailLineDTO is one persisted line together with the catalogue identity of its
// variant, so the document stays legible with the prices of the sale and with the serial and
// term of every battery it sold.
type saleDetailLineDTO struct {
	VariantID      int64         `json:"variant_id"`
	CatalogEntryID int64         `json:"catalog_entry_id"`
	Brand          string        `json:"brand"`
	Model          string        `json:"model"`
	Capacity       string        `json:"capacity_ah"`
	Polarity       string        `json:"polarity"`
	Quantity       int64         `json:"quantity"`
	UnitPrice      string        `json:"unit_price"`
	MinPrice       string        `json:"min_price"`
	Units          []saleUnitDTO `json:"units"`
	Subtotal       string        `json:"subtotal"`
}

// saleDetailDTO is one persisted sale with its catalogue-resolved lines. The header is
// the history row's header plus the client of the warranty and the settlement of the
// document, so the detail screen and the warranty PDF need no second read.
type saleDetailDTO struct {
	ID             int64               `json:"id"`
	BranchSequence int64               `json:"branch_sequence"`
	WarrantyNumber string              `json:"warranty_number"`
	PaymentMethod  string              `json:"payment_method"`
	Payments       []salePaymentDTO    `json:"payments"`
	CustomerName   string              `json:"customer_name"`
	Customer       saleCustomerDTO     `json:"customer"`
	Total          string              `json:"total"`
	CreatedAt      string              `json:"created_at"`
	Lines          []saleDetailLineDTO `json:"lines"`
}

// saleSellableItemDTO is one variant of the catalogue as the branch sees it at the
// counter: the catalogue identity, whether this branch can sell it right now, the pair of
// its battery and the stock of the branch. `suggested_price` and `min_price` are JSON null
// when the variant is not sellable, because the counter shows the blocked row with its
// action disabled instead of hiding it (S7). The warranty term is not part of the
// catalogue.
type saleSellableItemDTO struct {
	VariantID      int64   `json:"variant_id"`
	CatalogEntryID int64   `json:"catalog_entry_id"`
	Brand          string  `json:"brand"`
	Model          string  `json:"model"`
	Capacity       string  `json:"capacity_ah"`
	Polarity       string  `json:"polarity"`
	Sellable       bool    `json:"sellable"`
	SuggestedPrice *string `json:"suggested_price"`
	MinPrice       *string `json:"min_price"`
	Existing       int64   `json:"existing"`
	Reserved       int64   `json:"reserved"`
	Available      int64   `json:"available"`
}

// saleSellablePageDTO is one admitted page of the sellable catalogue plus the total.
type saleSellablePageDTO struct {
	Page          int                   `json:"page"`
	PageSize      int                   `json:"page_size"`
	TotalVariants int64                 `json:"total_variants"`
	Items         []saleSellableItemDTO `json:"items"`
}

// saleMoneyText admits only the canonical two-decimal text this contract publishes. A
// value that would not round-trip is never written to a response.
func saleMoneyText(money sales.Money) (string, bool) {
	if money == "" || money.String() != string(money) {
		return "", false
	}
	return string(money), true
}

// salePaymentRank is the frozen order of the settlement: cash, card, transfer, QR. It is not
// the alphabetical one, so the order is read from the domain instead of being restated.
func salePaymentRank(method sales.PaymentMethod) (int, bool) {
	for rank, admitted := range sales.PaymentMethods() {
		if admitted == method {
			return rank, true
		}
	}
	return 0, false
}

// saleDerivedLabel is the label the database derives from the amounts: 'mixed' when more
// than one method paid, otherwise the single method that paid. It is derived here again
// so a label that contradicts its own money is never published.
//
// The whole range of the settlement is admitted, one payment per admitted method and no
// more: the four-method sale is reachable since QR became the fourth payment, so the bound
// is the domain's own count of methods instead of a restated number that would drift from
// it. A settlement beyond that count cannot be represented by four amounts at all.
func saleDerivedLabel(payments []sales.Payment) (sales.PaymentMethod, bool) {
	switch {
	case len(payments) == 1:
		return payments[0].Method, payments[0].Method.Valid()
	case len(payments) >= 2 && len(payments) <= len(sales.PaymentMethods()):
		return sales.PaymentMixed, true
	}
	return "", false
}

// saleSamePayments reports whether two settlements hold the same payments in the same
// order, so a settlement the store canonicalized differently is not published as is.
func saleSamePayments(left, right []sales.Payment) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}

// salePaymentsRecord admits only a complete settlement as this contract publishes it: one
// payment per admitted method at most, in the frozen order, each method once, every amount
// canonical and greater than zero. A method that did not pay is never a row of the document.
func salePaymentsRecord(payments []sales.Payment) ([]salePaymentDTO, bool) {
	if len(payments) < 1 || len(payments) > len(sales.PaymentMethods()) {
		return nil, false
	}
	records := make([]salePaymentDTO, 0, len(payments))
	previous := -1
	for _, payment := range payments {
		amount, ok := saleMoneyText(payment.Amount)
		rank, ordered := salePaymentRank(payment.Method)
		if !ok || amount == "0.00" || !ordered || rank <= previous {
			return nil, false
		}
		previous = rank
		records = append(records, salePaymentDTO{Method: string(payment.Method), Amount: amount})
	}
	return records, true
}

// saleWarrantyNumber is the frozen number format: the branch id, a hyphen and the
// branch correlative padded to six digits, exactly what the admission trigger allocates.
// It answers the empty text for a pair that cannot be a number, so a document whose
// number does not match its own sequence column is never published.
func saleWarrantyNumber(branch, sequence int64) string {
	if branch < 2 || branch > math.MaxInt16 || sequence < 1 || sequence > 999_999_999 {
		return ""
	}
	return fmt.Sprintf("%d-%06d", branch, sequence)
}

// saleText admits catalogue text of this package: valid UTF-8 without a NUL. The sale's
// catalogue identity follows the same rule as the price matrix.
func saleText(value string) bool {
	return utf8.ValidString(value) && !strings.ContainsRune(value, 0)
}

// saleSameUnits reports whether two unit lists hold the same batteries in the same order.
// A unit is the same only when its serial and its term agree, and an absent term only
// matches another absent term: null is never the same as a number.
func saleSameUnits(left, right []sales.Unit) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i].SerialNumber != right[i].SerialNumber {
			return false
		}
		switch {
		case (left[i].WarrantyMonths == nil) != (right[i].WarrantyMonths == nil):
			return false
		case left[i].WarrantyMonths != nil && *left[i].WarrantyMonths != *right[i].WarrantyMonths:
			return false
		}
	}
	return true
}

// saleUnitsRecord admits only the units this contract publishes: canonical serial text and a
// term that is either absent or inside the frozen bounds. An empty list is admitted because
// the caller has already revalidated the document: it is the line of a pre-vertical sale,
// whose empty units array is published as `[]` and never as an invented battery. A unit the
// document cannot describe exactly means the document is not published at all.
func saleUnitsRecord(units []sales.Unit) ([]saleUnitDTO, bool) {
	if len(units) > sales.MaxUnits {
		return nil, false
	}
	records := make([]saleUnitDTO, 0, len(units))
	for _, unit := range units {
		serial, ok := sales.CanonicalSerial(unit.SerialNumber)
		if !ok || serial != unit.SerialNumber {
			return nil, false
		}
		if unit.WarrantyMonths != nil && (*unit.WarrantyMonths < sales.MinWarrantyMonths ||
			*unit.WarrantyMonths > sales.MaxWarrantyMonths) {
			return nil, false
		}
		records = append(records, saleUnitDTO{SerialNumber: string(serial),
			WarrantyMonths: unit.WarrantyMonths})
	}
	return records, true
}

// saleDocument admits only a complete persisted document of the write contract: the branch,
// the actor, the database's own numbers, the frozen floor and the exact arithmetic. The
// document is revalidated with the domain's own contract, so a persisted sale that does not
// add up is never published, and every line is published with its units or not at all.
func saleDocument(sale sales.Sale) (saleDTO, error) {
	return saleDocumentRecord(sale, sales.Validate)
}

// saleHistoryDocument admits the document a read answers, which is the same contract with one
// exception: a pre-vertical sale -- one or more lines and not one unit between them -- was
// stored before the sold unit existed, so it is described with an empty units array per line
// instead of failing closed. A sale carrying some units is still held to exactly one unit per
// sold piece, so a corrupt document is never published.
func saleHistoryDocument(sale sales.Sale) (saleDTO, error) {
	return saleDocumentRecord(sale, sales.ValidatePersisted)
}

func saleDocumentRecord(sale sales.Sale, validate func(sales.CreateInput) (sales.Payload, error)) (saleDTO, error) {
	unavailable := func() (saleDTO, error) { return saleDTO{}, sales.ErrUnavailable }
	if sale.ID < 1 || sale.BranchLocationID < 2 || sale.BranchLocationID > math.MaxInt16 ||
		sale.BranchSequence < 1 || sale.CreatedByAccountID < 1 || sale.CreatedAt.IsZero() ||
		sale.Customer.Name == "" || !saleText(sale.Customer.Name) ||
		!saleText(sale.Customer.Phone) || !saleText(sale.Customer.Document) ||
		!saleText(sale.Customer.Address) ||
		sale.WarrantyNumber != saleWarrantyNumber(sale.BranchLocationID, sale.BranchSequence) ||
		len(sale.Lines) < 1 || len(sale.Lines) > sales.MaxLines {
		return unavailable()
	}
	// The settlement must be publishable and its label must be the one its own amounts
	// derive, so the document never contradicts itself.
	payments, ok := salePaymentsRecord(sale.Payments)
	if !ok {
		return unavailable()
	}
	label, ok := saleDerivedLabel(sale.Payments)
	if !ok || sale.PaymentMethod != label {
		return unavailable()
	}
	total, ok := saleMoneyText(sale.Total)
	if !ok {
		return unavailable()
	}
	// The domain's own validation is reused instead of restating the arithmetic here,
	// so the published subtotals, the canonical amounts, the settlement, the units and the
	// total are the same numbers the store applied.
	input := sales.CreateInput{Payments: sale.Payments, Customer: sale.Customer,
		Lines: make([]sales.LineInput, 0, len(sale.Lines))}
	for _, line := range sale.Lines {
		input.Lines = append(input.Lines, sales.LineInput{VariantID: line.VariantID,
			Quantity: line.Quantity, UnitPrice: line.UnitPrice, Units: line.Units})
	}
	payload, err := validate(input)
	if err != nil || payload.Total != sale.Total || payload.Customer != sale.Customer ||
		len(payload.Lines) != len(sale.Lines) || !saleSamePayments(payload.Payments, sale.Payments) {
		return unavailable()
	}
	lines := make([]saleLineDTO, 0, len(payload.Lines))
	for i, line := range payload.Lines {
		persisted := sale.Lines[i]
		unit, ok := saleMoneyText(persisted.UnitPrice)
		if !ok || persisted.VariantID != line.VariantID || persisted.Quantity != line.Quantity ||
			persisted.UnitPrice != line.UnitPrice || persisted.Subtotal != line.Subtotal ||
			!saleSameUnits(persisted.Units, line.Units) {
			return unavailable()
		}
		minimum, ok := saleMoneyText(persisted.MinPrice)
		if !ok || !persisted.UnitPrice.AtLeast(persisted.MinPrice) {
			return unavailable()
		}
		subtotal, ok := saleMoneyText(persisted.Subtotal)
		if !ok {
			return unavailable()
		}
		units, ok := saleUnitsRecord(line.Units)
		if !ok {
			return unavailable()
		}
		lines = append(lines, saleLineDTO{VariantID: persisted.VariantID, Quantity: persisted.Quantity,
			UnitPrice: unit, MinPrice: minimum, Units: units, Subtotal: subtotal})
	}
	return saleDTO{
		ID:                 sale.ID,
		BranchLocationID:   sale.BranchLocationID,
		BranchSequence:     sale.BranchSequence,
		WarrantyNumber:     sale.WarrantyNumber,
		PaymentMethod:      string(sale.PaymentMethod),
		Payments:           payments,
		Customer:           saleCustomerDTO{Name: sale.Customer.Name, Phone: sale.Customer.Phone, Document: sale.Customer.Document, Address: sale.Customer.Address},
		Total:              total,
		CreatedByAccountID: sale.CreatedByAccountID,
		CreatedAt:          sale.CreatedAt.UTC().Format(time.RFC3339),
		Lines:              lines,
	}, nil
}

// salePageRecord admits only a complete history page: the page fits inside the reported
// total, the rows are newest first and every header is the document's own.
func salePageRecord(page sales.Page) (salePageDTO, error) {
	unavailable := func() (salePageDTO, error) { return salePageDTO{}, sales.ErrUnavailable }
	if !sales.ValidPage(page.Page, page.PageSize) || page.TotalSales < 0 ||
		len(page.Sales) > page.PageSize ||
		// A page beyond the last one is legitimately empty; a page with rows must
		// still fit inside the reported total.
		(len(page.Sales) > 0 &&
			int64(page.Page-1)*int64(page.PageSize)+int64(len(page.Sales)) > page.TotalSales) {
		return unavailable()
	}
	rows := make([]saleSummaryDTO, 0, len(page.Sales))
	previous := int64(math.MaxInt64)
	for _, summary := range page.Sales {
		total, ok := saleMoneyText(summary.Total)
		if summary.ID < 1 || summary.ID >= previous || summary.CreatedAt.IsZero() ||
			summary.BranchSequence < 1 || summary.WarrantyNumber == "" ||
			// The label is one the database derived, so 'mixed' is a legible row and a
			// filter the branch can use.
			!summary.PaymentMethod.Recorded() || !ok ||
			summary.Lines < 1 || summary.Lines > sales.MaxLines ||
			// A sale with no unit at all was stored before the sold unit existed, so it is a
			// legible row with zero units; one carrying some units but fewer than its lines is
			// corrupt. One sale never carries more than MaxUnits units, and a warranted unit is
			// always one of them.
			summary.UnitsTotal > sales.MaxUnits ||
			(!sales.PreVertical(summary.Lines, summary.UnitsTotal) &&
				summary.UnitsTotal < summary.Lines) ||
			summary.UnitsWithWarranty < 0 || summary.UnitsWithWarranty > summary.UnitsTotal ||
			summary.CustomerName == "" || !saleText(summary.CustomerName) {
			return unavailable()
		}
		previous = summary.ID
		rows = append(rows, saleSummaryDTO{
			ID:                summary.ID,
			BranchSequence:    summary.BranchSequence,
			WarrantyNumber:    summary.WarrantyNumber,
			PaymentMethod:     string(summary.PaymentMethod),
			CustomerName:      summary.CustomerName,
			Total:             total,
			CreatedAt:         summary.CreatedAt.UTC().Format(time.RFC3339),
			Lines:             summary.Lines,
			UnitsTotal:        summary.UnitsTotal,
			UnitsWithWarranty: summary.UnitsWithWarranty,
		})
	}
	return salePageDTO{Page: page.Page, PageSize: page.PageSize, TotalSales: page.TotalSales,
		Sales: rows}, nil
}

// saleDetailRecord admits only a complete persisted document with the catalogue identity
// of every line: the battery, its brand and model, its capacity as canonical text and the
// polarity that was sold. A document stored before the sold unit existed is admitted with
// empty units arrays, because it is recoverable history and not corruption.
func saleDetailRecord(detail sales.Detail) (saleDetailDTO, error) {
	unavailable := func() (saleDetailDTO, error) { return saleDetailDTO{}, sales.ErrUnavailable }
	if len(detail.Lines) < 1 || len(detail.Lines) > sales.MaxLines || detail.Customer.Name == "" {
		return unavailable()
	}
	lines := make([]sales.SaleLine, 0, len(detail.Lines))
	for _, line := range detail.Lines {
		lines = append(lines, line.SaleLine)
	}
	document, err := saleHistoryDocument(sales.Sale{
		ID: detail.ID, BranchLocationID: detail.BranchLocationID, BranchSequence: detail.BranchSequence,
		WarrantyNumber: detail.WarrantyNumber, PaymentMethod: detail.PaymentMethod,
		Payments: detail.Payments, Customer: detail.Customer, Total: detail.Total,
		CreatedByAccountID: detail.CreatedByAccountID, CreatedAt: detail.CreatedAt, Lines: lines,
	})
	if err != nil || len(document.Lines) != len(detail.Lines) {
		return unavailable()
	}
	resolved := make([]saleDetailLineDTO, 0, len(detail.Lines))
	for i, line := range detail.Lines {
		capacity, err := catalog.ParseDecimal(string(line.Capacity))
		if err != nil || line.CatalogEntryID < 1 || line.Brand == "" || line.Model == "" ||
			!saleText(line.Brand) || !saleText(line.Model) ||
			(line.Polarity != "L" && line.Polarity != "R") {
			return unavailable()
		}
		price := document.Lines[i]
		resolved = append(resolved, saleDetailLineDTO{
			VariantID:      price.VariantID,
			CatalogEntryID: line.CatalogEntryID,
			Brand:          line.Brand,
			Model:          line.Model,
			Capacity:       string(capacity),
			Polarity:       line.Polarity,
			Quantity:       price.Quantity,
			UnitPrice:      price.UnitPrice,
			MinPrice:       price.MinPrice,
			Units:          price.Units,
			Subtotal:       price.Subtotal,
		})
	}
	return saleDetailDTO{
		ID:             document.ID,
		BranchSequence: document.BranchSequence,
		WarrantyNumber: document.WarrantyNumber,
		PaymentMethod:  document.PaymentMethod,
		Payments:       document.Payments,
		CustomerName:   document.Customer.Name,
		Customer:       document.Customer,
		Total:          document.Total,
		CreatedAt:      document.CreatedAt,
		Lines:          resolved,
	}, nil
}

// saleSellableRecord admits only a complete catalogue page: the variants the branch can
// actually sell, each carrying the pair of its battery, which is never below the minimum.
func saleSellableRecord(page sales.SellablePage) (saleSellablePageDTO, error) {
	unavailable := func() (saleSellablePageDTO, error) { return saleSellablePageDTO{}, sales.ErrUnavailable }
	if !sales.ValidPage(page.Page, page.PageSize) || page.TotalVariants < 0 ||
		len(page.Items) > page.PageSize ||
		(len(page.Items) > 0 &&
			int64(page.Page-1)*int64(page.PageSize)+int64(len(page.Items)) > page.TotalVariants) {
		return unavailable()
	}
	items := make([]saleSellableItemDTO, 0, len(page.Items))
	var previous int64
	for _, item := range page.Items {
		if item.VariantID < 1 || item.VariantID > saleMaxVariantID || item.VariantID <= previous ||
			item.CatalogEntryID < 1 || item.Brand == "" || item.Model == "" ||
			!saleText(item.Brand) || !saleText(item.Model) ||
			(item.Polarity != "L" && item.Polarity != "R") {
			return unavailable()
		}
		capacity, err := catalog.ParseDecimal(string(item.Capacity))
		if err != nil {
			return unavailable()
		}
		// The stock of the branch is published as the inventory payload publishes it, and
		// `available` is the difference the ledger derives, never a number invented here.
		if item.Existing < 0 || item.Reserved < 0 || item.Reserved > item.Existing ||
			item.Available != item.Existing-item.Reserved {
			return unavailable()
		}
		record := saleSellableItemDTO{
			VariantID:      item.VariantID,
			CatalogEntryID: item.CatalogEntryID,
			Brand:          item.Brand,
			Model:          item.Model,
			Capacity:       string(capacity),
			Polarity:       item.Polarity,
			Sellable:       item.Sellable,
			Existing:       item.Existing,
			Reserved:       item.Reserved,
			Available:      item.Available,
		}
		// A sellable variant carries the pair of its battery in force; a variant the branch
		// cannot sell carries no pair at all, so the counter can never offer a price it does
		// not have.
		if item.Sellable {
			suggested, ok := saleMoneyText(item.SuggestedPrice)
			if !ok {
				return unavailable()
			}
			minimum, ok := saleMoneyText(item.MinPrice)
			if !ok || !item.SuggestedPrice.AtLeast(item.MinPrice) {
				return unavailable()
			}
			record.SuggestedPrice, record.MinPrice = &suggested, &minimum
		} else if item.SuggestedPrice != "" || item.MinPrice != "" {
			return unavailable()
		}
		previous = item.VariantID
		items = append(items, record)
	}
	return saleSellablePageDTO{Page: page.Page, PageSize: page.PageSize,
		TotalVariants: page.TotalVariants, Items: items}, nil
}

// sales serves the branch point of sale collection: the newest-first history read and the
// creation of one immutable sale document. Only a completed branch session is admitted,
// the mutation carries the usual same-origin guards, and the store is the final authority
// for the branch, the floor, the stock and the document numbers.
func (a *API) sales(store *sales.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodPost {
			w.Header().Set("Allow", "GET, POST")
			failure(w, 405, "method_not_allowed")
			return
		}
		actor, ok := a.inventoryIdentity(w, r)
		if !ok {
			return
		}
		if r.Method == http.MethodGet {
			// A bare separator is an ambiguous framing, not the default page.
			if r.URL.RawQuery == "" && r.URL.ForceQuery {
				failure(w, 400, "invalid_request")
				return
			}
			query, err := saleListQuery(r.URL.RawQuery)
			if err != nil {
				saleFailure(w, err)
				return
			}
			page, err := store.List(r.Context(), actor, query)
			if err != nil {
				saleFailure(w, err)
				return
			}
			record, err := salePageRecord(page)
			if err != nil {
				saleFailure(w, err)
				return
			}
			respond(w, 200, record)
			return
		}
		site := r.Header.Values("Sec-Fetch-Site")
		if len(site) > 1 || (len(site) == 1 && site[0] != "same-origin") {
			failure(w, 403, "forbidden")
			return
		}
		if !a.GuardMutation(w, r) {
			return
		}
		if r.URL.RawQuery != "" || r.URL.ForceQuery {
			failure(w, 400, "invalid_request")
			return
		}
		in, err := decodeSale(r)
		if err != nil {
			saleFailure(w, err)
			return
		}
		created, err := store.Create(r.Context(), actor, in)
		if err != nil {
			saleFailure(w, err)
			return
		}
		record, err := saleDocument(created)
		if err != nil {
			saleFailure(w, err)
			return
		}
		respond(w, 201, saleCreatedDTO{Sale: record})
	}
}

// saleSellable serves the point-of-sale catalogue of the actor's own branch: every
// variant of the catalogue, each with the stock of the branch, whether the branch can sell
// it right now and the pair of its battery. A variant the branch cannot sell is served
// with `sellable: false` and null prices, so the counter shows the row with its action
// disabled instead of hiding it. The warranty term is not part of the catalogue because
// the seller states it on the sale.
func (a *API) saleSellable(store *sales.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodGet) {
			return
		}
		actor, ok := a.inventoryIdentity(w, r)
		if !ok {
			return
		}
		if r.URL.RawQuery == "" && r.URL.ForceQuery {
			failure(w, 400, "invalid_request")
			return
		}
		query, err := saleSellableQuery(r.URL.RawQuery)
		if err != nil {
			saleFailure(w, err)
			return
		}
		page, err := store.Sellable(r.Context(), actor, query)
		if err != nil {
			saleFailure(w, err)
			return
		}
		record, err := saleSellableRecord(page)
		if err != nil {
			saleFailure(w, err)
			return
		}
		respond(w, 200, record)
	}
}

// saleDetail serves the per-document read: the header and the catalogue identity of every
// line, with the prices of the sale. Only a canonical positive id reaches the document
// lookup, a sale of another branch is not found, and an ambiguous path never gets here.
func (a *API) saleDetail(store *sales.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodGet) {
			return
		}
		actor, ok := a.inventoryIdentity(w, r)
		if !ok {
			return
		}
		// A query string is not part of this contract: it is a framing error, never a
		// silently ignored parameter.
		if r.URL.RawQuery != "" || r.URL.ForceQuery {
			failure(w, 400, "invalid_request")
			return
		}
		// A segment that is not a canonical positive id is not a document path at all,
		// so it is not found exactly like an unknown document.
		id, err := canonicalAdjustmentInteger(r.PathValue("id"), math.MaxInt64)
		if err != nil {
			failure(w, 404, "not_found")
			return
		}
		detail, err := store.Read(r.Context(), actor, id)
		if err != nil {
			saleFailure(w, err)
			return
		}
		record, err := saleDetailRecord(detail)
		if err != nil {
			saleFailure(w, err)
			return
		}
		respond(w, 200, record)
	}
}

// saleWarrantyFilename is the stable download name of one warranty: the number the
// database allocated, ASCII only, so a client saves the document it is looking at and two
// warranties never share a file name. A number that is not the frozen format cannot name
// a file, so it fails closed.
func saleWarrantyFilename(number string) (string, bool) {
	if number == "" || len(number) > 32 {
		return "", false
	}
	for i := 0; i < len(number); i++ {
		if ch := number[i]; (ch < '0' || ch > '9') && ch != '-' {
			return "", false
		}
	}
	return "garantia-" + number + ".pdf", true
}

// saleWarrantyDocument maps one persisted sale onto the printable warranty. Every amount and
// every unit arrive from the document and are printed as persisted, so the PDF never
// recomputes a price, a subtotal or the total. Each physical battery is its own row, with the
// serial the seller read and the term stated for it, or the recorded absence of warranty. The
// payment rows are only the methods that actually paid, in the store's own order, and the
// moment of issue is the stored moment of the sale.
func saleWarrantyDocument(detail sales.Detail) (warranty.Document, error) {
	unavailable := func() (warranty.Document, error) { return warranty.Document{}, sales.ErrUnavailable }
	// The guard the detail read publishes is reused here, so a document that cannot be
	// described exactly is never printed either.
	record, err := saleDetailRecord(detail)
	if err != nil || detail.BranchName == "" || !saleText(detail.BranchName) {
		return unavailable()
	}
	payments := make([]warranty.Payment, 0, len(detail.Payments))
	for _, payment := range detail.Payments {
		amount, ok := saleMoneyText(payment.Amount)
		// A method that paid nothing is never a row of the warranty.
		if !ok || amount == "0.00" || !payment.Method.Valid() {
			return unavailable()
		}
		payments = append(payments, warranty.Payment{Method: string(payment.Method),
			Amount: warranty.Money(amount)})
	}
	if len(payments) == 0 {
		return unavailable()
	}
	// One row per physical unit. The amount of a row is the frozen price of its line, so the
	// rows of a line add up to its subtotal and the rows of the sale to the stored total.
	lines := make([]warranty.Line, 0, len(record.Lines))
	for i := range record.Lines {
		line := record.Lines[i]
		for _, unit := range line.Units {
			lines = append(lines, warranty.Line{Brand: line.Brand, Model: line.Model,
				Capacity: line.Capacity, Polarity: line.Polarity, SerialNumber: unit.SerialNumber,
				WarrantyMonths: unit.WarrantyMonths, Subtotal: warranty.Money(line.UnitPrice)})
		}
	}
	return warranty.Document{
		WarrantyNumber: record.WarrantyNumber,
		IssuedAt:       detail.CreatedAt,
		BranchName:     detail.BranchName,
		Customer: warranty.Customer{Name: record.Customer.Name, Phone: record.Customer.Phone,
			Document: record.Customer.Document},
		Lines:    lines,
		Total:    warranty.Money(record.Total),
		Payments: payments,
	}, nil
}

// saleWarranty serves the printable warranty of one sale as a download. It carries the
// guards of the document read -- the method, the session identity, no query string, the
// same not-found rule for a segment that is not a document id and for a sale of another
// branch -- and answers the document itself with the stable file name and the headers a
// download needs. A render failure is service_unavailable: a warranty is either the whole
// document or nothing.
func (a *API) saleWarranty(store *sales.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodGet) {
			return
		}
		actor, ok := a.inventoryIdentity(w, r)
		if !ok {
			return
		}
		if r.URL.RawQuery != "" || r.URL.ForceQuery {
			failure(w, 400, "invalid_request")
			return
		}
		id, err := canonicalAdjustmentInteger(r.PathValue("id"), math.MaxInt64)
		if err != nil {
			failure(w, 404, "not_found")
			return
		}
		detail, err := store.Read(r.Context(), actor, id)
		if err != nil {
			saleFailure(w, err)
			return
		}
		filename, ok := saleWarrantyFilename(detail.WarrantyNumber)
		if !ok {
			failure(w, 503, "service_unavailable")
			return
		}
		document, err := saleWarrantyDocument(detail)
		if err != nil {
			saleFailure(w, err)
			return
		}
		pdf, err := warranty.Render(document)
		if err != nil {
			failure(w, 503, "service_unavailable")
			return
		}
		w.Header().Set("Content-Type", "application/pdf")
		w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
		w.Header().Set("Content-Length", strconv.Itoa(len(pdf)))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(pdf)
	}
}
