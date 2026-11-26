package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"math"
	"mime"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"luson/api/internal/auth"
	"luson/api/internal/config"
	"luson/api/internal/warrantycase"
)

// This file is the HTTP contract of the battery case ("caso de garantía"): the two doors a failed
// battery enters through, the tray of a branch, the read of one case with its loans and its history,
// and the facts that move it -- the loan of a used battery, the journey to the warehouse and the
// factory, the verdict, the notice, the release and the delivery of the exchange.
//
// Two things the surface never restates. A rule of the vertical is the store's and the database's: a
// serial nobody sold, a term that has run out, a transition outside the frozen order, a release
// without a notice, a second release -- every one of them is refused where it is decided, and this
// file publishes that decision as one status and one stable code. And no rule of the actor split is
// trusted to the store alone (S14, S19): a warehouse session never delivers to a client, a branch
// session never releases a unit to stock, and the tramo that only the warehouse records cannot be
// recorded by the branch. The store and the database refuse the same acts again, so the split is
// enforced on two sides of one request and never in the transport only.
//
// The case number is the persisted one: `C-<location>-<sequence>` (S20). Nothing here composes a
// letter, an abbreviation or a second identity for it, because the database is the only writer of a
// number and the branch that printed it is the branch that owns the case.
//
// Nothing here writes a document: every mutation is the store's own, and the answer is the case as
// the store reads it back, so a client that receives a case with its loans and its history is reading
// the facts that were just persisted and not a promise of this handler.

const (
	// warrantyCaseCollectionPath is the one literal path of this contract; every route hangs from it.
	warrantyCaseCollectionPath = "/api/warranty-cases"
	// warrantyCaseClaimPath and warrantyCaseDefectPath are the two doors (S1). They are literal paths
	// beside the {id} pattern, so neither is ever read as a case id.
	warrantyCaseClaimPath  = warrantyCaseCollectionPath + "/claims"
	warrantyCaseDefectPath = warrantyCaseCollectionPath + "/stock-defects"
	// warrantyCaseBodyLimit bounds decoding work well above any admitted payload: the widest body is a
	// loan, a resolution or a stock defect, all of them well below this limit.
	warrantyCaseBodyLimit = 4 << 10
	// warrantyCaseMaxSearch is the bound of the two filters of the tray, restated so a wide query never
	// reaches the store.
	warrantyCaseMaxSearch = 24
	// warrantyCaseMaxID is the largest admitted case id: the column is a bigint.
	warrantyCaseMaxID int64 = 1<<63 - 1
	// warrantyCaseMaxOrdinal is the largest admitted loan ordinal: the column admits one hundred.
	warrantyCaseMaxOrdinal int64 = 100
	// warrantyCaseWarehouse is the Almacén. Branches start at 2, exactly like the settlement contract.
	warrantyCaseWarehouse = 1
	// warrantyCaseMaxFactoryNumber, warrantyCaseMaxNote, warrantyCaseMaxModel and warrantyCaseMaxSerial
	// are the database's own bounds, restated so an inadmissible text never reaches the store.
	warrantyCaseMaxFactoryNumber = 200
	warrantyCaseMaxNote          = 500
	warrantyCaseMaxModel         = 40
	warrantyCaseMaxSerial        = 64
)

// warrantyCaseNumberPattern is the number the database writes for a case (065): the `C-` of the case,
// the branch and the correlative of that branch, and nothing else. A number outside it is not a case
// this contract could have read.
var warrantyCaseNumberPattern = regexp.MustCompile(`^C-[1-9][0-9]{0,4}-[0-9]{6,12}$`)

// NewWithWarrantyCases mounts the battery case on a handler built by the settlement factory. The
// optional store keeps every existing constructor untouched: without it the case routes stay
// unregistered and every other request is forwarded unchanged.
func NewWithWarrantyCases(base http.Handler, service *auth.Service, cfg config.Auth,
	store *warrantycase.Store) (http.Handler, error) {
	if base == nil || service == nil {
		return nil, warrantycase.ErrUnavailable
	}
	parsed, err := config.ParseAuth(config.LocalTrial, cfg.Origin, cfg.Listen, cfg.TLSCert, cfg.TLSKey)
	if err != nil || parsed != cfg {
		return nil, warrantycase.ErrUnavailable
	}
	if store == nil {
		// A missing case store is not a broken server: the routes are simply not registered.
		return base, nil
	}
	api := &API{service, cfg}
	routes := api.warrantyCaseRoutes(store)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		// An ambiguous case path is refused before the handler can set its response headers, exactly
		// like the sale and settlement routes.
		if !warrantyCasePath(r) {
			failure(w, 404, "not_found")
			return
		}
		if warrantyCaseRoute(r.URL.Path) {
			routes.ServeHTTP(w, r)
			return
		}
		base.ServeHTTP(w, r)
	}), nil
}

// warrantyCaseRoute reports whether this path belongs to the case contract.
func warrantyCaseRoute(path string) bool {
	return path == warrantyCaseCollectionPath ||
		strings.HasPrefix(path, warrantyCaseCollectionPath+"/")
}

