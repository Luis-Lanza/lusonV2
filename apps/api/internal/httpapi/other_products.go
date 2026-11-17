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
	"luson/api/internal/config"
	"luson/api/internal/otherproducts"
)

const (
	// otherProductRoutePath is the single admitted collection of this contract.
	// Its one-segment identity below it is the only other resource.
	otherProductRoutePath = "/api/catalog/other-products"
	// otherProductBodyLimit bounds decoding work well below the HTTP read timeout:
	// the widest admitted document is a name and twenty fields, so an oversized
	// body is never buffered whole.
	otherProductBodyLimit = 4 << 10
	// otherProductMaxID is the catalog identity bound, restated here so an
	// impossible id never reaches the store.
	otherProductMaxID = math.MaxInt32
	// otherProductMaxSearch and otherProductMaxFields restate the read and field
	// bounds so an inadmissible document or query never reaches the store.
	otherProductMaxSearch = 128
	otherProductMaxFields = 20
	// otherProductMaxPageSize is the largest admitted page size of the read
	// contract, the price matrix's own bound.
	otherProductMaxPageSize = 50
)

// OtherProducts is the other-product catalog authority this surface mounts: the
// warehouse administrator gate the administration surface applies and the four
// catalog operations. The store implements it and rechecks the same gate inside
// every operation, so the surface never derives authority from the request alone.
//
// The interface is the seam between the HTTP contract and the catalog: the
// surface is exercised without a database through it, and wiring passes the one
// store the whole vertical uses.
type OtherProducts interface {
	Administrator(ctx context.Context, token string) error
	List(ctx context.Context, token string, query otherproducts.Query) (otherproducts.Page, error)
	Create(ctx context.Context, token string, in otherproducts.CreateInput) (otherproducts.Product, error)
	Edit(ctx context.Context, token string, id int64, in otherproducts.EditInput) (otherproducts.Product, error)
	Retire(ctx context.Context, token string, id int64) error
}

// NewWithOtherProducts mounts the warehouse other-product catalog on a handler
// built by another factory, following the battery contract. The composed
// constructor keeps every existing factory untouched: this one owns only its own
// path, every other request is forwarded unchanged, and the store is the final
// authority for both the read and the writes.
func NewWithOtherProducts(base http.Handler, service *auth.Service, cfg config.Auth, store OtherProducts) (http.Handler, error) {
	if base == nil || service == nil || store == nil {
		return nil, otherproducts.ErrUnavailable
	}
	parsed, err := config.ParseAuth(config.LocalTrial, cfg.Origin, cfg.Listen, cfg.TLSCert, cfg.TLSKey)
	if err != nil || parsed != cfg {
		return nil, otherproducts.ErrUnavailable
	}
	api := &API{service, cfg}
	routes := api.otherProductRoutes(store)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		// An ambiguous product path is refused before the handler can set its
		// response headers, exactly like the battery and price routes.
		if !otherProductPath(r) {
			failure(w, 404, "not_found")
			return
		}
		if otherProductRoute(r.URL.Path) {
			routes.ServeHTTP(w, r)
			return
		}
		base.ServeHTTP(w, r)
	}), nil
}

// otherProductRoute reports whether this path belongs to the product contract.
func otherProductRoute(path string) bool {
	return path == otherProductRoutePath || strings.HasPrefix(path, otherProductRoutePath+"/")
}

