package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"luson/api/internal/transfers"
)

func TestW01DirectShipmentHTTP(t *testing.T) {
	for _, destination := range []int{2, 3} {
		t.Run(fmt.Sprintf("destination_%d", destination), func(t *testing.T) {
			f := transferFixture(t)
			var expected string
			if f.p.QueryRow(f.ctx, `SELECT jsonb_agg(to_jsonb(b)||jsonb_build_object(
 'reserved',b.reserved+coalesce(i.quantity,0),
 'available',b.available-coalesce(i.quantity,0)) ORDER BY b.location_id,b.variant_id)::text
 FROM inventory_balances b LEFT JOIN (VALUES(1,2::bigint),(2,1::bigint)) i(variant_id,quantity)
 ON i.variant_id=b.variant_id AND b.location_id=1`).Scan(&expected) != nil {
				t.Fatal("expected complete warehouse reservation unavailable")
			}
			body := fmt.Sprintf(`{"kind":"direct_shipment","counterparty_location_id":%d,"retry_key":"w01-direct-http-%d","items":[{"variant_id":2,"quantity":"1"},{"variant_id":1,"quantity":"2"}]}`, destination, destination)
			// The historical request helper requires unchanged stock; direct creation
			// instead proves the full reservation before accepting a new baseline.
			w := httptest.NewRecorder()
			f.handler.ServeHTTP(w, f.newRequest(1, "POST", "/api/transfers", body))
			transferObject(t, w, 201) // Intended RED: existing POST must succeed.
			var dto transferDTO
			if json.Unmarshal(w.Body.Bytes(), &dto) != nil || dto.ID == "" || dto.Kind != transfers.Kind("direct_shipment") || dto.Status != "approved" || dto.CreatorLocationID != 1 || dto.OriginLocationID != 1 || dto.DestinationLocationID != destination || dto.ApproverLocationID != 1 || len(dto.Items) != 2 {
				t.Fatal("authenticated warehouse direction or approved cart changed")
			}
			if dto.Items[0].VariantID != 1 || dto.Items[0].Quantity != "2" || dto.Items[1].VariantID != 2 || dto.Items[1].Quantity != "1" || dto.DecisionLocationID == nil || *dto.DecisionLocationID != 1 || dto.DecidedAt == nil || *dto.DecidedAt != dto.CreatedAt {
				t.Fatal("complete canonical cart or initial decision missing")
			}
			stamp, err := time.Parse(time.RFC3339Nano, dto.CreatedAt)
			if err != nil || stamp.IsZero() || !strings.HasSuffix(dto.CreatedAt, "Z") {
				t.Fatal("initial timestamp is not UTC")
			}
			var persisted bool
			if f.p.QueryRow(f.ctx, `SELECT kind='direct_shipment' AND status='approved'
 AND creator_location_id=1 AND origin_location_id=1 AND destination_location_id=$2
 AND approver_location_id=1 AND decision_location_id=1 AND decided_at=created_at
 AND created_at=$3 AND dispatched_at IS NULL AND received_at IS NULL AND cancelled_at IS NULL
 FROM transfer_requests WHERE id=$1`, dto.ID, destination, stamp).Scan(&persisted) != nil || !persisted {
				t.Fatal("approved initial metadata was not server persisted")
			}
			var exact bool
			if f.p.QueryRow(f.ctx, `SELECT
 (SELECT count(*) FROM transfer_request_items WHERE request_id=$1)=2
 AND (SELECT count(*) FROM transfer_request_allocations)=2
 AND NOT EXISTS(SELECT 1 FROM transfer_request_items i
 LEFT JOIN transfer_request_allocations a USING(request_id,variant_id)
 WHERE i.request_id=$1 AND (a.request_id IS NULL OR a.quantity<>i.quantity OR a.consumed_at IS NOT NULL OR a.released_at IS NOT NULL))
 AND NOT EXISTS(SELECT 1 FROM transfer_request_allocations a
 LEFT JOIN transfer_request_items i USING(request_id,variant_id)
 WHERE a.request_id<>$1 OR i.request_id IS NULL)`, dto.ID).Scan(&exact) != nil || !exact || f.stock(t) != expected {
				t.Fatal("creation changed unexpected stock or omitted owned allocations")
			}
			if w.Header().Get("Location") != "/api/transfers/"+dto.ID || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Content-Type-Options") != "nosniff" || w.Header().Get("Access-Control-Allow-Origin") != "" || len(w.Result().Cookies()) != 0 {
				t.Fatal("creation security headers or resource location changed")
			}
			f.baseline = expected // Only after all persisted reservation proofs pass.
			before := fenceSnapshot(t, f)
			replay := f.request(t, 1, "POST", "/api/transfers", body)
			transferObject(t, replay, 200)
			if replay.Body.String() != w.Body.String() {
				t.Fatal("direct creation replay changed immutable response")
			}
			for _, participant := range []int{1, destination} {
				got := f.request(t, participant, "GET", "/api/transfers/"+dto.ID, "")
				transferObject(t, got, 200)
				var recovered transferDTO
				if json.Unmarshal(got.Body.Bytes(), &recovered) != nil || !reflect.DeepEqual(recovered, dto) {
					t.Fatal("participant recovery changed direct record")
				}
			}
			expectTransferError(t, f.request(t, 5-destination, "GET", "/api/transfers/"+dto.ID, ""), 404, "not_found")
			if fenceSnapshot(t, f) != before {
				t.Fatal("replay, reads or privacy refusal changed persisted state")
			}
		})
	}
}

