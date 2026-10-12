package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

func countHTTPBody(variant int, key, revision, actual, reason string) string {
	body := fmt.Sprintf(`{"variant_id":%d,"operation_key":%q,"expected_revision":%q,"reason":%q`, variant, key, revision, reason)
	if actual != "" {
		body += fmt.Sprintf(`,"actual_quantity":%q`, actual)
	}
	return body + "}"
}

func countHTTPReceived(t *testing.T, f *transferHTTPFixture) transferDTO {
	t.Helper()
	transit := receiptHTTPDispatch(t, f, "request_stock", 1)
	proof := receiptHTTPProof(t, f, transit, 1, 1)
	w := receiptHTTPMutation(f, f.newRequest(2, "POST", "/api/transfers/"+transit.ID+"/receive", `{"items":[{"variant_id":1,"actual_quantity":"1"},{"variant_id":2,"actual_quantity":"1"},{"variant_id":3,"actual_quantity":"7"}]}`))
	proof(w)
	var result transferDTO
	if json.Unmarshal(w.Body.Bytes(), &result) != nil {
		t.Fatal("received decode")
	}
	return result
}

func countHTTPOriginal(t *testing.T, f *transferHTTPFixture) string {
	t.Helper()
	var got string
	if f.p.QueryRow(f.ctx, `SELECT jsonb_build_array(
 (SELECT jsonb_agg(to_jsonb(h) ORDER BY id) FROM transfer_requests h),
 (SELECT jsonb_agg(to_jsonb(i) ORDER BY request_id,variant_id) FROM transfer_request_items i),
 (SELECT jsonb_agg(to_jsonb(a) ORDER BY request_id,variant_id) FROM transfer_request_allocations a),
 (SELECT jsonb_agg(to_jsonb(r) ORDER BY request_id,variant_id) FROM transfer_receipt_lines r),
 (SELECT jsonb_agg(to_jsonb(e) ORDER BY request_id,variant_id,kind) FROM transfer_receipt_exceptions e))::text`).Scan(&got) != nil {
		t.Fatal("original evidence snapshot")
	}
	return got
}

// Prove all 570 balances and immutable evidence before adopting the new stock
// baseline. Passive fixture helpers continue to prohibit any inventory change.
func countHTTPProof(t *testing.T, f *transferHTTPFixture, destination, variant int, delta int64) func(*httptest.ResponseRecorder) {
	t.Helper()
	original := countHTTPOriginal(t, f)
	var expected string
	if f.p.QueryRow(f.ctx, `SELECT jsonb_agg(to_jsonb(b)||jsonb_build_object(
 'existing',b.existing+CASE WHEN location_id=$1 AND variant_id=$2 THEN $3::bigint ELSE 0 END,
 'available',b.available+CASE WHEN location_id=$1 AND variant_id=$2 THEN $3::bigint ELSE 0 END) ORDER BY location_id,variant_id)::text FROM inventory_balances b`, destination, variant, delta).Scan(&expected) != nil {
		t.Fatal("correction stock proof construction")
	}
	return func(w *httptest.ResponseRecorder) {
		countHTTPOperation(t, w)
		if f.stock(t) != expected || countHTTPOriginal(t, f) != original {
			t.Fatal("correction changed wrong stock or immutable receipt/header/allocations")
		}
		f.baseline = expected
	}
}
func countHTTPOperation(t *testing.T, w *httptest.ResponseRecorder) countOperationDTO {
	t.Helper()
	if len(transferObject(t, w, 200)) != 10 {
		t.Fatal("operation field set changed")
	}
	if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Content-Type-Options") != "nosniff" || len(w.Result().Cookies()) != 0 {
		t.Fatal("operation security headers changed")
	}
	var op countOperationDTO
	if json.Unmarshal(w.Body.Bytes(), &op) != nil {
		t.Fatal("operation decode")
	}
	stamp, err := time.Parse(time.RFC3339Nano, op.RecordedAt)
	if err != nil || stamp.Location() != time.UTC || op.RecordedAt != countStamp(stamp) {
		t.Fatal("noncanonical UTC timestamp")
	}
	return op
}
func countHTTPSnapshot(t *testing.T, f *transferHTTPFixture, id string) countSnapshotDTO {
	t.Helper()
	w := f.request(t, 2, "GET", "/api/transfers/"+id+"/count-corrections", "")
	if len(transferObject(t, w, 200)) != 3 {
		t.Fatal("snapshot root contract")
	}
	var out countSnapshotDTO
	if json.Unmarshal(w.Body.Bytes(), &out) != nil || out.RequestID != id {
		t.Fatal("snapshot decode")
	}
	return out
}

