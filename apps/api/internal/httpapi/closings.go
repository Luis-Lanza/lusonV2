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

	"luson/api/internal/auth"
	"luson/api/internal/catalog"
	"luson/api/internal/closings"
	"luson/api/internal/config"
)

// This file is the HTTP contract of the branch account settlement ("rendición de
// cuentas"): the warehouse configures a branch's commission rate, opens the period, counts
// the stock, drafts the drawer, proposes the settlement and reads it, the branch accepts
// or rejects the offer and records the small expenses of its own till. Everything below is
// either a request shape judged before the store is touched or the store's own decision
// published as one status and one stable code; no rule of the vertical is restated here.
//
// Two things the surface must always say, because they are what an operator acts on: a
// refusal names what is missing (the variant still to count, the excess of a fund over the
// drawer, the settlement holding the branch, the branch without a commission rate) instead of
// a generic 400, and the derived money is published as it is computed. The commission is
// reported, never part of a cash identity (S9): expected_cash, cash_difference and taken_cash
// are the drawer's, and commission_amount sits beside them, not inside them.
//
// Corrections of a closed settlement (S16) are the second half of the vertical: the warehouse
// proposes one with a mandatory reason and the branch accepts or rejects it with one, and the
// document publishes the accepted corrections beside the numbers they moved. The routes and the
// payload below are that contract; what an accepted correction applies is the database's own work,
// never a rule restated here. The history of a branch's settlements is read through the collection
// route (GET), and a correction is a document of its own, so no route lists them separately.
//
// Nothing here restates a rule of the vertical: this file judges the framing of a request and
// publishes the store's own decision as one status and one stable code.

const (
	// closingsCollectionPath is the one literal path of this contract; every settlement
	// route hangs from it and the commission configuration of a branch lives below it.
	closingsCollectionPath = "/api/closings"
	// closingsCommissionPath is the commission rate of one branch. Its path is longer than a
	// settlement id, so it can never be read as one nor collide with the literal suffix of a
	// settlement operation.
	closingsCommissionPath = closingsCollectionPath + "/branches/{branch}/commission"
	// closingsExpensesPath is the branch's own till: the small expenses it pays out of it while
	// it operates. It is a literal path beside {id}, so it is never read as a settlement id, and
	// it names no settlement because the settlement that covers an expense is decided by the
	// instant the expense happened (S12).
	closingsExpensesPath = closingsCollectionPath + "/expenses"
	// closingsCorrectionsPath is the corrections of one closed settlement: the warehouse appends one
	// and the branch decides it, exactly like a round of a live settlement (S16). `corrections` is a
	// literal suffix of the settlement id, so it is never read as one.
	closingsCorrectionsPath = closingsCollectionPath + "/{id}/corrections"
	// closingsCorrectionDecisionPath is the branch's answer to one correction. A correction is named
	// by its own id and not below its settlement, because the correction is what the branch decides
	// and the database answers for the correction it locked, never for a document the path guessed.
	closingsCorrectionDecisionPath = closingsCollectionPath + "/corrections/{correction}/decision"
	// closingsBodyLimit bounds decoding work well above any admitted payload: the widest
	// settlement body is a count sheet of MaxCountLines lines plus a bounded observation,
	// far below this limit, and the check stops reading at the limit instead of buffering
	// the body whole.
	closingsBodyLimit = 32 << 10
	// closingsFirstBranch is the first branch id. The warehouse is location 1 and never
	// settles itself, so a branch below this is not a branch at all.
	closingsFirstBranch = 2
)

// NewWithClosings mounts the branch account settlement on a handler built by the purchase
// factory. The optional store keeps every existing constructor untouched: without it the
// settlement routes stay unregistered, exactly like stock ingress on the legacy factories, so
// a deployment without the store still serves every other surface unchanged.
func NewWithClosings(base http.Handler, service *auth.Service, cfg config.Auth, store *closings.Store) (http.Handler, error) {
	if base == nil || service == nil {
		return nil, closings.ErrUnavailable
	}
	parsed, err := config.ParseAuth(config.LocalTrial, cfg.Origin, cfg.Listen, cfg.TLSCert, cfg.TLSKey)
	if err != nil || parsed != cfg {
		return nil, closings.ErrUnavailable
	}
	if store == nil {
		// A missing settlement store is not a broken server: the routes are simply not
		// registered and every request is forwarded to the composed handler unchanged.
		return base, nil
	}
	api := &API{service, cfg}
	routes := api.closingRoutes(store)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		// An ambiguous settlement path is refused before the handler can set its response
		// headers, exactly like the sale, ingress and adjustment routes.
		if !closingPath(r) {
			failure(w, 404, "not_found")
			return
		}
		if closingRoute(r.URL.Path) {
			routes.ServeHTTP(w, r)
			return
		}
		base.ServeHTTP(w, r)
	}), nil
}

// closingRoute reports whether this path belongs to the settlement contract.
func closingRoute(path string) bool {
	return path == closingsCollectionPath || strings.HasPrefix(path, closingsCollectionPath+"/")
}

// closingPath refuses ambiguous settlement paths: a doubled slash, a dot segment, a
// backslash, a NUL or an encoded alias is not_found, never a silent redirect to a different
// resource. Every path outside the collection is admitted here and forwarded as is.
func closingPath(r *http.Request) bool {
	p := r.URL.Path
	if !closingRoute(p) {
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

// closingRoutes registers the settlement contract. The literal commission path is registered
// beside the {id} pattern and is never captured by it, and every operation of one settlement
// is a literal suffix of its id, so a document id is always one segment. Any other path below
// the collection is an unknown route answered as JSON, never a cleaned or redirected path.
func (a *API) closingRoutes(store *closings.Store) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc(closingsCollectionPath, a.closingCollection(store))
	mux.HandleFunc(closingsCommissionPath, a.closingSettings(store))
	mux.HandleFunc(closingsExpensesPath, a.closingExpenses(store))
	mux.HandleFunc(closingsCorrectionsPath, a.closingCorrections(store))
	mux.HandleFunc(closingsCorrectionDecisionPath, a.closingCorrectionDecision(store))
	mux.HandleFunc(closingsCollectionPath+"/{id}/count", a.closingCount(store))
	mux.HandleFunc(closingsCollectionPath+"/{id}/cash", a.closingCash(store))
	mux.HandleFunc(closingsCollectionPath+"/{id}/propose", a.closingPropose(store))
	mux.HandleFunc(closingsCollectionPath+"/{id}/decision", a.closingDecision(store))
	mux.HandleFunc(closingsCollectionPath+"/{id}", a.closingDetail(store))
	mux.HandleFunc(closingsCollectionPath+"/", func(w http.ResponseWriter, r *http.Request) {
		failure(w, 404, "not_found")
	})
	return mux
}

// closingFailure publishes the domain's own decision and nothing else. A refusal that names
// what is missing is answered with that fact beside the code, so the operator can act on the
// exact line, amount, branch or rate instead of guessing which one it was.
func closingFailure(w http.ResponseWriter, err error) {
	var pending *closings.CountPending
	var excess *closings.FundExceedsDrawer
	var retired *closings.RetiredBranch
	var notStated *closings.CashNotStated
	var reserved *closings.ReservedStock
	var moved *closings.StockMoved
	var stale *closings.StaleProposal
	var notClosed *closings.CorrectionNotClosed
	switch {
	case errors.As(err, &pending):
		closingFailureRecord(w, 409, "count_pending", "variant_id", pending.VariantID)
	case errors.As(err, &excess):
		closingFailureRecord(w, 409, "fund_exceeds_drawer", "excess", string(excess.Excess))
	case errors.As(err, &retired):
		closingFailureRecord(w, 409, "branch_retired", "branch_location_id", retired.BranchID)
	case errors.As(err, &notStated):
		failure(w, 409, "cash_not_stated")
	case errors.As(err, &reserved):
		// The closure is refused by a reservation of the branch, and the refusal names the
		// variant that is still owed to a transfer, exactly like the pending line does (S5).
		closingFailureRecord(w, 409, "reserved_stock", "variant_id", reserved.VariantID)
	case errors.As(err, &moved):
		// A variant moved during the settlement, so the count is stale: the warehouse recounts
		// that line instead of reading an outage (S5).
		closingFailureRecord(w, 409, "stock_moved", "variant_id", moved.VariantID)
	case errors.As(err, &stale):
		// The count sheet changed while the offer was being recorded, so the settlement is
		// re-read and proposed again; the refusal names the variant that is pending again.
		closingFailureRecord(w, 409, "proposal_stale", "variant_id", stale.VariantID)
	case errors.As(err, &notClosed):
		// A correction belongs to a closed settlement, and a live one is corrected by its own
		// proposal rounds: the refusal names the document the operator has to look at (LC012).
		closingFailureRecord(w, 409, "correction_not_closed", "closing_id", notClosed.ClosingID)
	case errors.Is(err, closings.ErrNoCommissionRate):
		// The missing fact is the rate itself, which is what the code names: without it no
		// branch can be proposed (S6).
		failure(w, 409, "commission_rate_missing")
	case errors.Is(err, closings.ErrCountFrozen):
		failure(w, 409, "count_frozen")
	case errors.Is(err, closings.ErrStateConflict):
		failure(w, 409, "state_conflict")
	case errors.Is(err, closings.ErrClosureRefused):
		failure(w, 409, "closure_refused")
	case errors.Is(err, closings.ErrReservedStock):
		failure(w, 409, "reserved_stock")
	case errors.Is(err, closings.ErrStockMoved):
		failure(w, 409, "stock_moved")
	case errors.Is(err, closings.ErrProposalStale):
		failure(w, 409, "proposal_stale")
	case errors.Is(err, closings.ErrRoundNotAccepted):
		failure(w, 409, "round_not_accepted")
	case errors.Is(err, closings.ErrCorrectionNotClosed):
		// Only a closed settlement is corrected (LC012).
		failure(w, 409, "correction_not_closed")
	case errors.Is(err, closings.ErrCorrectionDecided):
		// A correction is decided once, and a decided one is final (LC013).
		failure(w, 409, "correction_decided")
	case errors.Is(err, closings.ErrCorrectionPending):
		// One correction waits at a time: the second one is refused until the branch answers the
		// first (the one-pending index of 034).
		failure(w, 409, "correction_pending")
	case errors.Is(err, closings.ErrCorrectionPayload):
		// The payload is not one this domain applies: a value of the wrong shape, or a variant the
		// closed settlement never counted (LC021).
		failure(w, 409, "correction_payload")
	case errors.Is(err, closings.ErrCorrectionFundStarted):
		// The next period already inherited its opening cash from the recorded fund (LC022).
		failure(w, 409, "correction_fund_started")
	case errors.Is(err, closings.ErrCorrectionJournal):
		// A delta is journalled by the acceptance of its own correction and by nothing else
		// (LC023).
		failure(w, 409, "correction_journal")
	case errors.Is(err, closings.ErrBranchFrozen):
		// The settlement holding the branch is what froze it, and the code names the freeze
		// instead of reporting a generic state conflict (LC001, S3, S12).
		failure(w, 409, "branch_frozen")
	case errors.Is(err, closings.ErrNotBranchExpense):
		// The till of an expense is the branch's own, so the warehouse recording one is not the
		// actor of this operation (LC011).
		failure(w, 403, "forbidden")
	case errors.Is(err, closings.ErrInvalid):
		failure(w, 400, "invalid_request")
	case errors.Is(err, closings.ErrForbidden):
		failure(w, 403, "forbidden")
	case errors.Is(err, closings.ErrNotFound):
		failure(w, 404, "not_found")
	default:
		failure(w, 503, "service_unavailable")
	}
}

// closingFailureRecord answers a refusal with the fact it is about. The code is the one
// closingFailure publishes for that class, so a refusal has exactly one status and one code;
// the companion key is what makes it actionable.
func closingFailureRecord(w http.ResponseWriter, status int, code, key string, value any) {
	respond(w, status, map[string]any{"error": code, key: value})
}

// closingOpenFailure refuses a second live settlement of a branch by naming both the branch and
// the settlement that already holds it, which is the document the operator has to read or close.
// A conflict whose document the store could not read still names the branch, so the refusal is
// always actionable and never invents a document id.
func closingOpenFailure(w http.ResponseWriter, err error, branchID int64) {
	var conflict *closings.LiveConflict
	switch {
	case errors.As(err, &conflict):
		respond(w, 409, map[string]any{"error": "settlement_live",
			"branch_location_id": branchID, "closing_id": conflict.ClosingID})
	case errors.Is(err, closings.ErrLiveConflict):
		closingFailureRecord(w, 409, "settlement_live", "branch_location_id", branchID)
	default:
		closingFailure(w, err)
	}
}

// closingDecoder admits one canonical JSON body of this contract: exactly one Content-Type,
// application/json with at most a utf-8 charset, a body inside the limit, valid UTF-8, and a
// decoder that keeps numbers as text so no binary float ever touches an amount.
func closingDecoder(r *http.Request) (*json.Decoder, error) {
	if r == nil || r.Body == nil || len(r.Header.Values("Content-Type")) != 1 {
		return nil, closings.ErrInvalid
	}
	contentType := r.Header.Get("Content-Type")
	media, params, err := mime.ParseMediaType(contentType)
	// MIME parsing collapses identical duplicate parameters and admits a trailing separator;
	// neither is an unambiguous framing here.
	if err != nil || media != "application/json" || len(params) > 1 ||
		strings.Count(contentType, ";") != len(params) {
		return nil, closings.ErrInvalid
	}
	for key, value := range params {
		if key != "charset" || !strings.EqualFold(value, "utf-8") {
			return nil, closings.ErrInvalid
		}
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, closingsBodyLimit+1))
	if err != nil || len(body) > closingsBodyLimit || !utf8.Valid(body) {
		return nil, closings.ErrInvalid
	}
	d := json.NewDecoder(bytes.NewReader(body))
	d.UseNumber()
	return d, nil
}