// otherProductPath refuses ambiguous product paths: a doubled slash, a dot
// segment, a backslash, a NUL or an encoded alias is not_found, never a silent
// redirect to a different resource. Every path outside the collection is admitted
// here and forwarded as is.
func otherProductPath(r *http.Request) bool {
	p := r.URL.Path
	if !otherProductRoute(p) {
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

// otherProductRoutes registers the collection and the identity below it. Any other
// path below the collection is an unknown route answered as JSON, never a cleaned
// or redirected path.
func (a *API) otherProductRoutes(store OtherProducts) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc(otherProductRoutePath, a.otherProductsCollection(store))
	mux.HandleFunc(otherProductRoutePath+"/{id}", a.otherProductItem(store))
	mux.HandleFunc(otherProductRoutePath+"/", func(w http.ResponseWriter, r *http.Request) {
		failure(w, 404, "not_found")
	})
	return mux
}

// otherProductFailure publishes the domain's own decision and nothing else. The
// authentication and authorization refusals are delegated to the administration
// surface's own mapping, so a branch administrator and an unauthenticated caller
// are refused exactly there as here.
func otherProductFailure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, auth.ErrSession), errors.Is(err, auth.ErrAdminForbidden),
		errors.Is(err, auth.ErrAdminInvalid), errors.Is(err, auth.ErrAdminNotFound),
		errors.Is(err, auth.ErrLimited):
		administrationFailure(w, err)
	case errors.Is(err, otherproducts.ErrInvalid):
		failure(w, 400, "invalid_request")
	case errors.Is(err, otherproducts.ErrForbidden):
		failure(w, 403, "forbidden")
	case errors.Is(err, otherproducts.ErrNotFound):
		failure(w, 404, "not_found")
	case errors.Is(err, otherproducts.ErrHasStock):
		failure(w, 409, "catalog_product_has_stock")
	case errors.Is(err, otherproducts.ErrHasPending):
		failure(w, 409, "catalog_product_has_pending")
	case errors.Is(err, otherproducts.ErrConflict):
		failure(w, 409, "conflict")
	default:
		failure(w, 503, "service_unavailable")
	}
}

// otherProductAdmin is the surface gate: the same authority /api/administration
// already uses, applied before any method, payload or body work. Authorization
// therefore precedes everything else, and a refused caller never reaches a
// statement or the mutation guard.
func (a *API) otherProductAdmin(w http.ResponseWriter, r *http.Request, store OtherProducts) (string, bool) {
	token, unique := readCookie(r, sessionCookie)
	if !unique {
		failure(w, 400, "invalid_request")
		return "", false
	}
	if token == "" {
		failure(w, 401, "unauthenticated")
		return "", false
	}
	if err := store.Administrator(r.Context(), token); err != nil {
		otherProductFailure(w, err)
		return "", false
	}
	return token, true
}

// otherProductsCollection lists one page of the catalog or creates one product.
// The guards run in the battery contract's order: authority, method, framing, then
// the same-origin and CSRF guard, then the canonical document.
func (a *API) otherProductsCollection(store OtherProducts) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token, ok := a.otherProductAdmin(w, r, store)
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
			query, err := otherProductQuery(r.URL.RawQuery)
			if err != nil {
				otherProductFailure(w, err)
				return
			}
			page, err := store.List(r.Context(), token, query)
			if err != nil {
				otherProductFailure(w, err)
				return
			}
			record, err := otherProductPageRecord(page)
			if err != nil {
				otherProductFailure(w, err)
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
		body, err := otherProductDocument(r)
		if err != nil {
			otherProductFailure(w, err)
			return
		}
		product, err := store.Create(r.Context(), token, otherproducts.CreateInput{
			Name: body.name, Fields: body.fields,
		})
		if err != nil {
			otherProductFailure(w, err)
			return
		}
		record, err := otherProductRecord(product)
		if err != nil {
			otherProductFailure(w, err)
			return
		}
		respond(w, 201, record)
	}
}

// otherProductItem edits or retires one product. An edit carries the name and the
// whole field set, because the fields are replaced instead of merged; a retirement
// carries no body at all.
func (a *API) otherProductItem(store OtherProducts) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token, ok := a.otherProductAdmin(w, r, store)
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
		id, err := otherProductID(r.PathValue("id"))
		if err != nil {
			otherProductFailure(w, err)
			return
		}
		if !a.GuardMutation(w, r) {
			return
		}
		if r.Method == http.MethodDelete {
			if err = store.Retire(r.Context(), token, id); err != nil {
				otherProductFailure(w, err)
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		body, err := otherProductDocument(r)
		if err != nil {
			otherProductFailure(w, err)
			return
		}
		product, err := store.Edit(r.Context(), token, id, otherproducts.EditInput{
			Name: body.name, Fields: body.fields,
		})
		if err != nil {
			otherProductFailure(w, err)
			return
		}
		record, err := otherProductRecord(product)
		if err != nil {
			otherProductFailure(w, err)
			return
		}
		respond(w, 200, record)
	}
}

