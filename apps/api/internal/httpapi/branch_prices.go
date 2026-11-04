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
	"luson/api/internal/catalog"
	"luson/api/internal/config"
	"luson/api/internal/pricing"
)

// branchPriceBodyLimit bounds decoding work well below any admitted payload: fifty
// branch ids, two amounts and one term.
const branchPriceBodyLimit = 4 << 10

const (
	// branchPriceRoutePath is the single admitted path of this contract.
	branchPriceRoutePath = "/api/catalog/prices"
	// branchPriceMaxSearch is the free-text bound of the catalogue filters.
	branchPriceMaxSearch = 128
	// branchPriceMaxBranches is the block bound, restated here so an inadmissible
	// request never reaches the store.
	branchPriceMaxBranches = pricing.MaxBranches
)

// NewWithBranchPrices mounts the branch price list on a handler built by the stock
// entry factory. The optional store keeps its own constructor untouched: without it
// the price routes stay unregistered, exactly like ingress on the legacy factories,
// and every other request is forwarded to the composed handler unchanged.
func NewWithBranchPrices(base http.Handler, service *auth.Service, cfg config.Auth, store *pricing.Store) (http.Handler, error) {
	if base == nil || service == nil || store == nil {
		return nil, pricing.ErrUnavailable
	}
	parsed, err := config.ParseAuth(config.LocalTrial, cfg.Origin, cfg.Listen, cfg.TLSCert, cfg.TLSKey)
	if err != nil || parsed != cfg {
		return nil, pricing.ErrUnavailable
	}
	api := &API{service, cfg}
	prices := api.branchPrices(store)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if !branchPricePath(r) {
			failure(w, 404, "not_found")
			return
		}
		if branchPricesRoute(r.URL.Path) {
			prices.ServeHTTP(w, r)
			return
		}
		base.ServeHTTP(w, r)
	}), nil
}

