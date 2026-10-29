package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"mime"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"luson/api/internal/auth"
	"luson/api/internal/config"
	"luson/api/internal/inventory"
	"luson/api/internal/transfers"
)

// NewWithTransfers explicitly opts in; legacy New never registers transfers.
// Dependencies must be initialized. Pool availability remains a store concern.
func NewWithTransfers(service *auth.Service, cfg config.Auth, stock *inventory.Store, requests *transfers.Store) (http.Handler, error) {
	if service == nil || stock == nil || requests == nil {
		return nil, transfers.ErrUnavailable
	}
	parsed, err := config.ParseAuth(config.LocalTrial, cfg.Origin, cfg.Listen, cfg.TLSCert, cfg.TLSKey)
	if err != nil || parsed != cfg {
		return nil, transfers.ErrUnavailable
	}
	return compose(service, cfg, stock, requests), nil
}

// Prevent ServeMux cleaning/redirects and encoded aliases on these new routes,
// without changing historical auth/inventory routing or outer webui guards.
func transferPath(w http.ResponseWriter, r *http.Request) bool {
	p := r.URL.Path
	if p != "/api/transfers" && !strings.HasPrefix(p, "/api/transfers/") {
		return true
	}
	unsafe := strings.Contains(p, "//") || strings.ContainsAny(p, "\\\x00")
	for _, part := range strings.Split(p, "/") {
		if part == "." || part == ".." {
			unsafe = true
		}
	}
	if unsafe {
		failure(w, 404, "not_found")
		return false
	}
	if r.URL.EscapedPath() != p {
		failure(w, 400, "invalid_request")
		return false
	}
	return true
}
func transferFailure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, transfers.ErrInvalid):
		failure(w, 400, "invalid_request")
	case errors.Is(err, transfers.ErrForbidden):
		failure(w, 403, "forbidden")
	case errors.Is(err, transfers.ErrNotFound):
		failure(w, 404, "not_found")
	case errors.Is(err, transfers.ErrInsufficientStock):
		failure(w, 409, "insufficient_stock")
	case errors.Is(err, transfers.ErrDecisionConflict):
		failure(w, 409, "decision_conflict")
	case errors.Is(err, transfers.ErrRetryConflict):
		failure(w, 409, "retry_conflict")
	default:
		failure(w, 503, "service_unavailable")
	}
}
func canonicalTransferInteger(value string, max int64) (int64, error) {
	if len(value) == 0 || len(value) > 19 || value[0] < '1' || value[0] > '9' {
		return 0, transfers.ErrInvalid
	}
	for _, c := range value {
		if c < '0' || c > '9' {
			return 0, transfers.ErrInvalid
		}
	}
	n, err := strconv.ParseInt(value, 10, 64)
	if err != nil || n > max {
		return 0, transfers.ErrInvalid
	}
	return n, nil
}
func transferNumber(d *json.Decoder, max int64) (int64, error) {
	token, err := d.Token()
	if err != nil {
		return 0, transfers.ErrInvalid
	}
	number, ok := token.(json.Number)
	if !ok {
		return 0, transfers.ErrInvalid
	}
	return canonicalTransferInteger(string(number), max)
}
func transferString(d *json.Decoder) (string, error) {
	token, err := d.Token()
	if err != nil {
		return "", transfers.ErrInvalid
	}
	value, ok := token.(string)
	if !ok {
		return "", transfers.ErrInvalid
	}
	return value, nil
}
func transferDelimiter(d *json.Decoder, want json.Delim) bool {
	token, err := d.Token()
	return err == nil && token == want
}
func transferItems(d *json.Decoder) ([]transfers.Line, error) {
	if !transferDelimiter(d, '[') {
		return nil, transfers.ErrInvalid
	}
	items := make([]transfers.Line, 0)
	for d.More() {
		if len(items) >= 190 || !transferDelimiter(d, '{') {
			return nil, transfers.ErrInvalid
		}
		var line transfers.Line
		seen := map[string]bool{}
		for d.More() {
			key, err := transferString(d)
			if err != nil || seen[key] {
				return nil, transfers.ErrInvalid
			}
			seen[key] = true
			switch key {
			case "variant_id":
				line.VariantID, err = transferNumber(d, math.MaxInt32)
			case "quantity":
				var value string
				value, err = transferString(d)
				if err == nil {
					line.Quantity, err = canonicalTransferInteger(value, math.MaxInt64)
				}
			default:
				return nil, transfers.ErrInvalid
			}
			if err != nil {
				return nil, transfers.ErrInvalid
			}
		}
		if len(seen) != 2 || !transferDelimiter(d, '}') {
			return nil, transfers.ErrInvalid
		}
		items = append(items, line)
	}
	if len(items) == 0 || !transferDelimiter(d, ']') {
		return nil, transfers.ErrInvalid
	}
	return items, nil
}