// closingEmptyBody admits an operation that takes no argument at all: a proposal states
// nothing the store does not already know, so any body is a framing error and never a silently
// ignored document.
func closingEmptyBody(r *http.Request) error {
	if r == nil || r.Body == nil {
		return nil
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1))
	if err != nil || len(body) != 0 {
		return closings.ErrInvalid
	}
	return nil
}

// closingString is the transfer contract's strict token reader with this domain's own refusal,
// so an invalid body never surfaces another package's error.
func closingString(d *json.Decoder) (string, error) {
	if value, err := transferString(d); err == nil {
		return value, nil
	}
	return "", closings.ErrInvalid
}

func closingDelimiter(d *json.Decoder, want json.Delim) bool {
	return transferDelimiter(d, want)
}

// closingWhole reads a canonical whole number: decimal digits only, no sign, no padding, no
// fraction and a hard upper bound.
func closingWhole(value string, max int64) (int64, error) {
	if len(value) == 0 || len(value) > 19 || value[0] < '1' || value[0] > '9' {
		return 0, closings.ErrInvalid
	}
	for _, c := range value {
		if c < '0' || c > '9' {
			return 0, closings.ErrInvalid
		}
	}
	n, err := strconv.ParseInt(value, 10, 64)
	if err != nil || n > max {
		return 0, closings.ErrInvalid
	}
	return n, nil
}

// closingID reads a canonical identifier: a settlement id and a branch id are never zero and
// never padded.
func closingID(d *json.Decoder, max int64) (int64, error) {
	token, err := d.Token()
	if err != nil {
		return 0, closings.ErrInvalid
	}
	number, ok := token.(json.Number)
	if !ok {
		return 0, closings.ErrInvalid
	}
	return closingWhole(string(number), max)
}

// closingCounted reads one counted quantity: zero is a legitimate result of a physical count,
// while a negative, padded or differently typed value is never a promise the client may make.
func closingCounted(d *json.Decoder) (int64, error) {
	token, err := d.Token()
	if err != nil {
		return 0, closings.ErrInvalid
	}
	number, ok := token.(json.Number)
	if !ok {
		return 0, closings.ErrInvalid
	}
	if string(number) == "0" {
		return 0, nil
	}
	return closingWhole(string(number), closings.MaxCounted)
}

// closingAmount admits the canonical two-decimal text this contract publishes: a value that
// would not round-trip is never a promise of this domain.
func closingAmount(d *json.Decoder) (closings.Money, error) {
	text, err := closingString(d)
	if err != nil {
		return "", closings.ErrInvalid
	}
	amount, err := closings.ParseAmount(text)
	if err != nil || string(amount) != text {
		return "", closings.ErrInvalid
	}
	return amount, nil
}

// closingOptionalAmount admits a money field that may still be uncounted, which the draft of
// the drawer states as JSON null and never as an invented zero.
func closingOptionalAmount(d *json.Decoder) (*closings.Money, error) {
	token, err := d.Token()
	if err != nil {
		return nil, closings.ErrInvalid
	}
	if token == nil {
		return nil, nil
	}
	text, ok := token.(string)
	if !ok {
		return nil, closings.ErrInvalid
	}
	amount, err := closings.ParseAmount(text)
	if err != nil || string(amount) != text {
		return nil, closings.ErrInvalid
	}
	return &amount, nil
}

// closingPercent admits the configured commission percentage: canonical two-decimal text
// between 0 and 100, exactly like the column it is stored in.
func closingPercent(d *json.Decoder) (closings.Percent, error) {
	text, err := closingString(d)
	if err != nil {
		return "", closings.ErrInvalid
	}
	rate, err := closings.ParsePercent(text)
	if err != nil || string(rate) != text {
		return "", closings.ErrInvalid
	}
	return rate, nil
}

// decodeClosingOpen reads the opening request: the branch to settle and nothing else. The cut
// instant, the period start, the inherited fund and the expected snapshot are the database's
// own facts, so no client can promise them.
func decodeClosingOpen(r *http.Request) (int64, error) {
	d, err := closingDecoder(r)
	if err != nil || !closingDelimiter(d, '{') {
		return 0, closings.ErrInvalid
	}
	var branch int64
	seen := map[string]bool{}
	for d.More() {
		key, err := closingString(d)
		if err != nil || seen[key] {
			return 0, closings.ErrInvalid
		}
		seen[key] = true
		if key != "branch_location_id" {
			return 0, closings.ErrInvalid
		}
		if branch, err = closingID(d, closings.MaxBranchID); err != nil || branch < closingsFirstBranch {
			return 0, closings.ErrInvalid
		}
	}
	if !seen["branch_location_id"] || !closingDelimiter(d, '}') {
		return 0, closings.ErrInvalid
	}
	if _, err := d.Token(); err != io.EOF {
		return 0, closings.ErrInvalid
	}
	return branch, nil
}

// decodeClosingSettings reads the commission configuration: the percentage and nothing else.
// The branch is in the path, so the body cannot disagree with it.
func decodeClosingSettings(r *http.Request) (closings.Percent, error) {
	d, err := closingDecoder(r)
	if err != nil || !closingDelimiter(d, '{') {
		return "", closings.ErrInvalid
	}
	var rate closings.Percent
	seen := map[string]bool{}
	for d.More() {
		key, err := closingString(d)
		if err != nil || seen[key] {
			return "", closings.ErrInvalid
		}
		seen[key] = true
		if key != "commission_rate_percent" {
			return "", closings.ErrInvalid
		}
		if rate, err = closingPercent(d); err != nil {
			return "", closings.ErrInvalid
		}
	}
	if !seen["commission_rate_percent"] || !closingDelimiter(d, '}') {
		return "", closings.ErrInvalid
	}
	if _, err := d.Token(); err != io.EOF {
		return "", closings.ErrInvalid
	}
	return rate, nil
}

