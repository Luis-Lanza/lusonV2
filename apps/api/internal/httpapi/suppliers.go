package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"mime"
	"net/http"
	"strings"
	"unicode/utf8"

	"luson/api/internal/auth"
	"luson/api/internal/catalog"
	"luson/api/internal/config"
	"luson/api/internal/suppliers"
)

const (
	// supplierRoutePath is the single admitted collection of this contract. Below it
	// live the identity, its fixed sub-resources and the assignable catalogue.
	supplierRoutePath = "/api/suppliers"
	// supplierBodyLimit bounds decoding work well below the HTTP read timeout: the
	// widest admitted document is a trimmed name and a 200-character contact.
	supplierBodyLimit = 4 << 10
	// supplierOffersBodyLimit bounds the offer set document, which is at most 200
	// catalogue identities.
	supplierOffersBodyLimit = 16 << 10
	// supplierMaxEntryID is the catalogue identity bound, restated here so an
	// impossible entry id never reaches the store.
	supplierMaxEntryID = math.MaxInt32
	// supplierMaxOffers, supplierMaxSearch and supplierMaxPageSize restate the store
	// bounds so an inadmissible document or query never reaches it.
	supplierMaxOffers   = 200
	supplierMaxSearch   = 128
	supplierMaxPageSize = 50
)

// Suppliers is the supplier administration authority this surface mounts: the
// warehouse administrator gate the rest of the admin surface applies and the eight
// operations of this contract. The store implements it and rechecks the same gate
// inside every operation, so the surface never derives authority from the request
// alone.
//
// The interface is the seam between the HTTP contract and the domain: the surface is
// exercised without a database through it, and wiring passes the one store the
// vertical uses.
type Suppliers interface {
	Authorize(ctx context.Context, actor auth.Identity) error
	List(ctx context.Context, actor auth.Identity, page, pageSize int) (suppliers.Page, error)
	Create(ctx context.Context, actor auth.Identity, in suppliers.CreateInput) (suppliers.Supplier, error)
	Edit(ctx context.Context, actor auth.Identity, id int64, in suppliers.EditInput) (suppliers.Supplier, error)
	Retire(ctx context.Context, actor auth.Identity, id int64) error
	Read(ctx context.Context, actor auth.Identity, id int64) (suppliers.Detail, error)
	ReplaceOffers(ctx context.Context, actor auth.Identity, id int64, entryIDs []int64) (suppliers.Detail, error)
	Catalog(ctx context.Context, actor auth.Identity, q suppliers.EntryQuery) (suppliers.EntryPage, error)
	OfferedVariants(ctx context.Context, actor auth.Identity, id int64, q suppliers.VariantQuery) (suppliers.VariantPage, error)
}

// NewWithSuppliers mounts the warehouse supplier administration on a handler built by
// another factory, following the other-product contract. The composed constructor
// keeps every existing factory untouched: this one owns only its own path, every other
// request is forwarded unchanged, and the store is the final authority for both the
// reads and the writes.
func NewWithSuppliers(base http.Handler, service *auth.Service, cfg config.Auth, store Suppliers) (http.Handler, error) {
	if base == nil || service == nil || store == nil {
		return nil, suppliers.ErrUnavailable
	}
	parsed, err := config.ParseAuth(config.LocalTrial, cfg.Origin, cfg.Listen, cfg.TLSCert, cfg.TLSKey)
	if err != nil || parsed != cfg {
		return nil, suppliers.ErrUnavailable
	}
	api := &API{service, cfg}
	routes := api.supplierRoutes(store)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		// An ambiguous supplier path is refused before the handler can set its response
		// headers, exactly like the battery, price and other-product routes.
		if !supplierPath(r) {
			failure(w, 404, "not_found")
			return
		}
		if supplierRoute(r.URL.Path) {
			routes.ServeHTTP(w, r)
			return
		}
		base.ServeHTTP(w, r)
	}), nil
}

// supplierRoute reports whether this path belongs to the supplier contract.
func supplierRoute(path string) bool {
	return path == supplierRoutePath || strings.HasPrefix(path, supplierRoutePath+"/")
}

