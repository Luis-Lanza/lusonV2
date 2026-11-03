package httpapi

import (
	"encoding/json"
	"testing"
)

// HTTP fixtures for the surviving transfer routes. The count-correction HTTP
// surface is retired; the unified reconciliation snapshot is the only reader of
// that historical evidence.

func countHTTPReceived(t *testing.T, f *transferHTTPFixture) transferDTO {
	t.Helper()
	// The third receipt line describes a genuinely dispatched variant; the
	// receipt API refuses lines for variants that were never dispatched.
	transit := receiptHTTPDispatchItems(t, f, "request_stock", 1, "receipt-http-create-001", `[{"variant_id":1,"quantity":"1"},{"variant_id":2,"quantity":"1"},{"variant_id":3,"quantity":"1"}]`)
	proof := receiptHTTPProof(t, f, transit, 1, 1, 1)
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

// The three legacy audit HTTP subtrees are unregistered: every action path answers
// the ordinary unknown-route 404 for any method, while the unified reconciliation
// mount stays registered. Routing is decided before authentication, so no fixture
// state is needed here.
func TestLegacyAuditRoutesRetired(t *testing.T) {
	f := transferFixture(t)
	const unknown = "404 page not found\n"
	for _, subtree := range []string{"count-corrections", "restitutions", "dispatch-reconciliations"} {
		for _, suffix := range []string{"", "/", "/propose", "/accept", "/reject", "/unknown"} {
			route := "/api/transfers/1/" + subtree + suffix
			for _, method := range []string{"GET", "POST"} {
				w := f.request(t, 2, method, route, "{}")
				if w.Code != 404 || w.Body.String() != unknown {
					t.Fatalf("%s %s: %d %q", method, route, w.Code, w.Body.String())
				}
			}
		}
	}
	// Registered routes answer the method guard instead of the unknown-route 404.
	if w := f.request(t, 2, "PUT", "/api/transfers/1/unified-reconciliations", "{}"); w.Code != 405 {
		t.Fatalf("unified reconciliation mount missing: %d %q", w.Code, w.Body.String())
	}
}
