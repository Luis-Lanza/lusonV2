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
	"unicode/utf8"

	"luson/api/internal/auth"
	"luson/api/internal/catalog"
	"luson/api/internal/catalogadmin"
	"luson/api/internal/config"
)

const (
	// catalogBatteryRoutePath is the single admitted collection of this contract.
	// Its one-segment identity below it is the only other resource.
	catalogBatteryRoutePath = "/api/catalog/batteries"
	// catalogBatteryBodyLimit bounds decoding work well below the HTTP read
	// timeout: the widest admitted document is a brand, a model, a capacity and two
	// polarities, so an oversized body is never buffered whole.
	catalogBatteryBodyLimit = 4 << 10
	// catalogBatteryMaxID is the catalog identity bound, restated here so an
	// impossible id never reaches the store.
	catalogBatteryMaxID = math.MaxInt32
)

// NewWithCatalogAdmin mounts the warehouse catalog battery contract on a handler
// built by the sale factory. The optional store keeps every existing constructor
// untouched: without it the battery routes stay unregistered, exactly like the
// other composed surfaces, and every other request is forwarded unchanged.
func NewWithCatalogAdmin(base http.Handler, service *auth.Service, cfg config.Auth, store *catalogadmin.Store) (http.Handler, error) {
	if base == nil || service == nil || store == nil {
		return nil, catalogadmin.ErrUnavailable
	}
	parsed, err := config.ParseAuth(config.LocalTrial, cfg.Origin, cfg.Listen, cfg.TLSCert, cfg.TLSKey)
	if err != nil || parsed != cfg {
		return nil, catalogadmin.ErrUnavailable
	}
	api := &API{service, cfg}
	routes := api.catalogBatteryRoutes(store)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		// An ambiguous battery path is refused before the handler can set its
		// response headers, exactly like the ingress, adjustment and price routes.
		if !catalogBatteryPath(r) {
			failure(w, 404, "not_found")
			return
		}
		if catalogBatteryRoute(r.URL.Path) {
			routes.ServeHTTP(w, r)
			return
		}
		base.ServeHTTP(w, r)
	}), nil
}

// catalogBatteryRoute reports whether this path belongs to the battery contract.
func catalogBatteryRoute(path string) bool {
	return path == catalogBatteryRoutePath || strings.HasPrefix(path, catalogBatteryRoutePath+"/")
}

// catalogBatteryPath refuses ambiguous battery paths: a doubled slash, a dot
// segment, a backslash, a NUL or an encoded alias is not_found, never a silent
// redirect to a different resource. Every path outside the collection is admitted
// here and forwarded as is.
func catalogBatteryPath(r *http.Request) bool {
	p := r.URL.Path
	if !catalogBatteryRoute(p) {
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

// catalogBatteryRoutes registers the collection and the identity below it. Any
// other path below the collection is an unknown route answered as JSON, never a
// cleaned or redirected path.
func (a *API) catalogBatteryRoutes(store *catalogadmin.Store) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc(catalogBatteryRoutePath, a.catalogBatteryCreate(store))
	mux.HandleFunc(catalogBatteryRoutePath+"/{id}", a.catalogBatteryItem(store))
	mux.HandleFunc(catalogBatteryRoutePath+"/", func(w http.ResponseWriter, r *http.Request) {
		failure(w, 404, "not_found")
	})
	return mux
}

// catalogBatteryFailure publishes the domain's own decision and nothing else. The
// authentication and authorization refusals are delegated to the administration
// surface's own mapping, so a branch administrator and an unauthenticated caller
// are refused exactly there as here.
func catalogBatteryFailure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, auth.ErrSession), errors.Is(err, auth.ErrAdminForbidden),
		errors.Is(err, auth.ErrAdminInvalid), errors.Is(err, auth.ErrAdminNotFound),
		errors.Is(err, auth.ErrLimited):
		administrationFailure(w, err)
	case errors.Is(err, catalogadmin.ErrInvalid):
		failure(w, 400, "invalid_request")
	case errors.Is(err, catalogadmin.ErrForbidden):
		failure(w, 403, "forbidden")
	case errors.Is(err, catalogadmin.ErrNotFound):
		failure(w, 404, "not_found")
	case errors.Is(err, catalogadmin.ErrHasStock):
		failure(w, 409, "catalog_battery_has_stock")
	case errors.Is(err, catalogadmin.ErrHasPending):
		failure(w, 409, "catalog_battery_has_pending")
	case errors.Is(err, catalogadmin.ErrConflict):
		failure(w, 409, "conflict")
	default:
		failure(w, 503, "service_unavailable")
	}
}

// catalogBatteryAdmin is the surface gate: the same authority /api/administration
// already uses, applied before any method, payload or body work. Authorization
// therefore precedes everything else, and a refused caller never reaches a
// statement or the mutation guard.
func (a *API) catalogBatteryAdmin(w http.ResponseWriter, r *http.Request) (string, bool) {
	token, unique := readCookie(r, sessionCookie)
	if !unique {
		failure(w, 400, "invalid_request")
		return "", false
	}
	if token == "" {
		failure(w, 401, "unauthenticated")
		return "", false
	}
	if err := a.service.Administrator(r.Context(), token); err != nil {
		administrationFailure(w, err)
		return "", false
	}
	return token, true
}