// supplierPath refuses ambiguous supplier paths: a doubled slash, a dot segment, a
// backslash, a NUL or an encoded alias is not_found, never a silent redirect to a
// different resource. Every path outside the collection is admitted here and
// forwarded as is.
func supplierPath(r *http.Request) bool {
	p := r.URL.Path
	if !supplierRoute(p) {
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

// supplierRoutes registers the collection, the assignable catalogue, the identity and
// its two fixed sub-resources. The literal catalogue path is registered beside the
// {id} pattern, which is never more specific than it. Any other path below the
// collection is an unknown route answered as JSON, never a cleaned or redirected path.
func (a *API) supplierRoutes(store Suppliers) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc(supplierRoutePath, a.suppliersCollection(store))
	mux.HandleFunc(supplierRoutePath+"/catalog", a.supplierCatalog(store))
	mux.HandleFunc(supplierRoutePath+"/{id}", a.supplierItem(store))
	mux.HandleFunc(supplierRoutePath+"/{id}/offers", a.supplierOffers(store))
	mux.HandleFunc(supplierRoutePath+"/{id}/catalog", a.supplierOfferedVariants(store))
	mux.HandleFunc(supplierRoutePath+"/", func(w http.ResponseWriter, r *http.Request) {
		failure(w, 404, "not_found")
	})
	return mux
}

// supplierFailure publishes the domain's own decision and nothing else.
func supplierFailure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, suppliers.ErrInvalid):
		failure(w, 400, "invalid_request")
	case errors.Is(err, suppliers.ErrForbidden):
		failure(w, 403, "forbidden")
	case errors.Is(err, suppliers.ErrNotFound):
		failure(w, 404, "not_found")
	case errors.Is(err, suppliers.ErrConflict):
		failure(w, 409, "conflict")
	default:
		failure(w, 503, "service_unavailable")
	}
}

// supplierAdmin is the surface gate: the session identity resolved by the same reader
// the rest of the warehouse surface uses, admitted here by the store's warehouse
// administrator decision before any method, payload or body work. Authorization
// therefore precedes everything else, and a refused caller never reaches a statement
// or the mutation guard.
func (a *API) supplierAdmin(w http.ResponseWriter, r *http.Request, store Suppliers) (auth.Identity, bool) {
	actor, ok := a.inventoryIdentity(w, r)
	if !ok {
		return auth.Identity{}, false
	}
	if err := store.Authorize(r.Context(), actor); err != nil {
		supplierFailure(w, err)
		return auth.Identity{}, false
	}
	return actor, true
}

// supplierID is the strict reader of this contract: decimal digits only, no sign, no
// padding and no fraction. The identity column is a bigint, so no other bound applies.
func supplierID(raw string) (int64, error) {
	id, err := canonicalAdjustmentInteger(raw, math.MaxInt64)
	if err != nil {
		return 0, suppliers.ErrInvalid
	}
	return id, nil
}

// suppliersCollection lists one page of suppliers or creates one supplier. The guards
// run in the other-product contract's order: authority, method, framing, then the
// same-origin and CSRF guard, then the canonical document.
func (a *API) suppliersCollection(store Suppliers) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		actor, ok := a.supplierAdmin(w, r, store)
		if !ok {
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodPost {
			w.Header().Set("Allow", "GET, POST")
			failure(w, 405, "method_not_allowed")
			return
		}
		if r.Method == http.MethodGet {
			// A bare separator is an ambiguous framing, not the default page.
			if r.URL.RawQuery == "" && r.URL.ForceQuery {
				failure(w, 400, "invalid_request")
				return
			}
			page, pageSize, err := supplierListQuery(r.URL.RawQuery)
			if err != nil {
				supplierFailure(w, err)
				return
			}
			result, err := store.List(r.Context(), actor, page, pageSize)
			if err != nil {
				supplierFailure(w, err)
				return
			}
			record, err := supplierPageRecord(result)
			if err != nil {
				supplierFailure(w, err)
				return
			}
			respond(w, 200, record)
			return
		}
		// A write never carries a query string.
		if r.URL.RawQuery != "" || r.URL.ForceQuery {
			failure(w, 400, "invalid_request")
			return
		}
		if !a.GuardMutation(w, r) {
			return
		}
		body, err := supplierDocument(r)
		if err != nil {
			supplierFailure(w, err)
			return
		}
		supplier, err := store.Create(r.Context(), actor, suppliers.CreateInput{Name: body.name, Contact: body.contact})
		if err != nil {
			supplierFailure(w, err)
			return
		}
		record, err := supplierRecord(supplier)
		if err != nil {
			supplierFailure(w, err)
			return
		}
		respond(w, 201, record)
	}
}