// warrantyCasePath refuses ambiguous case paths: a doubled slash, a dot segment, a backslash, a NUL or
// an encoded alias is not_found, never a silent redirect to a different resource. Every path outside
// the collection is admitted here and forwarded as is.
func warrantyCasePath(r *http.Request) bool {
	p := r.URL.Path
	if !warrantyCaseRoute(p) {
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

// warrantyCaseRoutes registers the contract. The two doors and every operation of one case are
// literal suffixes of the collection, so a case id is always one segment; any other path below the
// collection is an unknown route answered as JSON, never a cleaned or redirected path.
func (a *API) warrantyCaseRoutes(store *warrantycase.Store) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc(warrantyCaseCollectionPath, a.warrantyCaseTray(store))
	mux.HandleFunc(warrantyCaseCollectionPath+"/counts", a.warrantyCasePending(store))
	// The stock of used batteries is a literal suffix of the collection, exactly like the counts, so
	// the `{id}` pattern never reads it as a case number (S24, S26).
	mux.HandleFunc(warrantyCaseCollectionPath+warrantyUsedStockPath, a.warrantyUsedStock(store))
	mux.HandleFunc(warrantyCaseClaimPath, a.warrantyClaim(store))
	mux.HandleFunc(warrantyCaseDefectPath, a.warrantyDefect(store))
	mux.HandleFunc(warrantyCaseCollectionPath+"/{id}", a.warrantyCaseDetail(store))
	mux.HandleFunc(warrantyCaseCollectionPath+"/{id}/loans", a.warrantyCaseLoans(store))
	mux.HandleFunc(warrantyCaseCollectionPath+"/{id}/loans/{ordinal}/fate", a.warrantyCaseLoanFate(store))
	mux.HandleFunc(warrantyCaseCollectionPath+"/{id}/advance", a.warrantyCaseAdvance(store))
	mux.HandleFunc(warrantyCaseCollectionPath+"/{id}/resolution", a.warrantyCaseResolution(store))
	mux.HandleFunc(warrantyCaseCollectionPath+"/{id}/notice", a.warrantyCaseNotice(store))
	mux.HandleFunc(warrantyCaseCollectionPath+"/{id}/release", a.warrantyCaseRelease(store))
	mux.HandleFunc(warrantyCaseCollectionPath+"/{id}/delivery", a.warrantyCaseDelivery(store))
	// The loan receipt is the printable paper of the handover (S8): a literal suffix of the case,
	// exactly like the warranty of a sale, so the case id stays one segment.
	mux.HandleFunc(warrantyCaseCollectionPath+"/{id}"+warrantyReceiptPath, a.warrantyCaseReceipt(store))
	mux.HandleFunc(warrantyCaseCollectionPath+"/", func(w http.ResponseWriter, r *http.Request) {
		failure(w, 404, "not_found")
	})
	return mux
}

// warrantyFailure publishes the domain's own decision and nothing else: one status and one stable
// code, and the two phases of a refused transition, so a client points at the tramo instead of
// guessing why the journey did not move.
func warrantyFailure(w http.ResponseWriter, err error) {
	var refusal *warrantycase.PhaseRefusal
	if errors.As(err, &refusal) {
		respond(w, 409, map[string]string{"error": "transition_not_allowed",
			"from": string(refusal.From), "to": string(refusal.To)})
		return
	}
	switch {
	case errors.Is(err, warrantycase.ErrInvalid):
		failure(w, 400, "invalid_request")
	case errors.Is(err, warrantycase.ErrForbidden):
		failure(w, 403, "forbidden")
	case errors.Is(err, warrantycase.ErrNotFound):
		failure(w, 404, "not_found")
	// The three refusals of the claim door state their own fact (S2).
	case errors.Is(err, warrantycase.ErrSerialNotSold):
		failure(w, 409, "serial_not_sold")
	case errors.Is(err, warrantycase.ErrNoWarranty):
		failure(w, 409, "no_warranty")
	case errors.Is(err, warrantycase.ErrWarrantyExpired):
		failure(w, 409, "warranty_expired")
	// The shelf of a finding (S16) and the origin of a loan (S25): two different stocks and two
	// different refusals.
	case errors.Is(err, warrantycase.ErrNoStock):
		failure(w, 409, "no_stock")
	case errors.Is(err, warrantycase.ErrLoanSourceStock):
		failure(w, 409, "loan_source_stock")
	// The model of a loan is one the pool already knows, and the origin holds it (S25, S30): a model
	// nobody bought and an empty shelf are two refusals and never one.
	case errors.Is(err, warrantycase.ErrLoanModelUnknown):
		failure(w, 409, "loan_model_unknown")
	case errors.Is(err, warrantycase.ErrReservedStock):
		failure(w, 409, "reserved_stock")
	case errors.Is(err, warrantycase.ErrClaimOnly):
		failure(w, 409, "claim_only")
	// The loan receipt of a claim that has not handed a used battery over has nothing to print
	// (S8).
	case errors.Is(err, warrantycase.ErrNoLoan):
		failure(w, 409, "no_loan")
	// The journey, its gates and its resolution (S9, S10, S11).
	case errors.Is(err, warrantycase.ErrTransition):
		failure(w, 409, "transition_not_allowed")
	case errors.Is(err, warrantycase.ErrResolutionRequired):
		failure(w, 409, "resolution_required")
	case errors.Is(err, warrantycase.ErrResolutionFinal):
		failure(w, 409, "resolution_final")
	case errors.Is(err, warrantycase.ErrFactoryFileRequired):
		failure(w, 400, "factory_file_required")
	case errors.Is(err, warrantycase.ErrFactoryFileOnlyOnShipment):
		failure(w, 400, "factory_file_not_allowed")
	case errors.Is(err, warrantycase.ErrWarehouseVerdict):
		failure(w, 409, "warehouse_verdict")
	case errors.Is(err, warrantycase.ErrNoteRequired):
		failure(w, 400, "reason_required")
	case errors.Is(err, warrantycase.ErrMatrix):
		failure(w, 409, "resolution_matrix")
	case errors.Is(err, warrantycase.ErrLoanFateFinal):
		failure(w, 409, "loan_fate_final")
	case errors.Is(err, warrantycase.ErrLoanFateOpen):
		failure(w, 400, "loan_fate_required")
	// The notice, the release and the delivery (S13, S14, S19).
	case errors.Is(err, warrantycase.ErrResolutionPending):
		failure(w, 409, "resolution_pending")
	case errors.Is(err, warrantycase.ErrNoticeRequired):
		failure(w, 409, "notice_required")
	case errors.Is(err, warrantycase.ErrAlreadyReleased):
		failure(w, 409, "already_released")
	case errors.Is(err, warrantycase.ErrReleaseUnavailable):
		failure(w, 409, "nothing_to_release")
	// The unit of the case is the branch's sellable stock: the release sells it and closes the case,
	// and the delivery asserts a handover that did not happen (S31).
	case errors.Is(err, warrantycase.ErrUnitBelongsToStock):
		failure(w, 409, "unit_belongs_to_stock")
	// The release that closes the case is refused while a loan of it is still undecided (S32): the
	// branch decides the fate, and the release only asks for it.
	case errors.Is(err, warrantycase.ErrCaseHasOpenLoan):
		failure(w, 409, "loan_fate_open")
	default:
		failure(w, 503, "service_unavailable")
	}
}

// warrantyActorOf reads the identity of the request, which is the only authority on the side a session
// acts from: the warehouse is location 1 and every other provisioned location is a branch.
func (a *API) warrantyActorOf(w http.ResponseWriter, r *http.Request) (auth.Identity, bool) {
	return a.inventoryIdentity(w, r)
}

// warrantyBranch refuses a session that does not act from a branch: a warehouse account owns no
// client, so it never opens a case, lends a used battery, notifies one or delivers an exchange (S19).
func warrantyBranch(actor auth.Identity) bool {
	return actor.Location.ID > warrantyCaseWarehouse
}

// warrantyCaseMutation is the guard of every write of this contract: the same-origin session, the CSRF
// token and a body with no query string, exactly like the settlement mutations.
func (a *API) warrantyCaseMutation(w http.ResponseWriter, r *http.Request) bool {
	site := r.Header.Values("Sec-Fetch-Site")
	if len(site) > 1 || (len(site) == 1 && site[0] != "same-origin") {
		failure(w, 403, "forbidden")
		return false
	}
	if !a.GuardMutation(w, r) {
		return false
	}
	if r.URL.RawQuery != "" || r.URL.ForceQuery {
		failure(w, 400, "invalid_request")
		return false
	}
	return true
}

// warrantyRecord answers one case as the contract publishes it.
func (a *API) warrantyRecord(w http.ResponseWriter, status int, document warrantycase.Case) {
	record, err := warrantyCaseRecord(document)
	if err != nil {
		warrantyFailure(w, err)
		return
	}
	respond(w, status, record)
}

// warrantyCaseTray serves the collection: GET lists the tray of the session's own branch, filtered by
// the phase and the origin of the frozen vocabulary. A branch reads its own cases and the warehouse
// reads the cases it moves (S19).
func (a *API) warrantyCaseTray(store *warrantycase.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodGet) {
			return
		}
		actor, ok := a.warrantyActorOf(w, r)
		if !ok {
			return
		}
		// A bare separator is an ambiguous framing, not "no filter".
		if r.URL.RawQuery == "" && r.URL.ForceQuery {
			failure(w, 400, "invalid_request")
			return
		}
		filter, err := warrantyCaseTrayQuery(r.URL.RawQuery)
		if err != nil {
			warrantyFailure(w, err)
			return
		}
		tray, err := store.List(r.Context(), actor, filter)
		if err != nil {
			warrantyFailure(w, err)
			return
		}
		record := warrantyTrayDTO{Cases: make([]warrantyCaseRowDTO, 0, len(tray))}
		for _, document := range tray {
			row, err := warrantyCaseRowRecord(document)
			if err != nil {
				warrantyFailure(w, err)
				return
			}
			record.Cases = append(record.Cases, row)
		}
		respond(w, 200, record)
	}
}