// catalogBatteryCreate creates one battery with its one or two variants. The
// guards run in the administration surface's order: authority, framing, method,
// then the same-origin and CSRF guard, then the canonical document.
func (a *API) catalogBatteryCreate(store *catalogadmin.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token, ok := a.catalogBatteryAdmin(w, r)
		if !ok {
			return
		}
		if r.URL.RawQuery != "" || r.URL.ForceQuery {
			failure(w, 400, "invalid_request")
			return
		}
		if !method(w, r, http.MethodPost) {
			return
		}
		if !a.GuardMutation(w, r) {
			return
		}
		body, err := catalogBatteryFields(r, true)
		if err != nil {
			catalogBatteryFailure(w, err)
			return
		}
		battery, err := store.Create(r.Context(), token, catalogadmin.CreateInput{
			Brand: body.brand, Model: body.model, Capacity: body.capacity, Polarities: body.polarities,
		})
		if err != nil {
			catalogBatteryFailure(w, err)
			return
		}
		record, err := catalogBatteryRecord(battery)
		if err != nil {
			catalogBatteryFailure(w, err)
			return
		}
		respond(w, 201, record)
	}
}

// catalogBatteryItem edits or archives one battery. An edit carries exactly the
// three identity fields; an archive carries no body at all.
func (a *API) catalogBatteryItem(store *catalogadmin.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token, ok := a.catalogBatteryAdmin(w, r)
		if !ok {
			return
		}
		if r.URL.RawQuery != "" || r.URL.ForceQuery {
			failure(w, 400, "invalid_request")
			return
		}
		if r.Method != http.MethodPatch && r.Method != http.MethodDelete {
			w.Header().Set("Allow", "PATCH, DELETE")
			failure(w, 405, "method_not_allowed")
			return
		}
		id, err := catalogBatteryID(r.PathValue("id"))
		if err != nil {
			catalogBatteryFailure(w, err)
			return
		}
		if !a.GuardMutation(w, r) {
			return
		}
		if r.Method == http.MethodDelete {
			if err = store.Archive(r.Context(), token, id); err != nil {
				catalogBatteryFailure(w, err)
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		body, err := catalogBatteryFields(r, false)
		if err != nil {
			catalogBatteryFailure(w, err)
			return
		}
		battery, err := store.Edit(r.Context(), token, id, catalogadmin.EditInput{
			Brand: body.brand, Model: body.model, Capacity: body.capacity,
		})
		if err != nil {
			catalogBatteryFailure(w, err)
			return
		}
		record, err := catalogBatteryRecord(battery)
		if err != nil {
			catalogBatteryFailure(w, err)
			return
		}
		respond(w, 200, record)
	}
}

// catalogBatteryID is the transfer query's strict reader with this contract's own
// error: decimal digits only, no sign, no padding, no fraction and the catalog
// identity bound.
func catalogBatteryID(raw string) (int64, error) {
	id, err := canonicalAdjustmentInteger(raw, catalogBatteryMaxID)
	if err != nil {
		return 0, catalogadmin.ErrInvalid
	}
	return id, nil
}

// catalogBatteryBody is the canonical creation/edit document. The capacity is
// already the catalogue decimal, never a binary float and never the client's
// padding.
type catalogBatteryBody struct {
	brand      string
	model      string
	capacity   catalog.Decimal
	polarities []catalog.Polarity
}

// catalogBatteryFields decodes one bounded flat document with an exact key set:
// no duplicate keys, no unknown keys, no aliases, no nulls and no nested objects.
// A creation also carries the polarity list, the only admitted array; an edit
// carries exactly the three identity fields.
func catalogBatteryFields(r *http.Request, withPolarities bool) (catalogBatteryBody, error) {
	if len(r.Header.Values("Content-Type")) != 1 {
		return catalogBatteryBody{}, catalogadmin.ErrInvalid
	}
	kind, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || kind != "application/json" {
		return catalogBatteryBody{}, catalogadmin.ErrInvalid
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, catalogBatteryBodyLimit+1))
	if err != nil || len(raw) > catalogBatteryBodyLimit || !utf8.Valid(raw) {
		return catalogBatteryBody{}, catalogadmin.ErrInvalid
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	open, err := decoder.Token()
	if err != nil || open != json.Delim('{') {
		return catalogBatteryBody{}, catalogadmin.ErrInvalid
	}
	seen := map[string]bool{}
	var body catalogBatteryBody
	var brand, model, capacity *string
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return catalogBatteryBody{}, catalogadmin.ErrInvalid
		}
		key, ok := token.(string)
		if !ok || seen[key] {
			return catalogBatteryBody{}, catalogadmin.ErrInvalid
		}
		seen[key] = true
		switch key {
		case "brand", "model":
			value, err := catalogBatteryText(decoder)
			if err != nil {
				return catalogBatteryBody{}, err
			}
			if key == "brand" {
				brand = &value
			} else {
				model = &value
			}
		case "capacity_ah":
			value, err := catalogBatteryText(decoder)
			if err != nil {
				return catalogBatteryBody{}, err
			}
			capacity = &value
		case "polarities":
			if !withPolarities {
				return catalogBatteryBody{}, catalogadmin.ErrInvalid
			}
			polarities, err := catalogBatteryPolarities(decoder)
			if err != nil {
				return catalogBatteryBody{}, err
			}
			body.polarities = polarities
		default:
			return catalogBatteryBody{}, catalogadmin.ErrInvalid
		}
	}
	close, err := decoder.Token()
	if err != nil || close != json.Delim('}') {
		return catalogBatteryBody{}, catalogadmin.ErrInvalid
	}
	if _, err = decoder.Token(); err != io.EOF {
		return catalogBatteryBody{}, catalogadmin.ErrInvalid
	}
	if brand == nil || model == nil || capacity == nil || (withPolarities && body.polarities == nil) {
		return catalogBatteryBody{}, catalogadmin.ErrInvalid
	}
	canonical, err := catalog.ParseDecimal(*capacity)
	if err != nil {
		return catalogBatteryBody{}, catalogadmin.ErrInvalid
	}
	body.brand, body.model, body.capacity = *brand, *model, canonical
	return body, nil
}