// supplierItem reads, edits or retires one supplier. An edit carries the name and the
// contact, because that pair is the whole editable document and the offer set is never
// part of it; a retirement carries no body at all.
func (a *API) supplierItem(store Suppliers) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		actor, ok := a.supplierAdmin(w, r, store)
		if !ok {
			return
		}
		if r.URL.RawQuery != "" || r.URL.ForceQuery {
			failure(w, 400, "invalid_request")
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodPatch && r.Method != http.MethodDelete {
			w.Header().Set("Allow", "GET, PATCH, DELETE")
			failure(w, 405, "method_not_allowed")
			return
		}
		id, err := supplierID(r.PathValue("id"))
		if err != nil {
			supplierFailure(w, err)
			return
		}
		if r.Method == http.MethodGet {
			detail, err := store.Read(r.Context(), actor, id)
			if err != nil {
				supplierFailure(w, err)
				return
			}
			record, err := supplierDetailRecord(detail)
			if err != nil {
				supplierFailure(w, err)
				return
			}
			respond(w, 200, record)
			return
		}
		if !a.GuardMutation(w, r) {
			return
		}
		if r.Method == http.MethodDelete {
			if err = store.Retire(r.Context(), actor, id); err != nil {
				supplierFailure(w, err)
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		body, err := supplierDocument(r)
		if err != nil {
			supplierFailure(w, err)
			return
		}
		supplier, err := store.Edit(r.Context(), actor, id, suppliers.EditInput{Name: body.name, Contact: body.contact})
		if err != nil {
			supplierFailure(w, err)
			return
		}
		record, err := supplierRecord(supplier)
		if err != nil {
			supplierFailure(w, err)
			return
		}
		respond(w, 200, record)
	}
}

// supplierOffers replaces the whole offer set of one supplier. The body is the final
// set, so an empty list is a supplier that offers nothing, and the response is the same
// shape the detail read publishes.
func (a *API) supplierOffers(store Suppliers) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		actor, ok := a.supplierAdmin(w, r, store)
		if !ok {
			return
		}
		if r.Method != http.MethodPut {
			w.Header().Set("Allow", "PUT")
			failure(w, 405, "method_not_allowed")
			return
		}
		if r.URL.RawQuery != "" || r.URL.ForceQuery {
			failure(w, 400, "invalid_request")
			return
		}
		id, err := supplierID(r.PathValue("id"))
		if err != nil {
			supplierFailure(w, err)
			return
		}
		if !a.GuardMutation(w, r) {
			return
		}
		entries, err := supplierOffersDocument(r)
		if err != nil {
			supplierFailure(w, err)
			return
		}
		detail, err := store.ReplaceOffers(r.Context(), actor, id, entries)
		if err != nil {
			supplierFailure(w, err)
			return
		}
		record, err := supplierDetailRecord(detail)
		if err != nil {
			supplierFailure(w, err)
			return
		}
		respond(w, 200, record)
	}
}

// supplierCatalog serves the assignable catalogue: the active catalogue ENTRIES of
// both kinds, because that is what a supplier offers. It never mutates the catalogue
// and carries no stock number.
func (a *API) supplierCatalog(store Suppliers) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		actor, ok := a.supplierAdmin(w, r, store)
		if !ok {
			return
		}
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			failure(w, 405, "method_not_allowed")
			return
		}
		if r.URL.RawQuery == "" && r.URL.ForceQuery {
			failure(w, 400, "invalid_request")
			return
		}
		query, err := supplierCatalogQuery(r.URL.RawQuery)
		if err != nil {
			supplierFailure(w, err)
			return
		}
		page, err := store.Catalog(r.Context(), actor, query)
		if err != nil {
			supplierFailure(w, err)
			return
		}
		record, err := supplierCatalogRecord(page)
		if err != nil {
			supplierFailure(w, err)
			return
		}
		respond(w, 200, record)
	}
}

