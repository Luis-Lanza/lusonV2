package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"luson/api/internal/catalog"
	"luson/api/internal/stockadjustments"
)

// stockAdjustmentBodyLimit bounds decoding work well below any admitted payload:
// 190 lines of maximum variant/counted plus a 500-character reason and detail.
const stockAdjustmentBodyLimit = 16 << 10

const (
	// stockAdjustmentMaxLines, stockAdjustmentMaxCounted, stockAdjustmentMaxReason
	// and stockAdjustmentMaxDetail are the document bounds, restated here so an
	// inadmissible request never reaches the store and a history row never
	// advertises a document this domain could not have written.
	stockAdjustmentMaxLines   = 190
	stockAdjustmentMaxCounted = 1_000_000
	stockAdjustmentMaxReason  = 500
	stockAdjustmentMaxDetail  = 500
	stockAdjustmentMaxSearch  = 128
	// A single line can only add stockAdjustmentMaxCounted and can only subtract an
	// existing balance, so a total beyond this bound is not this ledger's.
	stockAdjustmentMaxTotal = stockAdjustmentMaxLines * stockAdjustmentMaxCounted
)

// stockAdjustmentPathSafety refuses an ambiguous adjustment path before compose can
// set its response headers, so the two unconditional headers are repeated here.
func stockAdjustmentPathSafety(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if !stockAdjustmentPath(r) {
			failure(w, 404, "not_found")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// stockAdjustmentPath refuses ambiguous adjustment paths before ServeMux can clean
// or redirect them, exactly like the ingress and transfer routes: a doubled slash,
// a dot segment, a backslash, a NUL or an encoded alias is not_found, never a
// silent redirect to a different document.
func stockAdjustmentPath(r *http.Request) bool {
	p := r.URL.Path
	if p != "/api/stock-adjustments" && !strings.HasPrefix(p, "/api/stock-adjustments/") {
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

// stockAdjustmentFailure publishes the domain's own decision and nothing else.
func stockAdjustmentFailure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, stockadjustments.ErrInvalid):
		failure(w, 400, "invalid_request")
	case errors.Is(err, stockadjustments.ErrForbidden):
		failure(w, 403, "forbidden")
	case errors.Is(err, stockadjustments.ErrNotFound):
		failure(w, 404, "not_found")
	case errors.Is(err, stockadjustments.ErrDecisionConflict):
		failure(w, 409, "decision_conflict")
	case errors.Is(err, stockadjustments.ErrInsufficientStock):
		failure(w, 409, "insufficient_stock")
	case errors.Is(err, stockadjustments.ErrRetryConflict):
		failure(w, 409, "retry_conflict")
	default:
		failure(w, 503, "service_unavailable")
	}
}

// The transfer helpers below are the same strict token readers used by
// POST /api/transfers; only the domain error is restated.
func adjustmentString(d *json.Decoder) (string, error) {
	if value, err := transferString(d); err == nil {
		return value, nil
	}
	return "", stockadjustments.ErrInvalid
}

func adjustmentDelimiter(d *json.Decoder, want json.Delim) bool {
	return transferDelimiter(d, want)
}

// canonicalAdjustmentInteger is the transfer query's strict reader: decimal
// digits only, no sign, no padding, no fraction and a hard upper bound.
func canonicalAdjustmentInteger(value string, max int64) (int64, error) {
	if len(value) == 0 || len(value) > 19 || value[0] < '1' || value[0] > '9' {
		return 0, stockadjustments.ErrInvalid
	}
	for _, c := range value {
		if c < '0' || c > '9' {
			return 0, stockadjustments.ErrInvalid
		}
	}
	n, err := strconv.ParseInt(value, 10, 64)
	if err != nil || n > max {
		return 0, stockadjustments.ErrInvalid
	}
	return n, nil
}

func adjustmentNumber(d *json.Decoder, max int64) (int64, error) {
	token, err := d.Token()
	if err != nil {
		return 0, stockadjustments.ErrInvalid
	}
	number, ok := token.(json.Number)
	if !ok {
		return 0, stockadjustments.ErrInvalid
	}
	return canonicalAdjustmentInteger(string(number), max)
}

// adjustmentCounted admits the counted quantity: zero is a legitimate result of a
// physical count, while a negative, padded or differently typed value is never a
// promise the client may make.
func adjustmentCounted(d *json.Decoder) (int64, error) {
	token, err := d.Token()
	if err != nil {
		return 0, stockadjustments.ErrInvalid
	}
	number, ok := token.(json.Number)
	if !ok {
		return 0, stockadjustments.ErrInvalid
	}
	if value := string(number); value == "0" {
		return 0, nil
	}
	return canonicalAdjustmentInteger(string(number), stockAdjustmentMaxCounted)
}

// adjustmentLines reads the counted lines: exact names, presence, types and
// duplicate keys are enforced at every object level, and the expected quantity and
// the difference are not part of this contract at all.
func adjustmentLines(d *json.Decoder) ([]stockadjustments.Line, error) {
	if !adjustmentDelimiter(d, '[') {
		return nil, stockadjustments.ErrInvalid
	}
	lines := make([]stockadjustments.Line, 0)
	for d.More() {
		if len(lines) >= stockAdjustmentMaxLines || !adjustmentDelimiter(d, '{') {
			return nil, stockadjustments.ErrInvalid
		}
		var line stockadjustments.Line
		seen := map[string]bool{}
		for d.More() {
			key, err := adjustmentString(d)
			if err != nil || seen[key] {
				return nil, stockadjustments.ErrInvalid
			}
			seen[key] = true
			switch key {
			case "variant_id":
				line.VariantID, err = adjustmentNumber(d, math.MaxInt32)
			case "counted_quantity":
				line.Counted, err = adjustmentCounted(d)
			default:
				return nil, stockadjustments.ErrInvalid
			}
			if err != nil {
				return nil, stockadjustments.ErrInvalid
			}
		}
		if len(seen) != 2 || !adjustmentDelimiter(d, '}') {
			return nil, stockadjustments.ErrInvalid
		}
		lines = append(lines, line)
	}
	if len(lines) == 0 || !adjustmentDelimiter(d, ']') {
		return nil, stockadjustments.ErrInvalid
	}
	return lines, nil
}

// decodeStockAdjustment reads tokens rather than structs: exact names, presence,
// types and duplicate keys (including escaped-equivalent keys) are enforced at
// every object level, and the terminal EOF rejects trailing input. The client
// supplies counted quantities only; expected, difference and location are not part
// of the body at all, so a blinded count cannot even be expressed.
func decodeStockAdjustment(r *http.Request) (stockadjustments.CreateInput, error) {
	var in stockadjustments.CreateInput
	if r == nil || r.Body == nil || len(r.Header.Values("Content-Type")) != 1 {
		return in, stockadjustments.ErrInvalid
	}
	contentType := r.Header.Get("Content-Type")
	media, params, err := mime.ParseMediaType(contentType)
	// MIME parsing collapses identical duplicate parameters and admits a
	// trailing separator; neither is an unambiguous framing here.
	if err != nil || media != "application/json" || len(params) > 1 || strings.Count(contentType, ";") != len(params) {
		return in, stockadjustments.ErrInvalid
	}
	for key, value := range params {
		if key != "charset" || !strings.EqualFold(value, "utf-8") {
			return in, stockadjustments.ErrInvalid
		}
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, stockAdjustmentBodyLimit+1))
	if err != nil || len(body) > stockAdjustmentBodyLimit || !utf8.Valid(body) {
		return in, stockadjustments.ErrInvalid
	}
	d := json.NewDecoder(bytes.NewReader(body))
	d.UseNumber()
	if !adjustmentDelimiter(d, '{') {
		return in, stockadjustments.ErrInvalid
	}
	seen := map[string]bool{}
	for d.More() {
		key, err := adjustmentString(d)
		if err != nil || seen[key] {
			return stockadjustments.CreateInput{}, stockadjustments.ErrInvalid
		}
		seen[key] = true
		switch key {
		case "operation_key":
			in.OperationKey, err = adjustmentString(d)
		case "reason":
			in.Reason, err = adjustmentString(d)
		case "detail":
			in.Detail, err = adjustmentString(d)
		case "lines":
			in.Lines, err = adjustmentLines(d)
		default:
			return stockadjustments.CreateInput{}, stockadjustments.ErrInvalid
		}
		if err != nil {
			return stockadjustments.CreateInput{}, stockadjustments.ErrInvalid
		}
	}
	if !seen["operation_key"] || !seen["reason"] || !seen["lines"] || len(seen) > 4 || !adjustmentDelimiter(d, '}') {
		return stockadjustments.CreateInput{}, stockadjustments.ErrInvalid
	}
	if _, err := d.Token(); err != io.EOF {
		return stockadjustments.CreateInput{}, stockadjustments.ErrInvalid
	}
	// Actor, location, reason, detail and line bounds are revalidated by the store
	// with the authenticated identity, so nothing below derives authority from
	// JSON. The key shape is checked here as well, exactly like a transfer retry key.
	if !stockadjustments.ValidOperationKey(in.OperationKey) {
		return stockadjustments.CreateInput{}, stockadjustments.ErrInvalid
	}
	variants := make(map[int64]bool, len(in.Lines))
	for _, line := range in.Lines {
		if variants[line.VariantID] {
			return stockadjustments.CreateInput{}, stockadjustments.ErrInvalid
		}
		variants[line.VariantID] = true
	}
	return in, nil
}