// decodeClosingCount reads the count sheet: what was counted, per variant, and nothing else.
// The expected quantity, the difference and the branch are not part of this body at all, so a
// blinded count cannot even be expressed.
func decodeClosingCount(r *http.Request) ([]closings.Counted, error) {
	d, err := closingDecoder(r)
	if err != nil || !closingDelimiter(d, '{') {
		return nil, closings.ErrInvalid
	}
	var lines []closings.Counted
	seen := map[string]bool{}
	for d.More() {
		key, err := closingString(d)
		if err != nil || seen[key] {
			return nil, closings.ErrInvalid
		}
		seen[key] = true
		if key != "lines" {
			return nil, closings.ErrInvalid
		}
		if lines, err = closingCountLines(d); err != nil {
			return nil, closings.ErrInvalid
		}
	}
	if !seen["lines"] || !closingDelimiter(d, '}') {
		return nil, closings.ErrInvalid
	}
	if _, err := d.Token(); err != io.EOF {
		return nil, closings.ErrInvalid
	}
	variants := make(map[int64]bool, len(lines))
	for _, line := range lines {
		if variants[line.VariantID] {
			return nil, closings.ErrInvalid
		}
		variants[line.VariantID] = true
	}
	return lines, nil
}

// closingCountLines reads the counted lines: exact names, presence, types and duplicate keys at
// every object level, one line per variant, inside the database's own bounds.
func closingCountLines(d *json.Decoder) ([]closings.Counted, error) {
	if !closingDelimiter(d, '[') {
		return nil, closings.ErrInvalid
	}
	lines := make([]closings.Counted, 0)
	for d.More() {
		if len(lines) >= closings.MaxCountLines || !closingDelimiter(d, '{') {
			return nil, closings.ErrInvalid
		}
		var line closings.Counted
		seen := map[string]bool{}
		for d.More() {
			key, err := closingString(d)
			if err != nil || seen[key] {
				return nil, closings.ErrInvalid
			}
			seen[key] = true
			switch key {
			case "variant_id":
				line.VariantID, err = closingID(d, math.MaxInt32)
			case "counted_quantity":
				line.Quantity, err = closingCounted(d)
			default:
				return nil, closings.ErrInvalid
			}
			if err != nil {
				return nil, closings.ErrInvalid
			}
		}
		if len(seen) != 2 || !closingDelimiter(d, '}') {
			return nil, closings.ErrInvalid
		}
		lines = append(lines, line)
	}
	if len(lines) == 0 || !closingDelimiter(d, ']') {
		return nil, closings.ErrInvalid
	}
	return lines, nil
}

// decodeClosingCash reads the draft of the drawer: what the warehouse counted, the contribution
// it made, the fund it leaves behind and its observation. The cash sales and the cash expenses
// of the period are the ledgers' own facts, so they are not part of this body at all, exactly
// like the derived amounts the store computes on read.
func decodeClosingCash(r *http.Request) (closings.CashDraft, error) {
	draft := closings.CashDraft{}
	d, err := closingDecoder(r)
	if err != nil || !closingDelimiter(d, '{') {
		return closings.CashDraft{}, closings.ErrInvalid
	}
	seen := map[string]bool{}
	for d.More() {
		key, err := closingString(d)
		if err != nil || seen[key] {
			return closings.CashDraft{}, closings.ErrInvalid
		}
		seen[key] = true
		switch key {
		case "counted_cash":
			draft.CountedCash, err = closingOptionalAmount(d)
		case "contributed_cash":
			draft.ContributedCash, err = closingAmount(d)
		case "closing_cash":
			draft.ClosingCash, err = closingOptionalAmount(d)
		case "observation":
			draft.Observation, err = closingString(d)
		default:
			return closings.CashDraft{}, closings.ErrInvalid
		}
		if err != nil {
			return closings.CashDraft{}, closings.ErrInvalid
		}
	}
	// Every key is mandatory, so a draft states the drawer whole: an absent key would be an
	// omitted fact and not an uncounted amount, which is the JSON null of this contract.
	if len(seen) != 4 || !closingDelimiter(d, '}') {
		return closings.CashDraft{}, closings.ErrInvalid
	}
	if _, err := d.Token(); err != io.EOF {
		return closings.CashDraft{}, closings.ErrInvalid
	}
	if !closings.ValidObservation(draft.Observation) {
		return closings.CashDraft{}, closings.ErrInvalid
	}
	return draft, nil
}

// decodeClosingExpense reads the expense of a branch: the amount it paid out of its till and what
// for, and nothing else. The branch is the session's own account and the instant is the database's,
// so neither is part of this body: a caller can never record an expense in another till nor
// backdate one into a settled period.
func decodeClosingExpense(r *http.Request) (closings.Money, string, error) {
	d, err := closingDecoder(r)
	if err != nil || !closingDelimiter(d, '{') {
		return "", "", closings.ErrInvalid
	}
	var amount closings.Money
	var description string
	seen := map[string]bool{}
	for d.More() {
		key, err := closingString(d)
		if err != nil || seen[key] {
			return "", "", closings.ErrInvalid
		}
		seen[key] = true
		switch key {
		case "amount":
			amount, err = closingAmount(d)
		case "description":
			description, err = closingString(d)
		default:
			return "", "", closings.ErrInvalid
		}
		if err != nil {
			return "", "", closings.ErrInvalid
		}
	}
	// Both keys are mandatory: an expense states its amount and what it was for.
	if len(seen) != 2 || !closingDelimiter(d, '}') {
		return "", "", closings.ErrInvalid
	}
	if _, err := d.Token(); err != io.EOF {
		return "", "", closings.ErrInvalid
	}
	// The description is persisted verbatim, so it is exactly the canonical text the ledger admits:
	// trimmed, never blank and inside its own bound.
	canonical, ok := closings.CanonicalDescription(description)
	if !ok || canonical != description {
		return "", "", closings.ErrInvalid
	}
	return amount, canonical, nil
}

// decodeClosingDecision reads the branch's answer: accept, or reject with its mandatory motive.
// The two decisions are exclusive, so an acceptance that carries a reason is a malformed answer
// and not an accepted one with a stray field.
func decodeClosingDecision(r *http.Request) (closings.Decision, string, error) {
	d, err := closingDecoder(r)
	if err != nil || !closingDelimiter(d, '{') {
		return "", "", closings.ErrInvalid
	}
	var decision closings.Decision
	var reason string
	seen := map[string]bool{}
	for d.More() {
		key, err := closingString(d)
		if err != nil || seen[key] {
			return "", "", closings.ErrInvalid
		}
		seen[key] = true
		switch key {
		case "decision":
			var text string
			if text, err = closingString(d); err == nil {
				decision = closings.Decision(text)
			}
		case "reason":
			reason, err = closingString(d)
		default:
			return "", "", closings.ErrInvalid
		}
		if err != nil {
			return "", "", closings.ErrInvalid
		}
	}
	if !seen["decision"] || !closingDelimiter(d, '}') {
		return "", "", closings.ErrInvalid
	}
	if _, err := d.Token(); err != io.EOF {
		return "", "", closings.ErrInvalid
	}
	switch decision {
	case closings.DecisionRejected:
		// The motive is named by the branch, so it is exactly the canonical text that is
		// persisted: trimmed and non-blank, inside the database's bound.
		if !seen["reason"] {
			return "", "", closings.ErrInvalid
		}
		canonical, ok := closings.CanonicalReason(reason)
		if !ok || canonical != reason {
			return "", "", closings.ErrInvalid
		}
		return decision, canonical, nil
	case closings.DecisionAccepted:
		if seen["reason"] {
			return "", "", closings.ErrInvalid
		}
		return decision, "", nil
	}
	return "", "", closings.ErrInvalid
}

// decodeClosingCorrection reads the warehouse's correction of a closed settlement: the mandatory
// reason it corrects for and the payload of values it corrects. Every value of the payload is
// optional and at least one is stated, because a correction never restates a number it does not
// touch; a null is never an uncounted amount here, it is simply an absent value (S16).
func decodeClosingCorrection(r *http.Request) (closings.CorrectionOffer, string, error) {
	d, err := closingDecoder(r)
	if err != nil || !closingDelimiter(d, '{') {
		return closings.CorrectionOffer{}, "", closings.ErrInvalid
	}
	var offer closings.CorrectionOffer
	var reason string
	seen := map[string]bool{}
	for d.More() {
		key, err := closingString(d)
		if err != nil || seen[key] {
			return closings.CorrectionOffer{}, "", closings.ErrInvalid
		}
		seen[key] = true
		switch key {
		case "reason":
			reason, err = closingString(d)
		case "payload":
			offer, err = closingCorrectionPayload(d)
		default:
			return closings.CorrectionOffer{}, "", closings.ErrInvalid
		}
		if err != nil {
			return closings.CorrectionOffer{}, "", closings.ErrInvalid
		}
	}
	// Both keys are mandatory: a correction states why it is made and what it corrects.
	if len(seen) != 2 || !closingDelimiter(d, '}') {
		return closings.CorrectionOffer{}, "", closings.ErrInvalid
	}
	if _, err := d.Token(); err != io.EOF {
		return closings.CorrectionOffer{}, "", closings.ErrInvalid
	}
	// The reason is the warehouse's own and is persisted as written, so exactly the canonical text
	// the table admits: trimmed, never blank and inside its bound.
	canonical, ok := closings.CanonicalReason(reason)
	if !ok || canonical != reason {
		return closings.CorrectionOffer{}, "", closings.ErrInvalid
	}
	if !offer.Stated() {
		return closings.CorrectionOffer{}, "", closings.ErrInvalid
	}
	return offer, canonical, nil
}

