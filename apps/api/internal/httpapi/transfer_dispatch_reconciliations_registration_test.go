package httpapi

import (
	"fmt"
	"net/http"
	"reflect"
	"testing"
)

// No dr3Route: every request below traverses NewWithTransfers' production mux.
func TestDR3HTTPReadProductionRouter(t *testing.T) {
	f := transferFixture(t)
	received := countHTTPReceived(t, f)
	pending := decisionCreate(t, f, "request_stock", 1, "dr3-read-pending-001")
	detail := "/api/transfers/" + received.ID
	path := detail + "/dispatch-reconciliations"
	line := func(id int) string {
		return fmt.Sprintf(`{"variant_id":%d,"expected_quantity":"1","actual_quantity":"1","available_quantity":"1","effective_dispatch":"1","effective_actual":"1","effective_credit":"1","applied_retained_quantity":"0","workflow_revision":"0","applied_revision":"0","count_generation":"0","count_applied_revision":"0","restitution_generation":"0","reconciliation_generation":"0","proposals":[]}`, id)
	}
	want := fmt.Sprintf("{\"request_id\":%q,\"lines\":[%s,%s],\"operations\":[]}\n", received.ID, line(1), line(2))
	// Public inventory includes all reserved/available balances; public snapshots
	// include workflow generations and operations, and counts cover all actors.
	snapshot := func() []string {
		return []string{dr3Get(t, f, detail), dr3Get(t, f, detail+"/count-corrections"), dr3Get(t, f, detail+"/restitutions"), dr3Get(t, f, path), dr3Counts(t, f)}
	}
	before, stock := snapshot(), dr3Inventory(t, f)
	check := func(r *http.Request, status int, body, allow string) {
		t.Helper()
		r.Body = dr3UnreadBody{t}
		w := receiptHTTPMutation(f, r)
		headers := http.Header{"Content-Type": {"application/json"}, "Cache-Control": {"no-store"}, "X-Content-Type-Options": {"nosniff"}}
		if allow != "" {
			headers.Set("Allow", allow)
		}
		if w.Code != status || w.Body.String() != body || !reflect.DeepEqual(w.Header(), headers) {
			t.Fatalf("%s %s: status=%d body=%q headers=%v; want %d %q %v", r.Method, r.URL, w.Code, w.Body.String(), w.Header(), status, body, headers)
		}
		if !reflect.DeepEqual(snapshot(), before) || !reflect.DeepEqual(dr3Inventory(t, f), stock) {
			t.Fatal("read/refusal changed public state or counters")
		}
	}
	for _, actor := range []int{1, 2} {
		check(f.newRequest(actor, "GET", path, ""), 200, want, "")
	}
	reject := func(actor int, method, target string, status int, code, allow string) {
		t.Helper()
		check(f.newRequest(actor, method, target, ""), status, fmt.Sprintf("{\"error\":%q}\n", code), allow)
	}
	reject(3, "GET", path, 404, "not_found", "")
	reject(0, "GET", path, 401, "unauthenticated", "")
	reject(2, "GET", "/api/transfers/"+pending.ID+"/dispatch-reconciliations", 409, "decision_conflict", "")
	reject(2, "GET", "/api/transfers/9223372036854775807/dispatch-reconciliations", 404, "not_found", "")
	for _, id := range []string{"0", "01", "-1", "1.0", "9223372036854775808", "%31"} {
		reject(2, "GET", "/api/transfers/"+id+"/dispatch-reconciliations", 400, "invalid_request", "")
	}
	for _, query := range []string{"?", "?actor=1", "?location_id=1"} {
		reject(2, "GET", path+query, 400, "invalid_request", "")
	}
	for _, method := range []string{"POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"} {
		for _, actor := range []int{0, 1, 2, 3} {
			reject(actor, method, path, 405, "method_not_allowed", "GET")
		}
	}
	for _, suffix := range []string{"/", "/propose", "/accept", "/reject", "/accept/", "/unknown", "/propose/extra"} {
		for _, method := range []string{"GET", "POST"} {
			reject(2, method, path+suffix, 404, "not_found", "")
		}
	}
	for _, target := range []string{"/api/transfers//1/dispatch-reconciliations", detail + "/./dispatch-reconciliations", detail + "/../dispatch-reconciliations"} {
		reject(2, "GET", target, 404, "not_found", "")
	}
	r := f.newRequest(2, "GET", path, "")
	r.AddCookie(&http.Cookie{Name: sessionCookie, Value: f.tokens[1]})
	check(r, 400, "{\"error\":\"invalid_request\"}\n", "")
}
