package httpapi

import (
	"math"
	"net/http"

	"luson/api/internal/transfers"
)

func (a *API) transferCancellation(store *transfers.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
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
		id, err := canonicalTransferInteger(r.PathValue("id"), math.MaxInt64)
		if err != nil {
			transferFailure(w, err)
			return
		}
		if err := decodeTransferDecision(r); err != nil {
			transferFailure(w, err)
			return
		}
		result, err := store.Cancel(r.Context(), actor, id)
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