// otherProductID is the strict reader of this contract: decimal digits only, no
// sign, no padding, no fraction and the catalog identity bound.
func otherProductID(raw string) (int64, error) {
	id, err := canonicalAdjustmentInteger(raw, otherProductMaxID)
	if err != nil {
		return 0, otherproducts.ErrInvalid
	}
	return id, nil
}

// otherProductQuery reads the frozen read query: only search, page and page_size,
// each exactly once. Order is irrelevant; duplicates, empty values, unknown keys
// and encoding aliases are rejections, never defaults. The numeric parameters stay
// canonical on their raw spelling while the free text is percent-decoded once.
func otherProductQuery(raw string) (otherproducts.Query, error) {
	query := otherproducts.Query{Page: 1, PageSize: otherproducts.DefaultPageSize}
	values, err := stockAdjustmentQueryValues(raw)
	if err != nil {
		return query, otherproducts.ErrInvalid
	}
	for key, value := range values {
		switch key {
		case "search":
			if len(value.decoded) > otherProductMaxSearch {
				return query, otherproducts.ErrInvalid
			}
			query.Search = value.decoded
		case "page":
			n, err := canonicalAdjustmentInteger(value.raw, otherproducts.MaxPage)
			if err != nil {
				return query, otherproducts.ErrInvalid
			}
			query.Page = int(n)
		case "page_size":
			n, err := canonicalAdjustmentInteger(value.raw, otherProductMaxPageSize)
			if err != nil {
				return query, otherproducts.ErrInvalid
			}
			query.PageSize = int(n)
		default:
			return query, otherproducts.ErrInvalid
		}
	}
	if !otherproducts.ValidQuery(query) {
		return query, otherproducts.ErrInvalid
	}
	return query, nil
}

// otherProductBody is the canonical creation/edit document. The numbers are
// already the catalog decimal text, never a binary float and never the client's
// padding.
type otherProductBody struct {
	name   string
	fields []otherproducts.Field
}

// otherProductDocument decodes one bounded document with an exact key set: no
// duplicate keys, no unknown keys, no aliases, no nulls and no nested objects. A
// creation and an edit carry the same two keys, the free name and the whole field
// set, because an edit replaces the field set instead of merging it.
func otherProductDocument(r *http.Request) (otherProductBody, error) {
	if r == nil || r.Body == nil || len(r.Header.Values("Content-Type")) != 1 {
		return otherProductBody{}, otherproducts.ErrInvalid
	}
	kind, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || kind != "application/json" {
		return otherProductBody{}, otherproducts.ErrInvalid
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, otherProductBodyLimit+1))
	if err != nil || len(raw) > otherProductBodyLimit || !utf8.Valid(raw) {
		return otherProductBody{}, otherproducts.ErrInvalid
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	open, err := decoder.Token()
	if err != nil || open != json.Delim('{') {
		return otherProductBody{}, otherproducts.ErrInvalid
	}
	seen := map[string]bool{}
	var body otherProductBody
	var name *string
	var fields *[]otherproducts.Field
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return otherProductBody{}, otherproducts.ErrInvalid
		}
		key, ok := token.(string)
		if !ok || seen[key] {
			return otherProductBody{}, otherproducts.ErrInvalid
		}
		seen[key] = true
		switch key {
		case "name":
			value, err := otherProductText(decoder)
			if err != nil {
				return otherProductBody{}, err
			}
			name = &value
		case "fields":
			value, err := otherProductFieldList(decoder)
			if err != nil {
				return otherProductBody{}, err
			}
			fields = &value
		default:
			return otherProductBody{}, otherproducts.ErrInvalid
		}
	}
	close, err := decoder.Token()
	if err != nil || close != json.Delim('}') {
		return otherProductBody{}, otherproducts.ErrInvalid
	}
	if _, err = decoder.Token(); err != io.EOF {
		return otherProductBody{}, otherproducts.ErrInvalid
	}
	if name == nil || fields == nil {
		return otherProductBody{}, otherproducts.ErrInvalid
	}
	body.name, body.fields = *name, *fields
	return body, nil
}