func TestC3CountAdmission(t *testing.T) {
	f := transferFixture(t)
	original := decisionCreate(t, f, "request_stock", 1, "count-admission-001")
	path := "/api/transfers/" + original.ID + "/count-corrections"
	for _, action := range []string{"", "/propose", "/accept", "/reject"} {
		verb, wrong := "POST", "GET"
		if action == "" {
			verb, wrong = "GET", "POST"
		}
		expectTransferError(t, f.request(t, 0, wrong, path+action, "junk"), 405, "method_not_allowed")
		expectTransferError(t, f.request(t, 0, verb, path+action, "junk"), 401, "unauthenticated")
		expectTransferError(t, f.request(t, 2, verb, path+action+"?", countBody), 400, "invalid_request")
	}
	expectTransferError(t, f.request(t, 2, "GET", path, ""), 409, "decision_conflict")
	expectTransferError(t, f.request(t, 3, "GET", path, ""), 404, "not_found")
	expectTransferError(t, f.request(t, 3, "POST", path+"/propose", countBody), 404, "not_found")
	for _, id := range []string{"0", "01", "-1", "1.0", "9223372036854775808"} {
		expectTransferError(t, f.request(t, 2, "GET", "/api/transfers/"+id+"/count-corrections", ""), 400, "invalid_request")
	}
	for _, suffix := range []string{"/", "/accept/", "/unknown", "/propose/extra"} {
		expectTransferError(t, f.request(t, 2, "POST", path+suffix, countBody), 404, "not_found")
	}
	expectTransferError(t, f.request(t, 2, "POST", "/api/transfers/%31/count-corrections/propose", countBody), 400, "invalid_request")
	expectTransferError(t, f.request(t, 2, "POST", "/api/transfers//1/count-corrections/propose", countBody), 404, "not_found")
	for _, action := range []string{"propose", "accept", "reject"} {
		for _, guard := range []string{"site", "duplicate_site", "empty_site", "origin", "duplicate_origin", "csrf", "duplicate_csrf"} {
			r := f.newRequest(2, "POST", "/api/transfers/01/count-corrections/"+action, "junk")
			switch guard {
			case "site":
				r.Header.Set("Sec-Fetch-Site", "cross-site")
			case "duplicate_site":
				r.Header.Add("Sec-Fetch-Site", "same-origin")
			case "empty_site":
				r.Header.Set("Sec-Fetch-Site", "")
			case "origin":
				r.Header.Del("Origin")
			case "duplicate_origin":
				r.Header.Add("Origin", f.cfg.Origin)
			case "csrf":
				r.Header.Del("X-CSRF-Token")
			case "duplicate_csrf":
				r.Header.Add("X-CSRF-Token", r.Header.Get("X-CSRF-Token"))
			}
			expectTransferError(t, f.serve(t, r), 403, "forbidden")
		}
	}
	r := f.newRequest(2, "POST", path+"/propose", countBody)
	r.Header.Del("Sec-Fetch-Site")
	expectTransferError(t, f.serve(t, r), 409, "decision_conflict")
	r = f.newRequest(2, "GET", path, "")
	r.AddCookie(&http.Cookie{Name: sessionCookie, Value: f.tokens[1]})
	expectTransferError(t, f.serve(t, r), 400, "invalid_request")
	expectTransferError(t, f.request(t, 2, "GET", "/api/transfers/9223372036854775807/count-corrections", ""), 404, "not_found")
}