func TestW01DirectShipmentHTTPLifecycle(t *testing.T) {
	for _, terminal := range []string{"cancelled", "received"} {
		t.Run(terminal, func(t *testing.T) {
			f := transferFixture(t)
			body := w01HTTPBody(2)
			proof := w01HTTPProof(t, f, 2)
			w := receiptHTTPMutation(f, f.newRequest(1, "POST", "/api/transfers", body))
			initial := proof(w)
			current := initial
			path := "/api/transfers/" + initial.ID
			for _, action := range []string{"approve", "reject"} {
				expectTransferError(t, f.request(t, 1, "POST", path+"/"+action, "{}"), 409, "decision_conflict")
				expectTransferError(t, f.request(t, 2, "POST", path+"/"+action, "{}"), 403, "forbidden")
				expectTransferError(t, f.request(t, 3, "POST", path+"/"+action, "{}"), 404, "not_found")
			}
			if terminal == "cancelled" {
				expectTransferError(t, f.request(t, 2, "POST", path+"/cancel", "{}"), 403, "forbidden")
				check := cancellationProof(t, f, current)
				w = receiptHTTPMutation(f, f.newRequest(1, "POST", path+"/cancel", "{}"))
				check(w)
			} else {
				expectTransferError(t, f.request(t, 2, "POST", path+"/dispatch", "{}"), 403, "forbidden")
				check := dispatchProof(t, f, current)
				w = receiptHTTPMutation(f, f.newRequest(1, "POST", path+"/dispatch", "{}"))
				check(w)
				if json.Unmarshal(w.Body.Bytes(), &current) != nil {
					t.Fatal("direct transit decode failed")
				}
				replay := f.request(t, 1, "POST", "/api/transfers", body)
				if !reflect.DeepEqual(transferObject(t, replay, 200), transferObject(t, w, 200)) {
					t.Fatal("HTTP creation replay lost current transit truth")
				}
				expectTransferError(t, f.request(t, 1, "POST", path+"/cancel", "{}"), 409, "decision_conflict")
				check = receiptHTTPProof(t, f, current, 2, 1)
				w = receiptHTTPMutation(f, f.newRequest(2, "POST", path+"/receive", `{"items":[{"variant_id":1,"actual_quantity":"2"},{"variant_id":2,"actual_quantity":"1"}]}`))
				check(w)
			}
			want := transferObject(t, w, 200)
			if json.Unmarshal(w.Body.Bytes(), &current) != nil || current.Status != terminal || current.Kind != initial.Kind || current.DecidedAt == nil || *current.DecidedAt != initial.CreatedAt || current.CreatorLocationID != 1 {
				t.Fatal("terminal direct history lost initial authorization")
			}
			before, revisions := receiptHTTPState(t, f), decisionRevisions(t, f)
			for _, id := range []int{1, 2} {
				if !reflect.DeepEqual(transferObject(t, f.request(t, id, "GET", path, ""), 200), want) {
					t.Fatal("terminal HTTP detail lost direct history")
				}
				page := transferObject(t, f.request(t, id, "GET", "/api/transfers?status="+terminal, ""), 200)
				var rows []map[string]json.RawMessage
				if json.Unmarshal(page["records"], &rows) != nil || len(rows) != 1 || !reflect.DeepEqual(rows[0], want) {
					t.Fatal("terminal HTTP list lost direct history")
				}
				counts := transferObject(t, f.request(t, id, "GET", "/api/transfers/counts", ""), 200)
				if string(counts["pending_total"]) != `"0"` || string(counts["action_count"]) != `"0"` {
					t.Fatal("terminal direct HTTP count retained an action")
				}
			}
			reordered := strings.Replace(body, `{"variant_id":2,"quantity":"1"},{"variant_id":1,"quantity":"2"}`, `{"variant_id":1,"quantity":"2"},{"variant_id":2,"quantity":"1"}`, 1)
			if !reflect.DeepEqual(transferObject(t, f.request(t, 1, "POST", "/api/transfers", reordered), 200), want) {
				t.Fatal("terminal HTTP replay fabricated original approved state")
			}
			changed := strings.Replace(body, `"quantity":"2"`, `"quantity":"3"`, 1)
			expectTransferError(t, f.request(t, 1, "POST", "/api/transfers", changed), 409, "retry_conflict")
			expectTransferError(t, f.request(t, 3, "GET", path, ""), 404, "not_found")
			if receiptHTTPState(t, f) != before || decisionRevisions(t, f) != revisions {
				t.Fatal("terminal HTTP replay/read/refusal changed persisted state")
			}
		})
	}
}