// otherProductText reads one string token. A number, boolean, null, object or
// array is never an alias for text.
func otherProductText(decoder *json.Decoder) (string, error) {
	token, err := decoder.Token()
	if err != nil {
		return "", otherproducts.ErrInvalid
	}
	value, ok := token.(string)
	if !ok {
		return "", otherproducts.ErrInvalid
	}
	return value, nil
}

// otherProductFieldList reads the whole field set: an array of at most twenty
// objects. An empty set is admissible, because a product is not required to carry
// a custom field.
func otherProductFieldList(decoder *json.Decoder) ([]otherproducts.Field, error) {
	open, err := decoder.Token()
	if err != nil || open != json.Delim('[') {
		return nil, otherproducts.ErrInvalid
	}
	fields := []otherproducts.Field{}
	for decoder.More() {
		if len(fields) == otherProductMaxFields {
			return nil, otherproducts.ErrInvalid
		}
		field, err := otherProductField(decoder)
		if err != nil {
			return nil, err
		}
		fields = append(fields, field)
	}
	if close, err := decoder.Token(); err != nil || close != json.Delim(']') {
		return nil, otherproducts.ErrInvalid
	}
	return fields, nil
}

// otherProductField reads one field object with an exact key set. The name and the
// kind are the only required keys; which of the value keys is admissible is the
// store's canonical decision, not this decoder's convenience, so the decoder only
// refuses the shapes no document may use: an unknown or repeated key, a non-string
// value and a declared but empty unit.
func otherProductField(decoder *json.Decoder) (otherproducts.Field, error) {
	open, err := decoder.Token()
	if err != nil || open != json.Delim('{') {
		return otherproducts.Field{}, otherproducts.ErrInvalid
	}
	seen := map[string]bool{}
	var name, kind, unit, number, text *string
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return otherproducts.Field{}, otherproducts.ErrInvalid
		}
		key, ok := token.(string)
		if !ok || seen[key] {
			return otherproducts.Field{}, otherproducts.ErrInvalid
		}
		seen[key] = true
		var target **string
		switch key {
		case "name":
			target = &name
		case "kind":
			target = &kind
		case "unit":
			target = &unit
		case "number":
			target = &number
		case "text":
			target = &text
		default:
			return otherproducts.Field{}, otherproducts.ErrInvalid
		}
		value, err := otherProductText(decoder)
		if err != nil {
			return otherproducts.Field{}, err
		}
		// A declared unit is 1 to 8 bytes, so an empty one is never a way to erase
		// it: absence is the only way to declare no unit.
		if key == "unit" && value == "" {
			return otherproducts.Field{}, otherproducts.ErrInvalid
		}
		*target = &value
	}
	close, err := decoder.Token()
	if err != nil || close != json.Delim('}') {
		return otherproducts.Field{}, otherproducts.ErrInvalid
	}
	if name == nil || kind == nil {
		return otherproducts.Field{}, otherproducts.ErrInvalid
	}
	field := otherproducts.Field{Name: *name, Kind: otherproducts.Kind(*kind)}
	if unit != nil {
		field.Unit = *unit
	}
	if number != nil {
		value, err := otherproducts.CanonicalNumber(*number)
		if err != nil {
			return otherproducts.Field{}, otherproducts.ErrInvalid
		}
		field.Number = &value
	}
	if text != nil {
		field.Text = text
	}
	return field, nil
}