// closingCorrectionPayload reads the four values a correction can state: the counted quantities,
// the counted cash, the commission and the fund. A money value is canonical two-decimal text and
// never a JSON number, and a counted sheet is the same one the count route admits.
func closingCorrectionPayload(d *json.Decoder) (closings.CorrectionOffer, error) {
	offer := closings.CorrectionOffer{}
	if !closingDelimiter(d, '{') {
		return offer, closings.ErrInvalid
	}
	seen := map[string]bool{}
	for d.More() {
		key, err := closingString(d)
		if err != nil || seen[key] {
			return closings.CorrectionOffer{}, closings.ErrInvalid
		}
		seen[key] = true
		switch key {
		case "counted_quantities":
			// One line per variant: a correction that corrected the same variant twice would apply
			// two differences against one recorded quantity.
			if offer.CountedQuantities, err = closingCountLines(d); err == nil {
				variants := make(map[int64]bool, len(offer.CountedQuantities))
				for _, line := range offer.CountedQuantities {
					if variants[line.VariantID] {
						err = closings.ErrInvalid
						break
					}
					variants[line.VariantID] = true
				}
			}
		case "counted_cash":
			var amount closings.Money
			if amount, err = closingAmount(d); err == nil {
				offer.CountedCash = &amount
			}
		case "commission_amount":
			var amount closings.Money
			if amount, err = closingAmount(d); err == nil {
				offer.CommissionAmount = &amount
			}
		case "closing_cash":
			var amount closings.Money
			if amount, err = closingAmount(d); err == nil {
				offer.ClosingCash = &amount
			}
		default:
			return closings.CorrectionOffer{}, closings.ErrInvalid
		}
		if err != nil {
			return closings.CorrectionOffer{}, closings.ErrInvalid
		}
	}
	if !closingDelimiter(d, '}') || !offer.Stated() {
		return closings.CorrectionOffer{}, closings.ErrInvalid
	}
	return offer, nil
}

// closingPathID admits one canonical identifier of a path segment: a padded, signed, zero,
// fractional or aliased spelling is a malformed request, never a cleaned id.
func closingPathID(value string, max int64) (int64, error) {
	return closingWhole(value, max)
}

// closingPathBranch admits the branch of the settings path. The warehouse never settles itself,
// so the bound starts at the first branch.
func closingPathBranch(value string) (int64, error) {
	branch, err := closingPathID(value, closings.MaxBranchID)
	if err != nil || branch < closingsFirstBranch {
		return 0, closings.ErrInvalid
	}
	return branch, nil
}

// closingSettingsDTO is the commission configuration of one branch: the branch it belongs to and
// the percentage its settlement pays on the sales total of a period.
type closingSettingsDTO struct {
	BranchID       int64  `json:"branch_location_id"`
	CommissionRate string `json:"commission_rate_percent"`
}

// closingSettingsRecord admits only a canonical setting: a branch inside the column range and
// the exact percentage the database stores.
func closingSettingsRecord(settings closings.Settings) (closingSettingsDTO, error) {
	unavailable := func() (closingSettingsDTO, error) { return closingSettingsDTO{}, closings.ErrUnavailable }
	rate, err := closings.ParsePercent(string(settings.CommissionRatePercent))
	if settings.BranchID < closingsFirstBranch || settings.BranchID > closings.MaxBranchID || err != nil ||
		string(rate) != string(settings.CommissionRatePercent) {
		return unavailable()
	}
	return closingSettingsDTO{BranchID: settings.BranchID, CommissionRate: string(rate)}, nil
}

// closingCountLineDTO is one line of the count sheet with the catalogue identity of its variant,
// so the sheet is legible without a second lookup. counted_quantity is JSON null while the
// variant is still pending, which is what blocks the proposal.
type closingCountLineDTO struct {
	VariantID        int64  `json:"variant_id"`
	CatalogEntryID   int64  `json:"catalog_entry_id"`
	Brand            string `json:"brand"`
	Model            string `json:"model"`
	Capacity         string `json:"capacity_ah"`
	Polarity         string `json:"polarity"`
	ExpectedQuantity int64  `json:"expected_quantity"`
	CountedQuantity  *int64 `json:"counted_quantity"`
}

// closingExpenseDTO is one recorded expense of a branch's till: what it paid out, what for, when it
// was recorded and by which account. It is the same shape inside the settlement document and in the
// answer of the route that records it, so the operator reads one thing in both places.
type closingExpenseDTO struct {
	ID                 int64  `json:"id"`
	BranchLocationID   int64  `json:"branch_location_id"`
	Amount             string `json:"amount"`
	Description        string `json:"description"`
	OccurredAt         string `json:"occurred_at"`
	CreatedByAccountID int64  `json:"created_by_account_id"`
}

// closingOfferLineDTO is one line of an offer: what the system expected at the cut and what the
// warehouse counted, both stated, because the branch is accepting that arithmetic.
type closingOfferLineDTO struct {
	VariantID        int64 `json:"variant_id"`
	ExpectedQuantity int64 `json:"expected_quantity"`
	CountedQuantity  int64 `json:"counted_quantity"`
}

// closingCorrectionLineDTO is one corrected quantity: the variant and the number the warehouse says
// it counted, which is a difference against the settlement's own count sheet.
type closingCorrectionLineDTO struct {
	VariantID       int64 `json:"variant_id"`
	CountedQuantity int64 `json:"counted_quantity"`
}

// closingCorrectionPayloadDTO is the payload of one correction exactly as the warehouse offered it:
// the counted quantities, the counted cash, the commission and the fund. A value the correction
// does not touch stays absent instead of restating the signed one, so a client reads which numbers
// this correction rewrote (S16).
type closingCorrectionPayloadDTO struct {
	CountedQuantities []closingCorrectionLineDTO `json:"counted_quantities,omitempty"`
	CountedCash       string                     `json:"counted_cash,omitempty"`
	CommissionAmount  string                     `json:"commission_amount,omitempty"`
	ClosingCash       string                     `json:"closing_cash,omitempty"`
}

// closingCorrectionEffectDTO is one delta an accepted correction applied. Exactly one of the two
// deltas is set, so an effect is never read as the wrong unit: a count carries its variant and a
// quantity, money carries a signed amount that both directions of a correction produce.
type closingCorrectionEffectDTO struct {
	Kind          string  `json:"kind"`
	VariantID     *int64  `json:"variant_id"`
	QuantityDelta *int64  `json:"quantity_delta"`
	AmountDelta   *string `json:"amount_delta"`
}

// closingCorrectionDTO is one correction of a closed settlement: the reason the warehouse stated,
// the payload it offered, the branch's answer and the deltas that answer applied. The document
// publishes the accepted ones beside the corrected numbers they produced, so a corrected number is
// legible as the result of a correction and the signed one is recoverable from the delta (S16).
type closingCorrectionDTO struct {
	ID                  int64                        `json:"id"`
	ClosingID           int64                        `json:"closing_id"`
	Status              string                       `json:"status"`
	Reason              string                       `json:"reason"`
	Payload             closingCorrectionPayloadDTO  `json:"payload"`
	ProposedByAccountID int64                        `json:"proposed_by_account_id"`
	ProposedAt          string                       `json:"proposed_at"`
	DecidedByAccountID  *int64                       `json:"decided_by_account_id"`
	DecidedAt           *string                      `json:"decided_at"`
	DecisionReason      string                       `json:"decision_reason"`
	Effects             []closingCorrectionEffectDTO `json:"effects"`
}

// closingOfferDTO is one round's offer exactly as it was stored: the period, the collection by
// payment method, the reported commission of the period and the drawer. The commission is a
// reported amount and participates in no cash identity (S9); qr_total is money the branch
// collected and never holds in its drawer (S13). The offer's own period is frozen, so the
// drawer it states is published as it was offered and never recomputed against today's rates.
type closingOfferDTO struct {
	PeriodStart           string                `json:"period_start"`
	CutAt                 string                `json:"cut_at"`
	SalesTotal            string                `json:"sales_total"`
	CommissionRatePercent string                `json:"commission_rate_percent"`
	CommissionAmount      string                `json:"commission_amount"`
	CashSales             string                `json:"cash_sales"`
	CashExpenses          string                `json:"cash_expenses"`
	CardTotal             string                `json:"card_total"`
	TransferTotal         string                `json:"transfer_total"`
	QRTotal               string                `json:"qr_total"`
	CountedCash           *string               `json:"counted_cash"`
	ContributedCash       string                `json:"contributed_cash"`
	ClosingCash           *string               `json:"closing_cash"`
	Observation           string                `json:"observation"`
	CountLines            []closingOfferLineDTO `json:"count_lines"`
}

// closingRoundDTO is one proposal round with the branch's answer, if it has one. Rounds are
// numbered by the database and never rewritten, so the whole history stays legible (S15).
type closingRoundDTO struct {
	ID                  int64           `json:"id"`
	Round               int             `json:"round"`
	Offer               closingOfferDTO `json:"offer"`
	ProposedByAccountID int64           `json:"proposed_by_account_id"`
	ProposedAt          string          `json:"proposed_at"`
	Decision            string          `json:"decision"`
	DecisionReason      string          `json:"decision_reason"`
	DecidedByAccountID  *int64          `json:"decided_by_account_id"`
	DecidedAt           *string         `json:"decided_at"`
}

