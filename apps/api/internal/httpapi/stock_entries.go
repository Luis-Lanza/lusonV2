package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"mime"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"luson/api/internal/auth"
	"luson/api/internal/config"
	"luson/api/internal/inventory"
	"luson/api/internal/realtime"
	"luson/api/internal/stockentries"
	"luson/api/internal/transfers"
)

// stockEntryBodyLimit bounds decoding work well below any admitted payload:
// 190 lines of maximum variant/quantity plus a 500-character note.
const stockEntryBodyLimit = 16 << 10

const (
	// stockEntryMaxLines and stockEntryMaxUnits are the document bounds, reused as
	// the summary bounds so a history row never advertises an impossible total.
	stockEntryMaxLines = 190
	stockEntryMaxUnits = stockEntryMaxLines * 1_000_000
)

// NewWithStockEntries opts in to warehouse stock ingress. Dependencies must be
// initialized except the realtime broker, which only adds the event stream.
func NewWithStockEntries(service *auth.Service, cfg config.Auth, stock *inventory.Store, requests *transfers.Store, entries *stockentries.Store, broker *realtime.Broker) (http.Handler, error) {
	if service == nil || stock == nil || requests == nil || entries == nil {
		return nil, stockentries.ErrUnavailable
	}
	parsed, err := config.ParseAuth(config.LocalTrial, cfg.Origin, cfg.Listen, cfg.TLSCert, cfg.TLSKey)
	if err != nil || parsed != cfg {
		return nil, stockentries.ErrUnavailable
	}
	return stockEntryPathSafety(compose(service, cfg, stock, requests, entries, broker)), nil
}