// branchPricePath refuses ambiguous price paths before the handler can set its
// response headers, exactly like the ingress and adjustment routes: a doubled slash,
// a dot segment, a backslash, a NUL or an encoded alias is not_found, never a silent
// redirect to a different resource.
func branchPricePath(r *http.Request) bool {
	p := r.URL.Path
	if p != branchPriceRoutePath && !strings.HasPrefix(p, branchPriceRoutePath+"/") {
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

// branchPricesRoute reports whether this path belongs to the price contract. Any
// other path below the collection is an unknown route answered as JSON.
func branchPricesRoute(path string) bool {
	return path == branchPriceRoutePath || strings.HasPrefix(path, branchPriceRoutePath+"/")
}

// branchPriceFailure publishes the domain's own decision and nothing else. A retired
// branch carries the id the client must drop, so it is answered with that id beside
// the usual error code.
func branchPriceFailure(w http.ResponseWriter, err error) {
	var retired *pricing.RetiredBranch
	if errors.As(err, &retired) {
		respond(w, 400, map[string]any{"error": "retired_branch", "branch_id": retired.BranchID})
		return
	}
	switch {
	case errors.Is(err, pricing.ErrInvalid):
		failure(w, 400, "invalid_request")
	case errors.Is(err, pricing.ErrForbidden):
		failure(w, 403, "forbidden")
	default:
		failure(w, 503, "service_unavailable")
	}
}

// branchPriceNumber is the shared strict reader: decimal digits only, no sign, no
// padding, no fraction and a hard upper bound.
func branchPriceNumber(d *json.Decoder, max int64) (int64, error) {
	token, err := d.Token()
	if err != nil {
		return 0, pricing.ErrInvalid
	}
	number, ok := token.(json.Number)
	if !ok {
		return 0, pricing.ErrInvalid
	}
	return canonicalAdjustmentInteger(string(number), max)
}

// branchPriceBranchIDs reads the destination branches: one to fifty unique ids, each
// exactly once and never the warehouse.
func branchPriceBranchIDs(d *json.Decoder) ([]int64, error) {
	if !transferDelimiter(d, '[') {
		return nil, pricing.ErrInvalid
	}
	ids := make([]int64, 0, 4)
	seen := make(map[int64]bool, 4)
	for d.More() {
		if len(ids) >= branchPriceMaxBranches {
			return nil, pricing.ErrInvalid
		}
		id, err := branchPriceNumber(d, math.MaxInt16)
		if err != nil || seen[id] {
			return nil, pricing.ErrInvalid
		}
		seen[id] = true
		ids = append(ids, id)
	}
	if len(ids) == 0 || !transferDelimiter(d, ']') {
		return nil, pricing.ErrInvalid
	}
	return ids, nil
}

// decodeBranchPrices reads tokens rather than structs: exact names, presence, types
// and duplicate keys (including escaped-equivalent keys) are enforced at every object
// level, and the terminal EOF rejects trailing input. The actor is never part of the
// body, and the amounts are canonical decimal strings, never JSON numbers.
func decodeBranchPrices(r *http.Request) (pricing.WriteInput, error) {
	var in pricing.WriteInput
	if r == nil || r.Body == nil || len(r.Header.Values("Content-Type")) != 1 {
		return in, pricing.ErrInvalid
	}
	contentType := r.Header.Get("Content-Type")
	media, params, err := mime.ParseMediaType(contentType)
	// MIME parsing collapses identical duplicate parameters and admits a trailing
	// separator; neither is an unambiguous framing here.
	if err != nil || media != "application/json" || len(params) > 1 || strings.Count(contentType, ";") != len(params) {
		return in, pricing.ErrInvalid
	}
	for key, value := range params {
		if key != "charset" || !strings.EqualFold(value, "utf-8") {
			return in, pricing.ErrInvalid
		}
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, branchPriceBodyLimit+1))
	if err != nil || len(body) > branchPriceBodyLimit || !utf8.Valid(body) {
		return in, pricing.ErrInvalid
	}
	d := json.NewDecoder(bytes.NewReader(body))
	d.UseNumber()
	if !transferDelimiter(d, '{') {
		return in, pricing.ErrInvalid
	}
	seen := map[string]bool{}
	for d.More() {
		key, err := transferString(d)
		if err != nil || seen[key] {
			return pricing.WriteInput{}, pricing.ErrInvalid
		}
		seen[key] = true
		switch key {
		case "variant_id":
			in.VariantID, err = branchPriceNumber(d, math.MaxInt32)
		case "min_price":
			in.MinPrice, err = branchPriceMoney(d)
		case "suggested_price":
			in.SuggestedPrice, err = branchPriceMoney(d)
		case "warranty_months":
			var months int64
			months, err = branchPriceNumber(d, pricing.MaxWarrantyMonths)
			if err == nil {
				value := int(months)
				in.WarrantyMonths = &value
			}
		case "branch_ids":
			in.BranchIDs, err = branchPriceBranchIDs(d)
		default:
			return pricing.WriteInput{}, pricing.ErrInvalid
		}
		if err != nil {
			return pricing.WriteInput{}, pricing.ErrInvalid
		}
	}
	if !seen["variant_id"] || !seen["min_price"] || !seen["suggested_price"] || !seen["branch_ids"] ||
		len(seen) > 5 || !transferDelimiter(d, '}') {
		return pricing.WriteInput{}, pricing.ErrInvalid
	}
	if _, err := d.Token(); err != io.EOF {
		return pricing.WriteInput{}, pricing.ErrInvalid
	}
	// The amounts and the pair of them are revalidated by the store with the
	// authenticated identity, so nothing below derives authority from JSON.
	return in, nil
}

// branchPriceMoney admits one amount in its canonical decimal text. More than two
// decimals, a negative or empty amount and a JSON number are all invalid.
func branchPriceMoney(d *json.Decoder) (pricing.Money, error) {
	text, err := transferString(d)
	if err != nil {
		return "", pricing.ErrInvalid
	}
	return pricing.ParseMoney(text)
}

// branchPriceQuery reads the frozen read query: only the catalogue filters, the page
// and the page size, each exactly once. Order is irrelevant; duplicates, empty
// values, unknown keys and encoding aliases are rejections, never defaults. The
// numeric parameters stay canonical on their raw spelling while the free text is
// percent-decoded once.
func branchPriceQuery(raw string) (pricing.BranchQuery, error) {
	query := pricing.BranchQuery{Page: 1, PageSize: pricing.DefaultPageSize}
	values, err := stockAdjustmentQueryValues(raw)
	if err != nil {
		return query, pricing.ErrInvalid
	}
	for key, value := range values {
		switch key {
		case "search":
			if len(value.decoded) > branchPriceMaxSearch {
				return query, pricing.ErrInvalid
			}
			query.Search = value.decoded
		case "brand":
			if len(value.decoded) > branchPriceMaxSearch {
				return query, pricing.ErrInvalid
			}
			query.Brand = value.decoded
		case "capacity":
			capacity, err := catalog.ParseDecimal(value.decoded)
			if err != nil {
				return query, pricing.ErrInvalid
			}
			query.Capacity = capacity
		case "polarity":
			if value.decoded != "L" && value.decoded != "R" {
				return query, pricing.ErrInvalid
			}
			query.Polarity = value.decoded
		case "page":
			n, err := canonicalAdjustmentInteger(value.raw, pricing.MaxPage)
			if err != nil {
				return query, pricing.ErrInvalid
			}
			query.Page = int(n)
		case "page_size":
			n, err := canonicalAdjustmentInteger(value.raw, 50)
			if err != nil {
				return query, pricing.ErrInvalid
			}
			query.PageSize = int(n)
		default:
			return query, pricing.ErrInvalid
		}
	}
	if !pricing.ValidQuery(query) {
		return query, pricing.ErrInvalid
	}
	return query, nil
}

// branchPriceBranchDTO is one active branch of the matrix.
type branchPriceBranchDTO struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

// branchPriceDTO is one persisted pair: canonical amounts, the moment it was written
// and the account that wrote it.
type branchPriceDTO struct {
	BranchLocationID     int64  `json:"branch_location_id"`
	MinPrice             string `json:"min_price"`
	SuggestedPrice       string `json:"suggested_price"`
	UpdatedAt            string `json:"updated_at"`
	UpdatedByAccountID   int64  `json:"updated_by_account_id"`
	UpdatedByDisplayName string `json:"updated_by_display_name"`
}

// branchPriceVariantDTO is one row of the matrix. The warranty term is a product
// datum: it is null when the variant has none, never defaulted.
type branchPriceVariantDTO struct {
	VariantID         int64            `json:"variant_id"`
	CatalogEntryID    int64            `json:"catalog_entry_id"`
	Brand             string           `json:"brand"`
	Model             string           `json:"model"`
	Capacity          string           `json:"capacity_ah"`
	Polarity          string           `json:"polarity"`
	Cells             []string         `json:"cells"`
	WarrantyMonths    *int             `json:"warranty_months"`
	WarrantyUpdatedAt *string          `json:"warranty_updated_at"`
	Prices            []branchPriceDTO `json:"prices"`
}

// branchPriceMatrixDTO is the frozen read response: the active branches, one page of
// variants with their prices and the total of matching variants.
type branchPriceMatrixDTO struct {
	Branches      []branchPriceBranchDTO  `json:"branches"`
	Variants      []branchPriceVariantDTO `json:"variants"`
	Page          int                     `json:"page"`
	PageSize      int                     `json:"page_size"`
	TotalVariants int64                   `json:"total_variants"`
}

// branchPriceWriteDTO is the frozen write response: the variant, how many pairs were
// written, the branches in ascending order, the canonical pair and the term in force.
type branchPriceWriteDTO struct {
	VariantID      int64   `json:"variant_id"`
	Written        int     `json:"written"`
	BranchIDs      []int64 `json:"branch_ids"`
	MinPrice       string  `json:"min_price"`
	SuggestedPrice string  `json:"suggested_price"`
	WarrantyMonths *int    `json:"warranty_months"`
}

// validBranchPriceText admits the optional display text of the matrix.
func validBranchPriceText(value string) bool {
	return utf8.ValidString(value) && !strings.ContainsRune(value, 0)
}

// canonicalBranchPrice admits only a canonical amount: the exact two-decimal text
// this domain persists, never a rounded or differently spelled value.
func canonicalBranchPrice(money pricing.Money) (pricing.Money, bool) {
	canonical, err := pricing.ParseMoney(string(money))
	if err != nil || string(canonical) != string(money) {
		return "", false
	}
	return canonical, true
}

// branchPriceWarranty admits the optional term: inside its bound, or absent.
func branchPriceWarranty(months *int) bool {
	return months == nil || (*months >= pricing.MinWarrantyMonths && *months <= pricing.MaxWarrantyMonths)
}

// branchPriceRecord admits only a complete applied assignment.
func branchPriceRecord(result pricing.WriteResult) (branchPriceWriteDTO, error) {
	unavailable := func() (branchPriceWriteDTO, error) {
		return branchPriceWriteDTO{}, pricing.ErrUnavailable
	}
	min, ok := canonicalBranchPrice(result.MinPrice)
	if !ok {
		return unavailable()
	}
	suggested, ok := canonicalBranchPrice(result.SuggestedPrice)
	if !ok || !suggested.AtLeast(min) || !branchPriceWarranty(result.WarrantyMonths) {
		return unavailable()
	}
	if result.VariantID < 1 || result.VariantID > math.MaxInt32 ||
		len(result.BranchIDs) < 1 || len(result.BranchIDs) > branchPriceMaxBranches {
		return unavailable()
	}
	branches := make([]int64, 0, len(result.BranchIDs))
	previous := int64(1)
	for _, id := range result.BranchIDs {
		if id <= previous || id > math.MaxInt16 {
			return unavailable()
		}
		previous = id
		branches = append(branches, id)
	}
	return branchPriceWriteDTO{
		VariantID:      result.VariantID,
		Written:        len(branches),
		BranchIDs:      branches,
		MinPrice:       string(min),
		SuggestedPrice: string(suggested),
		WarrantyMonths: result.WarrantyMonths,
	}, nil
}

// branchPriceMatrixRecord admits only a complete matrix page: the branches it is read
// against, the catalogue identity of every variant, its null term when it has none
// and the canonical pairs of the active branches.
func branchPriceMatrixRecord(matrix pricing.Matrix) (branchPriceMatrixDTO, error) {
	unavailable := func() (branchPriceMatrixDTO, error) {
		return branchPriceMatrixDTO{}, pricing.ErrUnavailable
	}
	if !pricing.ValidPage(matrix.Page, matrix.PageSize) || matrix.TotalVariants < 0 ||
		len(matrix.Variants) > matrix.PageSize ||
		// A page beyond the last one is legitimately empty; a page with rows must
		// still fit inside the reported total.
		(len(matrix.Variants) > 0 &&
			int64(matrix.Page-1)*int64(matrix.PageSize)+int64(len(matrix.Variants)) > matrix.TotalVariants) {
		return unavailable()
	}
	branches := make([]branchPriceBranchDTO, 0, len(matrix.Branches))
	active := make(map[int64]bool, len(matrix.Branches))
	previousBranch := int64(1)
	for _, item := range matrix.Branches {
		if item.ID <= previousBranch || !validBranchPriceText(item.Name) || item.Name == "" {
			return unavailable()
		}
		previousBranch = item.ID
		active[item.ID] = true
		branches = append(branches, branchPriceBranchDTO{ID: item.ID, Name: item.Name})
	}
	var previousVariant int64
	variants := make([]branchPriceVariantDTO, 0, len(matrix.Variants))
	for _, item := range matrix.Variants {
		if item.VariantID < 1 || item.VariantID > math.MaxInt32 || item.VariantID <= previousVariant ||
			item.CatalogEntryID < 1 || !validBranchPriceText(item.Brand) || item.Brand == "" ||
			!validBranchPriceText(item.Model) || item.Model == "" ||
			(item.Polarity != "L" && item.Polarity != "R") || len(item.Cells) != 3 {
			return unavailable()
		}
		capacity, err := catalog.ParseDecimal(string(item.Capacity))
		if err != nil {
			return unavailable()
		}
		for _, cell := range item.Cells {
			if cell == "" || !validBranchPriceText(cell) {
				return unavailable()
			}
		}
		if !branchPriceWarranty(item.WarrantyMonths) {
			return unavailable()
		}
		// The term and the moment it was written are present exactly together.
		if (item.WarrantyMonths == nil) != (item.WarrantyAt == nil) {
			return unavailable()
		}
		var warrantyAt *string
		if item.WarrantyAt != nil {
			if item.WarrantyAt.IsZero() {
				return unavailable()
			}
			formatted := item.WarrantyAt.UTC().Format(time.RFC3339)
			warrantyAt = &formatted
		}
		prices := make([]branchPriceDTO, 0, len(item.Prices))
		var previousPrice int64
		for _, price := range item.Prices {
			min, ok := canonicalBranchPrice(price.MinPrice)
			if !ok {
				return unavailable()
			}
			suggested, ok := canonicalBranchPrice(price.SuggestedPrice)
			if !ok || !suggested.AtLeast(min) {
				return unavailable()
			}
			// A price belongs to a listed active branch, in ascending order and never
			// to the warehouse.
			if price.BranchLocationID <= previousPrice || !active[price.BranchLocationID] ||
				price.UpdatedAt.IsZero() || price.UpdatedByAccountID < 1 ||
				!validBranchPriceText(price.UpdatedByDisplayName) {
				return unavailable()
			}
			previousPrice = price.BranchLocationID
			prices = append(prices, branchPriceDTO{
				BranchLocationID:     price.BranchLocationID,
				MinPrice:             string(min),
				SuggestedPrice:       string(suggested),
				UpdatedAt:            price.UpdatedAt.UTC().Format(time.RFC3339),
				UpdatedByAccountID:   price.UpdatedByAccountID,
				UpdatedByDisplayName: price.UpdatedByDisplayName,
			})
		}
		previousVariant = item.VariantID
		variants = append(variants, branchPriceVariantDTO{
			VariantID:         item.VariantID,
			CatalogEntryID:    item.CatalogEntryID,
			Brand:             item.Brand,
			Model:             item.Model,
			Capacity:          string(capacity),
			Polarity:          item.Polarity,
			Cells:             item.Cells,
			WarrantyMonths:    item.WarrantyMonths,
			WarrantyUpdatedAt: warrantyAt,
			Prices:            prices,
		})
	}
	return branchPriceMatrixDTO{
		Branches:      branches,
		Variants:      variants,
		Page:          matrix.Page,
		PageSize:      matrix.PageSize,
		TotalVariants: matrix.TotalVariants,
	}, nil
}

// branchPrices serves the catalogue price list and its write. The read is the
// administrator's matrix; the write replaces the pair of every chosen branch and the
// warranty term in one transaction. Only the warehouse administrator is admitted and
// the store is the final authority for both.
func (a *API) branchPrices(store *pricing.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Anything below the collection is an unknown route answered as JSON, never a
		// cleaned or redirected path.
		if r.URL.Path != branchPriceRoutePath {
			failure(w, 404, "not_found")
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodPut {
			w.Header().Set("Allow", "GET, PUT")
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
			query, err := branchPriceQuery(r.URL.RawQuery)
			if err != nil {
				branchPriceFailure(w, err)
				return
			}
			matrix, err := store.Matrix(r.Context(), actor, query)
			if err != nil {
				branchPriceFailure(w, err)
				return
			}
			record, err := branchPriceMatrixRecord(matrix)
			if err != nil {
				branchPriceFailure(w, err)
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
		in, err := decodeBranchPrices(r)
		if err != nil {
			branchPriceFailure(w, err)
			return
		}
		result, err := store.Write(r.Context(), actor, in)
		if err != nil {
			branchPriceFailure(w, err)
			return
		}
		record, err := branchPriceRecord(result)
		if err != nil {
			branchPriceFailure(w, err)
			return
		}
		respond(w, 200, record)
	}
}