// otherProductFieldResponse is one field of a product. The value keys are mutually
// exclusive, so a number travels with its unit and a text travels alone.
type otherProductFieldResponse struct {
	Name   string  `json:"name"`
	Kind   string  `json:"kind"`
	Unit   *string `json:"unit,omitempty"`
	Number *string `json:"number,omitempty"`
	Text   *string `json:"text,omitempty"`
}

// otherProductResponse is the created or edited product: the allocated identity,
// the free name and the whole field set.
type otherProductResponse struct {
	ID     int64                       `json:"id"`
	Name   string                      `json:"name"`
	Fields []otherProductFieldResponse `json:"fields"`
}

// otherProductPageResponse is the read response: one page of products and the
// total of matching products.
type otherProductPageResponse struct {
	Products      []otherProductResponse `json:"products"`
	Page          int                    `json:"page"`
	PageSize      int                    `json:"page_size"`
	TotalProducts int64                  `json:"total_products"`
}

// otherProductRecord validates the persisted product once more before echoing it.
// A record the catalog cannot hold — an untrimmed name, a non-canonical field or a
// field set the contract would change — never leaves this process as a payload.
func otherProductRecord(product otherproducts.Product) (otherProductResponse, error) {
	unavailable := func() (otherProductResponse, error) {
		return otherProductResponse{}, otherproducts.ErrUnavailable
	}
	if product.ID < 1 || product.ID > otherProductMaxID {
		return unavailable()
	}
	name, err := otherproducts.CanonicalName(product.Name)
	if err != nil || name != product.Name {
		return unavailable()
	}
	fields, err := otherproducts.CanonicalFields(product.Fields)
	if err != nil || product.Fields == nil || len(fields) != len(product.Fields) {
		return unavailable()
	}
	record := otherProductResponse{ID: product.ID, Name: name, Fields: make([]otherProductFieldResponse, 0, len(fields))}
	for i, field := range fields {
		// The canonical form must be the persisted one: only a decimal may be
		// respelled from the column's own text, every other value is exact.
		stored := product.Fields[i]
		if field.Name != stored.Name || field.Kind != stored.Kind || field.Unit != stored.Unit ||
			(field.Number == nil) != (stored.Number == nil) || (field.Text == nil) != (stored.Text == nil) ||
			(field.Text != nil && *field.Text != *stored.Text) {
			return unavailable()
		}
		item := otherProductFieldResponse{Name: field.Name, Kind: string(field.Kind)}
		if field.Unit != "" {
			unit := field.Unit
			item.Unit = &unit
		}
		if field.Number != nil {
			number := string(*field.Number)
			item.Number = &number
		}
		if field.Text != nil {
			text := *field.Text
			item.Text = &text
		}
		record.Fields = append(record.Fields, item)
	}
	return record, nil
}

// otherProductPageRecord validates one page of the catalog before echoing it: the
// page window, the total and every product of the page.
func otherProductPageRecord(page otherproducts.Page) (otherProductPageResponse, error) {
	unavailable := func() (otherProductPageResponse, error) {
		return otherProductPageResponse{}, otherproducts.ErrUnavailable
	}
	if !otherproducts.ValidPage(page.Page, page.PageSize) || page.Total < 0 ||
		len(page.Products) > page.PageSize ||
		// A page beyond the last one is legitimately empty; a page with rows must
		// still fit inside the reported total.
		(len(page.Products) > 0 &&
			int64(page.Page-1)*int64(page.PageSize)+int64(len(page.Products)) > page.Total) {
		return unavailable()
	}
	products := make([]otherProductResponse, 0, len(page.Products))
	var previous int64
	for _, product := range page.Products {
		if product.ID <= previous {
			return unavailable()
		}
		previous = product.ID
		record, err := otherProductRecord(product)
		if err != nil {
			return unavailable()
		}
		products = append(products, record)
	}
	return otherProductPageResponse{
		Products:      products,
		Page:          page.Page,
		PageSize:      page.PageSize,
		TotalProducts: page.Total,
	}, nil
}
