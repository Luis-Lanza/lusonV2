package httpapi

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"luson/api/internal/inventory"
)

func dr3Get(t *testing.T, f *transferHTTPFixture, path string) string {
	t.Helper()
	w := receiptHTTPMutation(f, f.newRequest(2, "GET", path, ""))
	if w.Code != 200 {
		t.Fatalf("GET %s: %d %s", path, w.Code, w.Body.String())
	}
	return w.Body.String()
}
func dr3Inventory(t *testing.T, f *transferHTTPFixture) map[string]inventory.Item {
	t.Helper()
	out := map[string]inventory.Item{}
	for location := 1; location <= 3; location++ {
		for page := 1; page <= 4; page++ {
			raw := dr3Get(t, f, fmt.Sprintf("/api/inventory?location_id=%d&page=%d&page_size=50", location, page))
			var result inventory.Page
			if json.Unmarshal([]byte(raw), &result) != nil {
				t.Fatal("inventory decode")
			}
			for _, item := range result.Items {
				out[fmt.Sprintf("%d/%d", location, item.VariantID)] = item
			}
		}
	}
	if len(out) != 570 {
		t.Fatal("public inventory incomplete")
	}
	return out
}
func dr3Counts(t *testing.T, f *transferHTTPFixture) string {
	t.Helper()
	var out string
	for actor := 1; actor <= 3; actor++ {
		w := receiptHTTPMutation(f, f.newRequest(actor, "GET", "/api/transfers/counts", ""))
		if w.Code != 200 {
			t.Fatal("public counts", w.Code)
		}
		out += w.Body.String()
	}
	return out
}
func dr3NoChange(t *testing.T, f *transferHTTPFixture, path string) func() {
	t.Helper()
	history, counts, stock := dr3Get(t, f, path), dr3Counts(t, f), dr3Inventory(t, f)
	return func() {
		t.Helper()
		if dr3Get(t, f, path) != history || dr3Counts(t, f) != counts || !reflect.DeepEqual(dr3Inventory(t, f), stock) {
			t.Fatal("rejected/replayed request changed public evidence")
		}
	}
}
func dr3Reject(t *testing.T, f *transferHTTPFixture, path string, r *http.Request, status int, code string) {
	t.Helper()
	unchanged := dr3NoChange(t, f, path)
	expectTransferError(t, receiptHTTPMutation(f, r), status, code)
	unchanged()
}
func dr3Apply(t *testing.T, f *transferHTTPFixture, r *http.Request, source, destination int64) *httptest.ResponseRecorder {
	t.Helper()
	before := dr3Inventory(t, f)
	w := receiptHTTPMutation(f, r)
	if w.Code != 200 {
		t.Fatalf("mutation %s: %d %s", r.URL.Path, w.Code, w.Body.String())
	}
	after := dr3Inventory(t, f)
	for key, item := range before {
		delta := int64(0)
		if key == "1/1" {
			delta = source
		}
		if key == "2/1" {
			delta = destination
		}
		item.Existing += delta
		item.Available += delta
		if !reflect.DeepEqual(item, after[key]) {
			t.Fatal("public balance/reservation mismatch", key)
		}
	}
	// Existing fixture cleanup also checks every balance. Adopt only after the
	// public interface has proved the exact intended transformation.
	f.baseline = f.stock(t)
	return w
}
func dr3Received(t *testing.T, f *transferHTTPFixture) string {
	t.Helper()
	body := `{"kind":"request_stock","counterparty_location_id":1,"retry_key":"dr3-create-fixture-001","items":[{"variant_id":1,"quantity":"5"}]}`
	w := f.request(t, 2, "POST", "/api/transfers", body)
	var record transferDTO
	if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &record) != nil {
		t.Fatal("create", w.Code)
	}
	path := "/api/transfers/" + record.ID
	// Setup uses real lifecycle routes; later effects are checked through public
	// inventory, history, immutable detail and counts rather than private ledgers.
	for _, step := range []struct {
		actor        int
		action, body string
	}{
		{1, "approve", "{}"}, {1, "dispatch", "{}"}, {2, "receive", `{"items":[{"variant_id":1,"actual_quantity":"7"},{"variant_id":2,"actual_quantity":"1"}]}`},
	} {
		w = receiptHTTPMutation(f, f.newRequest(step.actor, "POST", path+"/"+step.action, step.body))
		if w.Code != 200 {
			t.Fatalf("fixture %s: %d %s", step.action, w.Code, w.Body.String())
		}
		f.baseline = f.stock(t)
	}
	dr3Route(f)
	return path
}
func TestDR3HTTPMutationAgreement(t *testing.T) {
	f := transferFixture(t)
	detail := dr3Received(t, f)
	path := detail + "/dispatch-reconciliations"
	original := dr3Get(t, f, detail)
	proposal := dr3Body("dr3-agreement-propose-001", "0", "7")
	first := dr3Apply(t, f, f.newRequest(1, "POST", path+"/propose", proposal), 0, 0)
	accept := dr3Body("dr3-agreement-accept-001", "1", "")
	dr3Reject(t, f, path, f.newRequest(1, "POST", path+"/accept", accept), 403, "forbidden")
	balances := dr3Inventory(t, f)
	accepted := dr3Apply(t, f, f.newRequest(2, "POST", path+"/accept", accept), -2, 2)
	var op dispatchReconciliationOperationDTO
	if json.Unmarshal(accepted.Body.Bytes(), &op) != nil || op.SourceExistingBefore == nil || op.SourceExistingAfter == nil || op.DestinationExistingBefore == nil || op.DestinationExistingAfter == nil || op.DispatchQuantity != nil {
		t.Fatal("persisted balances missing")
	}
	if *op.SourceExistingBefore != countInt(balances["1/1"].Existing) || *op.SourceExistingAfter != countInt(balances["1/1"].Existing-2) || *op.DestinationExistingBefore != countInt(balances["2/1"].Existing) || *op.DestinationExistingAfter != countInt(balances["2/1"].Existing+2) {
		t.Fatal("persisted balances differ from public inventory")
	}
	var state dispatchReconciliationSnapshotDTO
	if json.Unmarshal([]byte(dr3Get(t, f, path)), &state) != nil {
		t.Fatal("snapshot")
	}
	line := state.Lines[0]
	if line.ExpectedQuantity != "5" || line.OriginalActual != "7" || line.OriginalCredit != "5" || line.EffectiveDispatch != "7" || line.EffectiveCredit != "7" || line.Proposals[0].Application.SourceDelta != "-2" || line.Proposals[0].Application.DestinationDelta != "2" {
		t.Fatal("original/effective evidence", line)
	}
	// Count correction changes A and C; a fresh reverse-endpoint agreement must
	// compensate only source. Current C must include both accounting workflows.
	cp := detail + "/count-corrections"
	dr3Apply(t, f, f.newRequest(2, "POST", cp+"/propose", countHTTPBody(1, "dr3-count-propose-001", "0", "6", "recount")), 0, 0)
	dr3Apply(t, f, f.newRequest(1, "POST", cp+"/accept", countHTTPBody(1, "dr3-count-accept-001", "1", "", "agree")), 0, -1)
	dr3Apply(t, f, f.newRequest(2, "POST", path+"/propose", dr3Body("dr3-agreement-propose-002", "1", "6")), 0, 0)
	dr3Apply(t, f, f.newRequest(1, "POST", path+"/accept", dr3Body("dr3-agreement-accept-002", "2", "")), 1, 0)
	if dr3Get(t, f, detail) != original {
		t.Fatal("original receipt/cart changed")
	}
	for _, replay := range []struct {
		actor        int
		action, body string
		prior        *httptest.ResponseRecorder
	}{{1, "propose", proposal, first}, {2, "accept", accept, accepted}} {
		unchanged := dr3NoChange(t, f, path)
		got := receiptHTTPMutation(f, f.newRequest(replay.actor, "POST", path+"/"+replay.action, replay.body))
		if got.Code != 200 || got.Body.String() != replay.prior.Body.String() {
			t.Fatal("historical replay recomputed")
		}
		unchanged()
	}
	dr3Reject(t, f, path, f.newRequest(1, "POST", path+"/propose", strings.Replace(proposal, "evidence", "changed", 1)), 409, "retry_conflict")
	dr3Reject(t, f, path, f.newRequest(1, "POST", path+"/propose", dr3Body("dr3-mismatch-key-001", "2", "7")), 400, "invalid_request")
	dr3Reject(t, f, path, f.newRequest(1, "POST", path+"/propose", strings.Replace(dr3Body("dr3-unexpected-key-001", "0", "1"), `"variant_id":1`, `"variant_id":2`, 1)), 400, "invalid_request")
	dr3Reject(t, f, path, f.newRequest(1, "POST", path+"/accept", dr3Body("dr3-stale-key-0001", "1", "")), 409, "decision_conflict")
}