// closingDTO is one settlement exactly as this contract publishes it. The derived numbers are the
// drawer's and are computed on read: expected_cash is the inherited fund plus the cash sales minus
// the cash expenses of the period, cash_difference is the counted cash against it with its sign
// (negative is a shortage), and taken_cash is what the warehouse takes out of the till.
// commission_amount and the electronic collections are reported beside them and are added to none
// of them.
type closingDTO struct {
	ID                    int64                 `json:"id"`
	BranchLocationID      int64                 `json:"branch_location_id"`
	BranchName            string                `json:"branch_name"`
	Status                string                `json:"status"`
	PeriodStart           string                `json:"period_start"`
	CutAt                 string                `json:"cut_at"`
	ClosedAt              *string               `json:"closed_at"`
	CommissionRatePercent *string               `json:"commission_rate_percent"`
	OpeningCash           string                `json:"opening_cash"`
	CashSales             string                `json:"cash_sales"`
	CashExpenses          string                `json:"cash_expenses"`
	ExpectedCash          string                `json:"expected_cash"`
	CountedCash           *string               `json:"counted_cash"`
	CashDifference        *string               `json:"cash_difference"`
	ContributedCash       string                `json:"contributed_cash"`
	ClosingCash           *string               `json:"closing_cash"`
	TakenCash             *string               `json:"taken_cash"`
	SalesTotal            string                `json:"sales_total"`
	CommissionAmount      string                `json:"commission_amount"`
	CardTotal             string                `json:"card_total"`
	TransferTotal         string                `json:"transfer_total"`
	QRTotal               string                `json:"qr_total"`
	Observation           string                `json:"observation"`
	OpenedByAccountID     int64                 `json:"opened_by_account_id"`
	CountLines            []closingCountLineDTO `json:"count_lines"`
	// Expenses are the small expenses of the window this settlement covers, in the order the branch
	// recorded them (S12). They are the facts its cash_expenses total was computed from, so the
	// warehouse sees what it subtracts and the branch what it is charged for.
	Expenses []closingExpenseDTO `json:"expenses"`
	Rounds   []closingRoundDTO   `json:"rounds"`
	// Corrections are the accepted corrections of the closed settlement, oldest first: each one with
	// the reason the warehouse stated, the branch's answer, the payload it offered and the deltas it
	// applied. The drawer above is the signed one plus those deltas, so the document publishes a
	// corrected number as corrected and the delta that produced it beside it (S16). A live
	// settlement publishes none: it is corrected by its own rounds, not after the fact.
	Corrections []closingCorrectionDTO `json:"corrections"`
}

// closingExpenseRecord admits only a complete recorded expense: an amount the till can hold, a
// description the ledger admits, the branch it belongs to and the account that recorded it.
func closingExpenseRecord(expense closings.Expense) (closingExpenseDTO, error) {
	unavailable := func() (closingExpenseDTO, error) { return closingExpenseDTO{}, closings.ErrUnavailable }
	amount, ok := closingAmountText(expense.Amount)
	if !ok {
		return unavailable()
	}
	description, ok := closings.CanonicalDescription(expense.Description)
	// A canonical amount of exactly "0.00" is the only non-positive amount canonical text can
	// hold, and an expense is never zero.
	if !ok || description != expense.Description || amount == "0.00" || expense.ID < 1 ||
		expense.BranchID < closingsFirstBranch || expense.BranchID > closings.MaxBranchID ||
		expense.CreatedByAccountID < 1 {
		return unavailable()
	}
	occurred, ok := closingMoment(expense.OccurredAt)
	if !ok {
		return unavailable()
	}
	return closingExpenseDTO{ID: expense.ID, BranchLocationID: expense.BranchID, Amount: amount,
		Description: description, OccurredAt: occurred, CreatedByAccountID: expense.CreatedByAccountID}, nil
}

// closingAmountText admits only the canonical two-decimal text this contract publishes.
func closingAmountText(amount closings.Money) (string, bool) {
	canonical, err := closings.ParseAmount(string(amount))
	if err != nil || string(canonical) != string(amount) {
		return "", false
	}
	return string(canonical), true
}

// closingSignedText admits only a canonical signed amount, which is what a derived number always
// is.
func closingSignedText(amount closings.Signed) (string, bool) {
	text := amount.String()
	if text == "" {
		return "", false
	}
	return text, true
}

// closingText admits the free text of this domain: valid UTF-8 without a NUL.
func closingText(value string) bool {
	return utf8.ValidString(value) && !strings.ContainsRune(value, 0)
}

// closingMoment renders one persisted instant as RFC3339 in UTC, refusing a zero.
func closingMoment(moment time.Time) (string, bool) {
	if moment.IsZero() {
		return "", false
	}
	return moment.UTC().Format(time.RFC3339), true
}

// closingOptionalAmountRecord admits one amount the warehouse has not stated yet, which is JSON
// null and never an invented zero.
func closingOptionalAmountRecord(amount *closings.Money) (*string, bool) {
	if amount == nil {
		return nil, true
	}
	text, ok := closingAmountText(*amount)
	if !ok {
		return nil, false
	}
	return &text, true
}

// closingRecord admits only a complete persisted settlement: the identity of the branch, the
// state machine, the money of the period, the drawer and the derived numbers, all of them
// recomputed here, so a stored shape that disagrees with its own facts is never published.
func closingRecord(closing closings.Closing) (closingDTO, error) {
	unavailable := func() (closingDTO, error) { return closingDTO{}, closings.ErrUnavailable }
	if closing.ID < 1 || closing.BranchID < closingsFirstBranch ||
		closing.BranchID > closings.MaxBranchID || closing.BranchName == "" ||
		!closingText(closing.BranchName) || !closing.Status.Valid() ||
		closing.OpenedByAccountID < 1 || !closings.ValidObservation(closing.Observation) ||
		len(closing.CountLines) > closings.MaxCountLines {
		return unavailable()
	}
	periodStart, ok := closingMoment(closing.PeriodStart)
	if !ok {
		return unavailable()
	}
	cutAt, ok := closingMoment(closing.CutAt)
	if !ok || closing.CutAt.Before(closing.PeriodStart) {
		return unavailable()
	}
	// Only a closed settlement has a closure instant, and every closed one has it: the database
	// stamps both in the same transition.
	var closedAt *string
	if closing.Status == closings.StatusClosed {
		if closing.ClosedAt == nil {
			return unavailable()
		}
		moment, ok := closingMoment(*closing.ClosedAt)
		if !ok {
			return unavailable()
		}
		closedAt = &moment
	} else if closing.ClosedAt != nil {
		return unavailable()
	}
	// The rate is frozen when the warehouse proposes (S6): a settlement it still holds states
	// none, and every settlement that was ever proposed keeps the rate of its first offer.
	var rate *string
	if closing.CommissionRatePercent != nil {
		canonical, err := closings.ParsePercent(string(*closing.CommissionRatePercent))
		if err != nil || string(canonical) != string(*closing.CommissionRatePercent) {
			return unavailable()
		}
		if closing.Status == closings.StatusOpen {
			return unavailable()
		}
		text := string(canonical)
		rate = &text
	} else if closing.Status != closings.StatusOpen {
		return unavailable()
	}
	amounts := make([]string, 0, 9)
	for _, amount := range []closings.Money{closing.OpeningCash, closing.CashSales,
		closing.CashExpenses, closing.SalesTotal, closing.CommissionAmount, closing.CardTotal,
		closing.TransferTotal, closing.QRTotal, closing.ContributedCash} {
		text, ok := closingAmountText(amount)
		if !ok {
			return unavailable()
		}
		amounts = append(amounts, text)
	}
	countedCash, ok := closingOptionalAmountRecord(closing.CountedCash)
	if !ok {
		return unavailable()
	}
	closingCash, ok := closingOptionalAmountRecord(closing.ClosingCash)
	if !ok {
		return unavailable()
	}
	// The derived numbers are published as they are computed, and only from the facts that
	// produce them: a stored shape that disagrees is never shown to an operator. The commission is
	// inside none of these identities (S9).
	expected, err := closings.ExpectedCash(closing.OpeningCash, closing.CashSales, closing.CashExpenses)
	if err != nil || expected != closing.ExpectedCash {
		return unavailable()
	}
	expectedText, ok := closingSignedText(expected)
	if !ok {
		return unavailable()
	}
	var differenceText, takenText *string
	switch {
	case closing.CountedCash == nil:
		if closing.CashDifference != nil || closing.TakenCash != nil {
			return unavailable()
		}
	default:
		difference, err := closings.CashDifference(*closing.CountedCash, expected)
		if err != nil || closing.CashDifference == nil || difference != *closing.CashDifference {
			return unavailable()
		}
		text, ok := closingSignedText(difference)
		if !ok {
			return unavailable()
		}
		differenceText = &text
		if closing.ClosingCash == nil {
			if closing.TakenCash != nil {
				return unavailable()
			}
			break
		}
		taken, err := closings.TakenCash(*closing.CountedCash, closing.ContributedCash, *closing.ClosingCash)
		if err != nil || closing.TakenCash == nil || taken != *closing.TakenCash {
			return unavailable()
		}
		amount, ok := closingSignedText(taken)
		if !ok {
			return unavailable()
		}
		takenText = &amount
	}
	lines := make([]closingCountLineDTO, 0, len(closing.CountLines))
	var previous int64
	for _, line := range closing.CountLines {
		record, ok := closingCountLineRecord(line, previous)
		if !ok {
			return unavailable()
		}
		previous = line.VariantID
		lines = append(lines, record)
	}
	rounds := make([]closingRoundDTO, 0, len(closing.Rounds))
	for index, round := range closing.Rounds {
		record, ok := closingRoundRecord(round, index+1)
		if !ok {
			return unavailable()
		}
		rounds = append(rounds, record)
	}
	// The expenses of the document are the ledger of its own branch, in the order the branch
	// recorded them: another branch's expense is never published in this settlement.
	expenses := make([]closingExpenseDTO, 0, len(closing.Expenses))
	for _, expense := range closing.Expenses {
		record, err := closingExpenseRecord(expense)
		if err != nil || expense.BranchID != closing.BranchID ||
			(len(expenses) > 0 && expenses[len(expenses)-1].ID >= record.ID) {
			return unavailable()
		}
		expenses = append(expenses, record)
	}
	// The corrections of the document are the ones the branch accepted, oldest first: a pending
	// correction is a decision that has not been taken and a rejected one applied nothing, so
	// neither of them rewrote a number. Only a closed settlement is corrected at all (LC012).
	corrections := make([]closingCorrectionDTO, 0, len(closing.Corrections))
	var previousCorrection int64
	for _, correction := range closing.Corrections {
		if correction.Status != closings.CorrectionAccepted || correction.ClosingID != closing.ID ||
			correction.ID <= previousCorrection || closing.Status != closings.StatusClosed {
			return unavailable()
		}
		record, err := closingCorrectionRecord(correction)
		if err != nil {
			return unavailable()
		}
		previousCorrection = correction.ID
		corrections = append(corrections, record)
	}
	return closingDTO{
		ID: closing.ID, BranchLocationID: closing.BranchID, BranchName: closing.BranchName,
		Status: string(closing.Status), PeriodStart: periodStart, CutAt: cutAt, ClosedAt: closedAt,
		CommissionRatePercent: rate, OpeningCash: amounts[0], CashSales: amounts[1],
		CashExpenses: amounts[2], ExpectedCash: expectedText, CountedCash: countedCash,
		CashDifference: differenceText, ContributedCash: amounts[8], ClosingCash: closingCash,
		TakenCash: takenText, SalesTotal: amounts[3], CommissionAmount: amounts[4],
		CardTotal: amounts[5], TransferTotal: amounts[6], QRTotal: amounts[7],
		Observation: closing.Observation, OpenedByAccountID: closing.OpenedByAccountID,
		CountLines: lines, Rounds: rounds, Expenses: expenses, Corrections: corrections,
	}, nil
}