func TestC3CountWorkflowHTTP(t *testing.T) {
	f := transferFixture(t)
	received := countHTTPReceived(t, f)
	path := "/api/transfers/" + received.ID + "/count-corrections"
	original := countHTTPOriginal(t, f)
	initial := countHTTPSnapshot(t, f, received.ID)
	if len(initial.Lines) != 3 || len(initial.Operations) != 0 {
		t.Fatal("initial membership")
	}
	if initial.Lines[0].WorkflowRevision != "0" || initial.Lines[0].OriginalActual != "1" || initial.Lines[0].OriginalCredit != "1" || initial.Lines[0].EffectiveCredit != "1" || len(initial.Lines[0].Proposals) != 0 {
		t.Fatal("initial original/effective")
	}

	// Physical origin proposes on an originally matching line; counterparty
	// alone decides. Credit reduction produces an exact signed inventory delta.
	proposal := countHTTPBody(1, "count-workflow-propose-001", "0", "0", "  corrected count  ")
	first := f.request(t, 1, "POST", path+"/propose", proposal)
	op := countHTTPOperation(t, first)
	if op.ActorLocationID != 1 || op.RequestID != received.ID || op.Actual == nil || *op.Actual != "0" || op.Reason != "  corrected count  " || op.Revision != "1" {
		t.Fatal("proposal evidence mutated")
	}
	pending := countHTTPSnapshot(t, f, received.ID).Lines[0].Proposals[0]
	if pending.State != "pending" || pending.Decision != nil || pending.Application != nil {
		t.Fatal("pending null evidence")
	}
	accept := countHTTPBody(1, "count-workflow-accept-001", "1", "", "confirmed")
	expectTransferError(t, f.request(t, 1, "POST", path+"/accept", accept), 403, "forbidden")
	expectTransferError(t, f.request(t, 3, "POST", path+"/accept", accept), 404, "not_found")
	proof := countHTTPProof(t, f, 2, 1, -1)
	accepted := receiptHTTPMutation(f, f.newRequest(2, "POST", path+"/accept", accept))
	proof(accepted)
	if countHTTPOperation(t, accepted).Actual != nil {
		t.Fatal("decision actual not null")
	}
	applied := countHTTPSnapshot(t, f, received.ID).Lines[0]
	if applied.OriginalActual != "1" || applied.OriginalCredit != "1" || applied.EffectiveActual != "0" || applied.EffectiveCredit != "0" || applied.AppliedRevision != "1" || applied.Proposals[0].Application.Delta != "-1" {
		t.Fatal("latest effective delta/original separation")
	}

	// Replacement creates fresh consent; every old operation response remains
	// byte-identical even after supersession, rejection, and newer applications.
	secondBody := countHTTPBody(1, "count-workflow-propose-002", "1", "9007199254740993", "second")
	second := f.request(t, 2, "POST", path+"/propose", secondBody)
	countHTTPOperation(t, second)
	expectTransferError(t, f.request(t, 1, "POST", path+"/propose", countHTTPBody(1, "count-workflow-foreign-001", "2", "1", "replace")), 403, "forbidden")
	thirdBody := countHTTPBody(1, "count-workflow-propose-003", "2", "9223372036854775807", "third")
	third := f.request(t, 2, "POST", path+"/propose", thirdBody)
	countHTTPOperation(t, third)
	reject := countHTTPBody(1, "count-workflow-reject-003", "3", "", "rejected")
	rejected := f.request(t, 1, "POST", path+"/reject", reject)
	countHTTPOperation(t, rejected)
	expectTransferError(t, f.request(t, 1, "POST", path+"/accept", countHTTPBody(1, "count-workflow-stale-001", "2", "", "stale")), 409, "decision_conflict")
	fourthBody := countHTTPBody(1, "count-workflow-propose-004", "3", "9223372036854775807", "fourth")
	fourth := f.request(t, 1, "POST", path+"/propose", fourthBody)
	countHTTPOperation(t, fourth)
	finalAccept := countHTTPBody(1, "count-workflow-accept-004", "4", "", "agreed")
	proof = countHTTPProof(t, f, 2, 1, 1)
	final := receiptHTTPMutation(f, f.newRequest(2, "POST", path+"/accept", finalAccept))
	proof(final)
	state := countHTTPSnapshot(t, f, received.ID)
	line := state.Lines[0]
	if line.WorkflowRevision != "4" || line.AppliedRevision != "4" || line.EffectiveActual != "9223372036854775807" || line.EffectiveCredit != "1" || line.Proposals[3].BaseCredit != "0" || line.Proposals[3].Application.Delta != "1" {
		t.Fatal("latest capped credit delta")
	}
	for i, want := range []string{"applied", "superseded", "rejected", "applied"} {
		if line.Proposals[i].State != want {
			t.Fatal("history state", i)
		}
	}
	for _, replay := range []struct {
		actor        int
		action, body string
		prior        *httptest.ResponseRecorder
	}{
		{1, "propose", proposal, first}, {2, "accept", accept, accepted}, {2, "propose", secondBody, second}, {2, "propose", thirdBody, third}, {1, "reject", reject, rejected}, {1, "propose", fourthBody, fourth}, {2, "accept", finalAccept, final},
	} {
		w := f.request(t, replay.actor, "POST", path+"/"+replay.action, replay.body)
		if w.Code != 200 || w.Body.String() != replay.prior.Body.String() {
			t.Fatal("historical replay substituted current state")
		}
	}
	expectTransferError(t, f.request(t, 1, "POST", path+"/propose", strings.Replace(proposal, "corrected count", "changed count", 1)), 409, "retry_conflict")
	expectTransferError(t, f.request(t, 2, "POST", path+"/propose", proposal), 409, "retry_conflict")
	expectTransferError(t, f.request(t, 3, "POST", path+"/propose", proposal), 404, "not_found")
	expectTransferError(t, f.request(t, 3, "GET", path, ""), 404, "not_found")
	if !reflect.DeepEqual(countHTTPSnapshot(t, f, received.ID), state) || countHTTPOriginal(t, f) != original {
		t.Fatal("replay/failure changed evidence")
	}
}

