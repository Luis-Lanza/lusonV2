package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"luson/api/internal/auth"
	"luson/api/internal/config"
	"luson/api/internal/purchases"
)

const (
	// purchaseCollectionPath and the five literal reads of this contract. The document and
	// its counter-document are read below the collection.
	purchaseCollectionPath = "/api/purchases"
	purchaseModelsPath     = "/api/purchases/models"
	purchaseMaterialsPath  = "/api/purchases/materials"
	purchaseLastPricesPath = "/api/purchases/last-prices"
	purchaseReceivedPath   = "/api/purchases/received"
	// purchaseReverseSuffix is the counter-document action of one document, a literal
	// suffix of the {id} pattern so the document id is still one segment.
	purchaseReverseSuffix = "/reverse"
	// purchaseBodyLimit bounds decoding work well above any admitted payload: one hundred
	// ninety used lines and one hundred ninety scrap lines of the widest admitted framing
	// measure well under 32 KiB, and the check stops reading at the limit instead of
	// buffering the body whole.
	purchaseBodyLimit = 64 << 10
	// purchaseMaxPageSize is the largest admitted page size of the read contract.
	purchaseMaxPageSize = 50
)

// NewWithPurchases mounts the Compras contract on a handler built by another factory. It is
// a wrapper on purpose: the purchase routes are added without changing any existing
// constructor, and every other request is forwarded to the composed handler unchanged.
func NewWithPurchases(base http.Handler, service *auth.Service, cfg config.Auth, store *purchases.Store) (http.Handler, error) {
	if base == nil || service == nil || store == nil {
		return nil, purchases.ErrUnavailable
	}
	parsed, err := config.ParseAuth(config.LocalTrial, cfg.Origin, cfg.Listen, cfg.TLSCert, cfg.TLSKey)
	if err != nil || parsed != cfg {
		return nil, purchases.ErrUnavailable
	}
	api := &API{service, cfg}
	routes := api.purchaseRoutes(store)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		// An ambiguous purchase path is refused before the handler can set its response
		// headers, exactly like the sale, ingress and price routes.
		if !purchasePath(r) {
			failure(w, 404, "not_found")
			return
		}
		if purchaseRoute(r.URL.Path) {
			routes.ServeHTTP(w, r)
			return
		}
		base.ServeHTTP(w, r)
	}), nil
}

// purchaseRoute reports whether this path belongs to the purchase contract.
func purchaseRoute(path string) bool {
	return path == purchaseCollectionPath || strings.HasPrefix(path, purchaseCollectionPath+"/")
}

// purchasePath refuses ambiguous purchase paths: a doubled slash, a dot segment, a
// backslash, a NUL or an encoded alias is not_found, never a silent redirect to a different
// document. Every path outside the collection is admitted here and forwarded as is.
func purchasePath(r *http.Request) bool {
	p := r.URL.Path
	if !purchaseRoute(p) {
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

// purchaseRoutes registers the contract. The literal reads are registered beside the {id}
// pattern, which is never more specific than them, so the catalogue can never be read as a
// document id. Any other path below the collection is an unknown route answered as JSON,
// never a cleaned or redirected path.
func (a *API) purchaseRoutes(store *purchases.Store) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc(purchaseCollectionPath, a.purchases(store))
	mux.HandleFunc(purchaseModelsPath, a.purchaseModels(store))
	mux.HandleFunc(purchaseMaterialsPath, a.purchaseMaterials(store))
	mux.HandleFunc(purchaseLastPricesPath, a.purchaseLastPrices(store))
	mux.HandleFunc(purchaseReceivedPath, a.purchaseReceived(store))
	mux.HandleFunc(purchaseCollectionPath+"/{id}", a.purchaseDetail(store))
	mux.HandleFunc(purchaseCollectionPath+"/{id}"+purchaseReverseSuffix, a.purchaseReverse(store))
	mux.HandleFunc(purchaseCollectionPath+"/", func(w http.ResponseWriter, r *http.Request) {
		failure(w, 404, "not_found")
	})
	return mux
}

// purchaseFailure publishes the domain's own decision and nothing else: the contract has one
// token per class, and anything unexpected fails closed.
func purchaseFailure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, purchases.ErrInvalid):
		failure(w, 400, "invalid_request")
	case errors.Is(err, purchases.ErrForbidden):
		failure(w, 403, "forbidden")
	case errors.Is(err, purchases.ErrNotFound):
		failure(w, 404, "not_found")
	case errors.Is(err, purchases.ErrRetryConflict):
		failure(w, 409, "retry_conflict")
	case errors.Is(err, purchases.ErrAlreadyReversed):
		failure(w, 409, "already_reversed")
	default:
		failure(w, 503, "service_unavailable")
	}
}

// purchaseJSONFraming admits the mutation framing of the contract: exactly one
// Content-Type of application/json with an optional utf-8 charset.
func purchaseJSONFraming(r *http.Request) bool {
	if r == nil || r.Body == nil || len(r.Header.Values("Content-Type")) != 1 {
		return false
	}
	contentType := r.Header.Get("Content-Type")
	media, params, err := mime.ParseMediaType(contentType)
	// MIME parsing collapses identical duplicate parameters and admits a trailing
	// separator; neither is an unambiguous framing here.
	if err != nil || media != "application/json" || len(params) > 1 ||
		strings.Count(contentType, ";") != len(params) {
		return false
	}
	for key, value := range params {
		if key != "charset" || !strings.EqualFold(value, "utf-8") {
			return false
		}
	}
	return true
}

// purchaseBody reads the whole body of one request, bounded and valid UTF-8.
func purchaseBody(r *http.Request) ([]byte, bool) {
	if !purchaseJSONFraming(r) {
		return nil, false
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, purchaseBodyLimit+1))
	if err != nil || len(body) > purchaseBodyLimit || !utf8.Valid(body) {
		return nil, false
	}
	return body, true
}