// closingCountLineRecord admits one line of the count sheet: the catalogue identity of its
// variant, the snapshot the database took at the cut and the counted quantity, which is null
// exactly while the variant is pending.
func closingCountLineRecord(line closings.CountLine, previous int64) (closingCountLineDTO, bool) {
	if line.VariantID < 1 || line.VariantID <= previous || line.CatalogEntryID < 1 ||
		line.Brand == "" || !closingText(line.Brand) || line.Model == "" || !closingText(line.Model) ||
		(line.Polarity != "L" && line.Polarity != "R") ||
		line.ExpectedQuantity < 0 || line.ExpectedQuantity > closings.MaxCounted ||
		(line.CountedQuantity != nil &&
			(*line.CountedQuantity < 0 || *line.CountedQuantity > closings.MaxCounted)) {
		return closingCountLineDTO{}, false
	}
	capacity, err := catalog.ParseDecimal(string(line.Capacity))
	if err != nil {
		return closingCountLineDTO{}, false
	}
	return closingCountLineDTO{VariantID: line.VariantID, CatalogEntryID: line.CatalogEntryID,
		Brand: line.Brand, Model: line.Model, Capacity: string(capacity), Polarity: line.Polarity,
		ExpectedQuantity: line.ExpectedQuantity, CountedQuantity: line.CountedQuantity}, true
}

// closingRoundRecord admits one persisted round: its number is the database's own sequence, a
// decided round states who decided it and when, and the offer it carries is revalidated whole, so
// the branch is always shown exactly the numbers it answered.
func closingRoundRecord(round closings.Round, want int) (closingRoundDTO, bool) {
	if round.ID < 1 || round.Round != want || round.ProposedByAccountID < 1 {
		return closingRoundDTO{}, false
	}
	proposedAt, ok := closingMoment(round.ProposedAt)
	if !ok {
		return closingRoundDTO{}, false
	}
	offer, ok := closingOfferRecord(round.Payload)
	if !ok {
		return closingRoundDTO{}, false
	}
	decision := string(round.Decision)
	switch round.Decision {
	case closings.DecisionPending:
		if round.DecidedByAccountID != nil || round.DecidedAt != nil || round.DecisionReason != "" {
			return closingRoundDTO{}, false
		}
		return closingRoundDTO{ID: round.ID, Round: round.Round, Offer: offer,
			ProposedByAccountID: round.ProposedByAccountID, ProposedAt: proposedAt,
			Decision: decision}, true
	case closings.DecisionRejected:
		// The motive of a rejection is mandatory (S14) and is published as it was persisted.
		if _, ok := closings.CanonicalReason(round.DecisionReason); !ok {
			return closingRoundDTO{}, false
		}
	case closings.DecisionAccepted:
		if round.DecisionReason != "" {
			return closingRoundDTO{}, false
		}
	default:
		return closingRoundDTO{}, false
	}
	if round.DecidedByAccountID == nil || *round.DecidedByAccountID < 1 || round.DecidedAt == nil {
		return closingRoundDTO{}, false
	}
	decidedAt, ok := closingMoment(*round.DecidedAt)
	if !ok {
		return closingRoundDTO{}, false
	}
	decidedBy := *round.DecidedByAccountID
	return closingRoundDTO{ID: round.ID, Round: round.Round, Offer: offer,
		ProposedByAccountID: round.ProposedByAccountID, ProposedAt: proposedAt,
		Decision: decision, DecisionReason: round.DecisionReason,
		DecidedByAccountID: &decidedBy, DecidedAt: &decidedAt}, true
}

// closingOfferRecord admits one stored offer: the period, the collection by payment method, the
// reported commission, the drawer and the counted sheet. The commission is revalidated as the
// frozen rate over that offer's own total, rounded once (S6, S20), so a history entry that does
// not add up is never published.
func closingOfferRecord(payload closings.ProposalPayload) (closingOfferDTO, bool) {
	periodStart, ok := closingMoment(payload.PeriodStart)
	if !ok {
		return closingOfferDTO{}, false
	}
	cutAt, ok := closingMoment(payload.CutAt)
	if !ok || payload.CutAt.Before(payload.PeriodStart) {
		return closingOfferDTO{}, false
	}
	rate, err := closings.ParsePercent(string(payload.CommissionRatePercent))
	if err != nil || string(rate) != string(payload.CommissionRatePercent) {
		return closingOfferDTO{}, false
	}
	commission, err := closings.Commission(payload.SalesTotal, rate)
	if err != nil || commission != payload.CommissionAmount {
		return closingOfferDTO{}, false
	}
	amounts := make([]string, 0, 6)
	for _, amount := range []closings.Money{payload.SalesTotal, payload.CommissionAmount,
		payload.CashSales, payload.CashExpenses, payload.CardTotal, payload.TransferTotal} {
		text, ok := closingAmountText(amount)
		if !ok {
			return closingOfferDTO{}, false
		}
		amounts = append(amounts, text)
	}
	qrTotal, ok := closingAmountText(payload.QRTotal)
	if !ok {
		return closingOfferDTO{}, false
	}
	contributed, ok := closingAmountText(payload.ContributedCash)
	if !ok {
		return closingOfferDTO{}, false
	}
	countedCash, ok := closingOptionalAmountRecord(payload.CountedCash)
	if !ok {
		return closingOfferDTO{}, false
	}
	closingCash, ok := closingOptionalAmountRecord(payload.ClosingCash)
	// An offer is only made for a counted drawer, so both sides of it are stated.
	if !ok || countedCash == nil || closingCash == nil {
		return closingOfferDTO{}, false
	}
	if payload.Observation != "" && !closings.ValidObservation(payload.Observation) {
		return closingOfferDTO{}, false
	}
	lines := make([]closingOfferLineDTO, 0, len(payload.CountLines))
	var previous int64
	for _, line := range payload.CountLines {
		if line.VariantID < 1 || line.VariantID <= previous ||
			line.ExpectedQuantity < 0 || line.ExpectedQuantity > closings.MaxCounted ||
			line.CountedQuantity < 0 || line.CountedQuantity > closings.MaxCounted {
			return closingOfferDTO{}, false
		}
		previous = line.VariantID
		lines = append(lines, closingOfferLineDTO{VariantID: line.VariantID,
			ExpectedQuantity: line.ExpectedQuantity, CountedQuantity: line.CountedQuantity})
	}
	return closingOfferDTO{PeriodStart: periodStart, CutAt: cutAt, SalesTotal: amounts[0],
		CommissionRatePercent: string(rate), CommissionAmount: amounts[1], CashSales: amounts[2],
		CashExpenses: amounts[3], CardTotal: amounts[4], TransferTotal: amounts[5], QRTotal: qrTotal,
		CountedCash: countedCash, ContributedCash: contributed, ClosingCash: closingCash,
		Observation: payload.Observation, CountLines: lines}, true
}

// closingCorrectionRecord admits one persisted correction: its state and the answer that state
// implies, the reason the warehouse stated, the payload it offered as it was stored, and the deltas
// the acceptance journalled. A shape this domain never wrote is never published, so the surface can
// always show which correction produced which number (S16).
func closingCorrectionRecord(correction closings.Correction) (closingCorrectionDTO, error) {
	unavailable := func() (closingCorrectionDTO, error) {
		return closingCorrectionDTO{}, closings.ErrUnavailable
	}
	if correction.ID < 1 || correction.ClosingID < 1 || !correction.Status.Valid() ||
		correction.ProposedByAccountID < 1 {
		return unavailable()
	}
	reason, ok := closings.CanonicalReason(correction.Reason)
	if !ok || reason != correction.Reason {
		return unavailable()
	}
	payload, ok := closingCorrectionPayloadRecord(correction.Payload)
	if !ok {
		return unavailable()
	}
	proposedAt, ok := closingMoment(correction.ProposedAt)
	if !ok {
		return unavailable()
	}
	// A correction is decided once, and only with the state the database stores: a pending one has
	// no answer at all, an acceptance carries no motive of its own and a rejection always states
	// the one the branch wrote (S16).
	var decidedBy *int64
	var decidedAt *string
	switch correction.Status {
	case closings.CorrectionProposed:
		if correction.DecidedByAccountID != nil || correction.DecidedAt != nil ||
			correction.DecisionReason != "" {
			return unavailable()
		}
	case closings.CorrectionRejected:
		motive, ok := closings.CanonicalReason(correction.DecisionReason)
		if !ok || motive != correction.DecisionReason {
			return unavailable()
		}
	case closings.CorrectionAccepted:
		if correction.DecisionReason != "" {
			return unavailable()
		}
	}
	if correction.Status != closings.CorrectionProposed {
		if correction.DecidedByAccountID == nil || *correction.DecidedByAccountID < 1 ||
			correction.DecidedAt == nil {
			return unavailable()
		}
		moment, ok := closingMoment(*correction.DecidedAt)
		if !ok {
			return unavailable()
		}
		by := *correction.DecidedByAccountID
		decidedBy, decidedAt = &by, &moment
	}
	// A delta exists because the branch accepted its own correction and for no other reason (LC023),
	// so a correction it has not accepted journals nothing.
	if correction.Status != closings.CorrectionAccepted && len(correction.Effects) > 0 {
		return unavailable()
	}
	effects := make([]closingCorrectionEffectDTO, 0, len(correction.Effects))
	for _, effect := range correction.Effects {
		record, ok := closingCorrectionEffectRecord(effect)
		if !ok {
			return unavailable()
		}
		effects = append(effects, record)
	}
	return closingCorrectionDTO{ID: correction.ID, ClosingID: correction.ClosingID,
		Status: string(correction.Status), Reason: reason, Payload: payload,
		ProposedByAccountID: correction.ProposedByAccountID, ProposedAt: proposedAt,
		DecidedByAccountID: decidedBy, DecidedAt: decidedAt,
		DecisionReason: correction.DecisionReason, Effects: effects}, nil
}

