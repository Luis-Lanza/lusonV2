package httpapi

import (
	"encoding/json"
	"math"
	"net/http/httptest"
	"strings"
	"testing"

	"luson/api/internal/transfers"
)

func dr3Body(key, revision, quantity string) string {
	body := countHTTPBody(1, key, revision, "", "evidence")
	if quantity != "" {
		body = strings.TrimSuffix(body, "}") + `,"dispatch_quantity":"` + quantity + `"}`
	}
	return body
}
func TestDR3HTTPReadRegistered(t *testing.T) {
	f := transferFixture(t)
	received := countHTTPReceived(t, f)
	path := "/api/transfers/" + received.ID + "/dispatch-reconciliations"
	w := f.request(t, 2, "GET", path, "")
	var state dispatchReconciliationSnapshotDTO
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &state) != nil || len(state.Lines) != 2 || state.Operations == nil {
		t.Fatalf("snapshot: %d %s", w.Code, w.Body.String())
	}
	if state.Lines[0].OriginalActual != "1" || state.Lines[0].Proposals == nil {
		t.Fatal("original evidence or empty history lost")
	}
	dr3Reject(t, f, path, f.newRequest(3, "GET", path, ""), 404, "not_found")
	dr3Reject(t, f, path, f.newRequest(0, "GET", path, ""), 401, "unauthenticated")
	for _, id := range []string{"0", "01", "-1", "1.0", "9223372036854775808", "%31"} {
		dr3Reject(t, f, path, f.newRequest(2, "GET", "/api/transfers/"+id+"/dispatch-reconciliations", ""), 400, "invalid_request")
	}
	for _, suffix := range []string{"/", "/accept/", "/unknown", "/propose/extra"} {
		dr3Reject(t, f, path, f.newRequest(2, "POST", path+suffix, "junk"), 404, "not_found")
	}
	dr3Reject(t, f, path, f.newRequest(2, "GET", path+"?", ""), 400, "invalid_request")
}
func TestDR3HTTPMutationPrepared(t *testing.T) {
	f := transferFixture(t)
	received := countHTTPReceived(t, f)
	path := "/api/transfers/" + received.ID + "/dispatch-reconciliations"
	// A matching dispatch cannot be reconciled; private access wins over junk.
	dr3Reject(t, f, path, f.newRequest(2, "POST", path+"/propose", dr3Body("dr3-proposal-key-001", "0", "1")), 400, "invalid_request")
	dr3Reject(t, f, path, f.newRequest(3, "POST", path+"/propose", "junk"), 404, "not_found")
}
func TestDR3HTTPDecodeWire(t *testing.T) {
	n := int64(math.MaxInt64)
	op := dispatchReconciliationOperationRecord(transfers.DispatchReconciliationOperation{RequestID: n, ExpectedRevision: n, SourceExistingBefore: &n})
	raw, err := json.Marshal(op)
	if err != nil || op.RequestID != "9223372036854775807" || op.SourceExistingBefore == nil || *op.SourceExistingBefore != "9223372036854775807" || !strings.Contains(string(raw), `"destination_existing_after":null`) {
		t.Fatal("lossy/null wire", string(raw))
	}
	for _, quantity := range []string{"0", "9007199254740993", "9223372036854775807"} {
		r := httptest.NewRequest("POST", "/", strings.NewReader(dr3Body("dr3-decoder-key-001", "0", quantity)))
		r.Header.Set("Content-Type", "application/json")
		if _, err := decodeDispatchReconciliationMutation(r, true); err != nil {
			t.Fatal("valid quantity rejected", quantity)
		}
	}
}