// purchaseMoney reads one amount of the wire: canonical two-decimal text above zero.
func purchaseMoney(d *json.Decoder) (purchases.Money, error) {
	text, err := transferString(d)
	if err != nil {
		return "", purchases.ErrInvalid
	}
	amount, ok := purchases.ParseMoney(text)
	if !ok {
		return "", purchases.ErrInvalid
	}
	return amount, nil
}

// purchaseAmount reads one side of the settlement: canonical two-decimal text that may be
// zero, because a document settled only by transfer carries 0.00 in cash.
func purchaseAmount(d *json.Decoder) (purchases.Money, error) {
	text, err := transferString(d)
	if err != nil {
		return "", purchases.ErrInvalid
	}
	amount, ok := purchases.ParseAmount(text)
	if !ok {
		return "", purchases.ErrInvalid
	}
	return amount, nil
}

// purchaseWeight reads one weight of the wire and answers its canonical form: "12.4" is
// admitted and published as "12.400".
func purchaseWeight(d *json.Decoder) (purchases.Weight, error) {
	text, err := transferString(d)
	if err != nil {
		return "", purchases.ErrInvalid
	}
	weight, ok := purchases.ParseWeight(text)
	if !ok {
		return "", purchases.ErrInvalid
	}
	return weight, nil
}

// purchaseModel reads one model code of the wire: a string, canonicalized by the domain so
// " ns60zl " is the battery NS60ZL.
func purchaseModel(d *json.Decoder) (string, error) {
	text, err := transferString(d)
	if err != nil {
		return "", purchases.ErrInvalid
	}
	model, ok := purchases.CanonicalModel(text)
	if !ok {
		return "", purchases.ErrInvalid
	}
	return model, nil
}

// purchaseUsedLine reads one used line: exactly the model code, the quantity and the price.
func purchaseUsedLine(d *json.Decoder) (purchases.UsedLineInput, error) {
	var line purchases.UsedLineInput
	if !transferDelimiter(d, '{') {
		return line, purchases.ErrInvalid
	}
	seen := map[string]bool{}
	for d.More() {
		key, err := transferString(d)
		if err != nil || seen[key] {
			return purchases.UsedLineInput{}, purchases.ErrInvalid
		}
		seen[key] = true
		switch key {
		case "model":
			line.Model, err = purchaseModel(d)
		case "quantity":
			line.Quantity, err = canonicalTransferInteger(numberToken(d), purchases.MaxQuantity)
		case "unit_price":
			line.UnitPrice, err = purchaseMoney(d)
		default:
			return purchases.UsedLineInput{}, purchases.ErrInvalid
		}
		if err != nil {
			return purchases.UsedLineInput{}, purchases.ErrInvalid
		}
	}
	if len(seen) != 3 || !transferDelimiter(d, '}') {
		return purchases.UsedLineInput{}, purchases.ErrInvalid
	}
	return line, nil
}

// numberToken reads one JSON number token as its own text, so a quantity is judged by the
// canonical integer reader and never by a float.
func numberToken(d *json.Decoder) string {
	token, err := d.Token()
	if err != nil {
		return ""
	}
	number, ok := token.(json.Number)
	if !ok {
		return ""
	}
	return string(number)
}

// purchaseScrapLine reads one scrap line: exactly the material, the weight in kilograms and
// the price per kilogram.
func purchaseScrapLine(d *json.Decoder) (purchases.ScrapLineInput, error) {
	var line purchases.ScrapLineInput
	if !transferDelimiter(d, '{') {
		return line, purchases.ErrInvalid
	}
	seen := map[string]bool{}
	for d.More() {
		key, err := transferString(d)
		if err != nil || seen[key] {
			return purchases.ScrapLineInput{}, purchases.ErrInvalid
		}
		seen[key] = true
		switch key {
		case "material_id":
			line.MaterialID, err = canonicalTransferInteger(numberToken(d), math.MaxInt16)
		case "kg":
			line.Kg, err = purchaseWeight(d)
		case "price_per_kg":
			line.PricePerKg, err = purchaseMoney(d)
		default:
			return purchases.ScrapLineInput{}, purchases.ErrInvalid
		}
		if err != nil {
			return purchases.ScrapLineInput{}, purchases.ErrInvalid
		}
	}
	if len(seen) != 3 || !transferDelimiter(d, '}') {
		return purchases.ScrapLineInput{}, purchases.ErrInvalid
	}
	return line, nil
}

// decodePurchase reads tokens rather than structs: exact names, presence, types and
// duplicate keys are enforced at every object level, and the terminal EOF rejects trailing
// input. The actor and the branch are never part of the body.
func decodePurchase(r *http.Request) (purchases.CreateInput, error) {
	var in purchases.CreateInput
	body, ok := purchaseBody(r)
	if !ok {
		return in, purchases.ErrInvalid
	}
	d := json.NewDecoder(bytes.NewReader(body))
	d.UseNumber()
	if !transferDelimiter(d, '{') {
		return in, purchases.ErrInvalid
	}
	seen := map[string]bool{}
	for d.More() {
		key, err := transferString(d)
		if err != nil || seen[key] {
			return purchases.CreateInput{}, purchases.ErrInvalid
		}
		seen[key] = true
		switch key {
		case "operation_key":
			in.OperationKey, err = transferString(d)
		case "note":
			in.Note, err = transferString(d)
		case "used_lines":
			in.UsedLines, err = purchaseLines(d, purchases.MaxLines, purchaseUsedLine)
		case "scrap_lines":
			in.ScrapLines, err = purchaseLines(d, purchases.MaxLines, purchaseScrapLine)
		case "paid_cash":
			in.PaidCash, err = purchaseAmount(d)
		case "paid_transfer":
			in.PaidTransfer, err = purchaseAmount(d)
		default:
			return purchases.CreateInput{}, purchases.ErrInvalid
		}
		if err != nil {
			return purchases.CreateInput{}, purchases.ErrInvalid
		}
	}
	if !seen["operation_key"] || !seen["paid_cash"] || !seen["paid_transfer"] ||
		!transferDelimiter(d, '}') {
		return purchases.CreateInput{}, purchases.ErrInvalid
	}
	if _, err := d.Token(); err != io.EOF {
		return purchases.CreateInput{}, purchases.ErrInvalid
	}
	// The key, the note, the bounds and the settlement are revalidated by the store with
	// the authenticated identity, so nothing below derives authority from JSON.
	if !purchases.ValidOperationKey(in.OperationKey) {
		return purchases.CreateInput{}, purchases.ErrInvalid
	}
	return in, nil
}