// decodeStockAdjustmentReversal reads exactly the two admitted tokens of the
// counter-entry contract: the operation key and the mandatory reason. Lines,
// quantities and the target are never accepted from the client, so a partial or
// invented reversal cannot even be expressed. The canonical reason is computed
// once here and revalidated by the store.
func decodeStockAdjustmentReversal(r *http.Request) (string, string, error) {
	if r == nil || r.Body == nil || len(r.Header.Values("Content-Type")) != 1 {
		return "", "", stockadjustments.ErrInvalid
	}
	contentType := r.Header.Get("Content-Type")
	media, params, err := mime.ParseMediaType(contentType)
	if err != nil || media != "application/json" || len(params) > 1 || strings.Count(contentType, ";") != len(params) {
		return "", "", stockadjustments.ErrInvalid
	}
	for key, value := range params {
		if key != "charset" || !strings.EqualFold(value, "utf-8") {
			return "", "", stockadjustments.ErrInvalid
		}
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, stockAdjustmentBodyLimit+1))
	if err != nil || len(body) > stockAdjustmentBodyLimit || !utf8.Valid(body) {
		return "", "", stockadjustments.ErrInvalid
	}
	d := json.NewDecoder(bytes.NewReader(body))
	d.UseNumber()
	if !adjustmentDelimiter(d, '{') {
		return "", "", stockadjustments.ErrInvalid
	}
	var operationKey, reason string
	seen := map[string]bool{}
	for d.More() {
		key, err := adjustmentString(d)
		if err != nil || seen[key] {
			return "", "", stockadjustments.ErrInvalid
		}
		seen[key] = true
		switch key {
		case "operation_key":
			operationKey, err = adjustmentString(d)
		case "reason":
			reason, err = adjustmentString(d)
		default:
			return "", "", stockadjustments.ErrInvalid
		}
		if err != nil {
			return "", "", stockadjustments.ErrInvalid
		}
	}
	if !seen["operation_key"] || !seen["reason"] || !adjustmentDelimiter(d, '}') {
		return "", "", stockadjustments.ErrInvalid
	}
	if _, err := d.Token(); err != io.EOF {
		return "", "", stockadjustments.ErrInvalid
	}
	canonicalReason, valid := stockadjustments.CanonicalReason(reason)
	if !stockadjustments.ValidOperationKey(operationKey) || !valid {
		return "", "", stockadjustments.ErrInvalid
	}
	return operationKey, canonicalReason, nil
}

