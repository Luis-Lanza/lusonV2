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
	"time"

	"luson/api/internal/auth"
	"luson/api/internal/transfers"
)

func TestC01PendingCancellationHTTP(t *testing.T) {
	for _, flow := range []struct {
		name, kind   string
		counterparty int
	}{
		{"warehouse_request", "request_stock", 1},
		{"branch_request", "request_stock", 3},
		{"warehouse_proposal", "send_to_warehouse", 1},
	} {
		t.Run(flow.name, func(t *testing.T) {
			f := transferFixture(t)
			body := fmt.Sprintf(`{"kind":%q,"counterparty_location_id":%d,"retry_key":"cancellation-pending-key-01","items":[{"variant_id":1,"quantity":"1"},{"variant_id":2,"quantity":"1"}]}`, flow.kind, flow.counterparty)
			original := transferObject(t, f.request(t, 2, "POST", "/api/transfers", body), 201)
			var id string
			if json.Unmarshal(original["id"], &id) != nil || id == "" || string(original["status"]) != `"pending"` {
				t.Fatal("Pending cancellation setup failed")
			}
			path := "/api/transfers/" + id
			items, unrelated := decisionRows(t, f, id)

			// Use the existing authenticated route and generic JSON helper, not
			// a future cancellation export or the Pending-only DTO whitelist.
			w := f.request(t, 2, "POST", path+"/cancel", " \n{}\t")
			cancelled := transferObject(t, w, 200)
			if len(cancelled) != 16 || string(cancelled["status"]) != `"cancelled"` || len(w.Result().Cookies()) != 0 {
				t.Fatal("creator cancellation did not return Cancelled without cookies")
			}
			cancellationMetadata(t, f, id, cancelled, 2)
			for key, value := range original {
				if key != "status" && !reflect.DeepEqual(cancelled[key], value) {
					t.Fatalf("cancellation changed original field %s", key)
				}
			}
			// Cancellation must not manufacture approval or later lifecycle
			// history. Future cancellation metadata is verified in the full unit.
			for _, key := range []string{"decision_location_id", "decided_at", "dispatch_location_id", "dispatched_at", "receipt_location_id", "received_at", "receipt"} {
				if value, present := cancelled[key]; present && string(value) != "null" {
					t.Fatalf("Pending cancellation fabricated %s", key)
				}
			}
			var persisted bool
			if f.p.QueryRow(f.ctx, `SELECT status='cancelled'
 AND decision_location_id IS NULL AND decided_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM transfer_request_allocations WHERE request_id=$1)
 FROM transfer_requests WHERE id=$1`, id).Scan(&persisted) != nil || !persisted {
				t.Fatal("HTTP cancellation was not persisted without approval or ownership")
			}
			gotItems, gotUnrelated := decisionRows(t, f, id)
			if items != gotItems || unrelated != gotUnrelated {
				t.Fatal("Pending cancellation changed items or unrelated allocation history")
			}
			f.unchanged(t)
			settled := fenceSnapshot(t, f)
			for _, call := range []struct{ path, body string }{{path + "/cancel", "{}"}, {"/api/transfers", body}} {
				w := f.request(t, 2, "POST", call.path, call.body)
				if !reflect.DeepEqual(transferObject(t, w, 200), cancelled) || fenceSnapshot(t, f) != settled || (call.path == "/api/transfers" && w.Header().Get("Location") != path) {
					t.Fatal("duplicate/original creation replay lost current Cancelled truth")
				}
			}
			for _, participant := range []int{2, flow.counterparty} {
				got := transferObject(t, f.request(t, participant, "GET", path, ""), 200)
				if !reflect.DeepEqual(got, cancelled) || fenceSnapshot(t, f) != settled {
					t.Fatal("participant recovery lost persisted cancellation or changed state")
				}
			}
		})
	}
}