// warrantyCaseTrayQuery reads the two filters of the tray: the phase and the origin of S23, each at
// most once, and nothing else.
func warrantyCaseTrayQuery(raw string) (warrantycase.ListFilter, error) {
	filter := warrantycase.ListFilter{}
	if len(raw) > 4096 || strings.HasPrefix(raw, "&") || strings.HasSuffix(raw, "&") ||
		strings.Contains(raw, "&&") {
		return filter, warrantycase.ErrInvalid
	}
	values, err := url.ParseQuery(raw)
	if err != nil {
		return filter, warrantycase.ErrInvalid
	}
	for key, entries := range values {
		if len(entries) != 1 || len(entries[0]) > warrantyCaseMaxSearch ||
			!utf8.ValidString(entries[0]) || strings.ContainsRune(entries[0], 0) {
			return warrantycase.ListFilter{}, warrantycase.ErrInvalid
		}
		switch key {
		case "phase":
			phase := warrantycase.Phase(entries[0])
			if !phase.Valid() {
				return warrantycase.ListFilter{}, warrantycase.ErrInvalid
			}
			filter.Phase = phase
		case "origin":
			origin := warrantycase.Origin(entries[0])
			if !origin.Valid() {
				return warrantycase.ListFilter{}, warrantycase.ErrInvalid
			}
			filter.Origin = origin
		default:
			return warrantycase.ListFilter{}, warrantycase.ErrInvalid
		}
	}
	return filter, nil
}

// warrantyCasePending serves the notification of the section: the count of cases whose next act is
// the session's own (S14, S19). It is one aggregate of the store, never the tray, because the badge
// beside the navigation entry has to be honest while the list is not open, and a case the actor could
// not act on is never counted. The payload is one decimal string, exactly like the transfer count.
func (a *API) warrantyCasePending(store *warrantycase.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodGet) {
			return
		}
		if _, valid := passiveMode(r); !valid {
			failure(w, 400, "invalid_request")
			return
		}
		// The badge reads in the background even when no selector is supplied: clone the request
		// instead of changing the caller's header ownership, exactly like the transfer count.
		passive := r.Clone(r.Context())
		passive.Header.Set(passiveHeader, "1")
		actor, ok := a.warrantyActorOf(w, passive)
		if !ok {
			return
		}
		if r.URL.RawQuery != "" || r.URL.ForceQuery {
			failure(w, 400, "invalid_request")
			return
		}
		count, err := store.Pending(r.Context(), actor)
		if err != nil {
			warrantyFailure(w, err)
			return
		}
		respond(w, 200, struct {
			ActionCount string `json:"action_count"`
		}{strconv.FormatInt(count, 10)})
	}
}

// warrantyClaim serves the first door: the serial the client brought under warranty (S1, S2).
func (a *API) warrantyClaim(store *warrantycase.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodPost) {
			return
		}
		actor, ok := a.warrantyActorOf(w, r)
		if !ok || !a.warrantyCaseMutation(w, r) {
			return
		}
		input, err := decodeWarrantyClaim(r)
		if err != nil {
			warrantyFailure(w, err)
			return
		}
		if !warrantyBranch(actor) {
			failure(w, 403, "forbidden")
			return
		}
		claim, err := store.OpenClaim(r.Context(), actor, input)
		if err != nil {
			warrantyFailure(w, err)
			return
		}
		a.warrantyRecord(w, 201, claim)
	}
}

// warrantyDefect serves the second door: the battery the branch found failed on its own shelf (S1,
// S16). The motive of the write-off belongs to this door and to nothing else.
func (a *API) warrantyDefect(store *warrantycase.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodPost) {
			return
		}
		actor, ok := a.warrantyActorOf(w, r)
		if !ok || !a.warrantyCaseMutation(w, r) {
			return
		}
		input, err := decodeWarrantyDefect(r)
		if err != nil {
			warrantyFailure(w, err)
			return
		}
		if !warrantyBranch(actor) {
			failure(w, 403, "forbidden")
			return
		}
		finding, err := store.OpenStockDefect(r.Context(), actor, input)
		if err != nil {
			warrantyFailure(w, err)
			return
		}
		a.warrantyRecord(w, 201, finding)
	}
}

// warrantyCaseDetail reads one case with its loans and its append-only history.
func (a *API) warrantyCaseDetail(store *warrantycase.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodGet) {
			return
		}
		actor, ok := a.warrantyActorOf(w, r)
		if !ok {
			return
		}
		if r.URL.RawQuery != "" || r.URL.ForceQuery {
			failure(w, 400, "invalid_request")
			return
		}
		id, err := warrantyCasePathID(r.PathValue("id"), warrantyCaseMaxID)
		if err != nil {
			warrantyFailure(w, err)
			return
		}
		document, err := store.Read(r.Context(), actor, id)
		if err != nil {
			warrantyFailure(w, err)
			return
		}
		a.warrantyRecord(w, 200, document)
	}
}

// warrantyUsedStockPath is the literal suffix of the derived stock (S24): the warehouse reads what it
// holds and the branch reads what it can lend, per location and per model, and it is one segment beside
// the case id so the stock is never mistaken for a case.
const warrantyUsedStockPath = "/used-stock"

// warrantyUsedStock serves the stock of used batteries: every location and model the installation has
// a fact of, with the terms of S24 and their signed sum. It is one read of the store, no body and no
// query, and every number is the derived one: this handler recomposes no term and never invents a
// zero for a key no document states (S18, S24).
func (a *API) warrantyUsedStock(store *warrantycase.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodGet) {
			return
		}
		actor, ok := a.warrantyActorOf(w, r)
		if !ok {
			return
		}
		// The stock is one table and not a search: a query is a framing this route does not have.
		if r.URL.RawQuery != "" || r.URL.ForceQuery {
			failure(w, 400, "invalid_request")
			return
		}
		stock, err := store.UsedStock(r.Context(), actor)
		if err != nil {
			warrantyFailure(w, err)
			return
		}
		record, err := warrantyUsedStockRecord(stock)
		if err != nil {
			warrantyFailure(w, err)
			return
		}
		respond(w, 200, record)
	}
}