// stockAdjustmentQueryValue keeps the raw and the decoded spelling of one query
// parameter: the numeric parameters are admitted only in their canonical raw form,
// while the free-text catalogue filters need their decoded text.
type stockAdjustmentQueryValue struct{ raw, decoded string }

// stockAdjustmentQueryValues splits a query string once per parameter, so repeated
// keys, empty sections, missing separators, empty values and malformed escapes are
// rejections, never defaults.
func stockAdjustmentQueryValues(raw string) (map[string]stockAdjustmentQueryValue, error) {
	values := make(map[string]stockAdjustmentQueryValue)
	if raw == "" {
		return values, nil
	}
	if len(raw) > 4096 {
		return nil, stockadjustments.ErrInvalid
	}
	for _, part := range strings.Split(raw, "&") {
		key, value, ok := strings.Cut(part, "=")
		if !ok || key == "" || value == "" {
			return nil, stockadjustments.ErrInvalid
		}
		if _, exists := values[key]; exists {
			return nil, stockadjustments.ErrInvalid
		}
		decoded, err := url.QueryUnescape(value)
		if err != nil || !utf8.ValidString(decoded) || strings.ContainsRune(decoded, 0) {
			return nil, stockadjustments.ErrInvalid
		}
		values[key] = stockAdjustmentQueryValue{raw: value, decoded: decoded}
	}
	return values, nil
}

// stockAdjustmentQuery reads the frozen history query: only page and page_size,
// each exactly once, as a canonical integer. Order is irrelevant; duplicates, empty
// values, unknown keys and encoding aliases are rejections, never defaults.
func stockAdjustmentQuery(raw string) (page, pageSize int, err error) {
	page, pageSize = 1, stockadjustments.DefaultPageSize
	values, err := stockAdjustmentQueryValues(raw)
	if err != nil {
		return 0, 0, stockadjustments.ErrInvalid
	}
	for key, value := range values {
		var n int64
		var read error
		switch key {
		case "page":
			n, read = canonicalAdjustmentInteger(value.raw, stockadjustments.MaxPage)
			page = int(n)
		case "page_size":
			n, read = canonicalAdjustmentInteger(value.raw, 50)
			pageSize = int(n)
			if n != 10 && n != stockadjustments.DefaultPageSize && n != 50 {
				read = stockadjustments.ErrInvalid
			}
		default:
			return 0, 0, stockadjustments.ErrInvalid
		}
		if read != nil {
			return 0, 0, stockadjustments.ErrInvalid
		}
	}
	if !stockadjustments.ValidPage(page, pageSize) {
		return 0, 0, stockadjustments.ErrInvalid
	}
	return page, pageSize, nil
}

