package httpapi

import (
	"bytes"
	"encoding/json"
	"io"
	"math"
	"mime"
	"net/http"
	"strings"
	"unicode/utf8"

	"luson/api/internal/transfers"
)

// Decisions admit one empty object, not a reason, actor, key or cart. Keep the
// framing rules local and identical to creation without widening that decoder.
func decodeTransferDecision(r *http.Request) error {
	if r == nil || r.Body == nil || len(r.Header.Values("Content-Type")) != 1 {
		return transfers.ErrInvalid
	}
	contentType := r.Header.Get("Content-Type")
	media, params, err := mime.ParseMediaType(contentType)
	// ParseMediaType collapses identical duplicate parameters and accepts a
	// dangling separator. Neither is an admitted unambiguous JSON framing.
	if err != nil || media != "application/json" || len(params) > 1 || strings.Count(contentType, ";") != len(params) {
		return transfers.ErrInvalid
	}
	for key, value := range params {
		if key != "charset" || !strings.EqualFold(value, "utf-8") {
			return transfers.ErrInvalid
		}
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, (64<<10)+1))
	if err != nil || len(body) > 64<<10 || !utf8.Valid(body) {
		return transfers.ErrInvalid
	}
	d := json.NewDecoder(bytes.NewReader(body))
	if !transferDelimiter(d, '{') || d.More() || !transferDelimiter(d, '}') {
		return transfers.ErrInvalid
	}
	if _, err := d.Token(); err != io.EOF {
		return transfers.ErrInvalid
	}
	return nil
}

func (a *API) transferDecision(store *transfers.Store, approve bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !method(w, r, http.MethodPost) {
			return
		}
		// POST always uses Current, including with a passive-read header. Do
		// not validate IDs or bodies until identity and mutation guards pass.
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
		id, err := canonicalTransferInteger(r.PathValue("id"), math.MaxInt64)
		if err != nil {
			transferFailure(w, err)
			return
		}
		if err := decodeTransferDecision(r); err != nil {
			transferFailure(w, err)
			return
		}
		var result transfers.Request
		if approve {
			result, err = store.Approve(r.Context(), actor, id)
		} else {
			result, err = store.Reject(r.Context(), actor, id)
		}
		if err != nil {
			transferFailure(w, err)
			return
		}
		record, err := transferRecord(result)
		if err != nil {
			transferFailure(w, err)
			return
		}
		respond(w, 200, record)
	}
}