// warrantyUsedStockRecord publishes the derived stock after revalidating it: a location of the
// installation, five quantities that are not negative, a sum that is exactly the arithmetic of S24 and
// a strictly ordered list, so two rows of one key can never be published as one balance. The balance
// itself may be negative, because it is a sum of the whole history and never a clamp.
func warrantyUsedStockRecord(stock []warrantycase.StockPosition) (warrantyUsedStockDTO, error) {
	unavailable := func() (warrantyUsedStockDTO, error) {
		return warrantyUsedStockDTO{}, warrantycase.ErrUnavailable
	}
	record := warrantyUsedStockDTO{Stock: make([]warrantyUsedStockRowDTO, 0, len(stock))}
	for _, row := range stock {
		if row.LocationID < warrantyCaseWarehouse || row.LocationID > math.MaxInt16 ||
			row.Purchased < 0 || row.FactoryReturns < 0 || row.LoansReturned < 0 ||
			row.Delivered < 0 || row.LoansGiven < 0 || row.Available != warrantyStockSum(row) {
			return unavailable()
		}
		if len(record.Stock) > 0 {
			previous := record.Stock[len(record.Stock)-1]
			if previous.LocationID > int64(row.LocationID) ||
				(previous.LocationID == int64(row.LocationID) && previous.Model >= row.Model) {
				return unavailable()
			}
		}
		record.Stock = append(record.Stock, warrantyUsedStockRowDTO{
			LocationID:     int64(row.LocationID),
			Model:          row.Model,
			Purchased:      strconv.FormatInt(row.Purchased, 10),
			FactoryReturns: strconv.FormatInt(row.FactoryReturns, 10),
			LoansReturned:  strconv.FormatInt(row.LoansReturned, 10),
			Delivered:      strconv.FormatInt(row.Delivered, 10),
			LoansGiven:     strconv.FormatInt(row.LoansGiven, 10),
			Available:      strconv.FormatInt(row.Available, 10)})
	}
	return record, nil
}

// warrantyStockSum is the signed sum of one row: the same arithmetic the store states, and the reason
// this handler never publishes a balance of its own. The delivered quantity is the branch's outflow
// and the warehouse's inflow -- one delivery, counted once on each side (S24).
func warrantyStockSum(row warrantycase.StockPosition) int64 {
	total := row.Purchased + row.FactoryReturns + row.LoansReturned - row.LoansGiven
	if row.LocationID == warrantyCaseWarehouse {
		return total + row.Delivered
	}
	return total - row.Delivered
}

// warrantyUsedStockDTO is the stock as the contract publishes it: one row per location and model, each
// term of the formula as a decimal string and the signed sum beside them, so a client that shows the
// stock can show why it is that number.
type warrantyUsedStockDTO struct {
	Stock []warrantyUsedStockRowDTO `json:"stock"`
}

// warrantyUsedStockRowDTO is one position of the derived stock (S24): where the battery is, which
// model it is -- the only identity a used battery has (S26) -- and the five facts that make the sum.
type warrantyUsedStockRowDTO struct {
	LocationID     int64  `json:"location_id"`
	Model          string `json:"model"`
	Purchased      string `json:"purchased"`
	FactoryReturns string `json:"factory_returns"`
	LoansReturned  string `json:"loans_returned"`
	Delivered      string `json:"delivered"`
	LoansGiven     string `json:"loans_given"`
	Available      string `json:"available"`
}

// warrantyCaseLoans hands one used battery to the client of a case (S5, S6).
func (a *API) warrantyCaseLoans(store *warrantycase.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodPost) {
			return
		}
		actor, ok := a.warrantyActorOf(w, r)
		if !ok || !a.warrantyCaseMutation(w, r) {
			return
		}
		id, err := warrantyCasePathID(r.PathValue("id"), warrantyCaseMaxID)
		if err != nil {
			warrantyFailure(w, err)
			return
		}
		input, err := decodeWarrantyLoan(r)
		if err != nil {
			warrantyFailure(w, err)
			return
		}
		if !warrantyBranch(actor) {
			failure(w, 403, "forbidden")
			return
		}
		loan, err := store.AddLoan(r.Context(), actor, id, input)
		if err != nil {
			warrantyFailure(w, err)
			return
		}
		record, err := warrantyLoanRecord(loan)
		if err != nil {
			warrantyFailure(w, err)
			return
		}
		respond(w, 201, record)
	}
}

// warrantyCaseLoanFate states what became of one lent battery (S7).
func (a *API) warrantyCaseLoanFate(store *warrantycase.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodPost) {
			return
		}
		actor, ok := a.warrantyActorOf(w, r)
		if !ok || !a.warrantyCaseMutation(w, r) {
			return
		}
		id, err := warrantyCasePathID(r.PathValue("id"), warrantyCaseMaxID)
		if err != nil {
			warrantyFailure(w, err)
			return
		}
		ordinal, err := warrantyCasePathID(r.PathValue("ordinal"), warrantyCaseMaxOrdinal)
		if err != nil {
			warrantyFailure(w, err)
			return
		}
		fate, err := decodeWarrantyFate(r)
		if err != nil {
			warrantyFailure(w, err)
			return
		}
		if !warrantyBranch(actor) {
			failure(w, 403, "forbidden")
			return
		}
		loan, err := store.DecideLoan(r.Context(), actor, id, int(ordinal), fate)
		if err != nil {
			warrantyFailure(w, err)
			return
		}
		record, err := warrantyLoanRecord(loan)
		if err != nil {
			warrantyFailure(w, err)
			return
		}
		respond(w, 200, record)
	}
}

// warrantyAdvanceTramo is the tramo of the journey each side records: the branch ships its case and
// closes it, the warehouse receives it, ships it to the factory and answers for the factory (S19).
func warrantyAdvanceTramo(actor auth.Identity, phase warrantycase.Phase) bool {
	switch phase {
	case warrantycase.PhaseInTransit, warrantycase.PhaseClosed:
		return warrantyBranch(actor)
	case warrantycase.PhaseAtWarehouse, warrantycase.PhaseAtFactory:
		return actor.Location.ID == warrantyCaseWarehouse
	}
	// A bare `resolved` is not a tramo at all: it is the store's refusal that answers it.
	return true
}

// warrantyCaseAdvance records one tramo of the journey (S9, S10).
func (a *API) warrantyCaseAdvance(store *warrantycase.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodPost) {
			return
		}
		actor, ok := a.warrantyActorOf(w, r)
		if !ok || !a.warrantyCaseMutation(w, r) {
			return
		}
		id, err := warrantyCasePathID(r.PathValue("id"), warrantyCaseMaxID)
		if err != nil {
			warrantyFailure(w, err)
			return
		}
		input, err := decodeWarrantyAdvance(r)
		if err != nil {
			warrantyFailure(w, err)
			return
		}
		if !warrantyAdvanceTramo(actor, input.Phase) {
			failure(w, 403, "forbidden")
			return
		}
		moved, err := store.Advance(r.Context(), actor, id, input)
		if err != nil {
			warrantyFailure(w, err)
			return
		}
		a.warrantyRecord(w, 200, moved)
	}
}

// warrantyCaseResolution records the verdict and the destinations (S10, S11).
func (a *API) warrantyCaseResolution(store *warrantycase.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodPost) {
			return
		}
		actor, ok := a.warrantyActorOf(w, r)
		if !ok || !a.warrantyCaseMutation(w, r) {
			return
		}
		id, err := warrantyCasePathID(r.PathValue("id"), warrantyCaseMaxID)
		if err != nil {
			warrantyFailure(w, err)
			return
		}
		input, err := decodeWarrantyResolution(r)
		if err != nil {
			warrantyFailure(w, err)
			return
		}
		// The verdict is the warehouse's, whichever side of the gate it is recorded on (S19).
		if actor.Location.ID != warrantyCaseWarehouse {
			failure(w, 403, "forbidden")
			return
		}
		resolved, err := store.Resolve(r.Context(), actor, id, input)
		if err != nil {
			warrantyFailure(w, err)
			return
		}
		a.warrantyRecord(w, 200, resolved)
	}
}