// stockAdjustmentCatalogQuery reads the blind capture query: the page of the same
// frozen contract, a literal search and the two exact filters. The numeric
// parameters stay canonical on their raw spelling; only the free text is decoded,
// so a percent-encoded digit is still not an id.
func stockAdjustmentCatalogQuery(raw string) (stockadjustments.CatalogQuery, error) {
	query := stockadjustments.CatalogQuery{Page: 1, PageSize: stockadjustments.DefaultPageSize}
	values, err := stockAdjustmentQueryValues(raw)
	if err != nil {
		return query, stockadjustments.ErrInvalid
	}
	for key, value := range values {
		switch key {
		case "search":
			if len(value.decoded) > stockAdjustmentMaxSearch {
				return query, stockadjustments.ErrInvalid
			}
			query.Search = value.decoded
		case "brand":
			if len(value.decoded) > stockAdjustmentMaxSearch {
				return query, stockadjustments.ErrInvalid
			}
			query.Brand = value.decoded
		case "polarity":
			if value.decoded != "L" && value.decoded != "R" {
				return query, stockadjustments.ErrInvalid
			}
			query.Polarity = value.decoded
		case "page":
			n, err := canonicalAdjustmentInteger(value.raw, stockadjustments.MaxPage)
			if err != nil {
				return query, stockadjustments.ErrInvalid
			}
			query.Page = int(n)
		case "page_size":
			n, err := canonicalAdjustmentInteger(value.raw, 50)
			if err != nil {
				return query, stockadjustments.ErrInvalid
			}
			query.PageSize = int(n)
			if n != 10 && n != stockadjustments.DefaultPageSize && n != 50 {
				return query, stockadjustments.ErrInvalid
			}
		default:
			return query, stockadjustments.ErrInvalid
		}
	}
	if !stockadjustments.ValidPage(query.Page, query.PageSize) {
		return query, stockadjustments.ErrInvalid
	}
	return query, nil
}

type stockAdjustmentLineDTO struct {
	VariantID  int64 `json:"variant_id"`
	Expected   int64 `json:"expected_quantity"`
	Counted    int64 `json:"counted_quantity"`
	Difference int64 `json:"difference"`
}

// stockAdjustmentDTO is the frozen created and counter-entry document: the header,
// the persisted expected snapshot and counted quantity of every line and the exact
// applied difference. No operation key, no stored column outside this shape.
type stockAdjustmentDTO struct {
	ID                   int64                    `json:"id"`
	LocationID           int                      `json:"location_id"`
	Reason               string                   `json:"reason"`
	Detail               string                   `json:"detail"`
	CreatedByAccountID   int64                    `json:"created_by_account_id"`
	CreatedAt            string                   `json:"created_at"`
	ReversesAdjustmentID *int64                   `json:"reverses_adjustment_id"`
	Lines                []stockAdjustmentLineDTO `json:"lines"`
	TotalDifference      int64                    `json:"total_difference"`
}

type stockAdjustmentDetailLineDTO struct {
	VariantID      int64  `json:"variant_id"`
	CatalogEntryID int64  `json:"catalog_entry_id"`
	Brand          string `json:"brand"`
	Model          string `json:"model"`
	// Capacity is the inventory read's canonical rendering of capacity_ah as the
	// frozen detail contract spells it: the exact decimal text, never a binary float.
	Capacity   string `json:"capacity_ah"`
	Polarity   string `json:"polarity"`
	Expected   int64  `json:"expected_quantity"`
	Counted    int64  `json:"counted_quantity"`
	Difference int64  `json:"difference"`
}

// stockAdjustmentDetailDTO is the frozen per-document detail: the header, the
// catalogue identity of every line together with its expected, counted and applied
// difference, and the reversal cross-references. ReversedByReason is the motive of
// the counter-entry named by ReversedBy, so a reversed document is described by one
// response instead of a second read.
type stockAdjustmentDetailDTO struct {
	ID                   int64                          `json:"id"`
	LocationID           int                            `json:"location_id"`
	Reason               string                         `json:"reason"`
	Detail               string                         `json:"detail"`
	CreatedAt            string                         `json:"created_at"`
	CreatedByAccountID   int64                          `json:"created_by_account_id"`
	ReversesAdjustmentID *int64                         `json:"reverses_adjustment_id"`
	ReversedBy           *int64                         `json:"reversed_by"`
	ReversedByReason     string                         `json:"reversed_by_reason"`
	Lines                []stockAdjustmentDetailLineDTO `json:"lines"`
	TotalDifference      int64                          `json:"total_difference"`
}