// stockEntryPathSafety refuses an ambiguous ingress path before compose can set
// its response headers, so the two unconditional headers are repeated here.
func stockEntryPathSafety(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if !stockEntryPath(r) {
			failure(w, 404, "not_found")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// stockEntryPath refuses ambiguous ingress paths before ServeMux can clean or
// redirect them, exactly like the transfer routes: a doubled slash, a dot
// segment, a backslash, a NUL or an encoded alias is not_found, never a silent
// redirect to a different document.
func stockEntryPath(r *http.Request) bool {
	p := r.URL.Path
	if p != "/api/stock-entries" && !strings.HasPrefix(p, "/api/stock-entries/") {
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

func stockEntryFailure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, stockentries.ErrInvalid):
		failure(w, 400, "invalid_request")
	case errors.Is(err, stockentries.ErrForbidden):
		failure(w, 403, "forbidden")
	case errors.Is(err, stockentries.ErrNotFound):
		failure(w, 404, "not_found")
	case errors.Is(err, stockentries.ErrDecisionConflict):
		failure(w, 409, "decision_conflict")
	case errors.Is(err, stockentries.ErrInsufficientStock):
		failure(w, 409, "insufficient_stock")
	case errors.Is(err, stockentries.ErrRetryConflict):
		failure(w, 409, "retry_conflict")
	default:
		failure(w, 503, "service_unavailable")
	}
}

// The transfer helpers below are the same strict token readers used by
// POST /api/transfers; only the domain error is restated.
func stockNumber(d *json.Decoder, max int64) (int64, error) {
	if n, err := transferNumber(d, max); err == nil {
		return n, nil
	}
	return 0, stockentries.ErrInvalid
}

func stockString(d *json.Decoder) (string, error) {
	if value, err := transferString(d); err == nil {
		return value, nil
	}
	return "", stockentries.ErrInvalid
}

func stockDelimiter(d *json.Decoder, want json.Delim) bool {
	return transferDelimiter(d, want)
}

func stockLines(d *json.Decoder) ([]stockentries.Line, error) {
	if !stockDelimiter(d, '[') {
		return nil, stockentries.ErrInvalid
	}
	lines := make([]stockentries.Line, 0)
	for d.More() {
		if len(lines) >= stockEntryMaxLines || !stockDelimiter(d, '{') {
			return nil, stockentries.ErrInvalid
		}
		var line stockentries.Line
		seen := map[string]bool{}
		for d.More() {
			key, err := stockString(d)
			if err != nil || seen[key] {
				return nil, stockentries.ErrInvalid
			}
			seen[key] = true
			switch key {
			case "variant_id":
				line.VariantID, err = stockNumber(d, math.MaxInt32)
			case "quantity":
				line.Quantity, err = stockNumber(d, math.MaxInt64)
			default:
				return nil, stockentries.ErrInvalid
			}
			if err != nil {
				return nil, stockentries.ErrInvalid
			}
		}
		if len(seen) != 2 || !stockDelimiter(d, '}') {
			return nil, stockentries.ErrInvalid
		}
		lines = append(lines, line)
	}
	if len(lines) == 0 || !stockDelimiter(d, ']') {
		return nil, stockentries.ErrInvalid
	}
	return lines, nil
}

// decodeStockEntry reads tokens rather than structs: exact names, presence,
// types and duplicate keys (including escaped-equivalent keys) are enforced at
// every object level, and the terminal EOF rejects trailing input.
func decodeStockEntry(r *http.Request) (stockentries.CreateInput, error) {
	var in stockentries.CreateInput
	if r == nil || r.Body == nil || len(r.Header.Values("Content-Type")) != 1 {
		return in, stockentries.ErrInvalid
	}
	contentType := r.Header.Get("Content-Type")
	media, params, err := mime.ParseMediaType(contentType)
	// MIME parsing collapses identical duplicate parameters and admits a
	// trailing separator; neither is an unambiguous framing here.
	if err != nil || media != "application/json" || len(params) > 1 || strings.Count(contentType, ";") != len(params) {
		return in, stockentries.ErrInvalid
	}
	for key, value := range params {
		if key != "charset" || !strings.EqualFold(value, "utf-8") {
			return in, stockentries.ErrInvalid
		}
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, stockEntryBodyLimit+1))
	if err != nil || len(body) > stockEntryBodyLimit || !utf8.Valid(body) {
		return in, stockentries.ErrInvalid
	}
	d := json.NewDecoder(bytes.NewReader(body))
	d.UseNumber()
	if !stockDelimiter(d, '{') {
		return in, stockentries.ErrInvalid
	}
	seen := map[string]bool{}
	for d.More() {
		key, err := stockString(d)
		if err != nil || seen[key] {
			return stockentries.CreateInput{}, stockentries.ErrInvalid
		}
		seen[key] = true
		switch key {
		case "operation_key":
			in.OperationKey, err = stockString(d)
		case "note":
			in.Note, err = stockString(d)
		case "lines":
			in.Lines, err = stockLines(d)
		default:
			return stockentries.CreateInput{}, stockentries.ErrInvalid
		}
		if err != nil {
			return stockentries.CreateInput{}, stockentries.ErrInvalid
		}
	}
	if !seen["operation_key"] || !seen["lines"] || len(seen) > 3 || !stockDelimiter(d, '}') {
		return stockentries.CreateInput{}, stockentries.ErrInvalid
	}
	if _, err := d.Token(); err != io.EOF {
		return stockentries.CreateInput{}, stockentries.ErrInvalid
	}
	// Actor, location, note and line bounds are revalidated by the store with
	// the authenticated identity, so nothing below derives authority from JSON.
	// The key shape is checked here as well, exactly like a transfer retry key.
	if !stockentries.ValidOperationKey(in.OperationKey) {
		return stockentries.CreateInput{}, stockentries.ErrInvalid
	}
	variants := make(map[int64]bool, len(in.Lines))
	for _, line := range in.Lines {
		if variants[line.VariantID] {
			return stockentries.CreateInput{}, stockentries.ErrInvalid
		}
		variants[line.VariantID] = true
	}
	return in, nil
}