// supplierOfferedVariants serves the variants of the entries one supplier offers,
// which is the ingress picker: entry-level assignment expands to variants and no stock
// number is published here.
func (a *API) supplierOfferedVariants(store Suppliers) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		actor, ok := a.supplierAdmin(w, r, store)
		if !ok {
			return
		}
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			failure(w, 405, "method_not_allowed")
			return
		}
		if r.URL.RawQuery == "" && r.URL.ForceQuery {
			failure(w, 400, "invalid_request")
			return
		}
		id, err := supplierID(r.PathValue("id"))
		if err != nil {
			supplierFailure(w, err)
			return
		}
		query, err := supplierVariantQuery(r.URL.RawQuery)
		if err != nil {
			supplierFailure(w, err)
			return
		}
		page, err := store.OfferedVariants(r.Context(), actor, id, query)
		if err != nil {
			supplierFailure(w, err)
			return
		}
		record, err := supplierVariantPageRecord(page)
		if err != nil {
			supplierFailure(w, err)
			return
		}
		respond(w, 200, record)
	}
}

// supplierListQuery reads the frozen list query: only page and page_size, each exactly
// once. Order is irrelevant; duplicates, empty values, unknown keys and encoding
// aliases are rejections, never defaults. The numeric parameters stay canonical on
// their raw spelling.
func supplierListQuery(raw string) (page, pageSize int, err error) {
	page, pageSize = 1, suppliers.DefaultPageSize
	values, err := stockAdjustmentQueryValues(raw)
	if err != nil {
		return 0, 0, suppliers.ErrInvalid
	}
	for key, value := range values {
		var n int64
		var read error
		switch key {
		case "page":
			n, read = canonicalAdjustmentInteger(value.raw, suppliers.MaxPage)
			page = int(n)
		case "page_size":
			n, read = canonicalAdjustmentInteger(value.raw, supplierMaxPageSize)
			pageSize = int(n)
		default:
			return 0, 0, suppliers.ErrInvalid
		}
		if read != nil {
			return 0, 0, suppliers.ErrInvalid
		}
	}
	if !suppliers.ValidPage(page, pageSize) {
		return 0, 0, suppliers.ErrInvalid
	}
	return page, pageSize, nil
}

// supplierCatalogQuery reads the assignable catalogue query: the absent or one of the
// two catalogue kinds, a literal search and the admitted page size. It has no page
// parameter, so the search is what narrows a long catalogue.
func supplierCatalogQuery(raw string) (suppliers.EntryQuery, error) {
	query := suppliers.EntryQuery{PageSize: supplierMaxPageSize}
	values, err := stockAdjustmentQueryValues(raw)
	if err != nil {
		return query, suppliers.ErrInvalid
	}
	for key, value := range values {
		switch key {
		case "kind":
			kind, ok := supplierKind(value.decoded)
			if !ok {
				return query, suppliers.ErrInvalid
			}
			query.Kind = kind
		case "search":
			// The bound is the number of runes, which is the bound the shipped client
			// applies: an accented rune is two bytes.
			if utf8.RuneCountInString(value.decoded) > supplierMaxSearch {
				return query, suppliers.ErrInvalid
			}
			query.Search = value.decoded
		case "page_size":
			n, err := canonicalAdjustmentInteger(value.raw, supplierMaxPageSize)
			if err != nil {
				return query, suppliers.ErrInvalid
			}
			query.PageSize = int(n)
		default:
			return query, suppliers.ErrInvalid
		}
	}
	if !suppliers.ValidEntryQuery(query) {
		return query, suppliers.ErrInvalid
	}
	return query, nil
}

// supplierVariantQuery reads the ingress picker query: only kind and search. The read
// publishes one bounded page and has no page parameter.
func supplierVariantQuery(raw string) (suppliers.VariantQuery, error) {
	var query suppliers.VariantQuery
	values, err := stockAdjustmentQueryValues(raw)
	if err != nil {
		return query, suppliers.ErrInvalid
	}
	for key, value := range values {
		switch key {
		case "kind":
			kind, ok := supplierKind(value.decoded)
			if !ok {
				return query, suppliers.ErrInvalid
			}
			query.Kind = kind
		case "search":
			if utf8.RuneCountInString(value.decoded) > supplierMaxSearch {
				return query, suppliers.ErrInvalid
			}
			query.Search = value.decoded
		default:
			return query, suppliers.ErrInvalid
		}
	}
	if !suppliers.ValidVariantQuery(query) {
		return query, suppliers.ErrInvalid
	}
	return query, nil
}