var transferRetryKey = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)

// Decode tokens rather than structs: exact names, presence, types and duplicate
// keys (including escaped-equivalent keys) are checked at every object level.
func decodeTransfer(r *http.Request) (transfers.CreateInput, error) {
	var in transfers.CreateInput
	if r == nil || r.Body == nil || len(r.Header.Values("Content-Type")) != 1 {
		return in, transfers.ErrInvalid
	}
	contentType := r.Header.Get("Content-Type")
	media, params, err := mime.ParseMediaType(contentType)
	// MIME parsing collapses identical duplicate parameters and permits a
	// trailing separator; neither is an unambiguous admitted framing.
	if err != nil || media != "application/json" || len(params) > 1 || strings.Count(contentType, ";") != len(params) {
		return in, transfers.ErrInvalid
	}
	for key, value := range params {
		if key != "charset" || !strings.EqualFold(value, "utf-8") {
			return in, transfers.ErrInvalid
		}
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, (64<<10)+1))
	if err != nil || len(body) > 64<<10 || !utf8.Valid(body) {
		return in, transfers.ErrInvalid
	}
	d := json.NewDecoder(bytes.NewReader(body))
	d.UseNumber()
	if !transferDelimiter(d, '{') {
		return in, transfers.ErrInvalid
	}
	seen := map[string]bool{}
	for d.More() {
		key, err := transferString(d)
		if err != nil || seen[key] {
			return transfers.CreateInput{}, transfers.ErrInvalid
		}
		seen[key] = true
		switch key {
		case "kind":
			var value string
			value, err = transferString(d)
			in.Kind = transfers.Kind(value)
		case "counterparty_location_id":
			var value int64
			value, err = transferNumber(d, 3)
			in.CounterpartyID = int(value)
		case "retry_key":
			in.RetryKey, err = transferString(d)
		case "items":
			in.Items, err = transferItems(d)
		default:
			return transfers.CreateInput{}, transfers.ErrInvalid
		}
		if err != nil {
			return transfers.CreateInput{}, transfers.ErrInvalid
		}
	}
	if len(seen) != 4 || !transferDelimiter(d, '}') {
		return transfers.CreateInput{}, transfers.ErrInvalid
	}
	if _, err := d.Token(); err != io.EOF {
		return transfers.CreateInput{}, transfers.ErrInvalid
	}
	if (in.Kind != transfers.RequestStock && in.Kind != transfers.SendToWarehouse && in.Kind != transfers.DirectShipment) || !transferRetryKey.MatchString(in.RetryKey) {
		return transfers.CreateInput{}, transfers.ErrInvalid
	}
	variants := map[int64]bool{}
	for _, line := range in.Items {
		if variants[line.VariantID] {
			return transfers.CreateInput{}, transfers.ErrInvalid
		}
		variants[line.VariantID] = true
	}
	// Direction/availability are validated by Create with the authenticated actor,
	// never an identity synthesized from JSON or a consulted inventory location.
	return in, nil
}