type stockAdjustmentSummaryDTO struct {
	ID                   int64  `json:"id"`
	Reason               string `json:"reason"`
	Detail               string `json:"detail"`
	CreatedAt            string `json:"created_at"`
	Lines                int    `json:"lines"`
	TotalDifference      int64  `json:"total_difference"`
	ReversesAdjustmentID *int64 `json:"reverses_adjustment_id"`
	ReversedBy           *int64 `json:"reversed_by"`
}

type stockAdjustmentPageDTO struct {
	Page             int                         `json:"page"`
	PageSize         int                         `json:"page_size"`
	TotalAdjustments int64                       `json:"total_adjustments"`
	Adjustments      []stockAdjustmentSummaryDTO `json:"adjustments"`
}

// stockAdjustmentCatalogItemDTO is the catalogue identity of one variant. It has no
// stock field at all, so the blind capture cannot reveal the expected quantity, the
// difference or any other stock number.
type stockAdjustmentCatalogItemDTO struct {
	VariantID      int64  `json:"variant_id"`
	CatalogEntryID int64  `json:"catalog_entry_id"`
	Brand          string `json:"brand"`
	Model          string `json:"model"`
	Capacity       string `json:"capacity_ah"`
	Polarity       string `json:"polarity"`
}

type stockAdjustmentCatalogDTO struct {
	Page          int                             `json:"page"`
	PageSize      int                             `json:"page_size"`
	TotalVariants int64                           `json:"total_variants"`
	Items         []stockAdjustmentCatalogItemDTO `json:"items"`
}

// stockAdjustmentMotive admits only the canonical mandatory motive the store
// persists: valid UTF-8, no NUL, at most 500 characters and never blank trimmed.
func stockAdjustmentMotive(reason string) bool {
	canonical, valid := stockadjustments.CanonicalReason(reason)
	return valid && canonical == reason
}

// validStockAdjustmentDetail is the optional detail bound, persisted verbatim.
func validStockAdjustmentDetail(detail string) bool {
	return utf8.ValidString(detail) && !strings.ContainsRune(detail, 0) &&
		utf8.RuneCountInString(detail) <= stockAdjustmentMaxDetail
}

// validStockAdjustmentCatalogueText is the catalogue identity bound of a line: the
// brand and the model are persisted non-empty text, so a blank, NUL or malformed
// one never reaches the wire.
func validStockAdjustmentCatalogueText(value string) bool {
	return value != "" && utf8.ValidString(value) && !strings.ContainsRune(value, 0)
}

// stockAdjustmentDifference sums exactly: a total that leaves int64 is a stored
// shape this domain never wrote.
func stockAdjustmentDifference(total, difference int64) (int64, error) {
	if (difference > 0 && total > math.MaxInt64-difference) || (difference < 0 && total < math.MinInt64-difference) {
		return 0, stockadjustments.ErrUnavailable
	}
	return total + difference, nil
}

// stockAdjustmentReference admits a cross-reference into this warehouse's own
// ledger. A reversal always points at a strictly earlier document, while the
// counter-entry that reverses a document is always a strictly later one.
func stockAdjustmentReference(id *int64, documentID int64, later bool) (*int64, bool) {
	if id == nil {
		return nil, true
	}
	if *id < 1 || (!later && *id >= documentID) || (later && *id <= documentID) {
		return nil, false
	}
	value := *id
	return &value, true
}

// stockAdjustmentRecord admits only a complete persisted document: lines are
// canonical and variant-ordered, the expected snapshot is the database's own
// non-negative value, the difference is derived from expected and counted, and the
// total is the exact signed sum. Anything else is a stored shape this domain never
// wrote.
func stockAdjustmentRecord(adjustment stockadjustments.Adjustment) (stockAdjustmentDTO, error) {
	unavailable := func() (stockAdjustmentDTO, error) {
		return stockAdjustmentDTO{}, stockadjustments.ErrUnavailable
	}
	if adjustment.ID < 1 || adjustment.LocationID != 1 || adjustment.CreatedByAccountID < 1 ||
		adjustment.CreatedAt.IsZero() || len(adjustment.Lines) == 0 ||
		len(adjustment.Lines) > stockAdjustmentMaxLines || !stockAdjustmentMotive(adjustment.Reason) ||
		!validStockAdjustmentDetail(adjustment.Detail) {
		return unavailable()
	}
	reverses, ok := stockAdjustmentReference(adjustment.ReversesAdjustmentID, adjustment.ID, false)
	if !ok {
		return unavailable()
	}
	lines := make([]stockAdjustmentLineDTO, 0, len(adjustment.Lines))
	var previous, total int64
	for _, line := range adjustment.Lines {
		if line.VariantID < 1 || line.VariantID > math.MaxInt32 || line.VariantID <= previous ||
			line.Expected < 0 || line.Counted < 0 || line.Counted > stockAdjustmentMaxCounted ||
			line.Difference != line.Counted-line.Expected {
			return unavailable()
		}
		next, err := stockAdjustmentDifference(total, line.Difference)
		if err != nil {
			return unavailable()
		}
		total = next
		previous = line.VariantID
		lines = append(lines, stockAdjustmentLineDTO{VariantID: line.VariantID, Expected: line.Expected,
			Counted: line.Counted, Difference: line.Difference})
	}
	if adjustment.TotalDifference != total || total > stockAdjustmentMaxTotal || total < -stockAdjustmentMaxTotal {
		return unavailable()
	}
	return stockAdjustmentDTO{
		ID:                   adjustment.ID,
		LocationID:           adjustment.LocationID,
		Reason:               adjustment.Reason,
		Detail:               adjustment.Detail,
		CreatedByAccountID:   adjustment.CreatedByAccountID,
		CreatedAt:            adjustment.CreatedAt.UTC().Format(time.RFC3339),
		ReversesAdjustmentID: reverses,
		Lines:                lines,
		TotalDifference:      adjustment.TotalDifference,
	}, nil
}