func TestW01DirectShipmentHTTPGuards(t *testing.T) {
	f := transferFixture(t)
	body := `{"kind":"direct_shipment","counterparty_location_id":2,"retry_key":"w01-direct-guards-01","items":[{"variant_id":2,"quantity":"1"},{"variant_id":1,"quantity":"2"}]}`
	before := fenceSnapshot(t, f)
	for _, branch := range []int{2, 3} {
		t.Run(fmt.Sprintf("branch_creator_%d", branch), func(t *testing.T) {
			other := 5 - branch
			cart := strings.Replace(body, `"counterparty_location_id":2`, fmt.Sprintf(`"counterparty_location_id":%d`, other), 1)
			expectTransferError(t, f.request(t, branch, "POST", "/api/transfers", cart), 403, "forbidden")
		})
	}
	for _, destination := range []int{1, 4} {
		t.Run(fmt.Sprintf("invalid_destination_%d", destination), func(t *testing.T) {
			cart := strings.Replace(body, `"counterparty_location_id":2`, fmt.Sprintf(`"counterparty_location_id":%d`, destination), 1)
			expectTransferError(t, f.request(t, 1, "POST", "/api/transfers", cart), 400, "invalid_request")
		})
	}
	for _, field := range []string{"actor", "creator_location_id", "origin_location_id", "destination_location_id", "approver_location_id", "decision_location_id", "decided_at", "status"} {
		t.Run("forged_"+field, func(t *testing.T) {
			cart := strings.Replace(body, `"kind":`, fmt.Sprintf(`%q:1,"kind":`, field), 1)
			expectTransferError(t, f.request(t, 1, "POST", "/api/transfers", cart), 400, "invalid_request")
		})
	}
	expectTransferError(t, f.request(t, 0, "POST", "/api/transfers", body), 401, "unauthenticated")
	if fenceSnapshot(t, f) != before {
		t.Fatal("creator, destination or framing refusal mutated complete state")
	}
}