// purchaseLines reads one array of lines of either kind, bounded by the contract.
func purchaseLines[T any](d *json.Decoder, max int, line func(*json.Decoder) (T, error)) ([]T, error) {
	if !transferDelimiter(d, '[') {
		return nil, purchases.ErrInvalid
	}
	lines := make([]T, 0, 4)
	for d.More() {
		if len(lines) >= max {
			return nil, purchases.ErrInvalid
		}
		admitted, err := line(d)
		if err != nil {
			return nil, purchases.ErrInvalid
		}
		lines = append(lines, admitted)
	}
	if !transferDelimiter(d, ']') {
		return nil, purchases.ErrInvalid
	}
	return lines, nil
}

// decodePurchaseReversal reads exactly the two admitted tokens of the counter-document
// contract: the operation key and the mandatory reason. Lines, quantities and the target
// are never accepted from the client, so a partial reversal cannot even be expressed.
func decodePurchaseReversal(r *http.Request) (string, string, error) {
	body, ok := purchaseBody(r)
	if !ok {
		return "", "", purchases.ErrInvalid
	}
	d := json.NewDecoder(bytes.NewReader(body))
	d.UseNumber()
	if !transferDelimiter(d, '{') {
		return "", "", purchases.ErrInvalid
	}
	var operationKey, reason string
	seen := map[string]bool{}
	for d.More() {
		key, err := transferString(d)
		if err != nil || seen[key] {
			return "", "", purchases.ErrInvalid
		}
		seen[key] = true
		switch key {
		case "operation_key":
			operationKey, err = transferString(d)
		case "reason":
			reason, err = transferString(d)
		default:
			return "", "", purchases.ErrInvalid
		}
		if err != nil {
			return "", "", purchases.ErrInvalid
		}
	}
	if !seen["operation_key"] || !seen["reason"] || !transferDelimiter(d, '}') {
		return "", "", purchases.ErrInvalid
	}
	if _, err := d.Token(); err != io.EOF {
		return "", "", purchases.ErrInvalid
	}
	canonicalReason, valid := purchases.CanonicalReason(reason)
	if !purchases.ValidOperationKey(operationKey) || !valid {
		return "", "", purchases.ErrInvalid
	}
	return operationKey, canonicalReason, nil
}

// purchasePageQuery reads the frozen page query: only page and page_size, each exactly once,
// as a canonical integer. Order is irrelevant; duplicates, empty values, unknown keys and
// encoding aliases are rejections, never defaults.
func purchasePageQuery(raw string) (page, pageSize int, err error) {
	page, pageSize = 1, purchases.DefaultPageSize
	if raw == "" {
		return page, pageSize, nil
	}
	if len(raw) > 4096 {
		return 0, 0, purchases.ErrInvalid
	}
	seen := map[string]bool{}
	for _, part := range strings.Split(raw, "&") {
		key, value, ok := strings.Cut(part, "=")
		if !ok || value == "" || seen[key] {
			return 0, 0, purchases.ErrInvalid
		}
		seen[key] = true
		var read error
		var n int64
		switch key {
		case "page":
			n, read = canonicalTransferInteger(value, purchases.MaxPage)
			page = int(n)
		case "page_size":
			n, read = canonicalTransferInteger(value, purchaseMaxPageSize)
			pageSize = int(n)
			if n != 10 && n != purchases.DefaultPageSize && n != purchaseMaxPageSize {
				read = purchases.ErrInvalid
			}
		default:
			return 0, 0, purchases.ErrInvalid
		}
		if read != nil {
			return 0, 0, purchases.ErrInvalid
		}
	}
	if !purchases.ValidPage(page, pageSize) {
		return 0, 0, purchases.ErrInvalid
	}
	return page, pageSize, nil
}

// purchaseMoneyText admits only the canonical two-decimal text this contract publishes; a
// persisted counter-document amount is negative and is published exactly as persisted.
func purchaseMoneyText(money purchases.Money) (string, bool) {
	if money == "" {
		return "", false
	}
	// The domain's own parser is the authority for both signs: a value that would not
	// round-trip is never written to a response.
	if positive, ok := purchases.ParseMoney(string(money)); ok && positive == money {
		return string(money), true
	}
	if negated, ok := purchases.ParseMoney(strings.TrimPrefix(string(money), "-")); ok &&
		string(money) == "-"+string(negated) && negated != "0.00" {
		return string(money), true
	}
	if money == "0.00" {
		return string(money), true
	}
	return "", false
}