// stockAdjustmentDetailRecord admits only a complete persisted detail: the lines
// carry the catalogue identity of their variant and the applied arithmetic, and the
// reversal cross-references point inside this warehouse's ledger.
func stockAdjustmentDetailRecord(detail stockadjustments.Detail) (stockAdjustmentDetailDTO, error) {
	unavailable := func() (stockAdjustmentDetailDTO, error) {
		return stockAdjustmentDetailDTO{}, stockadjustments.ErrUnavailable
	}
	if detail.ID < 1 || detail.LocationID != 1 || detail.CreatedByAccountID < 1 || detail.CreatedAt.IsZero() ||
		len(detail.Lines) == 0 || len(detail.Lines) > stockAdjustmentMaxLines ||
		!stockAdjustmentMotive(detail.Reason) || !validStockAdjustmentDetail(detail.Detail) {
		return unavailable()
	}
	reverses, ok := stockAdjustmentReference(detail.ReversesAdjustmentID, detail.ID, false)
	if !ok {
		return unavailable()
	}
	reversedBy, ok := stockAdjustmentReference(detail.ReversedBy, detail.ID, true)
	if !ok {
		return unavailable()
	}
	// The counter-entry's own motive travels beside its cross-reference: a reversed
	// document reports the canonical motive of its counter-entry, and a document
	// that is not reversed reports none at all.
	if reversedBy == nil {
		if detail.ReversedByReason != "" {
			return unavailable()
		}
	} else if !stockAdjustmentMotive(detail.ReversedByReason) {
		return unavailable()
	}
	lines := make([]stockAdjustmentDetailLineDTO, 0, len(detail.Lines))
	var previous, total int64
	for _, line := range detail.Lines {
		if line.VariantID < 1 || line.VariantID > math.MaxInt32 || line.VariantID <= previous ||
			line.CatalogEntryID < 1 || !validStockAdjustmentCatalogueText(line.Brand) ||
			!validStockAdjustmentCatalogueText(line.Model) ||
			(line.Polarity != "L" && line.Polarity != "R") ||
			line.Expected < 0 || line.Counted < 0 || line.Counted > stockAdjustmentMaxCounted ||
			line.Difference != line.Counted-line.Expected {
			return unavailable()
		}
		capacity, err := catalog.ParseDecimal(string(line.Capacity))
		if err != nil {
			return unavailable()
		}
		next, err := stockAdjustmentDifference(total, line.Difference)
		if err != nil {
			return unavailable()
		}
		total = next
		previous = line.VariantID
		lines = append(lines, stockAdjustmentDetailLineDTO{VariantID: line.VariantID,
			CatalogEntryID: line.CatalogEntryID, Brand: line.Brand, Model: line.Model,
			Capacity: string(capacity), Polarity: line.Polarity, Expected: line.Expected,
			Counted: line.Counted, Difference: line.Difference})
	}
	if detail.TotalDifference != total || total > stockAdjustmentMaxTotal || total < -stockAdjustmentMaxTotal {
		return unavailable()
	}
	return stockAdjustmentDetailDTO{
		ID:                   detail.ID,
		LocationID:           detail.LocationID,
		Reason:               detail.Reason,
		Detail:               detail.Detail,
		CreatedAt:            detail.CreatedAt.UTC().Format(time.RFC3339),
		CreatedByAccountID:   detail.CreatedByAccountID,
		ReversesAdjustmentID: reverses,
		ReversedBy:           reversedBy,
		ReversedByReason:     detail.ReversedByReason,
		Lines:                lines,
		TotalDifference:      detail.TotalDifference,
	}, nil
}