// closingCorrectionPayloadRecord admits the payload of one correction: at least one of the four
// values it can state, the counted sheet inside the database's own bounds and one line per variant,
// and every amount the canonical money of this vertical. An absent value is published as absent,
// because a correction never restates a number it does not touch.
func closingCorrectionPayloadRecord(payload closings.CorrectionOffer) (closingCorrectionPayloadDTO, bool) {
	if !payload.Stated() || len(payload.CountedQuantities) > closings.MaxCountLines {
		return closingCorrectionPayloadDTO{}, false
	}
	record := closingCorrectionPayloadDTO{
		CountedQuantities: make([]closingCorrectionLineDTO, 0, len(payload.CountedQuantities))}
	variants := make(map[int64]bool, len(payload.CountedQuantities))
	for _, line := range payload.CountedQuantities {
		if line.VariantID < 1 || line.VariantID > math.MaxInt32 || variants[line.VariantID] ||
			line.Quantity < 0 || line.Quantity > closings.MaxCounted {
			return closingCorrectionPayloadDTO{}, false
		}
		variants[line.VariantID] = true
		record.CountedQuantities = append(record.CountedQuantities,
			closingCorrectionLineDTO{VariantID: line.VariantID, CountedQuantity: line.Quantity})
	}
	for _, field := range []struct {
		amount *closings.Money
		into   *string
	}{{payload.CountedCash, &record.CountedCash},
		{payload.CommissionAmount, &record.CommissionAmount},
		{payload.ClosingCash, &record.ClosingCash}} {
		text, ok := closingOptionalAmountRecord(field.amount)
		if !ok {
			return closingCorrectionPayloadDTO{}, false
		}
		if text != nil {
			*field.into = *text
		}
	}
	return record, true
}

// closingCorrectionEffectRecord admits one delta an accepted correction applied. The unit is the
// kind's: a stock effect carries its variant and a non-zero quantity and no amount, and every other
// kind carries a non-zero signed amount and neither a variant nor a quantity.
func closingCorrectionEffectRecord(effect closings.CorrectionEffect) (closingCorrectionEffectDTO, bool) {
	switch effect.Kind {
	case closings.CorrectionKindStock:
		if effect.VariantID == nil || *effect.VariantID < 1 || *effect.VariantID > math.MaxInt32 ||
			effect.QuantityDelta == nil || *effect.QuantityDelta == 0 ||
			*effect.QuantityDelta > closings.MaxCounted || *effect.QuantityDelta < -closings.MaxCounted ||
			effect.AmountDelta != nil {
			return closingCorrectionEffectDTO{}, false
		}
		variant, quantity := *effect.VariantID, *effect.QuantityDelta
		return closingCorrectionEffectDTO{Kind: effect.Kind, VariantID: &variant,
			QuantityDelta: &quantity}, true
	case closings.CorrectionKindCountedCash, closings.CorrectionKindCommission, closings.CorrectionKindFund:
		if effect.VariantID != nil || effect.QuantityDelta != nil || effect.AmountDelta == nil {
			return closingCorrectionEffectDTO{}, false
		}
		amount, ok := closingSignedText(*effect.AmountDelta)
		if !ok || amount == "0.00" {
			return closingCorrectionEffectDTO{}, false
		}
		return closingCorrectionEffectDTO{Kind: effect.Kind, AmountDelta: &amount}, true
	}
	return closingCorrectionEffectDTO{}, false
}

// closingPageDTO is one newest-first page of one branch's settlements plus the total of that
// branch. Every row is the same document projection the single read publishes, so a history row
// and the settlement it summarises can never disagree; the count sheet and the rounds belong to
// the single read and are not unfolded here.
type closingPageDTO struct {
	Page          int          `json:"page"`
	PageSize      int          `json:"page_size"`
	TotalClosings int64        `json:"total_closings"`
	Closings      []closingDTO `json:"closings"`
}

// closingHistoryQuery is the history query: the branch to read plus the page contract of every
// history of this installation.
type closingHistoryQuery struct {
	BranchID int64
	Page     int
	PageSize int
}

// closingListPageSizes admits exactly the frozen page sizes of the history.
func closingListPageSize(size int64) bool {
	return size == 10 || size == closingDefaultPageSize || size == 50
}

const (
	// closingDefaultPageSize is the page size of every history of this installation.
	closingDefaultPageSize = 25
	// closingMaxPage is the bound of the page parameter, exactly like the other histories.
	closingMaxPage = 1_000_000
)

// closingListQueryValues splits a query string once per parameter, so repeated keys, empty
// sections, missing separators, empty values and malformed escapes are rejections, never
// defaults.
func closingListQueryValues(raw string) (map[string]string, error) {
	values := make(map[string]string)
	if raw == "" {
		return values, nil
	}
	if len(raw) > 4096 {
		return nil, closings.ErrInvalid
	}
	for _, part := range strings.Split(raw, "&") {
		key, value, ok := strings.Cut(part, "=")
		if !ok || key == "" || value == "" {
			return nil, closings.ErrInvalid
		}
		if _, exists := values[key]; exists {
			return nil, closings.ErrInvalid
		}
		// The numeric parameters of this contract are the raw spelling: a decoded alias of a
		// digit is still not a page number.
		if decoded, err := url.QueryUnescape(value); err != nil ||
			!utf8.ValidString(decoded) || strings.ContainsRune(decoded, 0) {
			return nil, closings.ErrInvalid
		}
		values[key] = value
	}
	return values, nil
}

// closingListQuery reads the history query: the branch, the page and the page size, each exactly
// once and each in its canonical spelling. Order is irrelevant; duplicates, empty values,
// unknown keys, a bare separator and encoding aliases are rejections, never defaults.
func closingHistoryQueryOf(raw string) (closingHistoryQuery, error) {
	query := closingHistoryQuery{Page: 1, PageSize: closingDefaultPageSize}
	values, err := closingListQueryValues(raw)
	if err != nil {
		return query, closings.ErrInvalid
	}
	for key, value := range values {
		switch key {
		case "branch_location_id":
			branch, err := closingPathID(value, closings.MaxBranchID)
			if err != nil || branch < closingsFirstBranch {
				return query, closings.ErrInvalid
			}
			query.BranchID = branch
		case "page":
			page, err := closingPathID(value, closingMaxPage)
			if err != nil {
				return query, closings.ErrInvalid
			}
			query.Page = int(page)
		case "page_size":
			size, err := closingPathID(value, 50)
			if err != nil || !closingListPageSize(size) {
				return query, closings.ErrInvalid
			}
			query.PageSize = int(size)
		default:
			return query, closings.ErrInvalid
		}
	}
	// The branch is mandatory: this read is one branch's own history and never a listing of
	// every branch at once.
	if query.BranchID == 0 || query.Page < 1 || query.Page > closingMaxPage {
		return closingHistoryQuery{}, closings.ErrInvalid
	}
	return query, nil
}

// closingPageRecord admits only a complete history page: shape, the page inside the reported
// total and the newest-first order the store promises. Rows are projected exactly like the
// single read, so nothing here is a second description of a settlement.
func closingPageRecord(page closings.Page) (closingPageDTO, error) {
	unavailable := func() (closingPageDTO, error) { return closingPageDTO{}, closings.ErrUnavailable }
	if page.Page < 1 || page.Page > closingMaxPage || page.TotalClosings < 0 ||
		!closingListPageSize(int64(page.PageSize)) || len(page.Closings) > page.PageSize ||
		// A page beyond the last one is legitimately empty; a page with rows must still fit
		// inside the reported total.
		(len(page.Closings) > 0 &&
			int64(page.Page-1)*int64(page.PageSize)+int64(len(page.Closings)) > page.TotalClosings) {
		return unavailable()
	}
	rows := make([]closingDTO, 0, len(page.Closings))
	for index, closing := range page.Closings {
		record, err := closingRecord(closing)
		if err != nil {
			return unavailable()
		}
		// The rows are newest first and never repeat a settlement.
		if index > 0 {
			previous := page.Closings[index-1]
			if previous.CutAt.Before(closing.CutAt) ||
				(previous.CutAt.Equal(closing.CutAt) && previous.ID <= closing.ID) {
				return unavailable()
			}
		}
		rows = append(rows, record)
	}
	return closingPageDTO{Page: page.Page, PageSize: page.PageSize,
		TotalClosings: page.TotalClosings, Closings: rows}, nil
}

// closingCollection serves the collection: the history of one branch (GET) and the opening of a
// new settlement of a branch (POST).
func (a *API) closingCollection(store *closings.Store) http.HandlerFunc {
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
			query, err := closingHistoryQueryOf(r.URL.RawQuery)
			if err != nil {
				closingFailure(w, err)
				return
			}
			page, err := store.List(r.Context(), actor, query.BranchID, query.Page, query.PageSize)
			if err != nil {
				closingFailure(w, err)
				return
			}
			record, err := closingPageRecord(page)
			if err != nil {
				closingFailure(w, err)
				return
			}
			respond(w, 200, record)
			return
		}
		if !a.closingMutation(w, r) {
			return
		}
		branch, err := decodeClosingOpen(r)
		if err != nil {
			closingFailure(w, err)
			return
		}
		closing, err := store.Open(r.Context(), actor, branch)
		if err != nil {
			closingOpenFailure(w, err, branch)
			return
		}
		record, err := closingRecord(closing)
		if err != nil {
			closingFailure(w, err)
			return
		}
		respond(w, 201, record)
	}
}