func cancellationMetadata(t *testing.T, f *transferHTTPFixture, id string, value map[string]json.RawMessage, creator int) {
	t.Helper()
	var location int
	var stamp string
	if json.Unmarshal(value["cancellation_location_id"], &location) != nil || location != creator ||
		json.Unmarshal(value["cancelled_at"], &stamp) != nil {
		t.Fatal("cancellation actor/time missing or not server-derived creator")
	}
	parsed, err := time.Parse(time.RFC3339Nano, stamp)
	if err != nil || !strings.HasSuffix(stamp, "Z") || parsed.UTC().Format(time.RFC3339Nano) != stamp {
		t.Fatal("cancellation timestamp is not canonical UTC")
	}
	var persistedLocation int
	var persistedTime time.Time
	if f.p.QueryRow(f.ctx, "SELECT cancellation_location_id,cancelled_at FROM transfer_requests WHERE id=$1", id).Scan(&persistedLocation, &persistedTime) != nil || persistedLocation != location || persistedTime.UTC().Format(time.RFC3339Nano) != stamp {
		t.Fatal("wire cancellation differs from persisted server history")
	}
}

// Accept a changed baseline only after proving every balance and retained
// allocation. Never bypass the fixture's historical invariance checks.
func cancellationProof(t *testing.T, f *transferHTTPFixture, original transferDTO) func(*httptest.ResponseRecorder) {
	t.Helper()
	items, unrelated := decisionRows(t, f, original.ID)
	var expected string
	if f.p.QueryRow(f.ctx, `SELECT jsonb_agg(to_jsonb(b)||jsonb_build_object(
 'reserved',b.reserved-coalesce(i.quantity,0),'available',b.available+coalesce(i.quantity,0))
 ORDER BY b.location_id,b.variant_id)::text FROM inventory_balances b
 LEFT JOIN transfer_request_items i ON i.request_id=$1 AND i.variant_id=b.variant_id AND b.location_id=$2`, original.ID, original.OriginLocationID).Scan(&expected) != nil {
		t.Fatal("expected complete release transformation unavailable")
	}
	return func(w *httptest.ResponseRecorder) {
		got := transferObject(t, w, 200)
		if len(got) != 18 || string(got["status"]) != `"cancelled"` || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Content-Type-Options") != "nosniff" || w.Header().Get("Access-Control-Allow-Origin") != "" || len(w.Result().Cookies()) != 0 {
			t.Fatal("Approved cancellation response contract changed")
		}
		cancellationMetadata(t, f, original.ID, got, original.CreatorLocationID)
		var result transferDTO
		if json.Unmarshal(w.Body.Bytes(), &result) != nil {
			t.Fatal("Cancelled DTO unavailable")
		}
		result.Status, result.CancellationLocationID, result.CancelledAt = original.Status, nil, nil
		if !reflect.DeepEqual(result, original) {
			t.Fatal("Approved cancellation changed original payload/approval history")
		}
		var exact bool
		if f.p.QueryRow(f.ctx, `SELECT count(*)=2 AND bool_and(a.released_at=r.cancelled_at AND a.consumed_at IS NULL)
 FROM transfer_request_allocations a JOIN transfer_requests r ON r.id=a.request_id WHERE r.id=$1`, original.ID).Scan(&exact) != nil || !exact {
			t.Fatal("Cancelled approval did not retain exact released ownership")
		}
		gotItems, gotUnrelated := decisionRows(t, f, original.ID)
		if items != gotItems || unrelated != gotUnrelated || f.stock(t) != expected {
			t.Fatal("release changed physical inventory, items or other allocations")
		}
		f.baseline = expected
	}
}