// stockAdjustmentPage admits only a complete persisted page: shape, newest-first
// order, counts and differences are the frozen contract.
func stockAdjustmentPage(page stockadjustments.Page) (stockAdjustmentPageDTO, error) {
	unavailable := func() (stockAdjustmentPageDTO, error) {
		return stockAdjustmentPageDTO{}, stockadjustments.ErrUnavailable
	}
	if !stockadjustments.ValidPage(page.Page, page.PageSize) || page.TotalAdjustments < 0 ||
		len(page.Adjustments) > page.PageSize ||
		// A page beyond the last one is legitimately empty; a page with rows must
		// still fit inside the reported total.
		(len(page.Adjustments) > 0 &&
			int64(page.Page-1)*int64(page.PageSize)+int64(len(page.Adjustments)) > page.TotalAdjustments) {
		return unavailable()
	}
	rows := make([]stockAdjustmentSummaryDTO, 0, len(page.Adjustments))
	previous := int64(math.MaxInt64)
	for _, summary := range page.Adjustments {
		if summary.ID < 1 || summary.ID >= previous || summary.CreatedAt.IsZero() ||
			summary.Lines < 1 || summary.Lines > stockAdjustmentMaxLines ||
			summary.TotalDifference > stockAdjustmentMaxTotal || summary.TotalDifference < -stockAdjustmentMaxTotal ||
			!stockAdjustmentMotive(summary.Reason) || !validStockAdjustmentDetail(summary.Detail) {
			return unavailable()
		}
		reverses, ok := stockAdjustmentReference(summary.ReversesAdjustmentID, summary.ID, false)
		if !ok {
			return unavailable()
		}
		reversedBy, ok := stockAdjustmentReference(summary.ReversedBy, summary.ID, true)
		if !ok {
			return unavailable()
		}
		previous = summary.ID
		rows = append(rows, stockAdjustmentSummaryDTO{ID: summary.ID, Reason: summary.Reason,
			Detail: summary.Detail, CreatedAt: summary.CreatedAt.UTC().Format(time.RFC3339),
			Lines: summary.Lines, TotalDifference: summary.TotalDifference,
			ReversesAdjustmentID: reverses, ReversedBy: reversedBy})
	}
	return stockAdjustmentPageDTO{Page: page.Page, PageSize: page.PageSize,
		TotalAdjustments: page.TotalAdjustments, Adjustments: rows}, nil
}

// stockAdjustmentCatalogPage admits only a complete capture catalogue page: the
// items are variant-ordered catalogue identities, and no stock quantity exists on
// this shape at all.
func stockAdjustmentCatalogPage(page stockadjustments.CatalogPage) (stockAdjustmentCatalogDTO, error) {
	unavailable := func() (stockAdjustmentCatalogDTO, error) {
		return stockAdjustmentCatalogDTO{}, stockadjustments.ErrUnavailable
	}
	if !stockadjustments.ValidPage(page.Page, page.PageSize) || page.TotalVariants < 0 ||
		len(page.Items) > page.PageSize ||
		(len(page.Items) > 0 &&
			int64(page.Page-1)*int64(page.PageSize)+int64(len(page.Items)) > page.TotalVariants) {
		return unavailable()
	}
	items := make([]stockAdjustmentCatalogItemDTO, 0, len(page.Items))
	var previous int64
	for _, item := range page.Items {
		if item.VariantID < 1 || item.VariantID > math.MaxInt32 || item.VariantID <= previous ||
			item.CatalogEntryID < 1 || !validStockAdjustmentCatalogueText(item.Brand) ||
			!validStockAdjustmentCatalogueText(item.Model) ||
			(item.Polarity != "L" && item.Polarity != "R") {
			return unavailable()
		}
		capacity, err := catalog.ParseDecimal(string(item.Capacity))
		if err != nil {
			return unavailable()
		}
		previous = item.VariantID
		items = append(items, stockAdjustmentCatalogItemDTO{VariantID: item.VariantID,
			CatalogEntryID: item.CatalogEntryID, Brand: item.Brand, Model: item.Model,
			Capacity: string(capacity), Polarity: item.Polarity})
	}
	return stockAdjustmentCatalogDTO{Page: page.Page, PageSize: page.PageSize,
		TotalVariants: page.TotalVariants, Items: items}, nil
}