// purchaseWeightText admits only the canonical three-decimal text this contract publishes.
func purchaseWeightText(weight purchases.Weight) (string, bool) {
	text := string(weight)
	if text == "" {
		return "", false
	}
	positive := strings.TrimPrefix(text, "-")
	canonical, ok := purchases.ParseWeight(positive)
	if !ok || canonical != purchases.Weight(positive) {
		return "", false
	}
	if strings.HasPrefix(text, "-") && text != "-"+string(canonical) {
		return "", false
	}
	return text, true
}

// purchaseDocumentShape carries the header fields every published shape shares, so the
// detail, the creation answer and the counter-document are validated by one rule.
type purchaseHeader struct {
	ID                 int64
	LocationID         int
	Note               string
	Total              purchases.Money
	PaidCash           purchases.Money
	PaidTransfer       purchases.Money
	CreatedByAccountID int64
	CreatedAt          time.Time
	ReversesPurchaseID *int64
	ReversedBy         *int64
	Reason             string
}

// purchasePaid admits one paid side of the settlement: canonical text whose direction is the
// document's, and zero when that method did not pay. Zero has no sign, so a counter-document
// returns 0.00 in the method nobody used.
func purchasePaid(amount purchases.Money, counter bool) bool {
	text, ok := purchaseMoneyText(amount)
	if !ok {
		return false
	}
	negative := strings.HasPrefix(text, "-")
	if counter {
		return negative || text == "0.00"
	}
	return !negative
}

// purchaseSign matches the sign the domain publishes for one persisted amount.
func purchaseSign(amount purchases.Money, counter bool) bool {
	text, ok := purchaseMoneyText(amount)
	if !ok {
		return false
	}
	if counter {
		return strings.HasPrefix(text, "-")
	}
	return !strings.HasPrefix(text, "-")
}

// purchaseHeaderAdmitted admits only a complete persisted header: the branch, the account,
// the moment, the settlement, the sign rule and the reversal cross-references.
func purchaseHeaderAdmitted(header purchaseHeader) bool {
	if header.ID < 1 || header.LocationID < 2 || header.LocationID > math.MaxInt16 ||
		header.CreatedByAccountID < 1 || header.CreatedAt.IsZero() ||
		!purchaseText(header.Note) || utf8.RuneCountInString(header.Note) > purchases.MaxNote {
		return false
	}
	counter := header.ReversesPurchaseID != nil
	if !purchaseSign(header.Total, counter) || !purchasePaid(header.PaidCash, counter) ||
		!purchasePaid(header.PaidTransfer, counter) {
		return false
	}
	if counter {
		reason, ok := purchases.CanonicalReason(header.Reason)
		if !ok || reason != header.Reason || *header.ReversesPurchaseID < 1 ||
			*header.ReversesPurchaseID >= header.ID {
			return false
		}
	} else if header.Reason != "" {
		return false
	}
	// A document is only ever reversed by a later document, and a counter-document is never
	// reversed itself.
	if header.ReversedBy != nil && (*header.ReversedBy <= header.ID || counter) {
		return false
	}
	return true
}

// purchaseText admits the text of this contract: valid UTF-8 without a NUL.
func purchaseText(value string) bool {
	return utf8.ValidString(value) && !strings.ContainsRune(value, 0)
}

// purchaseSettles admits the settlement of one published document: the two paid amounts
// close against its own total, exactly.
func purchaseSettles(header purchaseHeader) bool {
	cash, ok := purchaseCents(header.PaidCash)
	if !ok {
		return false
	}
	transfer, ok := purchaseCents(header.PaidTransfer)
	if !ok {
		return false
	}
	total, ok := purchaseCents(header.Total)
	return ok && cash+transfer == total
}

// purchaseCents reads a published amount as integer cents, with its sign.
func purchaseCents(amount purchases.Money) (int64, bool) {
	text, ok := purchaseMoneyText(amount)
	if !ok {
		return 0, false
	}
	negative := strings.HasPrefix(text, "-")
	digits := strings.TrimPrefix(text, "-")
	whole, fraction, ok := strings.Cut(digits, ".")
	if !ok || len(fraction) != 2 || len(whole) < 1 || len(whole) > 10 {
		return 0, false
	}
	var value int64
	for _, ch := range whole + fraction {
		if ch < '0' || ch > '9' {
			return 0, false
		}
		value = value*10 + int64(ch-'0')
	}
	if negative {
		value = -value
	}
	return value, true
}

// purchaseUsedAmount is the exact amount of one published used line: the quantity times the
// price, so the wire never publishes a number the document does not add up to.
func purchaseUsedAmount(line purchases.UsedLine) (purchases.Money, bool) {
	price, ok := purchaseCents(line.UnitPrice)
	if !ok || price < 1 || line.Quantity == 0 ||
		line.Quantity > purchases.MaxQuantity || line.Quantity < -purchases.MaxQuantity {
		return "", false
	}
	return purchaseProduct(price, line.Quantity)
}

// purchaseScrapAmount is the amount of one published scrap line: the weight times the price
// per kilogram rounded half up to the cent, which is the domain's own rule.
func purchaseScrapAmount(line purchases.ScrapLine) (purchases.Money, bool) {
	weight, ok := purchaseMilli(line.Kg)
	if !ok || weight == 0 {
		return "", false
	}
	price, ok := purchaseCents(line.PricePerKg)
	if !ok || price < 1 {
		return "", false
	}
	magnitude := weight
	negative := magnitude < 0
	if negative {
		magnitude = -magnitude
	}
	if price > (maxPurchaseCents*1000)/magnitude {
		return "", false
	}
	rounded := (magnitude*price + 500) / 1000
	if negative {
		rounded = -rounded
	}
	return purchaseCentsText(rounded)
}

// maxPurchaseCents is the whole range of numeric(12,2) in cents, restated for the published
// shapes.
const maxPurchaseCents = int64(999_999_999_999)