// warrantyCaseNotice registers the notice the branch owes its client (S14).
func (a *API) warrantyCaseNotice(store *warrantycase.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodPost) {
			return
		}
		actor, ok := a.warrantyActorOf(w, r)
		if !ok || !a.warrantyCaseMutation(w, r) {
			return
		}
		id, err := warrantyCasePathID(r.PathValue("id"), warrantyCaseMaxID)
		if err != nil {
			warrantyFailure(w, err)
			return
		}
		note, err := decodeWarrantyNote(r)
		if err != nil {
			warrantyFailure(w, err)
			return
		}
		// The notice is the branch's: the warehouse never notifies a client (S19).
		if !warrantyBranch(actor) {
			failure(w, 403, "forbidden")
			return
		}
		noticed, err := store.RegisterNotice(r.Context(), actor, id, note)
		if err != nil {
			warrantyFailure(w, err)
			return
		}
		a.warrantyRecord(w, 200, noticed)
	}
}

// warrantyCaseRelease authorises the release of the unit in custody to sellable stock (S13, S14).
func (a *API) warrantyCaseRelease(store *warrantycase.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodPost) {
			return
		}
		actor, ok := a.warrantyActorOf(w, r)
		if !ok || !a.warrantyCaseMutation(w, r) {
			return
		}
		id, err := warrantyCasePathID(r.PathValue("id"), warrantyCaseMaxID)
		if err != nil {
			warrantyFailure(w, err)
			return
		}
		note, err := decodeWarrantyNote(r)
		if err != nil {
			warrantyFailure(w, err)
			return
		}
		// A release states its motive, and the branch never authorises one (S14, S19).
		if strings.TrimSpace(note) == "" {
			failure(w, 400, "reason_required")
			return
		}
		if actor.Location.ID != warrantyCaseWarehouse {
			failure(w, 403, "forbidden")
			return
		}
		released, err := store.AuthorizeRelease(r.Context(), actor, id, note)
		if err != nil {
			warrantyFailure(w, err)
			return
		}
		a.warrantyRecord(w, 200, released)
	}
}

// warrantyCaseDelivery delivers the exchange and closes the case: the branch's own act, and never the
// warehouse's (S13, S19).
func (a *API) warrantyCaseDelivery(store *warrantycase.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodPost) {
			return
		}
		actor, ok := a.warrantyActorOf(w, r)
		if !ok || !a.warrantyCaseMutation(w, r) {
			return
		}
		id, err := warrantyCasePathID(r.PathValue("id"), warrantyCaseMaxID)
		if err != nil {
			warrantyFailure(w, err)
			return
		}
		input, err := decodeWarrantyDelivery(r)
		if err != nil {
			warrantyFailure(w, err)
			return
		}
		// A warehouse account never delivers to a customer (S19).
		if !warrantyBranch(actor) {
			failure(w, 403, "forbidden")
			return
		}
		delivered, err := store.DeliverExchange(r.Context(), actor, id, input)
		if err != nil {
			warrantyFailure(w, err)
			return
		}
		a.warrantyRecord(w, 200, delivered)
	}
}

// warrantyCasePathID admits one canonical identifier of a path segment: a padded, signed, zero,
// fractional or aliased spelling is a malformed request, never a cleaned id.
func warrantyCasePathID(value string, max int64) (int64, error) {
	if len(value) == 0 || len(value) > 19 || value[0] < '1' || value[0] > '9' {
		return 0, warrantycase.ErrInvalid
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			return 0, warrantycase.ErrInvalid
		}
	}
	number, err := strconv.ParseInt(value, 10, 64)
	if err != nil || number > max {
		return 0, warrantycase.ErrInvalid
	}
	return number, nil
}

// warrantyDecoder reads one JSON body of this contract: the media type the server wrote, a bounded
// body, and numbers as their own text so an id and a quantity are never a float.
func warrantyDecoder(r *http.Request) (*json.Decoder, error) {
	if r == nil || r.Body == nil || len(r.Header.Values("Content-Type")) != 1 {
		return nil, warrantycase.ErrInvalid
	}
	contentType := r.Header.Get("Content-Type")
	media, params, err := mime.ParseMediaType(contentType)
	if err != nil || media != "application/json" || len(params) > 1 ||
		strings.Count(contentType, ";") != len(params) {
		return nil, warrantycase.ErrInvalid
	}
	for key, value := range params {
		if key != "charset" || !strings.EqualFold(value, "utf-8") {
			return nil, warrantycase.ErrInvalid
		}
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, warrantyCaseBodyLimit+1))
	if err != nil || len(body) > warrantyCaseBodyLimit || !utf8.Valid(body) {
		return nil, warrantycase.ErrInvalid
	}
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	decoder.UseNumber()
	return decoder, nil
}

// warrantyObject walks one flat object whose keys are all required, refusing a duplicate, an unknown
// key and a trailing statement, and hands each field to its own reader.
func warrantyObject(r *http.Request, fields map[string]func(*json.Decoder) error) error {
	return warrantyFields(r, fields, nil)
}

// warrantyFields walks one flat object with two closed key sets -- the fields every body of that route
// states and the ones only one door states -- refusing a duplicate, an unknown key and a trailing
// statement, and hands each field to its own reader.
func warrantyFields(r *http.Request, stated, optional map[string]func(*json.Decoder) error) error {
	decoder, err := warrantyDecoder(r)
	if err != nil {
		return err
	}
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return warrantycase.ErrInvalid
	}
	seen := make(map[string]bool, len(stated)+len(optional))
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return warrantycase.ErrInvalid
		}
		key, ok := token.(string)
		if !ok || seen[key] {
			return warrantycase.ErrInvalid
		}
		read, known := stated[key]
		if !known {
			read, known = optional[key]
		}
		if !known {
			return warrantycase.ErrInvalid
		}
		seen[key] = true
		if err := read(decoder); err != nil {
			return warrantycase.ErrInvalid
		}
	}
	if token, err := decoder.Token(); err != nil || token != json.Delim('}') {
		return warrantycase.ErrInvalid
	}
	if _, err := decoder.Token(); err != io.EOF {
		return warrantycase.ErrInvalid
	}
	for key := range stated {
		if !seen[key] {
			return warrantycase.ErrInvalid
		}
	}
	return nil
}

// warrantyText reads one admitted text and refuses a value outside the database's bound.
func warrantyText(decoder *json.Decoder, maximum int) (string, error) {
	token, err := decoder.Token()
	if err != nil {
		return "", warrantycase.ErrInvalid
	}
	value, ok := token.(string)
	if !ok || len([]rune(value)) > maximum || !utf8.ValidString(value) ||
		strings.ContainsRune(value, 0) {
		return "", warrantycase.ErrInvalid
	}
	return value, nil
}