func TestC01ApprovedCancellationHTTP(t *testing.T) {
	for _, flow := range []struct {
		name, kind   string
		counterparty int
	}{
		{"warehouse_request", "request_stock", 1},
		{"branch_request", "request_stock", 3},
		{"warehouse_proposal", "send_to_warehouse", 1},
	} {
		t.Run(flow.name, func(t *testing.T) {
			f := transferFixture(t)
			original := decisionCreate(t, f, flow.kind, flow.counterparty, "cancel-approved-http-key-01")
			path := "/api/transfers/" + original.ID
			w := decisionServe(t, f, f.newRequest(original.ApproverLocationID, "POST", path+"/approve", "{}"), original)
			var approved transferDTO
			if json.Unmarshal(w.Body.Bytes(), &approved) != nil {
				t.Fatal("approval setup failed")
			}
			expectTransferError(t, f.request(t, flow.counterparty, "POST", path+"/cancel", "{}"), 403, "forbidden")
			proof := cancellationProof(t, f, approved)
			w = httptest.NewRecorder()
			f.handler.ServeHTTP(w, f.newRequest(2, "POST", path+"/cancel", "{}"))
			proof(w)
			want := transferObject(t, w, 200)
			before := fenceSnapshot(t, f)
			replay := fmt.Sprintf(`{"kind":%q,"counterparty_location_id":%d,"retry_key":"cancel-approved-http-key-01","items":[{"variant_id":1,"quantity":"1"},{"variant_id":2,"quantity":"1"}]}`, flow.kind, flow.counterparty)
			if !reflect.DeepEqual(transferObject(t, f.request(t, 2, "POST", "/api/transfers", replay), 200), want) {
				t.Fatal("creation replay lost cancelled approval history")
			}
			for _, call := range []struct{ method, suffix, body string }{{"POST", "/cancel", "{}"}, {"GET", "", ""}} {
				if !reflect.DeepEqual(transferObject(t, f.request(t, 2, call.method, path+call.suffix, call.body), 200), want) {
					t.Fatal("retry/recovery changed cancellation")
				}
			}
			expectTransferError(t, f.request(t, original.ApproverLocationID, "POST", path+"/approve", "{}"), 409, "decision_conflict")
			expectTransferError(t, f.request(t, original.ApproverLocationID, "POST", path+"/reject", "{}"), 409, "decision_conflict")
			expectTransferError(t, f.request(t, original.OriginLocationID, "POST", path+"/dispatch", "{}"), 409, "decision_conflict")
			if fenceSnapshot(t, f) != before {
				t.Fatal("retry/conflict changed lifecycle or stock")
			}
		})
	}
}

func TestC01CancellationHTTPFraming(t *testing.T) {
	f := transferFixture(t)
	original := decisionCreate(t, f, "request_stock", 1, "cancel-framing-http-key-01")
	path := "/api/transfers/" + original.ID + "/cancel"
	before := fenceSnapshot(t, f)
	check := func(r *http.Request, status int, code string) {
		t.Helper()
		expectTransferError(t, f.serve(t, r), status, code)
		if fenceSnapshot(t, f) != before {
			t.Fatal("framing/identity refusal mutated state")
		}
	}
	for _, verb := range []string{"GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"} {
		w := f.request(t, 0, verb, path, "bad")
		expectTransferError(t, w, 405, "method_not_allowed")
		if w.Header().Get("Allow") != "POST" {
			t.Fatal("cancel method admission changed")
		}
	}
	for _, id := range []string{"0", "01", "+1", "-1", "1e0", "9223372036854775808", "unknown", "%31"} {
		check(f.newRequest(2, "POST", "/api/transfers/"+id+"/cancel", "{}"), 400, "invalid_request")
		if id != "%31" {
			check(f.newRequest(0, "POST", "/api/transfers/"+id+"/cancel", "bad"), 401, "unauthenticated")
		}
	}
	for _, query := range []string{"?", "?location_id=2"} {
		check(f.newRequest(2, "POST", path+query, "{}"), 400, "invalid_request")
	}
	for _, body := range []string{"", "null", "[]", "{", "{}{}", "{} true", "{}\xff", `{"reason":"no"}`, `{"cancellation_location_id":2}`, `{"cancelled_at":"2020-01-01T00:00:00Z"}`, `{"x":1,"x":1}`, `{"\u0078":1}`, "{}" + strings.Repeat(" ", (64<<10)-1)} {
		check(f.newRequest(2, "POST", path, body), 400, "invalid_request")
	}
	for _, headers := range [][]string{nil, {"text/json"}, {"application/json", "application/json"}, {"application/json; charset=latin1"}, {"application/json; x=y"}, {"application/json;"}} {
		r := f.newRequest(2, "POST", path, "{}")
		r.Header.Del("Content-Type")
		for _, value := range headers {
			r.Header.Add("Content-Type", value)
		}
		check(r, 400, "invalid_request")
	}
	r := f.newRequest(2, "POST", path, "{}")
	r.Body = io.NopCloser(transferErrorReader{})
	check(r, 400, "invalid_request")
	for _, header := range []string{"Origin", "X-CSRF-Token", "Sec-Fetch-Site"} {
		for _, duplicate := range []bool{false, true} {
			r := f.newRequest(2, "POST", path, "{}")
			if duplicate {
				r.Header.Add(header, r.Header.Get(header))
			} else {
				r.Header.Set(header, "wrong")
			}
			check(r, 403, "forbidden")
		}
	}
	r = f.newRequest(2, "POST", path, "{}")
	r.AddCookie(&http.Cookie{Name: sessionCookie, Value: f.tokens[1]})
	check(r, 400, "invalid_request")
	boundary := f.newRequest(1, "POST", path, "{}"+strings.Repeat(" ", (64<<10)-2))
	boundary.Header.Set("Content-Type", "application/json; charset=UTF-8")
	boundary.Header.Del("Sec-Fetch-Site")
	check(boundary, 403, "forbidden")
	for _, mode := range []string{"revoked", "expired"} {
		t.Run(mode, func(t *testing.T) {
			g := transferFixture(t)
			if mode == "revoked" {
				if g.svc.Logout(g.ctx, g.tokens[1]) != nil {
					t.Fatal("revocation setup failed")
				}
			} else {
				g.clock.Add(int64(auth.AbsoluteTTL + time.Second))
			}
			expectTransferError(t, g.request(t, 2, "POST", "/api/transfers/invalid/cancel?", "bad"), 401, "unauthenticated")
		})
	}
}