// closingSettings serves the commission configuration of one branch: the warehouse reads and
// writes it, and a branch reads only its own. The branch in the path is the scope the store
// enforces, so a branch that names another one is refused there.
func (a *API) closingSettings(store *closings.Store) http.HandlerFunc {
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
		if !closingQueryAbsent(w, r) {
			return
		}
		branch, err := closingPathBranch(r.PathValue("branch"))
		if err != nil {
			closingFailure(w, err)
			return
		}
		if r.Method == http.MethodGet {
			settings, err := store.ReadSettings(r.Context(), actor, branch)
			if err != nil {
				closingFailure(w, err)
				return
			}
			record, err := closingSettingsRecord(settings)
			if err != nil {
				closingFailure(w, err)
				return
			}
			respond(w, 200, record)
			return
		}
		if !a.closingMutation(w, r) {
			return
		}
		rate, err := decodeClosingSettings(r)
		if err != nil {
			closingFailure(w, err)
			return
		}
		settings, err := store.ConfigureCommission(r.Context(), actor, branch, rate)
		if err != nil {
			closingFailure(w, err)
			return
		}
		record, err := closingSettingsRecord(settings)
		if err != nil {
			closingFailure(w, err)
			return
		}
		respond(w, 200, record)
	}
}

// closingExpenses records one small expense of the branch's own till (S12). The branch is the
// session's own account, the instant is the database's and the settlement that covers the expense is
// decided by that instant, so this route names no settlement and takes no approval: the branch
// records the expense as it happens, and a frozen branch is refused by name.
func (a *API) closingExpenses(store *closings.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodPost) {
			return
		}
		actor, ok := a.inventoryIdentity(w, r)
		if !ok {
			return
		}
		if !a.closingMutation(w, r) {
			return
		}
		amount, description, err := decodeClosingExpense(r)
		if err != nil {
			closingFailure(w, err)
			return
		}
		expense, err := store.RecordExpense(r.Context(), actor, amount, description)
		if err != nil {
			closingFailure(w, err)
			return
		}
		record, err := closingExpenseRecord(expense)
		if err != nil {
			closingFailure(w, err)
			return
		}
		respond(w, 201, record)
	}
}

// closingDetail serves one settlement: the period, the money, the count sheet, the expenses of its
// window and every proposal round with the answer it received.
func (a *API) closingDetail(store *closings.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodGet) {
			return
		}
		actor, ok := a.inventoryIdentity(w, r)
		if !ok {
			return
		}
		if !closingQueryAbsent(w, r) {
			return
		}
		id, err := closingPathID(r.PathValue("id"), math.MaxInt64)
		if err != nil {
			closingFailure(w, err)
			return
		}
		closing, err := store.Read(r.Context(), actor, id)
		if err != nil {
			closingFailure(w, err)
			return
		}
		record, err := closingRecord(closing)
		if err != nil {
			closingFailure(w, err)
			return
		}
		respond(w, 200, record)
	}
}

// closingCount records what the warehouse counted, per variant.
func (a *API) closingCount(store *closings.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodPost) {
			return
		}
		actor, ok := a.inventoryIdentity(w, r)
		if !ok {
			return
		}
		if !a.closingMutation(w, r) {
			return
		}
		id, err := closingPathID(r.PathValue("id"), math.MaxInt64)
		if err != nil {
			closingFailure(w, err)
			return
		}
		counted, err := decodeClosingCount(r)
		if err != nil {
			closingFailure(w, err)
			return
		}
		closing, err := store.Count(r.Context(), actor, id, counted)
		if err != nil {
			closingFailure(w, err)
			return
		}
		record, err := closingRecord(closing)
		if err != nil {
			closingFailure(w, err)
			return
		}
		respond(w, 200, record)
	}
}

// closingCash saves the draft of the drawer while the warehouse holds the settlement.
func (a *API) closingCash(store *closings.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodPost) {
			return
		}
		actor, ok := a.inventoryIdentity(w, r)
		if !ok {
			return
		}
		if !a.closingMutation(w, r) {
			return
		}
		id, err := closingPathID(r.PathValue("id"), math.MaxInt64)
		if err != nil {
			closingFailure(w, err)
			return
		}
		draft, err := decodeClosingCash(r)
		if err != nil {
			closingFailure(w, err)
			return
		}
		closing, err := store.SaveCash(r.Context(), actor, id, draft)
		if err != nil {
			closingFailure(w, err)
			return
		}
		record, err := closingRecord(closing)
		if err != nil {
			closingFailure(w, err)
			return
		}
		respond(w, 200, record)
	}
}

// closingPropose offers the settlement to the branch: the round it states and the period numbers
// the database records with it. The route takes no body at all, because the offer is composed from
// the ledgers of the period and never from a client promise.
func (a *API) closingPropose(store *closings.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodPost) {
			return
		}
		actor, ok := a.inventoryIdentity(w, r)
		if !ok {
			return
		}
		if !a.closingMutation(w, r) {
			return
		}
		id, err := closingPathID(r.PathValue("id"), math.MaxInt64)
		if err != nil {
			closingFailure(w, err)
			return
		}
		if err := closingEmptyBody(r); err != nil {
			closingFailure(w, err)
			return
		}
		closing, err := store.Propose(r.Context(), actor, id)
		if err != nil {
			closingFailure(w, err)
			return
		}
		record, err := closingRecord(closing)
		if err != nil {
			closingFailure(w, err)
			return
		}
		respond(w, 200, record)
	}
}

// closingDecision records the branch's answer to the pending round: acceptance is the only thing
// that closes (and applies the counted stock), and a rejection states its mandatory motive, applies
// nothing and hands the settlement back to the warehouse.
func (a *API) closingDecision(store *closings.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodPost) {
			return
		}
		actor, ok := a.inventoryIdentity(w, r)
		if !ok {
			return
		}
		if !a.closingMutation(w, r) {
			return
		}
		id, err := closingPathID(r.PathValue("id"), math.MaxInt64)
		if err != nil {
			closingFailure(w, err)
			return
		}
		decision, reason, err := decodeClosingDecision(r)
		if err != nil {
			closingFailure(w, err)
			return
		}
		closing, err := store.Decide(r.Context(), actor, id, decision, reason)
		if err != nil {
			closingFailure(w, err)
			return
		}
		record, err := closingRecord(closing)
		if err != nil {
			closingFailure(w, err)
			return
		}
		respond(w, 200, record)
	}
}

// closingCorrections appends the warehouse's correction of a closed settlement (S16): the values it
// corrects and the reason it corrects them for. The correction is an offer, so nothing is applied
// and no number of the closed document moves until the branch accepts it; the answer is the
// proposed correction the branch has to decide.
func (a *API) closingCorrections(store *closings.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodPost) {
			return
		}
		actor, ok := a.inventoryIdentity(w, r)
		if !ok {
			return
		}
		if !a.closingMutation(w, r) {
			return
		}
		id, err := closingPathID(r.PathValue("id"), math.MaxInt64)
		if err != nil {
			closingFailure(w, err)
			return
		}
		offer, reason, err := decodeClosingCorrection(r)
		if err != nil {
			closingFailure(w, err)
			return
		}
		correction, err := store.ProposeCorrection(r.Context(), actor, id, offer, reason)
		if err != nil {
			closingFailure(w, err)
			return
		}
		record, err := closingCorrectionRecord(correction)
		if err != nil {
			closingFailure(w, err)
			return
		}
		respond(w, 201, record)
	}
}

// closingCorrectionDecision records the branch's answer to the pending correction of its closed
// settlement. Only an acceptance applies the deltas the correction states; a rejection states its
// mandatory motive and applies nothing, exactly like the rejection of a round (S16).
func (a *API) closingCorrectionDecision(store *closings.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodPost) {
			return
		}
		actor, ok := a.inventoryIdentity(w, r)
		if !ok {
			return
		}
		if !a.closingMutation(w, r) {
			return
		}
		id, err := closingPathID(r.PathValue("correction"), math.MaxInt64)
		if err != nil {
			closingFailure(w, err)
			return
		}
		// The two decisions are the ones the settlement's own rounds admit, so the body is the same
		// one and the same refusal answers a malformed answer here.
		decision, reason, err := decodeClosingDecision(r)
		if err != nil {
			closingFailure(w, err)
			return
		}
		correction, err := store.DecideCorrection(r.Context(), actor, id, decision, reason)
		if err != nil {
			closingFailure(w, err)
			return
		}
		record, err := closingCorrectionRecord(correction)
		if err != nil {
			closingFailure(w, err)
			return
		}
		respond(w, 200, record)
	}
}

// closingQueryAbsent refuses a query string on a route where it is not part of the contract: a
// framing error, never a silently ignored parameter.
func closingQueryAbsent(w http.ResponseWriter, r *http.Request) bool {
	if r.URL.RawQuery != "" || r.URL.ForceQuery {
		failure(w, 400, "invalid_request")
		return false
	}
	return true
}

// closingMutation applies the house mutation guards in their frozen order: same-origin, the CSRF
// token, then no query string. The actor and the branch scope stay the store's own rules.
func (a *API) closingMutation(w http.ResponseWriter, r *http.Request) bool {
	site := r.Header.Values("Sec-Fetch-Site")
	if len(site) > 1 || (len(site) == 1 && site[0] != "same-origin") {
		failure(w, 403, "forbidden")
		return false
	}
	return a.GuardMutation(w, r) && closingQueryAbsent(w, r)
}