// Allowed fields are ASCII and need no URL escaping. Reject encoding aliases,
// empty components and duplicates instead of silently accepting ParseQuery's
// partial map or empty fields. Parameter order is otherwise irrelevant.
func transferQuery(raw string) (transfers.Query, error) {
	q := transfers.Query{Page: 1, PageSize: 25, Status: "pending"}
	if raw == "" {
		return q, nil
	}
	if len(raw) > 4096 {
		return transfers.Query{}, transfers.ErrInvalid
	}
	seen := map[string]bool{}
	for _, part := range strings.Split(raw, "&") {
		key, value, ok := strings.Cut(part, "=")
		if !ok || value == "" || seen[key] {
			return transfers.Query{}, transfers.ErrInvalid
		}
		seen[key] = true
		var n int64
		var err error
		switch key {
		case "page":
			n, err = canonicalTransferInteger(value, 1_000_000)
			q.Page = n
		case "page_size":
			n, err = canonicalTransferInteger(value, 50)
			q.PageSize = int(n)
			if n != 10 && n != 25 && n != 50 {
				err = transfers.ErrInvalid
			}
		case "requires_action":
			if value != "true" && value != "false" {
				err = transfers.ErrInvalid
			}
			q.RequiresAction = value == "true"
		case "status":
			if value != "all" && value != "pending" && value != "approved" && value != "rejected" && value != "in_transit" && value != "received" && value != "cancelled" {
				err = transfers.ErrInvalid
			}
			q.Status = value
		default:
			return transfers.Query{}, transfers.ErrInvalid
		}
		if err != nil {
			return transfers.Query{}, transfers.ErrInvalid
		}
	}
	return q, nil
}

type transferItemDTO struct {
	VariantID  int64  `json:"variant_id"`
	Brand      string `json:"brand"`
	Model      string `json:"model"`
	CapacityAH string `json:"capacity_ah"`
	Polarity   string `json:"polarity"`
	Quantity   string `json:"quantity"`
}
type transferDTO struct {
	Activity                []transfers.Activity `json:"activity,omitempty"`
	ID                      string               `json:"id"`
	Reference               string               `json:"reference"`
	CreatorLocationID       int                  `json:"creator_location_id"`
	CreatorLocationName     string               `json:"creator_location_name"`
	Kind                    transfers.Kind       `json:"kind"`
	OriginLocationID        int                  `json:"origin_location_id"`
	OriginLocationName      string               `json:"origin_location_name"`
	DestinationLocationID   int                  `json:"destination_location_id"`
	DestinationLocationName string               `json:"destination_location_name"`
	ApproverLocationID      int                  `json:"approver_location_id"`
	ApproverLocationName    string               `json:"approver_location_name"`
	Status                  string               `json:"status"`
	CreatedAt               string               `json:"created_at"`
	Items                   []transferItemDTO    `json:"items"`
	DecisionLocationID      *int                 `json:"decision_location_id,omitempty"`
	DecidedAt               *string              `json:"decided_at,omitempty"`
	DispatchLocationID      *int                 `json:"dispatch_location_id,omitempty"`
	DispatchedAt            *string              `json:"dispatched_at,omitempty"`
	ReceiptLocationID       *int                 `json:"receipt_location_id,omitempty"`
	ReceivedAt              *string              `json:"received_at,omitempty"`
	Receipt                 *receiptDTO          `json:"receipt,omitempty"`
	CancellationLocationID  *int                 `json:"cancellation_location_id,omitempty"`
	CancelledAt             *string              `json:"cancelled_at,omitempty"`
}

