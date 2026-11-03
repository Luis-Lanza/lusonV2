package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"luson/api/internal/inventory"
)

// The dispatch reconciliation HTTP routes are retired. These public-interface
// helpers stay because the surviving unified reconciliation tests prove their
// stock, counts and recovery behaviour through them.
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
		{1, "approve", "{}"}, {1, "dispatch", "{}"}, {2, "receive", `{"items":[{"variant_id":1,"actual_quantity":"7"}]}`},
	} {
		w = receiptHTTPMutation(f, f.newRequest(step.actor, "POST", path+"/"+step.action, step.body))
		if w.Code != 200 {
			t.Fatalf("fixture %s: %d %s", step.action, w.Code, w.Body.String())
		}
		f.baseline = f.stock(t)
	}
	// All agreement and guard assertions must traverse the production mux.
	return path
}