// warrantyInteger reads one positive whole number, never a float, a sign or a padded spelling.
func warrantyInteger(decoder *json.Decoder, max int64) (int64, error) {
	token, err := decoder.Token()
	if err != nil {
		return 0, warrantycase.ErrInvalid
	}
	number, ok := token.(json.Number)
	if !ok {
		return 0, warrantycase.ErrInvalid
	}
	return warrantyCasePathID(string(number), max)
}

// decodeWarrantyClaim reads the first door: the serial and what failed, and nothing else.
func decodeWarrantyClaim(r *http.Request) (warrantycase.OpenClaimInput, error) {
	input := warrantycase.OpenClaimInput{}
	err := warrantyObject(r, map[string]func(*json.Decoder) error{
		"serial_number": func(d *json.Decoder) error {
			value, err := warrantyText(d, warrantyCaseMaxSerial)
			input.SerialNumber = value
			return err
		},
		"declared_failure": func(d *json.Decoder) error {
			value, err := warrantyText(d, warrantyCaseMaxNote)
			input.DeclaredFailure = value
			return err
		},
	})
	return input, err
}

// decodeWarrantyDefect reads the second door: the variant, the quantity, what failed and the motive of
// the write-off, which is required here and forbidden on a claim.
func decodeWarrantyDefect(r *http.Request) (warrantycase.StockDefectInput, error) {
	input := warrantycase.StockDefectInput{}
	err := warrantyObject(r, map[string]func(*json.Decoder) error{
		"variant_id": func(d *json.Decoder) error {
			value, err := warrantyInteger(d, warrantycase.MaxVariantID)
			input.VariantID = value
			return err
		},
		"quantity": func(d *json.Decoder) error {
			value, err := warrantyInteger(d, warrantycase.MaxQuantity)
			input.Quantity = value
			return err
		},
		"declared_failure": func(d *json.Decoder) error {
			value, err := warrantyText(d, warrantyCaseMaxNote)
			input.DeclaredFailure = value
			return err
		},
		"reason": func(d *json.Decoder) error {
			value, err := warrantyText(d, warrantyCaseMaxNote)
			input.Reason = value
			return err
		},
	})
	return input, err
}

// decodeWarrantyLoan reads one loan: the model, the quantity, the optional serial and the shelf the
// battery came from.
func decodeWarrantyLoan(r *http.Request) (warrantycase.LoanInput, error) {
	input := warrantycase.LoanInput{}
	err := warrantyObject(r, map[string]func(*json.Decoder) error{
		"model": func(d *json.Decoder) error {
			value, err := warrantyText(d, warrantyCaseMaxModel)
			input.Model = value
			return err
		},
		"quantity": func(d *json.Decoder) error {
			value, err := warrantyInteger(d, warrantycase.MaxLoanQuantity)
			input.Quantity = value
			return err
		},
		"serial_number": func(d *json.Decoder) error {
			value, err := warrantyText(d, warrantyCaseMaxSerial)
			input.SerialNumber = value
			return err
		},
		"source_location_id": func(d *json.Decoder) error {
			// The smallest admissible location bound is the smallint the column stores.
			value, err := warrantyInteger(d, 32767)
			input.SourceLocationID = int(value)
			return err
		},
	})
	return input, err
}

// decodeWarrantyFate reads what became of one lent battery: one of the frozen five.
func decodeWarrantyFate(r *http.Request) (warrantycase.LoanFate, error) {
	var fate warrantycase.LoanFate
	err := warrantyObject(r, map[string]func(*json.Decoder) error{
		"fate": func(d *json.Decoder) error {
			value, err := warrantyText(d, warrantyCaseMaxSearch)
			fate = warrantycase.LoanFate(value)
			if err == nil && !fate.Valid() {
				return warrantycase.ErrInvalid
			}
			return err
		},
	})
	return fate, err
}

// decodeWarrantyAdvance reads one tramo: the phase it enters, the factory file number of the shipment
// and the reason of the tramo.
func decodeWarrantyAdvance(r *http.Request) (warrantycase.AdvanceInput, error) {
	input := warrantycase.AdvanceInput{}
	err := warrantyObject(r, map[string]func(*json.Decoder) error{
		"phase": func(d *json.Decoder) error {
			value, err := warrantyText(d, warrantyCaseMaxSearch)
			input.Phase = warrantycase.Phase(value)
			if err == nil && !input.Phase.Valid() {
				return warrantycase.ErrInvalid
			}
			return err
		},
		"factory_case_number": func(d *json.Decoder) error {
			value, err := warrantyText(d, warrantyCaseMaxFactoryNumber)
			input.FactoryCaseNumber = value
			return err
		},
		"note": func(d *json.Decoder) error {
			value, err := warrantyText(d, warrantyCaseMaxNote)
			input.Note = value
			return err
		},
	})
	return input, err
}

// decodeWarrantyResolution reads the verdict and the destination of the units the case has. The frozen
// vocabulary is judged here and again in the store and the database (S23). `loan_destination` is the
// lent battery of a claim and the finding on the shelf lends none, so that key is the door's own and
// the store decides which door states it (S11); the shelf destination is nobody's to state.
func decodeWarrantyResolution(r *http.Request) (warrantycase.ResolutionInput, error) {
	input := warrantycase.ResolutionInput{}
	verdict := func(d *json.Decoder) error {
		value, err := warrantyText(d, warrantyCaseMaxSearch)
		input.Verdict = warrantycase.Verdict(value)
		if err == nil && !input.Verdict.Valid() {
			return warrantycase.ErrInvalid
		}
		return err
	}
	reported := func(d *json.Decoder) error {
		value, err := warrantyText(d, warrantyCaseMaxSearch)
		input.ReportedDestination = warrantycase.Destination(value)
		if err == nil && !input.ReportedDestination.Valid() {
			return warrantycase.ErrInvalid
		}
		return err
	}
	note := func(d *json.Decoder) error {
		value, err := warrantyText(d, warrantyCaseMaxNote)
		input.Note = value
		return err
	}
	err := warrantyFields(r,
		map[string]func(*json.Decoder) error{
			"verdict": verdict, "reported_destination": reported, "note": note},
		map[string]func(*json.Decoder) error{
			"loan_destination": func(d *json.Decoder) error {
				value, err := warrantyText(d, warrantyCaseMaxSearch)
				input.LoanDestination = warrantycase.Destination(value)
				if err == nil && !input.LoanDestination.Valid() {
					return warrantycase.ErrInvalid
				}
				return err
			},
		})
	return input, err
}

// decodeWarrantyNote reads the words of the notice or the motive of the release: one key, and the
// bound of the note the history keeps.
func decodeWarrantyNote(r *http.Request) (string, error) {
	var note string
	err := warrantyObject(r, map[string]func(*json.Decoder) error{
		"note": func(d *json.Decoder) error {
			value, err := warrantyText(d, warrantyCaseMaxNote)
			note = value
			return err
		},
	})
	return note, err
}

// decodeWarrantyDelivery reads the delivery of the exchange: what became of the lent battery and the
// words of the counter.
func decodeWarrantyDelivery(r *http.Request) (warrantycase.DeliveryInput, error) {
	input := warrantycase.DeliveryInput{}
	err := warrantyObject(r, map[string]func(*json.Decoder) error{
		"loan_fate": func(d *json.Decoder) error {
			value, err := warrantyText(d, warrantyCaseMaxSearch)
			input.LoanFate = warrantycase.LoanFate(value)
			if err == nil && !input.LoanFate.Valid() {
				return warrantycase.ErrInvalid
			}
			return err
		},
		"note": func(d *json.Decoder) error {
			value, err := warrantyText(d, warrantyCaseMaxNote)
			input.Note = value
			return err
		},
	})
	return input, err
}

