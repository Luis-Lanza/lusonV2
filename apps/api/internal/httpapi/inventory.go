package httpapi

import (
	"errors"
	"luson/api/internal/auth"
	"luson/api/internal/inventory"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Keep legacy middleware plaintext behavior out of this JSON contract.
func (a *API) inventoryIdentity(w http.ResponseWriter, r *http.Request) (auth.Identity, bool) {
	token, unique := readCookie(r, sessionCookie)
	if !unique {
		failure(w, 400, "invalid_request")
		return auth.Identity{}, false
	}
	if token == "" {
		failure(w, 401, "unauthenticated")
		return auth.Identity{}, false
	}
	session, err := a.service.Current(r.Context(), token)
	if err != nil {
		if errors.Is(err, auth.ErrSession) {
			failure(w, 401, "unauthenticated")
		} else {
			failure(w, 503, "service_unavailable")
		}
		return auth.Identity{}, false
	}
	return session.Identity, true
}
func inventoryFailure(w http.ResponseWriter, err error) {
	if errors.Is(err, inventory.ErrInvalid) {
		failure(w, 400, "invalid_request")
	} else {
		failure(w, 503, "service_unavailable")
	}
}
func positive(value string) (int, error) {
	if len(value) == 0 || len(value) > 7 {
		return 0, inventory.ErrInvalid
	}
	for _, c := range value {
		if c < '0' || c > '9' {
			return 0, inventory.ErrInvalid
		}
	}
	n, err := strconv.Atoi(value)
	if err != nil || n < 1 || n > 1000000 {
		return 0, inventory.ErrInvalid
	}
	return n, nil
}
func inventoryQuery(raw string, metadata bool) (inventory.Query, error) {
	q := inventory.Query{Page: 1, PageSize: 10}
	// Bound decoding work independently of decoded field limits.
	if len(raw) > 4096 {
		return q, inventory.ErrInvalid
	}
	values, err := url.ParseQuery(raw)
	if err != nil {
		return q, inventory.ErrInvalid
	}
	for key, entries := range values {
		if metadata || len(entries) != 1 || !utf8.ValidString(entries[0]) || strings.ContainsRune(entries[0], 0) {
			return q, inventory.ErrInvalid
		}
		value := entries[0]
		switch key {
		case "location_id":
			q.LocationID, err = positive(value)
		case "page":
			q.Page, err = positive(value)
		case "page_size":
			q.PageSize, err = positive(value)
		case "search":
			q.Search = value
		case "brand":
			if value == "" {
				return q, inventory.ErrInvalid
			}
			q.Brand = value
		case "polarity":
			if value == "" {
				return q, inventory.ErrInvalid
			}
			q.Polarity = value
		default:
			return q, inventory.ErrInvalid
		}
		if err != nil {
			return q, inventory.ErrInvalid
		}
	}
	if !metadata {
		return q, q.Validate()
	}
	return q, nil
}
func (a *API) registerInventory(mux *http.ServeMux, store *inventory.Store) {
	for _, metadata := range []bool{false, true} {
		path := "/api/inventory"
		if metadata {
			path += "/metadata"
		}
		mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
			if !method(w, r, http.MethodGet) {
				return
			}
			actor, ok := a.inventoryIdentity(w, r)
			if !ok {
				return
			}
			q, err := inventoryQuery(r.URL.RawQuery, metadata)
			if err != nil {
				inventoryFailure(w, err)
				return
			}
			if store == nil {
				failure(w, 503, "service_unavailable")
				return
			}
			if metadata {
				result, err := store.Metadata(r.Context(), actor)
				if err != nil {
					inventoryFailure(w, err)
					return
				}
				respond(w, 200, result)
			} else {
				result, err := store.List(r.Context(), actor, q)
				if err != nil {
					inventoryFailure(w, err)
					return
				}
				respond(w, 200, result)
			}
		})
	}
}