func TestC01CancellationDTOGuards(t *testing.T) {
	now := time.Now().UTC()
	creator, approver := 2, 1
	r := transfers.Request{Status: "cancelled", CreatedAt: now, Creator: transfers.Location{ID: creator}, Approver: transfers.Location{ID: approver}, CancellationLocationID: &creator, CancelledAt: &now}
	for _, mutate := range []func(*transfers.Request){
		func(r *transfers.Request) { r.CancellationLocationID = nil },
		func(r *transfers.Request) { r.CancellationLocationID = &approver },
		func(r *transfers.Request) { r.CancelledAt = nil },
		func(r *transfers.Request) { past := now.Add(-time.Second); r.CancelledAt = &past },
		func(r *transfers.Request) { r.DecisionLocationID = &approver },
		func(r *transfers.Request) { r.DecidedAt = &now },
		func(r *transfers.Request) { r.Status = "pending" },
	} {
		bad := r
		mutate(&bad)
		if _, err := transferRecord(bad); err != transfers.ErrUnavailable {
			t.Fatal("partial/forged cancellation DTO admitted")
		}
	}
	if _, err := transferRecord(r); err != nil {
		t.Fatal("complete Pending cancellation DTO refused")
	}
	r.DecisionLocationID, r.DecidedAt = &approver, &now
	if _, err := transferRecord(r); err != nil {
		t.Fatal("original Approved cancellation history refused")
	}
}

func TestC01CancellationHTTPGuards(t *testing.T) {
	f := transferFixture(t)
	original := decisionCreate(t, f, "request_stock", 1, "cancellation-guards-key-01")
	path := "/api/transfers/" + original.ID
	before := fenceSnapshot(t, f)
	for _, guard := range []struct {
		name   string
		actor  int
		status int
		code   string
	}{
		{"unauthenticated", 0, 401, "unauthenticated"},
		{"visible_noncreator", 1, 403, "forbidden"},
		{"nonparticipant", 3, 404, "not_found"},
	} {
		t.Run(guard.name, func(t *testing.T) {
			expectTransferError(t, f.request(t, guard.actor, "POST", path+"/cancel", "{}"), guard.status, guard.code)
			if fenceSnapshot(t, f) != before {
				t.Fatal("cancellation refusal changed request, items, allocations or inventory")
			}
		})
	}
	// Preserve participant read privacy independently of mutation admission.
	expectTransferError(t, f.request(t, 3, "GET", path, ""), 404, "not_found")
	if !reflect.DeepEqual(transferWireRecord(t, f.request(t, 2, "GET", path, ""), 200), original) || fenceSnapshot(t, f) != before {
		t.Fatal("guard refusals changed the creator's original Pending request")
	}
}