// warrantyCaseDTO is one case as this contract publishes it: what the case is about, the two doors it
// can have come from, the phase of its journey, the resolution once it has one, and the loans and the
// history that make it legible without a second read. The verdict and the three destinations are JSON
// null until the case is resolved, and the stock destination is null on a claim, which never had
// branch stock in play.
type warrantyCaseDTO struct {
	ID                  int64              `json:"id"`
	CaseNumber          string             `json:"case_number"`
	BranchLocationID    int64              `json:"branch_location_id"`
	Origin              string             `json:"origin"`
	Phase               string             `json:"phase"`
	Verdict             *string            `json:"verdict"`
	ReportedDestination *string            `json:"reported_destination"`
	LoanDestination     *string            `json:"loan_destination"`
	StockDestination    *string            `json:"stock_destination"`
	SaleID              *int64             `json:"sale_id"`
	WarrantyNumber      *string            `json:"warranty_number"`
	VariantID           int64              `json:"variant_id"`
	SerialNumber        *string            `json:"serial_number"`
	Quantity            *int64             `json:"quantity"`
	DeclaredFailure     string             `json:"declared_failure"`
	Reason              *string            `json:"reason"`
	CreatedByAccountID  int64              `json:"created_by_account_id"`
	CreatedAt           string             `json:"created_at"`
	Loans               []warrantyLoanDTO  `json:"loans"`
	Events              []warrantyEventDTO `json:"events"`
}

// warrantyCaseRowDTO is one row of the tray: the header of a case and nothing else. The history of a
// case is read from the case itself, so a queue of two hundred cases never drags two hundred
// histories.
type warrantyCaseRowDTO struct {
	ID               int64   `json:"id"`
	CaseNumber       string  `json:"case_number"`
	BranchLocationID int64   `json:"branch_location_id"`
	Origin           string  `json:"origin"`
	Phase            string  `json:"phase"`
	VariantID        int64   `json:"variant_id"`
	SerialNumber     *string `json:"serial_number"`
	Quantity         *int64  `json:"quantity"`
	DeclaredFailure  string  `json:"declared_failure"`
	Reason           *string `json:"reason"`
	CreatedAt        string  `json:"created_at"`
}

// warrantyTrayDTO is the tray of one branch: the newest cases it owns, and each row names the branch
// it belongs to because the warehouse reads the tray of every branch.
type warrantyTrayDTO struct {
	Cases []warrantyCaseRowDTO `json:"cases"`
}

// warrantyLoanDTO is one used battery handed to the client of a case: the model and the quantity it
// identifies, the optional serial nobody keys on, where it came from and what became of it.
type warrantyLoanDTO struct {
	Ordinal          int     `json:"ordinal"`
	Model            string  `json:"model"`
	Quantity         int64   `json:"quantity"`
	SerialNumber     string  `json:"serial_number"`
	SourceLocationID int64   `json:"source_location_id"`
	GivenAt          string  `json:"given_at"`
	Fate             string  `json:"fate"`
	FateDecidedAt    *string `json:"fate_decided_at"`
	GivenByAccountID int64   `json:"given_by_account_id"`
}

// warrantyEventDTO is one tramo of the append-only history: what it states, the phase it carries, the
// file number of the factory shipment, who wrote it, when and why.
type warrantyEventDTO struct {
	Ordinal           int    `json:"ordinal"`
	Kind              string `json:"kind"`
	Phase             string `json:"phase"`
	FactoryCaseNumber string `json:"factory_case_number"`
	ActorAccountID    int64  `json:"actor_account_id"`
	RecordedAt        string `json:"recorded_at"`
	Note              string `json:"note"`
}

// warrantyInstant publishes one instant the way this contract states time: UTC, whole seconds and a
// value that reads back as itself. A moment the database could not have written is never published.
func warrantyInstant(moment time.Time) (string, bool) {
	if moment.IsZero() {
		return "", false
	}
	text := moment.UTC().Format(time.RFC3339)
	parsed, err := time.Parse(time.RFC3339, text)
	if err != nil || !parsed.Equal(moment.Truncate(time.Second)) {
		return "", false
	}
	return text, true
}

// warrantyCaseRecord revalidates one case whole before it is published: the number the database
// writes, the origin and the phase of the frozen vocabulary, the shape of each door, the verdict and
// the destinations of a resolution, the phase the history states and the order of the loans and the
// tramos.
func warrantyCaseRecord(document warrantycase.Case) (warrantyCaseDTO, error) {
	unavailable := func() (warrantyCaseDTO, error) { return warrantyCaseDTO{}, warrantycase.ErrUnavailable }
	row, err := warrantyCaseRowRecord(document)
	if err != nil {
		return unavailable()
	}
	createdAt, ok := warrantyInstant(document.CreatedAt)
	if !ok {
		return unavailable()
	}
	record := warrantyCaseDTO{
		ID: row.ID, CaseNumber: row.CaseNumber, BranchLocationID: row.BranchLocationID,
		Origin: row.Origin, Phase: row.Phase, VariantID: row.VariantID,
		SerialNumber: row.SerialNumber, Quantity: row.Quantity,
		DeclaredFailure: row.DeclaredFailure, Reason: row.Reason, CreatedAt: createdAt,
		SaleID: document.SaleID, WarrantyNumber: document.WarrantyNumber,
		CreatedByAccountID: document.CreatedByAccountID,
		Loans:              make([]warrantyLoanDTO, 0, len(document.Loans)),
		Events:             make([]warrantyEventDTO, 0, len(document.Events)),
	}
	// The verdict and the destinations are the resolution of the case, and they are stated at once: a
	// resolved case states its verdict and where its reported units end, and an open one states none
	// (S11). Each door then states the units it has: a claim the reported battery and the lent one and
	// never the shelf of a finding, a finding its own shelf -- which is the verdict's reading -- and never
	// a lent battery, because it lends none.
	verdict, reported := document.Verdict, document.ReportedDestination
	loan, stock := document.LoanDestination, document.StockDestination
	switch {
	case verdict == nil && reported == nil && loan == nil && stock == nil:
	case verdict == nil || reported == nil || !verdict.Valid() || !reported.Valid():
		return unavailable()
	case document.Origin == warrantycase.OriginWarrantyClaim:
		if loan == nil || !loan.Valid() || stock != nil {
			return unavailable()
		}
	case document.Origin == warrantycase.OriginStockDefect:
		if loan != nil || !stockStatedByVerdict(*verdict, stock) {
			return unavailable()
		}
	default:
		return unavailable()
	}
	if verdict != nil {
		stated := string(*verdict)
		statedReported := string(*reported)
		record.Verdict, record.ReportedDestination = &stated, &statedReported
		if loan != nil {
			statedLoan := string(*loan)
			record.LoanDestination = &statedLoan
		}
		if stock != nil {
			statedStock := string(*stock)
			record.StockDestination = &statedStock
		}
	}
	var previousLoan int
	for _, item := range document.Loans {
		loanRecord, err := warrantyLoanRecord(item)
		if err != nil || loanRecord.Ordinal <= previousLoan {
			return unavailable()
		}
		previousLoan = loanRecord.Ordinal
		record.Loans = append(record.Loans, loanRecord)
	}
	// The phase of a case is the phase its last event states, so the history and the header can never be
	// published disagreeing (S9, S31): a tramo of the journey enters its phase, and a notice or a release
	// carries the phase the case holds -- except the release that closes the case whose unit is the
	// branch's own stock, which states the `closed` it writes.
	phase := warrantycase.PhaseReceived
	var previousEvent int
	for _, item := range document.Events {
		eventRecord, err := warrantyEventRecord(item)
		if err != nil || eventRecord.Ordinal <= previousEvent {
			return unavailable()
		}
		previousEvent = eventRecord.Ordinal
		phase = item.Phase
		record.Events = append(record.Events, eventRecord)
	}
	if phase != document.Phase {
		return unavailable()
	}
	return record, nil
}