// Outcomes must be complete persisted results, never fabricated Pending or
// partially exposed metadata. Pending keeps its exact original field set.
func transferRecord(r transfers.Request) (transferDTO, error) {
	if r.Kind == transfers.DirectShipment && (r.Creator.ID != 1 || r.Origin.ID != 1 || r.Approver.ID != 1 ||
		(r.Destination.ID != 2 && r.Destination.ID != 3) || r.Status == "pending" || r.Status == "rejected" ||
		r.DecisionLocationID == nil || *r.DecisionLocationID != 1 || r.DecidedAt == nil || !r.DecidedAt.Equal(r.CreatedAt)) {
		return transferDTO{}, transfers.ErrUnavailable
	}
	var decidedAt *string
	switch r.Status {
	case "pending":
		if r.DecisionLocationID != nil || r.DecidedAt != nil {
			return transferDTO{}, transfers.ErrUnavailable
		}
	case "cancelled":
		if (r.DecisionLocationID == nil) != (r.DecidedAt == nil) {
			return transferDTO{}, transfers.ErrUnavailable
		}
		if r.DecidedAt != nil {
			if *r.DecisionLocationID != r.Approver.ID || *r.DecisionLocationID < 1 || *r.DecisionLocationID > 3 ||
				r.DecidedAt.IsZero() || r.DecidedAt.Before(r.CreatedAt) {
				return transferDTO{}, transfers.ErrUnavailable
			}
			stamp := r.DecidedAt.UTC().Format(time.RFC3339Nano)
			decidedAt = &stamp
		}
	case "approved", "rejected", "in_transit", "received":
		if r.DecisionLocationID == nil || r.DecidedAt == nil ||
			*r.DecisionLocationID < 1 || *r.DecisionLocationID > 3 ||
			*r.DecisionLocationID != r.Approver.ID || r.DecidedAt.IsZero() ||
			r.DecidedAt.Before(r.CreatedAt) {
			return transferDTO{}, transfers.ErrUnavailable
		}
		stamp := r.DecidedAt.UTC().Format(time.RFC3339Nano)
		decidedAt = &stamp
	default:
		return transferDTO{}, transfers.ErrUnavailable
	}
	var cancelledAt *string
	if r.Status == "cancelled" {
		if r.CancellationLocationID == nil || *r.CancellationLocationID != r.Creator.ID ||
			*r.CancellationLocationID < 1 || *r.CancellationLocationID > 3 || r.CancelledAt == nil || r.CancelledAt.IsZero() ||
			r.CancelledAt.Before(r.CreatedAt) || (r.DecidedAt != nil && r.CancelledAt.Before(*r.DecidedAt)) {
			return transferDTO{}, transfers.ErrUnavailable
		}
		stamp := r.CancelledAt.UTC().Format(time.RFC3339Nano)
		cancelledAt = &stamp
	} else if r.CancellationLocationID != nil || r.CancelledAt != nil {
		return transferDTO{}, transfers.ErrUnavailable
	}
	var dispatchedAt *string
	if r.Status == "in_transit" || r.Status == "received" {
		if r.DispatchLocationID == nil || *r.DispatchLocationID != r.Origin.ID || r.DispatchedAt == nil || r.DispatchedAt.IsZero() || r.DispatchedAt.Before(*r.DecidedAt) {
			return transferDTO{}, transfers.ErrUnavailable
		}
		stamp := r.DispatchedAt.UTC().Format(time.RFC3339Nano)
		dispatchedAt = &stamp
	} else if r.DispatchLocationID != nil || r.DispatchedAt != nil {
		return transferDTO{}, transfers.ErrUnavailable
	}
	receipt, receivedAt, err := receiptRecord(r)
	if err != nil {
		return transferDTO{}, err
	}
	items := make([]transferItemDTO, 0, len(r.Items))
	for _, item := range r.Items {
		items = append(items, transferItemDTO{item.VariantID, item.Brand, item.Model, string(item.Capacity), item.Polarity, strconv.FormatInt(item.Quantity, 10)})
	}
	return transferDTO{
		Activity:                r.Activity,
		ID:                      strconv.FormatInt(r.ID, 10),
		Reference:               r.Reference,
		CreatorLocationID:       r.Creator.ID,
		CreatorLocationName:     r.Creator.Name,
		Kind:                    r.Kind,
		OriginLocationID:        r.Origin.ID,
		OriginLocationName:      r.Origin.Name,
		DestinationLocationID:   r.Destination.ID,
		DestinationLocationName: r.Destination.Name,
		ApproverLocationID:      r.Approver.ID,
		ApproverLocationName:    r.Approver.Name,
		Status:                  r.Status,
		CreatedAt:               r.CreatedAt.UTC().Format(time.RFC3339Nano),
		Items:                   items,
		DecisionLocationID:      r.DecisionLocationID,
		DecidedAt:               decidedAt,
		DispatchLocationID:      r.DispatchLocationID,
		DispatchedAt:            dispatchedAt,
		ReceiptLocationID:       r.ReceiptLocationID,
		ReceivedAt:              receivedAt,
		Receipt:                 receipt,
		CancellationLocationID:  r.CancellationLocationID,
		CancelledAt:             cancelledAt,
	}, nil
}