// purchaseProduct multiplies a price by a whole quantity in integer cents, refusing an
// amount outside numeric(12,2) instead of wrapping it.
func purchaseProduct(cents, quantity int64) (purchases.Money, bool) {
	magnitude := quantity
	if magnitude < 0 {
		magnitude = -magnitude
	}
	if magnitude < 1 || cents < 1 || cents > maxPurchaseCents/magnitude {
		return "", false
	}
	total := cents * magnitude
	if quantity < 0 {
		total = -total
	}
	return purchaseCentsText(total)
}

// purchaseCentsText renders integer cents as the canonical amount this contract publishes.
func purchaseCentsText(cents int64) (purchases.Money, bool) {
	switch {
	case cents > maxPurchaseCents || cents < -maxPurchaseCents:
		return "", false
	case cents == 0:
		return "0.00", true
	}
	negative := cents < 0
	if negative {
		cents = -cents
	}
	text := strconv.FormatInt(cents/100, 10) + "." +
		string([]byte{byte('0' + (cents%100)/10), byte('0' + cents%10)})
	if negative {
		text = "-" + text
	}
	amount := purchases.Money(text)
	if _, ok := purchaseMoneyText(amount); !ok {
		return "", false
	}
	return amount, true
}

// purchaseMilli reads a published weight as integer thousandths, with its sign.
func purchaseMilli(weight purchases.Weight) (int64, bool) {
	text, ok := purchaseWeightText(weight)
	if !ok {
		return 0, false
	}
	negative := strings.HasPrefix(text, "-")
	digits := strings.TrimPrefix(text, "-")
	whole, fraction, ok := strings.Cut(digits, ".")
	if !ok || len(fraction) != 3 || len(whole) < 1 || len(whole) > 9 {
		return 0, false
	}
	var value int64
	for _, ch := range whole + fraction {
		if ch < '0' || ch > '9' {
			return 0, false
		}
		value = value*10 + int64(ch-'0')
	}
	if negative {
		value = -value
	}
	return value, true
}

type purchaseUsedLineDTO struct {
	Model     string `json:"model"`
	Quantity  int64  `json:"quantity"`
	UnitPrice string `json:"unit_price"`
	Amount    string `json:"amount"`
}

type purchaseScrapLineDTO struct {
	MaterialID int64  `json:"material_id"`
	Name       string `json:"name"`
	Kg         string `json:"kg"`
	PricePerKg string `json:"price_per_kg"`
	Amount     string `json:"amount"`
}

// purchaseDocumentDTO is the frozen document shape: the header, the used lines ordered by
// model code and the scrap lines ordered by material id.
type purchaseDocumentDTO struct {
	ID                 int64                  `json:"id"`
	LocationID         int                    `json:"location_id"`
	Note               string                 `json:"note"`
	Total              string                 `json:"total"`
	PaidCash           string                 `json:"paid_cash"`
	PaidTransfer       string                 `json:"paid_transfer"`
	CreatedByAccountID int64                  `json:"created_by_account_id"`
	CreatedAt          string                 `json:"created_at"`
	ReversesPurchaseID *int64                 `json:"reverses_purchase_id"`
	ReversedBy         *int64                 `json:"reversed_by"`
	Reason             string                 `json:"reason"`
	UsedLines          []purchaseUsedLineDTO  `json:"used_lines"`
	ScrapLines         []purchaseScrapLineDTO `json:"scrap_lines"`
}

// purchaseDocumentRecord admits only a complete persisted document: the header, both line
// kinds with their amounts re-derived, and the frozen order. Anything else is a stored shape
// this domain never wrote, so the answer fails closed instead of describing it.
func purchaseDocumentRecord(document purchases.Document) (purchaseDocumentDTO, error) {
	unavailable := func() (purchaseDocumentDTO, error) {
		return purchaseDocumentDTO{}, purchases.ErrUnavailable
	}
	header := purchaseHeader{ID: document.ID, LocationID: document.LocationID, Note: document.Note,
		Total: document.Total, PaidCash: document.PaidCash, PaidTransfer: document.PaidTransfer,
		CreatedByAccountID: document.CreatedByAccountID, CreatedAt: document.CreatedAt,
		ReversesPurchaseID: document.ReversesPurchaseID, ReversedBy: document.ReversedBy,
		Reason: document.Reason}
	if !purchaseHeaderAdmitted(header) || !purchaseSettles(header) {
		return unavailable()
	}
	counter := document.ReversesPurchaseID != nil
	if len(document.UsedLines)+len(document.ScrapLines) < 1 ||
		len(document.UsedLines) > purchases.MaxLines || len(document.ScrapLines) > purchases.MaxLines {
		return unavailable()
	}
	total, ok := purchaseMoneyText(document.Total)
	if !ok {
		return unavailable()
	}
	used := make([]purchaseUsedLineDTO, 0, len(document.UsedLines))
	var sum int64
	var previous string
	for _, line := range document.UsedLines {
		price, ok := purchaseMoneyText(line.UnitPrice)
		amount, derived := purchaseUsedAmount(line)
		amountText, publishes := purchaseMoneyText(line.Amount)
		model, canonical := purchases.CanonicalModel(line.Model)
		if !ok || !derived || !publishes || amount != line.Amount || !canonical ||
			model != line.Model || (line.Quantity > 0) == counter ||
			(len(used) > 0 && line.Model <= previous) {
			return unavailable()
		}
		previous = line.Model
		cents, _ := purchaseCents(line.Amount)
		sum += cents
		used = append(used, purchaseUsedLineDTO{Model: line.Model, Quantity: line.Quantity,
			UnitPrice: price, Amount: amountText})
	}
	scrap := make([]purchaseScrapLineDTO, 0, len(document.ScrapLines))
	var previousMaterial int64
	for _, line := range document.ScrapLines {
		price, ok := purchaseMoneyText(line.PricePerKg)
		kg, weight := purchaseWeightText(line.Kg)
		milli, read := purchaseMilli(line.Kg)
		amount, derived := purchaseScrapAmount(line)
		amountText, publishes := purchaseMoneyText(line.Amount)
		if !ok || !weight || !read || !derived || !publishes || amount != line.Amount ||
			line.MaterialID < 1 || line.MaterialID > math.MaxInt16 ||
			!purchaseText(line.Name) || line.Name == "" ||
			utf8.RuneCountInString(line.Name) > 200 ||
			(milli > 0) == counter || (len(scrap) > 0 && line.MaterialID <= previousMaterial) {
			return unavailable()
		}
		previousMaterial = line.MaterialID
		cents, _ := purchaseCents(line.Amount)
		sum += cents
		scrap = append(scrap, purchaseScrapLineDTO{MaterialID: line.MaterialID, Name: line.Name,
			Kg: kg, PricePerKg: price, Amount: amountText})
	}
	// The published total must equal the sum of the published lines, compared in integer
	// cents, and the settlement closes against it.
	persisted, ok := purchaseCents(document.Total)
	if !ok || sum != persisted {
		return unavailable()
	}
	cash, ok := purchaseMoneyText(document.PaidCash)
	if !ok {
		return unavailable()
	}
	transfer, ok := purchaseMoneyText(document.PaidTransfer)
	if !ok {
		return unavailable()
	}
	return purchaseDocumentDTO{
		ID:                 document.ID,
		LocationID:         document.LocationID,
		Note:               document.Note,
		Total:              total,
		PaidCash:           cash,
		PaidTransfer:       transfer,
		CreatedByAccountID: document.CreatedByAccountID,
		CreatedAt:          document.CreatedAt.UTC().Format(time.RFC3339),
		ReversesPurchaseID: document.ReversesPurchaseID,
		ReversedBy:         document.ReversedBy,
		Reason:             document.Reason,
		UsedLines:          used,
		ScrapLines:         scrap,
	}, nil
}