// registerStockAdjustments exposes the warehouse administrator's blind capture
// catalogue, adjustment history, creation, detail and counter-entry routes. Only
// that administrator is admitted and the store is the final authority for every one
// of them. The literal catalogue path is registered beside the {id} pattern, which
// is never more specific than it. Anything else below the collection is an unknown
// route answered as JSON, never a cleaned or redirected path.
func (a *API) registerStockAdjustments(mux *http.ServeMux, store *stockadjustments.Store) {
	mux.HandleFunc("/api/stock-adjustments/catalog", a.stockAdjustmentCatalog(store))
	mux.HandleFunc("/api/stock-adjustments/{id}/reverse", a.stockAdjustmentReverse(store))
	mux.HandleFunc("/api/stock-adjustments/{id}", a.stockAdjustmentDetail(store))
	mux.HandleFunc("/api/stock-adjustments/", func(w http.ResponseWriter, r *http.Request) {
		failure(w, 404, "not_found")
	})
	mux.HandleFunc("/api/stock-adjustments", func(w http.ResponseWriter, r *http.Request) {
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
			page, pageSize, err := stockAdjustmentQuery(r.URL.RawQuery)
			if err != nil {
				stockAdjustmentFailure(w, err)
				return
			}
			result, err := store.List(r.Context(), actor, page, pageSize)
			if err != nil {
				stockAdjustmentFailure(w, err)
				return
			}
			record, err := stockAdjustmentPage(result)
			if err != nil {
				stockAdjustmentFailure(w, err)
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
		in, err := decodeStockAdjustment(r)
		if err != nil {
			stockAdjustmentFailure(w, err)
			return
		}
		adjustment, replayed, err := store.Create(r.Context(), actor, in)
		if err != nil {
			stockAdjustmentFailure(w, err)
			return
		}
		record, err := stockAdjustmentRecord(adjustment)
		if err != nil {
			stockAdjustmentFailure(w, err)
			return
		}
		status := 201
		if replayed {
			status = 200
		}
		respond(w, status, record)
	})
}

// stockAdjustmentCatalog serves the blind capture catalogue: the identity of every
// variant of this warehouse and nothing else. The guard order is the history read's:
// method, identity, then no bare query separator, and only an admitted filter set
// reaches the catalogue lookup.
func (a *API) stockAdjustmentCatalog(store *stockadjustments.Store) http.HandlerFunc {
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
		query, err := stockAdjustmentCatalogQuery(r.URL.RawQuery)
		if err != nil {
			stockAdjustmentFailure(w, err)
			return
		}
		result, err := store.Catalog(r.Context(), actor, query)
		if err != nil {
			stockAdjustmentFailure(w, err)
			return
		}
		record, err := stockAdjustmentCatalogPage(result)
		if err != nil {
			stockAdjustmentFailure(w, err)
			return
		}
		respond(w, 200, record)
	}
}

// stockAdjustmentDetail serves the per-document read: the header, the catalogue
// identity of every line with its expected, counted and applied difference, and the
// reversal cross-references. Only a canonical positive id reaches the document
// lookup, and an ambiguous path never gets here.
func (a *API) stockAdjustmentDetail(store *stockadjustments.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodGet) {
			return
		}
		actor, ok := a.inventoryIdentity(w, r)
		if !ok {
			return
		}
		// A query string is not part of this contract: it is a framing error, never
		// a silently ignored parameter.
		if r.URL.RawQuery != "" || r.URL.ForceQuery {
			failure(w, 400, "invalid_request")
			return
		}
		id, err := canonicalAdjustmentInteger(r.PathValue("id"), math.MaxInt64)
		if err != nil {
			stockAdjustmentFailure(w, err)
			return
		}
		detail, err := store.Read(r.Context(), actor, id)
		if err != nil {
			stockAdjustmentFailure(w, err)
			return
		}
		record, err := stockAdjustmentDetailRecord(detail)
		if err != nil {
			stockAdjustmentFailure(w, err)
			return
		}
		respond(w, 200, record)
	}
}

// stockAdjustmentReverse serves the counter-entry contract. The target document is
// in the path, the body is only the operation key and the mandatory reason, and
// every line is derived by the store from the persisted original. The guard order
// is creation's: method, identity, Sec-Fetch-Site, CSRF, then no query string.
func (a *API) stockAdjustmentReverse(store *stockadjustments.Store) http.HandlerFunc {
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
		// Only a canonical positive id reaches the document lookup; an aliased
		// spelling is a malformed request, never a cleaned path.
		id, err := canonicalAdjustmentInteger(r.PathValue("id"), math.MaxInt64)
		if err != nil {
			stockAdjustmentFailure(w, err)
			return
		}
		operationKey, reason, err := decodeStockAdjustmentReversal(r)
		if err != nil {
			stockAdjustmentFailure(w, err)
			return
		}
		adjustment, replayed, err := store.Reverse(r.Context(), actor, id, operationKey, reason)
		if err != nil {
			stockAdjustmentFailure(w, err)
			return
		}
		record, err := stockAdjustmentRecord(adjustment)
		if err != nil {
			stockAdjustmentFailure(w, err)
			return
		}
		status := 201
		if replayed {
			status = 200
		}
		respond(w, status, record)
	}
}