func TestC3CountStockConflictHTTP(t *testing.T) {
	f := transferFixture(t)
	received := countHTTPReceived(t, f)
	path := "/api/transfers/" + received.ID + "/count-corrections"
	// Reserve all destination stock through real creation and approval, not
	// direct balance edits. A downward correction must preserve reserved coverage.
	var available int64
	if f.p.QueryRow(f.ctx, `SELECT available FROM inventory_balances WHERE location_id=2 AND variant_id=1`).Scan(&available) != nil || available < 1 {
		t.Fatal("reservation stock")
	}
	body := fmt.Sprintf(`{"kind":"send_to_warehouse","counterparty_location_id":1,"retry_key":"count-stock-reserve-001","items":[{"variant_id":1,"quantity":%q},{"variant_id":2,"quantity":"1"}]}`, countInt(available))
	hold := transferWireRecord(t, f.request(t, 2, "POST", "/api/transfers", body), 201)
	transferObject(t, decisionServe(t, f, f.newRequest(1, "POST", "/api/transfers/"+hold.ID+"/approve", "{}"), hold), 200)
	countHTTPOperation(t, f.request(t, 2, "POST", path+"/propose", countHTTPBody(1, "count-stock-propose-001", "0", "0", "recount")))
	before := countHTTPSnapshot(t, f, received.ID)
	revisions := decisionRevisions(t, f)
	expectTransferError(t, f.request(t, 1, "POST", path+"/accept", countHTTPBody(1, "count-stock-accept-001", "1", "", "agree")), 409, "insufficient_stock")
	if !reflect.DeepEqual(before, countHTTPSnapshot(t, f, received.ID)) || decisionRevisions(t, f) != revisions {
		t.Fatal("stock failure published evidence/hints")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := f.newRequest(2, "POST", path+"/propose", countHTTPBody(1, "count-unavailable-001", "1", "1", "retry later")).WithContext(ctx)
	expectTransferError(t, f.serve(t, r), 503, "service_unavailable")
}

func TestC3CountUnexpectedAuditHTTP(t *testing.T) {
	f := transferFixture(t)
	received := countHTTPReceived(t, f)
	path := "/api/transfers/" + received.ID + "/count-corrections"
	proposal := countHTTPBody(3, "count-unexpected-propose-001", "0", "9007199254740993", "audit recount")
	countHTTPOperation(t, f.request(t, 2, "POST", path+"/propose", proposal))
	accept := countHTTPBody(3, "count-unexpected-accept-001", "1", "", "audit agreed")
	proof := countHTTPProof(t, f, 2, 3, 0)
	w := receiptHTTPMutation(f, f.newRequest(1, "POST", path+"/accept", accept))
	proof(w)
	line := countHTTPSnapshot(t, f, received.ID).Lines[2]
	if line.ExpectedQuantity != "0" || line.OriginalActual != "7" || line.OriginalCredit != "0" || line.EffectiveActual != "9007199254740993" || line.EffectiveCredit != "0" || line.Proposals[0].Application.Delta != "0" {
		t.Fatal("unexpected count incorporated stock")
	}
	expectTransferError(t, f.request(t, 2, "POST", path+"/propose", countHTTPBody(4, "count-nonmember-propose-001", "0", "1", "nonmember")), 400, "invalid_request")
}