// decodeStockEntryReversal reads exactly the two admitted tokens of the frozen
// reversal contract: the operation key and the mandatory reason. Lines,
// quantities and the target are never accepted from the client, so a partial or
// invented reversal cannot even be expressed. The canonical reason is computed
// once here and revalidated by the store.
func decodeStockEntryReversal(r *http.Request) (string, string, error) {
	if r == nil || r.Body == nil || len(r.Header.Values("Content-Type")) != 1 {
		return "", "", stockentries.ErrInvalid
	}
	contentType := r.Header.Get("Content-Type")
	media, params, err := mime.ParseMediaType(contentType)
	if err != nil || media != "application/json" || len(params) > 1 || strings.Count(contentType, ";") != len(params) {
		return "", "", stockentries.ErrInvalid
	}
	for key, value := range params {
		if key != "charset" || !strings.EqualFold(value, "utf-8") {
			return "", "", stockentries.ErrInvalid
		}
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, stockEntryBodyLimit+1))
	if err != nil || len(body) > stockEntryBodyLimit || !utf8.Valid(body) {
		return "", "", stockentries.ErrInvalid
	}
	d := json.NewDecoder(bytes.NewReader(body))
	d.UseNumber()
	if !stockDelimiter(d, '{') {
		return "", "", stockentries.ErrInvalid
	}
	var operationKey, reason string
	seen := map[string]bool{}
	for d.More() {
		key, err := stockString(d)
		if err != nil || seen[key] {
			return "", "", stockentries.ErrInvalid
		}
		seen[key] = true
		switch key {
		case "operation_key":
			operationKey, err = stockString(d)
		case "reason":
			reason, err = stockString(d)
		default:
			return "", "", stockentries.ErrInvalid
		}
		if err != nil {
			return "", "", stockentries.ErrInvalid
		}
	}
	if !seen["operation_key"] || !seen["reason"] || !stockDelimiter(d, '}') {
		return "", "", stockentries.ErrInvalid
	}
	if _, err := d.Token(); err != io.EOF {
		return "", "", stockentries.ErrInvalid
	}
	canonicalReason, valid := stockentries.CanonicalReason(reason)
	if !stockentries.ValidOperationKey(operationKey) || !valid {
		return "", "", stockentries.ErrInvalid
	}
	return operationKey, canonicalReason, nil
}

// stockCanonicalInteger is the same strict reader the transfer query uses; only
// the domain error is restated.
func stockCanonicalInteger(value string, max int64) (int64, error) {
	if n, err := canonicalTransferInteger(value, max); err == nil {
		return n, nil
	}
	return 0, stockentries.ErrInvalid
}

// stockEntryQuery reads the frozen history query: only page and page_size, each
// exactly once, as a canonical integer. Order is irrelevant; duplicates, empty
// values, unknown keys and encoding aliases are rejections, never defaults.
func stockEntryQuery(raw string) (page, pageSize int, err error) {
	page, pageSize = 1, stockentries.DefaultPageSize
	if raw == "" {
		return page, pageSize, nil
	}
	if len(raw) > 4096 {
		return 0, 0, stockentries.ErrInvalid
	}
	seen := map[string]bool{}
	for _, part := range strings.Split(raw, "&") {
		key, value, ok := strings.Cut(part, "=")
		if !ok || value == "" || seen[key] {
			return 0, 0, stockentries.ErrInvalid
		}
		seen[key] = true
		var n int64
		var read error
		switch key {
		case "page":
			n, read = stockCanonicalInteger(value, stockentries.MaxPage)
			page = int(n)
		case "page_size":
			n, read = stockCanonicalInteger(value, 50)
			pageSize = int(n)
			if n != 10 && n != stockentries.DefaultPageSize && n != 50 {
				read = stockentries.ErrInvalid
			}
		default:
			return 0, 0, stockentries.ErrInvalid
		}
		if read != nil {
			return 0, 0, stockentries.ErrInvalid
		}
	}
	if !stockentries.ValidPage(page, pageSize) {
		return 0, 0, stockentries.ErrInvalid
	}
	return page, pageSize, nil
}

type stockEntryLineDTO struct {
	VariantID int64 `json:"variant_id"`
	Quantity  int64 `json:"quantity"`
}