// supplierKind admits the two catalogue kinds. The absent kind lists both, so "all" is
// not an alias here.
func supplierKind(value string) (catalog.Kind, bool) {
	switch catalog.Kind(value) {
	case catalog.BatteryKind:
		return catalog.BatteryKind, true
	case catalog.OtherKind:
		return catalog.OtherKind, true
	}
	return "", false
}

// supplierBody is the canonical creation/edit document. The offer set is never part of
// it, because an edit changes the name and the contact only.
type supplierBody struct {
	name    string
	contact string
}

// supplierDocument decodes one bounded document with an exact key set: no duplicate
// keys, no unknown keys, no aliases, no nulls and no nested objects. Both keys are
// required, because the pair is the whole editable document and an absent contact is a
// malformed body instead of an empty contact.
func supplierDocument(r *http.Request) (supplierBody, error) {
	decoder, err := supplierDecoder(r, supplierBodyLimit)
	if err != nil {
		return supplierBody{}, err
	}
	if open, err := decoder.Token(); err != nil || open != json.Delim('{') {
		return supplierBody{}, suppliers.ErrInvalid
	}
	seen := map[string]bool{}
	var body supplierBody
	var name, contact *string
	for decoder.More() {
		key, err := supplierText(decoder)
		if err != nil || seen[key] {
			return supplierBody{}, suppliers.ErrInvalid
		}
		seen[key] = true
		value, err := supplierText(decoder)
		if err != nil {
			return supplierBody{}, err
		}
		switch key {
		case "name":
			name = &value
		case "contact":
			contact = &value
		default:
			return supplierBody{}, suppliers.ErrInvalid
		}
	}
	if close, err := decoder.Token(); err != nil || close != json.Delim('}') {
		return supplierBody{}, suppliers.ErrInvalid
	}
	if _, err := decoder.Token(); err != io.EOF {
		return supplierBody{}, suppliers.ErrInvalid
	}
	if name == nil || contact == nil {
		return supplierBody{}, suppliers.ErrInvalid
	}
	body.name, body.contact = *name, *contact
	return body, nil
}

// supplierOffersDocument decodes the final offer set: the single key
// catalog_entry_ids, an array of catalogue entry identities. The array may be empty,
// because a supplier that offers nothing is a state, and repetition carries no meaning
// because the list is a set.
func supplierOffersDocument(r *http.Request) ([]int64, error) {
	decoder, err := supplierDecoder(r, supplierOffersBodyLimit)
	if err != nil {
		return nil, err
	}
	if open, err := decoder.Token(); err != nil || open != json.Delim('{') {
		return nil, suppliers.ErrInvalid
	}
	seen := map[string]bool{}
	var entries *[]int64
	for decoder.More() {
		key, err := supplierText(decoder)
		if err != nil || seen[key] {
			return nil, suppliers.ErrInvalid
		}
		seen[key] = true
		if key != "catalog_entry_ids" {
			return nil, suppliers.ErrInvalid
		}
		if open, err := decoder.Token(); err != nil || open != json.Delim('[') {
			return nil, suppliers.ErrInvalid
		}
		set := []int64{}
		for decoder.More() {
			if len(set) == supplierMaxOffers {
				return nil, suppliers.ErrInvalid
			}
			id, err := adjustmentNumber(decoder, supplierMaxEntryID)
			if err != nil {
				return nil, suppliers.ErrInvalid
			}
			set = append(set, id)
		}
		if close, err := decoder.Token(); err != nil || close != json.Delim(']') {
			return nil, suppliers.ErrInvalid
		}
		entries = &set
	}
	if close, err := decoder.Token(); err != nil || close != json.Delim('}') {
		return nil, suppliers.ErrInvalid
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, suppliers.ErrInvalid
	}
	if entries == nil {
		return nil, suppliers.ErrInvalid
	}
	return *entries, nil
}