// catalogBatteryText reads one string token. A number, boolean, null, object or
// array is never an alias for text.
func catalogBatteryText(decoder *json.Decoder) (string, error) {
	token, err := decoder.Token()
	if err != nil {
		return "", catalogadmin.ErrInvalid
	}
	value, ok := token.(string)
	if !ok {
		return "", catalogadmin.ErrInvalid
	}
	return value, nil
}

// catalogBatteryPolarities reads the creation's polarity list: an array of one or
// two string tokens. The order and the admitted values are the store's canonical
// decision, not this decoder's convenience.
func catalogBatteryPolarities(decoder *json.Decoder) ([]catalog.Polarity, error) {
	open, err := decoder.Token()
	if err != nil || open != json.Delim('[') {
		return nil, catalogadmin.ErrInvalid
	}
	polarities := []catalog.Polarity{}
	for decoder.More() {
		value, err := catalogBatteryText(decoder)
		if err != nil {
			return nil, err
		}
		if len(polarities) == 2 {
			return nil, catalogadmin.ErrInvalid
		}
		polarities = append(polarities, catalog.Polarity(value))
	}
	if close, err := decoder.Token(); err != nil || close != json.Delim(']') {
		return nil, catalogadmin.ErrInvalid
	}
	if len(polarities) == 0 {
		return nil, catalogadmin.ErrInvalid
	}
	return polarities, nil
}

// catalogBatteryVariantResponse is one allocated polarity. The id is the database's
// identity, never a typed value.
type catalogBatteryVariantResponse struct {
	ID       int64  `json:"id"`
	Polarity string `json:"polarity"`
}

// catalogBatteryResponse is the created or edited battery. priced_branches makes
// the unpriced state of a new battery visible: a battery with no price at any
// active branch is not sellable until the price screen prices it per branch.
type catalogBatteryResponse struct {
	ID             int64                           `json:"id"`
	Brand          string                          `json:"brand"`
	Model          string                          `json:"model"`
	Capacity       string                          `json:"capacity_ah"`
	Variants       []catalogBatteryVariantResponse `json:"variants"`
	PricedBranches int                             `json:"priced_branches"`
}

// catalogBatteryRecord validates the persisted battery once more before echoing
// it. A record the catalog cannot hold — including a capacity that is not already
// the canonical decimal — never leaves this process as a payload.
func catalogBatteryRecord(battery catalogadmin.Battery) (catalogBatteryResponse, error) {
	canonical, err := catalog.ParseDecimal(string(battery.Capacity))
	if err != nil || canonical != battery.Capacity || battery.ID < 1 ||
		!catalogadmin.ValidName(battery.Brand) || !catalogadmin.ValidName(battery.Model) ||
		battery.PricedBranches < 0 {
		return catalogBatteryResponse{}, catalogadmin.ErrUnavailable
	}
	if len(battery.Variants) < 1 || len(battery.Variants) > 2 {
		return catalogBatteryResponse{}, catalogadmin.ErrUnavailable
	}
	variants := make([]catalogBatteryVariantResponse, 0, len(battery.Variants))
	for i, variant := range battery.Variants {
		if variant.ID < 1 || (variant.Polarity != catalog.Left && variant.Polarity != catalog.Right) {
			return catalogBatteryResponse{}, catalogadmin.ErrUnavailable
		}
		if i > 0 && variant.Polarity <= battery.Variants[i-1].Polarity {
			return catalogBatteryResponse{}, catalogadmin.ErrUnavailable
		}
		variants = append(variants, catalogBatteryVariantResponse{ID: variant.ID, Polarity: string(variant.Polarity)})
	}
	return catalogBatteryResponse{
		ID:             battery.ID,
		Brand:          battery.Brand,
		Model:          battery.Model,
		Capacity:       string(canonical),
		Variants:       variants,
		PricedBranches: battery.PricedBranches,
	}, nil
}