type stockEntryDTO struct {
	ID                 int64               `json:"id"`
	LocationID         int                 `json:"location_id"`
	Note               string              `json:"note"`
	CreatedByAccountID int64               `json:"created_by_account_id"`
	CreatedAt          string              `json:"created_at"`
	Lines              []stockEntryLineDTO `json:"lines"`
	TotalUnits         int64               `json:"total_units"`
}

// validStockEntryNote is the note bound of the contract, shared by the created
// document and by every history row.
func validStockEntryNote(note string) bool {
	return utf8.ValidString(note) && !strings.ContainsRune(note, 0) && utf8.RuneCountInString(note) <= 500
}

// stockEntryRecord admits only a complete persisted ingress document: lines are
// canonical, the total is exact and no rejected shape reaches the wire. A
// counter-entry carries the exact negation of the original lines, so its sign
// rule is the mirror of an ingress document's and its target is always an
// earlier document of this warehouse.
func stockEntryRecord(entry stockentries.Entry) (stockEntryDTO, error) {
	if entry.ID < 1 || entry.LocationID != 1 || entry.CreatedByAccountID < 1 || entry.CreatedAt.IsZero() ||
		len(entry.Lines) == 0 || len(entry.Lines) > stockEntryMaxLines || !validStockEntryNote(entry.Note) {
		return stockEntryDTO{}, stockentries.ErrUnavailable
	}
	reversal := entry.ReversesEntryID != nil
	if reversal && (*entry.ReversesEntryID < 1 || *entry.ReversesEntryID >= entry.ID) {
		return stockEntryDTO{}, stockentries.ErrUnavailable
	}
	lines := make([]stockEntryLineDTO, 0, len(entry.Lines))
	var previous int64
	var total int64
	for _, line := range entry.Lines {
		if line.VariantID < 1 || line.VariantID <= previous || (reversal && line.Quantity > -1) || (!reversal && line.Quantity < 1) {
			return stockEntryDTO{}, stockentries.ErrUnavailable
		}
		if (line.Quantity > 0 && total > math.MaxInt64-line.Quantity) ||
			(line.Quantity < 0 && total < math.MinInt64-line.Quantity) {
			return stockEntryDTO{}, stockentries.ErrUnavailable
		}
		previous = line.VariantID
		total += line.Quantity
		lines = append(lines, stockEntryLineDTO{VariantID: line.VariantID, Quantity: line.Quantity})
	}
	if total != entry.TotalUnits || (reversal && total > -1) {
		return stockEntryDTO{}, stockentries.ErrUnavailable
	}
	return stockEntryDTO{
		ID:                 entry.ID,
		LocationID:         entry.LocationID,
		Note:               entry.Note,
		CreatedByAccountID: entry.CreatedByAccountID,
		CreatedAt:          entry.CreatedAt.UTC().Format(time.RFC3339),
		Lines:              lines,
		TotalUnits:         entry.TotalUnits,
	}, nil
}

type stockEntrySummaryDTO struct {
	ID         int64  `json:"id"`
	Note       string `json:"note"`
	CreatedAt  string `json:"created_at"`
	Lines      int    `json:"lines"`
	TotalUnits int64  `json:"total_units"`
	ReversedBy *int64 `json:"reversed_by"`
}

type stockEntryPageDTO struct {
	Page         int                    `json:"page"`
	PageSize     int                    `json:"page_size"`
	TotalEntries int64                  `json:"total_entries"`
	Entries      []stockEntrySummaryDTO `json:"entries"`
}