type purchaseSummaryDTO struct {
	ID                 int64  `json:"id"`
	CreatedAt          string `json:"created_at"`
	Total              string `json:"total"`
	ReversesPurchaseID *int64 `json:"reverses_purchase_id"`
	ReversedBy         *int64 `json:"reversed_by"`
	UsedUnits          int64  `json:"used_units"`
	ScrapLines         int    `json:"scrap_lines"`
}

type purchasePageDTO struct {
	Page           int                  `json:"page"`
	PageSize       int                  `json:"page_size"`
	TotalPurchases int64                `json:"total_purchases"`
	Purchases      []purchaseSummaryDTO `json:"purchases"`
}

// purchasePageRecord admits only a complete history page: the page fits inside the reported
// total, the rows are newest first and every header is the document's own.
func purchasePageRecord(page purchases.Page) (purchasePageDTO, error) {
	unavailable := func() (purchasePageDTO, error) {
		return purchasePageDTO{}, purchases.ErrUnavailable
	}
	if !purchases.ValidPage(page.Page, page.PageSize) || page.TotalPurchases < 0 ||
		len(page.Purchases) > page.PageSize ||
		// A page beyond the last one is legitimately empty; a page with rows must still fit
		// inside the reported total.
		(len(page.Purchases) > 0 &&
			int64(page.Page-1)*int64(page.PageSize)+int64(len(page.Purchases)) > page.TotalPurchases) {
		return unavailable()
	}
	rows := make([]purchaseSummaryDTO, 0, len(page.Purchases))
	previous := int64(math.MaxInt64)
	for _, summary := range page.Purchases {
		total, ok := purchaseMoneyText(summary.Total)
		counter := summary.ReversesPurchaseID != nil
		if summary.ID < 1 || summary.ID >= previous || summary.CreatedAt.IsZero() || !ok ||
			!purchaseSign(summary.Total, counter) ||
			summary.ScrapLines < 0 || summary.ScrapLines > purchases.MaxLines ||
			summary.UsedUnits > purchases.MaxLines*purchases.MaxQuantity ||
			summary.UsedUnits < -(purchases.MaxLines*purchases.MaxQuantity) ||
			// The used total follows the document's direction — never negative on an
			// original, never positive on a counter-document — and a document always
			// carries at least one line between the two kinds. A scrap-only purchase is
			// legal and carries zero used units, exactly like the contract admits.
			(counter && summary.UsedUnits > 0) || (!counter && summary.UsedUnits < 0) ||
			(summary.UsedUnits == 0 && summary.ScrapLines == 0) ||
			(counter && (*summary.ReversesPurchaseID < 1 ||
				*summary.ReversesPurchaseID >= summary.ID)) ||
			(summary.ReversedBy != nil && (*summary.ReversedBy <= summary.ID || counter)) {
			return unavailable()
		}
		previous = summary.ID
		rows = append(rows, purchaseSummaryDTO{ID: summary.ID,
			CreatedAt:          summary.CreatedAt.UTC().Format(time.RFC3339),
			Total:              total,
			ReversesPurchaseID: summary.ReversesPurchaseID,
			ReversedBy:         summary.ReversedBy,
			UsedUnits:          summary.UsedUnits,
			ScrapLines:         summary.ScrapLines})
	}
	return purchasePageDTO{Page: page.Page, PageSize: page.PageSize,
		TotalPurchases: page.TotalPurchases, Purchases: rows}, nil
}

type purchaseModelsDTO struct {
	Models []string `json:"models"`
}

