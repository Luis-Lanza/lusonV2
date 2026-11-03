package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestURHTTPMutations(t *testing.T) {
	f := transferFixture(t)
	received := countHTTPReceived(t, f)
	path := "/api/transfers/" + received.ID + "/unified-reconciliations"
	original := countHTTPOriginal(t, f)
	body := `{"variant_id":1,"operation_key":"unified-http-propose1","expected_revision":"0","dispatch_quantity":"4","arrival_quantity":"3","retained_quantity":"0","retained_at_origin":false,"reason":"exact proposal"}`
	run := func(actor int, action, body string, source, destination int64) string {
		t.Helper()
		w := dr3Apply(t, f, f.newRequest(actor, "POST", path+"/"+action, body), source, destination)
		var envelope struct {
			Schema    string                            `json:"schema"`
			Operation UnifiedReconciliationOperationDTO `json:"operation"`
		}
		if len(transferObject(t, w, 200)) != 2 || json.Unmarshal(w.Body.Bytes(), &envelope) != nil {
			t.Fatal(w.Body.String())
		}
		if envelope.Schema != "luson.transfer-reconciliation-operation/v2" || envelope.Operation.Action != action || envelope.Operation.RequestID != received.ID {
			t.Fatal(w.Body.String())
		}
		if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Content-Type-Options") != "nosniff" || len(w.Result().Cookies()) != 0 {
			t.Fatal("security headers", w.Header())
		}
		if countHTTPOriginal(t, f) != original {
			t.Fatal("original evidence changed")
		}
		return w.Body.String()
	}
	proposal := run(1, "propose", body, 0, 0)
	decision := `{"variant_id":1,"operation_key":"unified-http-accept01","expected_revision":"1","retained_at_origin":false,"reason":"exact acceptance"}`
	dr3Reject(t, f, path, f.newRequest(1, "POST", path+"/accept", decision), 403, "forbidden")
	// Original E=1/C=1; agreed D=4/A=3/R=0 targets source debit4 and credit3.
	accepted := run(2, "accept", decision, -3, 2)
	second := strings.ReplaceAll(strings.Replace(body, "unified-http-propose1", "unified-http-propose2", 1), `"expected_revision":"0"`, `"expected_revision":"1"`)
	run(2, "propose", second, 0, 0)
	rejection := `{"variant_id":1,"operation_key":"unified-http-reject02","expected_revision":"2","retained_at_origin":false,"reason":"not agreed"}`
	rejected := run(1, "reject", rejection, 0, 0)
	for _, retry := range []struct {
		actor               int
		action, body, prior string
	}{{1, "propose", body, proposal}, {2, "accept", decision, accepted}, {1, "reject", rejection, rejected}} {
		unchanged := dr3NoChange(t, f, path)
		if got := run(retry.actor, retry.action, retry.body, 0, 0); got != retry.prior {
			t.Fatal("historical retry replaced evidence")
		}
		unchanged()
	}
	dr3Reject(t, f, path, f.newRequest(1, "POST", path+"/propose", strings.Replace(body, "exact proposal", "changed reason", 1)), 409, "retry_conflict")
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
	for _, action := range []string{"propose", "accept", "reject"} {
		r := f.newRequest(0, "GET", path+"/"+action, "")
		r.Body = dr3UnreadBody{t}
		dr3Reject(t, f, path, r, 405, "method_not_allowed")
	}
	for _, suffix := range []string{"?", "?actor=1"} {
		r := f.newRequest(2, "POST", path+"/propose"+suffix, "")
		r.Body = dr3UnreadBody{t}
		dr3Reject(t, f, path, r, 400, "invalid_request")
	}
	r := f.newRequest(2, "POST", path+"/propose", "")
	r.AddCookie(&http.Cookie{Name: sessionCookie, Value: f.tokens[1]})
	r.Body = dr3UnreadBody{t}
	dr3Reject(t, f, path, r, 400, "invalid_request")
	r = f.newRequest(2, "POST", path+"/unknown", "")
	r.Body = dr3UnreadBody{t}
	dr3Reject(t, f, path, r, 404, "not_found")
	// Existing read contract and unrelated dispatch route remain registered.
	w := receiptHTTPMutation(f, f.newRequest(2, "GET", path, ""))
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	dr3Reject(t, f, path, f.newRequest(2, "POST", path, "junk"), 405, "method_not_allowed")
}
