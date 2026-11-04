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
	return compose(service, cfg, stock, requests, entries, broker), nil
}

func stockEntryFailure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, stockentries.ErrInvalid):
		failure(w, 400, "invalid_request")
	case errors.Is(err, stockentries.ErrForbidden):
		failure(w, 403, "forbidden")
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
		if len(lines) >= 190 || !stockDelimiter(d, '{') {
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

// stockEntryRecord admits only a complete persisted ingress document: lines are
// canonical, the total is exact and no rejected shape reaches the wire.
func stockEntryRecord(entry stockentries.Entry) (stockEntryDTO, error) {
	if entry.ID < 1 || entry.LocationID != 1 || entry.CreatedByAccountID < 1 || entry.CreatedAt.IsZero() ||
		len(entry.Lines) == 0 || len(entry.Lines) > 190 || utf8.RuneCountInString(entry.Note) > 500 ||
		!utf8.ValidString(entry.Note) || strings.ContainsRune(entry.Note, 0) {
		return stockEntryDTO{}, stockentries.ErrUnavailable
	}
	lines := make([]stockEntryLineDTO, 0, len(entry.Lines))
	var previous int64
	var total int64
	for _, line := range entry.Lines {
		if line.VariantID < 1 || line.Quantity < 1 || line.VariantID <= previous {
			return stockEntryDTO{}, stockentries.ErrUnavailable
		}
		if line.Quantity > math.MaxInt64-total {
			return stockEntryDTO{}, stockentries.ErrUnavailable
		}
		previous = line.VariantID
		total += line.Quantity
		lines = append(lines, stockEntryLineDTO{VariantID: line.VariantID, Quantity: line.Quantity})
	}
	if total != entry.TotalUnits {
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

// registerStockEntries exposes exactly one route and one method. Only the
// warehouse administrator is admitted; the store is the final authority.
func (a *API) registerStockEntries(mux *http.ServeMux, store *stockentries.Store) {
	mux.HandleFunc("/api/stock-entries", func(w http.ResponseWriter, r *http.Request) {
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