// purchaseModelsRecord publishes the catalogue's own list: ascending, deduplicated and never
// null, so an empty catalogue is an empty array.
func purchaseModelsRecord(models []string) (purchaseModelsDTO, error) {
	records := make([]string, 0, len(models))
	for _, model := range models {
		if model == "" || !purchaseText(model) || utf8.RuneCountInString(model) > 200 ||
			(len(records) > 0 && model <= records[len(records)-1]) {
			return purchaseModelsDTO{}, purchases.ErrUnavailable
		}
		records = append(records, model)
	}
	return purchaseModelsDTO{Models: records}, nil
}

type purchaseMaterialDTO struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

type purchaseMaterialsDTO struct {
	Materials []purchaseMaterialDTO `json:"materials"`
}

// purchaseMaterialsRecord publishes the reference data ordered by id.
func purchaseMaterialsRecord(materials []purchases.Material) (purchaseMaterialsDTO, error) {
	records := make([]purchaseMaterialDTO, 0, len(materials))
	for _, material := range materials {
		if material.ID < 1 || material.ID > math.MaxInt16 || !purchaseText(material.Name) ||
			strings.TrimSpace(material.Name) == "" ||
			utf8.RuneCountInString(material.Name) > 200 ||
			(len(records) > 0 && material.ID <= records[len(records)-1].ID) {
			return purchaseMaterialsDTO{}, purchases.ErrUnavailable
		}
		records = append(records, purchaseMaterialDTO{ID: material.ID, Name: material.Name})
	}
	return purchaseMaterialsDTO{Materials: records}, nil
}

type purchaseModelPriceDTO struct {
	Model       string `json:"model"`
	UnitPrice   string `json:"unit_price"`
	PurchasedAt string `json:"purchased_at"`
}

type purchaseMaterialPriceDTO struct {
	MaterialID  int64  `json:"material_id"`
	PricePerKg  string `json:"price_per_kg"`
	PurchasedAt string `json:"purchased_at"`
}

type purchaseLastPricesDTO struct {
	Models    []purchaseModelPriceDTO    `json:"models"`
	Materials []purchaseMaterialPriceDTO `json:"materials"`
}

// purchaseLastPricesRecord publishes the anchor of each input, ordered by model code and by
// material id, and never a price that is not above zero.
func purchaseLastPricesRecord(prices purchases.LastPrices) (purchaseLastPricesDTO, error) {
	unavailable := func() (purchaseLastPricesDTO, error) {
		return purchaseLastPricesDTO{}, purchases.ErrUnavailable
	}
	models := make([]purchaseModelPriceDTO, 0, len(prices.Models))
	for _, price := range prices.Models {
		unit, ok := purchaseMoneyText(price.UnitPrice)
		canonical, modelOK := purchases.CanonicalModel(price.Model)
		if !ok || !modelOK || canonical != price.Model || price.UnitPrice == "0.00" ||
			price.PurchasedAt.IsZero() ||
			(len(models) > 0 && price.Model <= models[len(models)-1].Model) {
			return unavailable()
		}
		models = append(models, purchaseModelPriceDTO{Model: price.Model, UnitPrice: unit,
			PurchasedAt: price.PurchasedAt.UTC().Format(time.RFC3339)})
	}
	materials := make([]purchaseMaterialPriceDTO, 0, len(prices.Materials))
	for _, price := range prices.Materials {
		unit, ok := purchaseMoneyText(price.PricePerKg)
		if !ok || price.PricePerKg == "0.00" || price.PurchasedAt.IsZero() ||
			price.MaterialID < 1 || price.MaterialID > math.MaxInt16 ||
			(len(materials) > 0 && price.MaterialID <= materials[len(materials)-1].MaterialID) {
			return unavailable()
		}
		materials = append(materials, purchaseMaterialPriceDTO{MaterialID: price.MaterialID,
			PricePerKg: unit, PurchasedAt: price.PurchasedAt.UTC().Format(time.RFC3339)})
	}
	return purchaseLastPricesDTO{Models: models, Materials: materials}, nil
}

type purchaseReceivedUsedDTO struct {
	Model    string `json:"model"`
	Quantity int64  `json:"quantity"`
	Value    string `json:"value"`
}

type purchaseReceivedScrapDTO struct {
	MaterialID int64  `json:"material_id"`
	Name       string `json:"name"`
	Kg         string `json:"kg"`
	Value      string `json:"value"`
}

type purchaseReceivedDTO struct {
	Used  []purchaseReceivedUsedDTO  `json:"used"`
	Scrap []purchaseReceivedScrapDTO `json:"scrap"`
}

// purchaseReceivedRecord publishes what the branch received, with the money it spent: rows
// netted to zero are never a row of this answer, and a value is never negative.
func purchaseReceivedRecord(received purchases.Received) (purchaseReceivedDTO, error) {
	unavailable := func() (purchaseReceivedDTO, error) {
		return purchaseReceivedDTO{}, purchases.ErrUnavailable
	}
	used := make([]purchaseReceivedUsedDTO, 0, len(received.Used))
	for _, row := range received.Used {
		value, ok := purchaseCents(row.Value)
		if !ok || value < 1 || row.Quantity < 1 ||
			row.Quantity > purchases.MaxLines*purchases.MaxQuantity ||
			!purchaseText(row.Model) || row.Model == "" ||
			utf8.RuneCountInString(row.Model) > 200 ||
			(len(used) > 0 && row.Model <= used[len(used)-1].Model) {
			return unavailable()
		}
		text, _ := purchaseMoneyText(row.Value)
		used = append(used, purchaseReceivedUsedDTO{Model: row.Model, Quantity: row.Quantity,
			Value: text})
	}
	scrap := make([]purchaseReceivedScrapDTO, 0, len(received.Scrap))
	for _, row := range received.Scrap {
		value, ok := purchaseCents(row.Value)
		kg, weight := purchaseWeightText(row.Kg)
		if !ok || value < 0 || !weight || row.MaterialID < 1 || row.MaterialID > math.MaxInt16 ||
			!purchaseText(row.Name) || row.Name == "" ||
			utf8.RuneCountInString(row.Name) > 200 ||
			strings.HasPrefix(kg, "-") ||
			(len(scrap) > 0 && row.MaterialID <= scrap[len(scrap)-1].MaterialID) {
			return unavailable()
		}
		text, _ := purchaseMoneyText(row.Value)
		scrap = append(scrap, purchaseReceivedScrapDTO{MaterialID: row.MaterialID, Name: row.Name,
			Kg: kg, Value: text})
	}
	return purchaseReceivedDTO{Used: used, Scrap: scrap}, nil
}

