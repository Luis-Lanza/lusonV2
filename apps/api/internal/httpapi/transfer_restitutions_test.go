package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"testing"
	"time"
)

// The restitution HTTP surface is retired with its routes. These helpers stay
// because the unified reconciliation snapshot exposes the same historical
// operation evidence.
func r4HTTPBody(variant int, key, revision, quantity, reason string) string {
	body := fmt.Sprintf(`{"variant_id":%d,"operation_key":%q,"expected_revision":%q,"reason":%q`, variant, key, revision, reason)
	if quantity != "" {
		body += fmt.Sprintf(`,"retained_quantity":%q,"retained_at_origin":true`, quantity)
	}
	return body + "}"
}
func r4HTTPOperation(t *testing.T, w *httptest.ResponseRecorder) restitutionOperationDTO {
	t.Helper()
	if len(transferObject(t, w, 200)) != 13 {
		t.Fatal("all persisted operation fields required")
	}
	if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Content-Type-Options") != "nosniff" || len(w.Result().Cookies()) != 0 {
		t.Fatal("operation security headers")
	}
	var op restitutionOperationDTO
	if json.Unmarshal(w.Body.Bytes(), &op) != nil {
		t.Fatal("operation decode")
	}
	stamp, err := time.Parse(time.RFC3339Nano, op.RecordedAt)
	if err != nil || op.RecordedAt != countStamp(stamp) {
		t.Fatal("operation canonical timestamp")
	}
	return op
}

// Unlike the destination-only C4 proof, adoption here allows precisely one
// origin credit and nothing else across all 570 balances and original evidence.
func r4HTTPProof(t *testing.T, f *transferHTTPFixture, origin, variant int, delta int64) func(*httptest.ResponseRecorder) {
	t.Helper()
	original := countHTTPOriginal(t, f)
	var expected string
	if f.p.QueryRow(f.ctx, `SELECT jsonb_agg(to_jsonb(b)||jsonb_build_object(
 'existing',b.existing+CASE WHEN location_id=$1 AND variant_id=$2 THEN $3::bigint ELSE 0 END,
 'available',b.available+CASE WHEN location_id=$1 AND variant_id=$2 THEN $3::bigint ELSE 0 END) ORDER BY location_id,variant_id)::text FROM inventory_balances b`, origin, variant, delta).Scan(&expected) != nil {
		t.Fatal("origin credit expectation")
	}
	return func(w *httptest.ResponseRecorder) {
		op := r4HTTPOperation(t, w)
		if op.SourceExistingBefore == nil || op.SourceExistingAfter == nil || op.Action != "accept" {
			t.Fatal("missing persisted stock snapshots")
		}
		if f.stock(t) != expected || countHTTPOriginal(t, f) != original {
			t.Fatal("origin credit changed reservations, destination or original receipt/dispatch")
		}
		f.baseline = expected
	}
}