type transferPageDTO struct {
	Page            int64              `json:"page"`
	PageSize        int                `json:"page_size"`
	Status          string             `json:"status"`
	TotalCount      string             `json:"total_count"`
	Records         []transferDTO      `json:"records"`
	RequiresAction  bool               `json:"requires_action"`
	RequiredActions map[int64][]string `json:"required_actions"`
}

func transferPage(page transfers.Page) (transferPageDTO, error) {
	records := make([]transferDTO, 0, len(page.Records))
	for _, record := range page.Records {
		dto, err := transferRecord(record)
		if err != nil {
			return transferPageDTO{}, err
		}
		records = append(records, dto)
	}
	reasons := page.RequiredActions
	if reasons == nil {
		reasons = make(map[int64][]string)
	}
	return transferPageDTO{page.Page, page.PageSize, page.Status, strconv.FormatInt(page.Total, 10), records, page.RequiresAction, reasons}, nil
}

// Counts intentionally has its own exact static route beside numeric detail.
// Identity lookup uses the existing passive inventory read policy, not Current.
func (a *API) transferCounts(store *transfers.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodGet) {
			return
		}
		if _, valid := passiveMode(r); !valid {
			failure(w, 400, "invalid_request")
			return
		}
		// Counts is inherently passive even when no selector is supplied.
		// Clone rather than changing the caller's request/header ownership.
		passive := r.Clone(r.Context())
		passive.Header.Set(passiveHeader, "1")
		actor, ok := a.inventoryIdentity(w, passive)
		if !ok {
			return
		}
		if r.URL.RawQuery != "" || r.URL.ForceQuery {
			failure(w, 400, "invalid_request")
			return
		}
		totals, err := store.Counts(r.Context(), actor)
		if err != nil {
			transferFailure(w, err)
			return
		}
		respond(w, 200, struct {
			PendingTotal string            `json:"pending_total"`
			ActionCount  string            `json:"action_count"`
			Actions      map[string]string `json:"actions"`
		}{strconv.FormatInt(totals.PendingTotal, 10), strconv.FormatInt(totals.ActionCount, 10), map[string]string{
			"approve":                        strconv.FormatInt(totals.Actions.Approve, 10),
			"dispatch":                       strconv.FormatInt(totals.Actions.Dispatch, 10),
			"receive":                        strconv.FormatInt(totals.Actions.Receive, 10),
			"review_count":                   strconv.FormatInt(totals.Actions.ReviewCount, 10),
			"review_restitution":             strconv.FormatInt(totals.Actions.ReviewRestitution, 10),
			"review_dispatch_reconciliation": strconv.FormatInt(totals.Actions.ReviewDispatchReconciliation, 10),
		}})
	}
}