// purchaseDocumentID reads the document id of one path segment. A segment that is not a
// canonical positive integer is not a document path at all, so it is not found exactly like
// an unknown document.
func purchaseDocumentID(r *http.Request) (int64, bool) {
	id, err := canonicalAdjustmentInteger(r.PathValue("id"), math.MaxInt64)
	return id, err == nil
}

// purchases serves the branch collection: the newest-first history read and the creation of
// one immutable purchase document. The guard order is the house one: method, identity,
// same-origin, CSRF, and only then the body.
func (a *API) purchases(store *purchases.Store) http.HandlerFunc {
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
			page, pageSize, err := purchasePageQuery(r.URL.RawQuery)
			if err != nil {
				purchaseFailure(w, err)
				return
			}
			result, err := store.List(r.Context(), actor, page, pageSize)
			if err != nil {
				purchaseFailure(w, err)
				return
			}
			record, err := purchasePageRecord(result)
			if err != nil {
				purchaseFailure(w, err)
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
		in, err := decodePurchase(r)
		if err != nil {
			purchaseFailure(w, err)
			return
		}
		document, err := store.Create(r.Context(), actor, in)
		if err != nil {
			purchaseFailure(w, err)
			return
		}
		record, err := purchaseDocumentRecord(document)
		if err != nil {
			purchaseFailure(w, err)
			return
		}
		// The contract answers 201 for the created document and for an identical replay of
		// the same operation key: the answer is the persisted document either way.
		respond(w, 201, record)
	}
}

// purchaseDetail serves the per-document read: the persisted document exactly as creation
// answers it. A document of another branch is not found, and an ambiguous path never gets
// here.
func (a *API) purchaseDetail(store *purchases.Store) http.HandlerFunc {
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
		id, ok := purchaseDocumentID(r)
		if !ok {
			failure(w, 404, "not_found")
			return
		}
		document, err := store.Detail(r.Context(), actor, id)
		if err != nil {
			purchaseFailure(w, err)
			return
		}
		record, err := purchaseDocumentRecord(document)
		if err != nil {
			purchaseFailure(w, err)
			return
		}
		respond(w, 200, record)
	}
}

// purchaseReverse serves the counter-document contract. The target is in the path, the body
// is only the operation key and the mandatory reason, and every line is derived by the store
// from the persisted original.
func (a *API) purchaseReverse(store *purchases.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodPost) {
			return
		}
		actor, ok := a.inventoryIdentity(w, r)
		if !ok {
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
		// An unknown or impossible target is not found, never a malformed request: the
		// contract answers 404 for a document that is not there.
		id, ok := purchaseDocumentID(r)
		if !ok {
			failure(w, 404, "not_found")
			return
		}
		operationKey, reason, err := decodePurchaseReversal(r)
		if err != nil {
			purchaseFailure(w, err)
			return
		}
		document, err := store.Reverse(r.Context(), actor, id, operationKey, reason)
		if err != nil {
			purchaseFailure(w, err)
			return
		}
		record, err := purchaseDocumentRecord(document)
		if err != nil {
			purchaseFailure(w, err)
			return
		}
		respond(w, 201, record)
	}
}

// purchaseModels serves the catalogue's own model list, deduplicated across brands.
func (a *API) purchaseModels(store *purchases.Store) http.HandlerFunc {
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
		models, err := store.Models(r.Context(), actor)
		if err != nil {
			purchaseFailure(w, err)
			return
		}
		record, err := purchaseModelsRecord(models)
		if err != nil {
			purchaseFailure(w, err)
			return
		}
		respond(w, 200, record)
	}
}

// purchaseMaterials serves the reference materials, all weighed in kilograms.
func (a *API) purchaseMaterials(store *purchases.Store) http.HandlerFunc {
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
		materials, err := store.Materials(r.Context(), actor)
		if err != nil {
			purchaseFailure(w, err)
			return
		}
		record, err := purchaseMaterialsRecord(materials)
		if err != nil {
			purchaseFailure(w, err)
			return
		}
		respond(w, 200, record)
	}
}

// purchaseLastPrices serves the anchor the counter shows next to each input.
func (a *API) purchaseLastPrices(store *purchases.Store) http.HandlerFunc {
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
		prices, err := store.LastPrices(r.Context(), actor)
		if err != nil {
			purchaseFailure(w, err)
			return
		}
		record, err := purchaseLastPricesRecord(prices)
		if err != nil {
			purchaseFailure(w, err)
			return
		}
		respond(w, 200, record)
	}
}

// purchaseReceived serves what the branch received, derived from every persisted document.
func (a *API) purchaseReceived(store *purchases.Store) http.HandlerFunc {
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
		received, err := store.Received(r.Context(), actor)
		if err != nil {
			purchaseFailure(w, err)
			return
		}
		record, err := purchaseReceivedRecord(received)
		if err != nil {
			purchaseFailure(w, err)
			return
		}
		respond(w, 200, record)
	}
}