// stockStatedByVerdict restates the shelf outcome of a finding's resolution: its units are back in the
// branch's stock exactly when the verdict returns them repaired or replaced, and the write-off stands
// otherwise, so the field is stated exactly then and never on a claim (S11).
func stockStatedByVerdict(verdict warrantycase.Verdict, stock *warrantycase.Destination) bool {
	returns := verdict == warrantycase.VerdictRepaired || verdict == warrantycase.VerdictReplaced
	if !returns {
		return stock == nil
	}
	return stock != nil && *stock == warrantycase.DestinationStock
}

// warrantyCaseRowRecord revalidates the header of one case: the number of the branch, the frozen
// origin and phase (S23) and the shape of the door it came through (S1).
func warrantyCaseRowRecord(document warrantycase.Case) (warrantyCaseRowDTO, error) {
	unavailable := func() (warrantyCaseRowDTO, error) {
		return warrantyCaseRowDTO{}, warrantycase.ErrUnavailable
	}
	createdAt, ok := warrantyInstant(document.CreatedAt)
	if document.ID < 1 || document.BranchLocationID <= warrantyCaseWarehouse ||
		!warrantyCaseNumberPattern.MatchString(document.CaseNumber) ||
		!document.Origin.Valid() || !document.Phase.Valid() || document.VariantID < 1 ||
		document.DeclaredFailure == "" || len([]rune(document.DeclaredFailure)) > warrantyCaseMaxNote ||
		document.CreatedByAccountID < 1 || !ok {
		return unavailable()
	}
	// A claim is the serial of a sold unit and a finding is the quantity of a shelf: neither door can
	// publish the shape of the other (S1, S16).
	switch document.Origin {
	case warrantycase.OriginWarrantyClaim:
		if document.SerialNumber == nil || len(*document.SerialNumber) == 0 ||
			len([]rune(*document.SerialNumber)) > warrantyCaseMaxSerial ||
			document.Quantity != nil || document.Reason != nil ||
			document.SaleID == nil || *document.SaleID < 1 {
			return unavailable()
		}
	case warrantycase.OriginStockDefect:
		if document.Quantity == nil || *document.Quantity < 1 ||
			*document.Quantity > warrantycase.MaxQuantity || document.SerialNumber != nil ||
			document.SaleID != nil || document.WarrantyNumber != nil ||
			document.Reason == nil || *document.Reason == "" ||
			len([]rune(*document.Reason)) > warrantyCaseMaxNote {
			return unavailable()
		}
	}
	if document.WarrantyNumber != nil && (len(*document.WarrantyNumber) > 32) {
		return unavailable()
	}
	return warrantyCaseRowDTO{ID: document.ID, CaseNumber: document.CaseNumber,
		BranchLocationID: int64(document.BranchLocationID), Origin: string(document.Origin),
		Phase: string(document.Phase), VariantID: document.VariantID,
		SerialNumber: document.SerialNumber, Quantity: document.Quantity,
		DeclaredFailure: document.DeclaredFailure, Reason: document.Reason,
		CreatedAt: createdAt}, nil
}

// warrantyLoanRecord revalidates one loan: the ordinal of the database, the model and the quantity the
// counter stated, the optional serial and a fate that carries its own instant exactly when it left
// open (S5, S7, S17).
func warrantyLoanRecord(item warrantycase.Loan) (warrantyLoanDTO, error) {
	unavailable := func() (warrantyLoanDTO, error) { return warrantyLoanDTO{}, warrantycase.ErrUnavailable }
	givenAt, ok := warrantyInstant(item.GivenAt)
	if item.Ordinal < 1 || item.Ordinal > int(warrantyCaseMaxOrdinal) || item.Model == "" ||
		len([]rune(item.Model)) > warrantyCaseMaxModel || item.Quantity < 1 ||
		item.Quantity > warrantycase.MaxLoanQuantity ||
		len([]rune(item.SerialNumber)) > warrantyCaseMaxSerial ||
		item.SourceLocationID < 1 || item.GivenByAccountID < 1 || !item.Fate.Valid() || !ok {
		return unavailable()
	}
	record := warrantyLoanDTO{Ordinal: item.Ordinal, Model: item.Model, Quantity: item.Quantity,
		SerialNumber: item.SerialNumber, SourceLocationID: int64(item.SourceLocationID),
		GivenAt: givenAt, Fate: string(item.Fate), GivenByAccountID: item.GivenByAccountID}
	// A loan is born open and undated and a decided fate states its instant (065, S17).
	if item.Fate == warrantycase.LoanOpen {
		if item.FateDecidedAt != nil {
			return unavailable()
		}
		return record, nil
	}
	if item.FateDecidedAt == nil {
		return unavailable()
	}
	decided, ok := warrantyInstant(*item.FateDecidedAt)
	if !ok || decided < givenAt {
		return unavailable()
	}
	record.FateDecidedAt = &decided
	return record, nil
}

// warrantyEventRecord revalidates one tramo: its order, its kind, the phase it states, the file number
// of the factory shipment and its actor (S9, S14).
func warrantyEventRecord(item warrantycase.Event) (warrantyEventDTO, error) {
	unavailable := func() (warrantyEventDTO, error) { return warrantyEventDTO{}, warrantycase.ErrUnavailable }
	recordedAt, ok := warrantyInstant(item.RecordedAt)
	if item.Ordinal < 1 || !item.Kind.Valid() || !item.Phase.Valid() || item.ActorAccountID < 1 ||
		len([]rune(item.FactoryCaseNumber)) > warrantyCaseMaxFactoryNumber ||
		len([]rune(item.Note)) > warrantyCaseMaxNote || !ok {
		return unavailable()
	}
	// The factory file number travels with the factory shipment and with nothing else (S9, S10).
	if shipment := item.Kind == warrantycase.KindPhase &&
		item.Phase == warrantycase.PhaseAtFactory; shipment != (item.FactoryCaseNumber != "") {
		return unavailable()
	}
	return warrantyEventDTO{Ordinal: item.Ordinal, Kind: string(item.Kind), Phase: string(item.Phase),
		FactoryCaseNumber: item.FactoryCaseNumber, ActorAccountID: item.ActorAccountID,
		RecordedAt: recordedAt, Note: item.Note}, nil
}