func (a *API) registerTransfers(mux *http.ServeMux, store *transfers.Store) {
	mux.HandleFunc("/api/transfers/{id}/dispatch-reconciliations", a.transferDispatchReconciliations(store, ""))
	mux.HandleFunc("/api/transfers/{id}/dispatch-reconciliations/propose", a.transferDispatchReconciliations(store, "propose"))
	mux.HandleFunc("/api/transfers/{id}/dispatch-reconciliations/accept", a.transferDispatchReconciliations(store, "accept"))
	mux.HandleFunc("/api/transfers/{id}/dispatch-reconciliations/reject", a.transferDispatchReconciliations(store, "reject"))
	mux.HandleFunc("/api/transfers/{id}/dispatch-reconciliations/", countCorrectionNotFound)
	mux.HandleFunc("/api/transfers/{id}/cancel", a.transferCancellation(store))
	mux.HandleFunc("/api/transfers/{id}/receive", a.transferReceive(store))
	mux.HandleFunc("/api/transfers/{id}/count-corrections", a.transferCountCorrections(store, ""))
	mux.HandleFunc("/api/transfers/{id}/count-corrections/", countCorrectionNotFound)
	mux.HandleFunc("/api/transfers/{id}/count-corrections/propose", a.transferCountCorrections(store, "propose"))
	mux.HandleFunc("/api/transfers/{id}/count-corrections/accept", a.transferCountCorrections(store, "accept"))
	mux.HandleFunc("/api/transfers/{id}/count-corrections/reject", a.transferCountCorrections(store, "reject"))
	mux.HandleFunc("/api/transfers/{id}/restitutions", a.transferRestitutions(store, ""))
	mux.HandleFunc("/api/transfers/{id}/restitutions/", restitutionNotFound)
	mux.HandleFunc("/api/transfers/{id}/restitutions/propose", a.transferRestitutions(store, "propose"))
	mux.HandleFunc("/api/transfers/{id}/restitutions/accept", a.transferRestitutions(store, "accept"))
	mux.HandleFunc("/api/transfers/{id}/restitutions/reject", a.transferRestitutions(store, "reject"))
	mux.HandleFunc("/api/transfers/{id}/dispatch", a.transferDispatch(store))
	mux.HandleFunc("/api/transfers/{id}/approve", a.transferDecision(store, true))
	mux.HandleFunc("/api/transfers/{id}/reject", a.transferDecision(store, false))
	mux.HandleFunc("/api/transfers/counts", a.transferCounts(store))
	mux.HandleFunc("/api/transfers", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodPost {
			w.Header().Set("Allow", "GET, POST")
			failure(w, 405, "method_not_allowed")
			return
		}
		actor, ok := a.inventoryIdentity(w, r)
		if !ok {
			return
		}
		if r.Method == http.MethodPost {
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
			in, err := decodeTransfer(r)
			if err != nil {
				transferFailure(w, err)
				return
			}
			result, err := store.Create(r.Context(), actor, in)
			if err != nil {
				transferFailure(w, err)
				return
			}
			record, err := transferRecord(result.Request)
			if err != nil {
				transferFailure(w, err)
				return
			}
			status := 201
			if result.Replayed {
				status = 200
			}
			w.Header().Set("Location", "/api/transfers/"+strconv.FormatInt(result.Request.ID, 10))
			respond(w, status, record)
			return
		}
		q, err := transferQuery(r.URL.RawQuery)
		if err != nil {
			transferFailure(w, err)
			return
		}
		page, err := store.List(r.Context(), actor, q)
		if err != nil {
			transferFailure(w, err)
			return
		}
		dto, err := transferPage(page)
		if err != nil {
			transferFailure(w, err)
			return
		}
		respond(w, 200, dto)
	})
	mux.HandleFunc("/api/transfers/{id}", func(w http.ResponseWriter, r *http.Request) {
		value := r.PathValue("id")
		// Textual operation names are unknown routes, not lifecycle capabilities.
		if !strings.ContainsAny(value, "0123456789") {
			failure(w, 404, "not_found")
			return
		}
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
		id, err := canonicalTransferInteger(value, math.MaxInt64)
		if err != nil {
			transferFailure(w, err)
			return
		}
		record, err := store.Get(r.Context(), actor, id)
		if err != nil {
			transferFailure(w, err)
			return
		}
		dto, err := transferRecord(record)
		if err != nil {
			transferFailure(w, err)
			return
		}
		respond(w, 200, dto)
	})
}
