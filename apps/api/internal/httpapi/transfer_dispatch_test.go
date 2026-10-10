package httpapi

import (
	"encoding/json"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"luson/api/internal/transfers"
)

// dispatchProof accepts a new fixture baseline only after proving all 570
// balances, unchanged items/other allocations and the exact consumed ownership.
func dispatchProof(t *testing.T, f *transferHTTPFixture, approved transferDTO) func(*httptest.ResponseRecorder) {
	t.Helper()
	items, unrelated := decisionRows(t, f, approved.ID)
	var expected string
	if f.p.QueryRow(f.ctx, `SELECT jsonb_agg(to_jsonb(b)||jsonb_build_object(
 'existing',b.existing-coalesce(i.quantity,0),
 'reserved',b.reserved-coalesce(i.quantity,0)) ORDER BY b.location_id,b.variant_id)::text
 FROM inventory_balances b LEFT JOIN transfer_request_items i
 ON i.request_id=$1 AND i.variant_id=b.variant_id AND b.location_id=$2`, approved.ID, approved.OriginLocationID).Scan(&expected) != nil {
		t.Fatal("dispatch balance expectation failed")
	}
	return func(w *httptest.ResponseRecorder) {
		got := transferObject(t, w, 200)
		if len(got) != 18 || string(got["status"]) != `"in_transit"` {
			t.Fatal("incomplete dispatch DTO")
		}
		var consumed bool
		if f.p.QueryRow(f.ctx, `SELECT count(*)=2 AND bool_and(a.consumed_at=r.dispatched_at)
 FROM transfer_request_allocations a JOIN transfer_requests r ON r.id=a.request_id WHERE r.id=$1`, approved.ID).Scan(&consumed) != nil || !consumed {
			t.Fatal("dispatch ownership history missing")
		}
		gotItems, gotUnrelated := decisionRows(t, f, approved.ID)
		if items != gotItems || unrelated != gotUnrelated || f.stock(t) != expected {
			t.Fatal("dispatch changed other holds, items, availability or destination")
		}
		f.baseline = expected
	}
}

func TestD01DispatchHTTP(t *testing.T) {
	f := transferFixture(t)
	original := decisionCreate(t, f, "send_to_warehouse", 1, "dispatch-http-key-00001")
	path := "/api/transfers/" + original.ID
	approved := decisionServe(t, f, f.newRequest(1, "POST", path+"/approve", "{}"), original)
	var outcome transferDTO
	if err := json.Unmarshal(approved.Body.Bytes(), &outcome); err != nil {
		t.Fatal(err)
	}
	before := fenceSnapshot(t, f)
	for _, tc := range []struct {
		actor                int
		method, suffix, body string
		status               int
		code                 string
	}{
		{0, "POST", "/dispatch", "{}", 401, "unauthenticated"},
		{1, "POST", "/dispatch", "{}", 403, "forbidden"},
		{3, "POST", "/dispatch", "{}", 404, "not_found"},
		{2, "GET", "/dispatch", "", 405, "method_not_allowed"},
		{2, "POST", "/dispatch?", "{}", 400, "invalid_request"},
		{2, "POST", "/dispatch", `{"actor":2}`, 400, "invalid_request"},
		{2, "POST", "/dispatch", "null", 400, "invalid_request"},
		{2, "POST", "/dispatch", "{}{}", 400, "invalid_request"},
	} {
		expectTransferError(t, f.request(t, tc.actor, tc.method, path+tc.suffix, tc.body), tc.status, tc.code)
	}
	for _, header := range []string{"Origin", "X-CSRF-Token", "Sec-Fetch-Site"} {
		r := f.newRequest(2, "POST", path+"/dispatch", "{}")
		r.Header.Set(header, "wrong")
		expectTransferError(t, f.serve(t, r), 403, "forbidden")
	}
	if fenceSnapshot(t, f) != before {
		t.Fatal("admission failures mutated state")
	}
	proof := dispatchProof(t, f, outcome)
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, f.newRequest(2, "POST", path+"/dispatch", "{}"))
	proof(w)
	want := transferObject(t, w, 200)
	settled := fenceSnapshot(t, f)
	for _, call := range []struct {
		actor          int
		method, suffix string
	}{
		{2, "POST", "/dispatch"}, {1, "POST", "/approve"},
		{1, "GET", ""}, {2, "GET", ""},
	} {
		body := ""
		if call.method == "POST" {
			body = "{}"
		}
		got := f.request(t, call.actor, call.method, path+call.suffix, body)
		if !reflect.DeepEqual(transferObject(t, got, 200), want) {
			t.Fatal("retry/recovery changed DTO")
		}
	}
	expectTransferError(t, f.request(t, 1, "POST", path+"/reject", "{}"), 409, "decision_conflict")
	if fenceSnapshot(t, f) != settled {
		t.Fatal("retry changed persisted outcome")
	}
}

func TestD01DispatchContract(t *testing.T) {
	q, err := transferQuery("status=in_transit")
	if err != nil || q.Status != "in_transit" {
		t.Fatal("in-transit participant filter refused", err)
	}
	now := time.Now().UTC()
	origin, approver := 2, 1
	r := transfers.Request{Status: "in_transit", CreatedAt: now.Add(-time.Hour), Origin: transfers.Location{ID: origin}, Approver: transfers.Location{ID: approver}, DecisionLocationID: &approver, DecidedAt: &now}
	if _, err := transferRecord(r); err == nil {
		t.Fatal("incomplete transit record admitted")
	}
	r.DispatchLocationID, r.DispatchedAt = &origin, &now
	dto, err := transferRecord(r)
	if err != nil || dto.Status != "in_transit" || dto.DispatchLocationID == nil || *dto.DispatchLocationID != origin || dto.DispatchedAt == nil || *dto.DispatchedAt != now.Format(time.RFC3339Nano) {
		t.Fatal("complete persisted dispatch refused", err)
	}
	for _, mutate := range []func(*transfers.Request){
		func(r *transfers.Request) { r.DispatchLocationID = &approver },
		func(r *transfers.Request) { earlier := now.Add(-time.Second); r.DispatchedAt = &earlier },
		func(r *transfers.Request) { r.DecidedAt = nil },
		func(r *transfers.Request) { r.Status = "approved" },
		func(r *transfers.Request) { r.Status = "received" },
	} {
		bad := r
		mutate(&bad)
		if _, err := transferRecord(bad); err == nil {
			t.Fatal("inconsistent lifecycle metadata admitted")
		}
	}
}