// supplierDecoder applies the one admitted framing: a single JSON content type, a
// bounded body of valid UTF-8 and a token decoder that keeps numbers exact.
func supplierDecoder(r *http.Request, limit int64) (*json.Decoder, error) {
	if r == nil || r.Body == nil || len(r.Header.Values("Content-Type")) != 1 {
		return nil, suppliers.ErrInvalid
	}
	kind, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || kind != "application/json" {
		return nil, suppliers.ErrInvalid
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if err != nil || int64(len(raw)) > limit || !utf8.Valid(raw) {
		return nil, suppliers.ErrInvalid
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	return decoder, nil
}

// supplierText reads one string token. A number, boolean, null, object or array is
// never an alias for text.
func supplierText(decoder *json.Decoder) (string, error) {
	token, err := decoder.Token()
	if err != nil {
		return "", suppliers.ErrInvalid
	}
	value, ok := token.(string)
	if !ok {
		return "", suppliers.ErrInvalid
	}
	return value, nil
}

// supplierResponse is the created or edited supplier: the allocated identity, the name
// and the free contact text.
type supplierResponse struct {
	ID      int64  `json:"id"`
	Name    string `json:"name"`
	Contact string `json:"contact"`
}

// supplierSummaryDTO is one row of the list: the record, its retirement marker, the
// kinds derived from its offers and the exact number of offers.
type supplierSummaryDTO struct {
	ID      int64    `json:"id"`
	Name    string   `json:"name"`
	Contact string   `json:"contact"`
	Retired bool     `json:"retired"`
	Kinds   []string `json:"kinds"`
	Offers  int64    `json:"offers"`
}

// supplierPageDTO is the frozen list response: one page of suppliers and the total.
type supplierPageDTO struct {
	Suppliers      []supplierSummaryDTO `json:"suppliers"`
	Page           int                  `json:"page"`
	PageSize       int                  `json:"page_size"`
	TotalSuppliers int64                `json:"total_suppliers"`
}

// supplierOfferDTO is one catalogue ENTRY the supplier offers. The battery attributes
// and the product name are mutually exclusive because the catalogue is, and the entry
// carries no polarity: polarity belongs to a variant and the assignment is entry level.
type supplierOfferDTO struct {
	CatalogEntryID int64   `json:"catalog_entry_id"`
	Kind           string  `json:"kind"`
	Brand          *string `json:"brand,omitempty"`
	Model          *string `json:"model,omitempty"`
	Capacity       *string `json:"capacity_ah,omitempty"`
	Name           *string `json:"name,omitempty"`
}

// supplierDetailDTO is one supplier with its whole current offer set.
type supplierDetailDTO struct {
	ID      int64              `json:"id"`
	Name    string             `json:"name"`
	Contact string             `json:"contact"`
	Retired bool               `json:"retired"`
	Offers  []supplierOfferDTO `json:"offers"`
	Kinds   []string           `json:"kinds"`
}

// supplierCatalogDTO is the frozen assignable-catalogue response: the first page of
// matching entries and the total, so a truncated read stays visible.
type supplierCatalogDTO struct {
	Entries      []supplierOfferDTO `json:"entries"`
	PageSize     int                `json:"page_size"`
	TotalEntries int64              `json:"total_entries"`
}

// supplierVariantDTO is the typed catalogue identity of one variant a supplier offers,
// together with the entry it belongs to. It has no stock field at all.
type supplierVariantDTO struct {
	catalog.Identity
	CatalogEntryID int64 `json:"catalog_entry_id"`
}

// supplierVariantPageDTO is the frozen ingress-picker response: one bounded page of
// variants and the page size it was read with.
type supplierVariantPageDTO struct {
	Items    []supplierVariantDTO `json:"items"`
	PageSize int                  `json:"page_size"`
}

// supplierRecord validates the persisted supplier once more before echoing it.
func supplierRecord(supplier suppliers.Supplier) (supplierResponse, error) {
	if supplier.ID < 1 {
		return supplierResponse{}, suppliers.ErrUnavailable
	}
	name, err := suppliers.CanonicalName(supplier.Name)
	if err != nil || name != supplier.Name {
		return supplierResponse{}, suppliers.ErrUnavailable
	}
	contact, err := suppliers.CanonicalContact(supplier.Contact)
	if err != nil || contact != supplier.Contact {
		return supplierResponse{}, suppliers.ErrUnavailable
	}
	return supplierResponse{ID: supplier.ID, Name: name, Contact: contact}, nil
}

// supplierSummaryRecord validates one listed row.
func supplierSummaryRecord(summary suppliers.Summary) (supplierSummaryDTO, error) {
	unavailable := func() (supplierSummaryDTO, error) { return supplierSummaryDTO{}, suppliers.ErrUnavailable }
	record, err := supplierRecord(suppliers.Supplier{ID: summary.ID, Name: summary.Name, Contact: summary.Contact})
	if err != nil || summary.Offers < 0 || summary.Offers > supplierMaxOffers || summary.Kinds == nil {
		return unavailable()
	}
	kinds, err := supplierKindList(summary.Kinds)
	if err != nil {
		return unavailable()
	}
	return supplierSummaryDTO{ID: record.ID, Name: record.Name, Contact: record.Contact,
		Retired: summary.Retired, Kinds: kinds, Offers: summary.Offers}, nil
}

// supplierPageRecord validates one page of suppliers before echoing it: the page
// window, the total, the order of the retirement marker and every row.
func supplierPageRecord(page suppliers.Page) (supplierPageDTO, error) {
	unavailable := func() (supplierPageDTO, error) { return supplierPageDTO{}, suppliers.ErrUnavailable }
	if !suppliers.ValidPage(page.Page, page.PageSize) || page.Total < 0 ||
		len(page.Suppliers) > page.PageSize ||
		// A page beyond the last one is legitimately empty; a page with rows must still
		// fit inside the reported total.
		(len(page.Suppliers) > 0 &&
			int64(page.Page-1)*int64(page.PageSize)+int64(len(page.Suppliers)) > page.Total) {
		return unavailable()
	}
	rows := make([]supplierSummaryDTO, 0, len(page.Suppliers))
	seen := make(map[int64]bool, len(page.Suppliers))
	retired := false
	for _, summary := range page.Suppliers {
		if seen[summary.ID] {
			return unavailable()
		}
		seen[summary.ID] = true
		// The contract's order: the active suppliers first and the retired ones last.
		if retired && !summary.Retired {
			return unavailable()
		}
		retired = retired || summary.Retired
		record, err := supplierSummaryRecord(summary)
		if err != nil {
			return unavailable()
		}
		rows = append(rows, record)
	}
	return supplierPageDTO{Suppliers: rows, Page: page.Page, PageSize: page.PageSize,
		TotalSuppliers: page.Total}, nil
}

// supplierDetailRecord validates one supplier with its offer set: the record, its
// retirement marker, the whole set in ascending entry order and the kinds derived from
// it, so a payload can never contradict itself.
func supplierDetailRecord(detail suppliers.Detail) (supplierDetailDTO, error) {
	unavailable := func() (supplierDetailDTO, error) { return supplierDetailDTO{}, suppliers.ErrUnavailable }
	record, err := supplierRecord(suppliers.Supplier{ID: detail.ID, Name: detail.Name, Contact: detail.Contact})
	if err != nil || detail.Offers == nil || detail.Kinds == nil {
		return unavailable()
	}
	offers := make([]supplierOfferDTO, 0, len(detail.Offers))
	previous := int64(0)
	for _, offer := range detail.Offers {
		if offer.CatalogEntryID <= previous {
			return unavailable()
		}
		item, err := supplierOfferRecord(offer)
		if err != nil {
			return unavailable()
		}
		previous = offer.CatalogEntryID
		offers = append(offers, item)
	}
	kinds, err := supplierKindList(detail.Kinds)
	if err != nil || !sameKinds(detail.Kinds, suppliers.Kinds(detail.Offers)) {
		return unavailable()
	}
	return supplierDetailDTO{ID: record.ID, Name: record.Name, Contact: record.Contact,
		Retired: detail.Retired, Offers: offers, Kinds: kinds}, nil
}

// supplierCatalogRecord validates one page of the assignable catalogue before echoing
// it: the page size, the total and the ascending entry order.
func supplierCatalogRecord(page suppliers.EntryPage) (supplierCatalogDTO, error) {
	unavailable := func() (supplierCatalogDTO, error) { return supplierCatalogDTO{}, suppliers.ErrUnavailable }
	if !suppliers.ValidEntryQuery(suppliers.EntryQuery{PageSize: page.PageSize}) || page.Total < 0 ||
		len(page.Entries) > page.PageSize ||
		(page.Entries != nil && int64(len(page.Entries)) > page.Total) {
		return unavailable()
	}
	entries := make([]supplierOfferDTO, 0, len(page.Entries))
	previous := int64(0)
	for _, offer := range page.Entries {
		if offer.CatalogEntryID <= previous {
			return unavailable()
		}
		item, err := supplierOfferRecord(offer)
		if err != nil {
			return unavailable()
		}
		previous = offer.CatalogEntryID
		entries = append(entries, item)
	}
	return supplierCatalogDTO{Entries: entries, PageSize: page.PageSize, TotalEntries: page.Total}, nil
}

// supplierVariantPageRecord validates one page of the ingress picker: the fixed page
// size, the ascending variant order and every identity of its own kind.
func supplierVariantPageRecord(page suppliers.VariantPage) (supplierVariantPageDTO, error) {
	unavailable := func() (supplierVariantPageDTO, error) {
		return supplierVariantPageDTO{}, suppliers.ErrUnavailable
	}
	if page.PageSize != suppliers.OfferedVariantsPageSize || len(page.Items) > page.PageSize {
		return unavailable()
	}
	items := make([]supplierVariantDTO, 0, len(page.Items))
	previous := 0
	for _, item := range page.Items {
		if item.CatalogEntryID < 1 || item.CatalogEntryID > supplierMaxEntryID ||
			item.Identity.Valid() != nil || item.VariantID <= previous {
			return unavailable()
		}
		previous = item.VariantID
		items = append(items, supplierVariantDTO{Identity: item.Identity, CatalogEntryID: item.CatalogEntryID})
	}
	return supplierVariantPageDTO{Items: items, PageSize: page.PageSize}, nil
}

// supplierOfferRecord validates one catalogue entry of an offer set or of the
// assignable catalogue: exactly one shape for its kind, and a capacity that is already
// the canonical decimal text of the column.
func supplierOfferRecord(offer suppliers.Offer) (supplierOfferDTO, error) {
	unavailable := func() (supplierOfferDTO, error) { return supplierOfferDTO{}, suppliers.ErrUnavailable }
	if offer.CatalogEntryID < 1 || offer.CatalogEntryID > supplierMaxEntryID {
		return unavailable()
	}
	item := supplierOfferDTO{CatalogEntryID: offer.CatalogEntryID, Kind: string(offer.Kind)}
	switch offer.Kind {
	case catalog.BatteryKind:
		capacity, err := catalog.ParseDecimal(offer.Capacity)
		if err != nil || string(capacity) != offer.Capacity || offer.Brand == "" || offer.Model == "" ||
			offer.Name != "" || !supplierPlainText(offer.Brand) || !supplierPlainText(offer.Model) {
			return unavailable()
		}
		item.Brand, item.Model, item.Capacity = supplierPointer(offer.Brand), supplierPointer(offer.Model),
			supplierPointer(offer.Capacity)
	case catalog.OtherKind:
		if offer.Name == "" || offer.Brand != "" || offer.Model != "" || offer.Capacity != "" ||
			strings.TrimSpace(offer.Name) != offer.Name || !supplierPlainText(offer.Name) {
			return unavailable()
		}
		item.Name = supplierPointer(offer.Name)
	default:
		return unavailable()
	}
	return item, nil
}

// supplierKindList publishes the derived kinds in the catalogue's own order, so every
// surface states them the same way. A repeated or unknown kind is a record this domain
// never wrote.
func supplierKindList(kinds []catalog.Kind) ([]string, error) {
	published := make([]string, 0, len(kinds))
	var battery, other bool
	for _, kind := range kinds {
		switch kind {
		case catalog.BatteryKind:
			if battery {
				return nil, suppliers.ErrUnavailable
			}
			battery = true
		case catalog.OtherKind:
			if other {
				return nil, suppliers.ErrUnavailable
			}
			other = true
		default:
			return nil, suppliers.ErrUnavailable
		}
	}
	if battery {
		published = append(published, string(catalog.BatteryKind))
	}
	if other {
		published = append(published, string(catalog.OtherKind))
	}
	return published, nil
}

// sameKinds compares the published kinds with the kinds the offer set implies.
func sameKinds(a, b []catalog.Kind) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// supplierPlainText admits the catalogue text of a name, a brand or a model: never
// empty and free of a NUL or a control character.
func supplierPlainText(value string) bool {
	if value == "" || !utf8.ValidString(value) {
		return false
	}
	for _, r := range value {
		if r == 0 || (r < 0x20 || r == 0x7f) {
			return false
		}
	}
	return true
}

func supplierPointer(value string) *string {
	item := value
	return &item
}