// stockEntryPage admits only a complete persisted page: shape, newest-first
// order, counts and totals are the frozen contract, and a counter-entry is
// always a later document than the one it reverses.
func stockEntryPage(page stockentries.EntryPage) (stockEntryPageDTO, error) {
	if !stockentries.ValidPage(page.Page, page.PageSize) || page.TotalEntries < 0 ||
		len(page.Entries) > page.PageSize ||
		// A page beyond the last one is legitimately empty; a page with rows must
		// still fit inside the reported total.
		(len(page.Entries) > 0 &&
			int64(page.Page-1)*int64(page.PageSize)+int64(len(page.Entries)) > page.TotalEntries) {
		return stockEntryPageDTO{}, stockentries.ErrUnavailable
	}
	entries := make([]stockEntrySummaryDTO, 0, len(page.Entries))
	previous := int64(math.MaxInt64)
	for _, entry := range page.Entries {
		if entry.ID < 1 || entry.ID >= previous || entry.CreatedAt.IsZero() ||
			entry.Lines < 1 || entry.Lines > stockEntryMaxLines ||
			entry.TotalUnits > stockEntryMaxUnits || entry.TotalUnits < -stockEntryMaxUnits ||
			!validStockEntryNote(entry.Note) {
			return stockEntryPageDTO{}, stockentries.ErrUnavailable
		}
		previous = entry.ID
		var reversedBy *int64
		if entry.ReversedBy != nil {
			if *entry.ReversedBy <= entry.ID {
				return stockEntryPageDTO{}, stockentries.ErrUnavailable
			}
			counter := *entry.ReversedBy
			reversedBy = &counter
		}
		entries = append(entries, stockEntrySummaryDTO{ID: entry.ID, Note: entry.Note,
			CreatedAt: entry.CreatedAt.UTC().Format(time.RFC3339), Lines: entry.Lines,
			TotalUnits: entry.TotalUnits, ReversedBy: reversedBy})
	}
	return stockEntryPageDTO{Page: page.Page, PageSize: page.PageSize, TotalEntries: page.TotalEntries, Entries: entries}, nil
}

// registerStockEntries exposes the warehouse administrator's history, creation and
// counter-entry routes. Only that administrator is admitted and the store is the
// final authority for every one of them. Anything else below the collection is an
// unknown route answered as JSON, never a cleaned or redirected path.
func (a *API) registerStockEntries(mux *http.ServeMux, store *stockentries.Store) {
	mux.HandleFunc("/api/stock-entries/{id}/reverse", a.stockEntryReverse(store))
	mux.HandleFunc("/api/stock-entries/", func(w http.ResponseWriter, r *http.Request) {
		failure(w, 404, "not_found")
	})
	mux.HandleFunc("/api/stock-entries", func(w http.ResponseWriter, r *http.Request) {
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
			page, pageSize, err := stockEntryQuery(r.URL.RawQuery)
			if err != nil {
				stockEntryFailure(w, err)
				return
			}
			result, err := store.ListEntries(r.Context(), actor, page, pageSize)
			if err != nil {
				stockEntryFailure(w, err)
				return
			}
			record, err := stockEntryPage(result)
			if err != nil {
				stockEntryFailure(w, err)
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
		in, err := decodeStockEntry(r)
		if err != nil {
			stockEntryFailure(w, err)
			return
		}
		entry, replayed, err := store.CreateEntry(r.Context(), actor, in)
		if err != nil {
			stockEntryFailure(w, err)
			return
		}
		record, err := stockEntryRecord(entry)
		if err != nil {
			stockEntryFailure(w, err)
			return
		}
		status := 201
		if replayed {
			status = 200
		}
		respond(w, status, record)
	})
}

// stockEntryReverse serves the counter-entry contract. The target document is in
// the path, the body is only the operation key and the mandatory reason, and
// every line is derived by the store from the persisted original. The guard order
// is creation's: method, identity, Sec-Fetch-Site, CSRF, then no query string.
func (a *API) stockEntryReverse(store *stockentries.Store) http.HandlerFunc {
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
		id, err := stockCanonicalInteger(r.PathValue("id"), math.MaxInt64)
		if err != nil {
			stockEntryFailure(w, err)
			return
		}
		operationKey, reason, err := decodeStockEntryReversal(r)
		if err != nil {
			stockEntryFailure(w, err)
			return
		}
		entry, replayed, err := store.ReverseEntry(r.Context(), actor, id, operationKey, reason)
		if err != nil {
			stockEntryFailure(w, err)
			return
		}
		record, err := stockEntryRecord(entry)
		if err != nil {
			stockEntryFailure(w, err)
			return
		}
		status := 201
		if replayed {
			status = 200
		}
		respond(w, status, record)
	}
}