type dr3UnreadBody struct{ t *testing.T }

func (b dr3UnreadBody) Read([]byte) (int, error) {
	b.t.Error("private/guard rejection read body")
	return 0, io.EOF
}
func (b dr3UnreadBody) Close() error { return nil }
func TestDR3HTTPMutationGuards(t *testing.T) {
	f := transferFixture(t)
	detail := dr3Received(t, f)
	path := detail + "/dispatch-reconciliations"
	for _, actor := range []int{0, 3} {
		r := f.newRequest(actor, "POST", path+"/propose", "")
		r.Body = dr3UnreadBody{t}
		status, code := 401, "unauthenticated"
		if actor == 3 {
			status, code = 404, "not_found"
		}
		dr3Reject(t, f, path, r, status, code)
	}
	for _, header := range []string{"Origin", "X-CSRF-Token", "Sec-Fetch-Site"} {
		for _, duplicate := range []bool{false, true} {
			r := f.newRequest(2, "POST", path+"/propose", "")
			r.Body = dr3UnreadBody{t}
			if duplicate {
				r.Header.Add(header, r.Header.Get(header))
			} else {
				r.Header.Set(header, "wrong")
			}
			dr3Reject(t, f, path, r, 403, "forbidden")
		}
	}
	r := f.newRequest(2, "POST", path+"/propose", "")
	r.AddCookie(&http.Cookie{Name: sessionCookie, Value: f.tokens[1]})
	r.Body = dr3UnreadBody{t}
	dr3Reject(t, f, path, r, 400, "invalid_request")
	for _, suffix := range []string{"?", "?actor=1"} {
		dr3Reject(t, f, path, f.newRequest(2, "POST", path+"/propose"+suffix, "junk"), 400, "invalid_request")
	}
	for _, action := range []string{"propose", "accept", "reject"} {
		dr3Reject(t, f, path, f.newRequest(2, "GET", path+"/"+action, ""), 405, "method_not_allowed")
	}
	// Session revocation uses the real service, not a forged actor/context.
	if f.svc.Logout(f.ctx, f.tokens[0]) != nil {
		t.Fatal("revoke")
	}
	r = f.newRequest(1, "POST", path+"/propose", "")
	r.Body = dr3UnreadBody{t}
	// Counts for revoked actor cannot be read; capture using remaining endpoint.
	before, stock := dr3Get(t, f, path), dr3Inventory(t, f)
	counts := dr3Get(t, f, "/api/transfers/counts")
	expectTransferError(t, receiptHTTPMutation(f, r), 401, "unauthenticated")
	if dr3Get(t, f, path) != before || dr3Get(t, f, "/api/transfers/counts") != counts || !reflect.DeepEqual(dr3Inventory(t, f), stock) {
		t.Fatal("revoked session changed state")
	}
}
