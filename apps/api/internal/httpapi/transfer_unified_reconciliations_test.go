package httpapi

import (
	"encoding/json"
	"math"
	"net/http"
	"reflect"
	"testing"
	"time"

	"luson/api/internal/transfers"
)

func TestURHTTPReadProductionRouter(t *testing.T) {
	f := transferFixture(t)
	received := countHTTPReceived(t, f)
	path := "/api/transfers/" + received.ID + "/unified-reconciliations"
	before, stock := dr3Counts(t, f), dr3Inventory(t, f)
	for _, actor := range []int{1, 2} {
		w := receiptHTTPMutation(f, f.newRequest(actor, "GET", path, ""))
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		var got map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if got["schema"] != "luson.transfer-reconciliation/v2" || got["request_id"] != received.ID || len(got["original"].([]any)) != 3 || len(got["current"].([]any)) != 3 || len(got["lines"].([]any)) != 3 {
			t.Fatal(w.Body.String())
		}
	}
	for _, tc := range []struct {
		actor          int
		method, suffix string
		status         int
		body           string
	}{
		{3, "GET", "", 404, "{\"error\":\"not_found\"}\n"},
		{0, "GET", "", 401, "{\"error\":\"unauthenticated\"}\n"},
		{2, "POST", "", 405, "{\"error\":\"method_not_allowed\"}\n"},
		{2, "GET", "?", 400, "{\"error\":\"invalid_request\"}\n"},
		{2, "GET", "/unknown", 404, "{\"error\":\"not_found\"}\n"},
	} {
		r := f.newRequest(tc.actor, tc.method, path+tc.suffix, "")
		r.Body = dr3UnreadBody{t}
		w := receiptHTTPMutation(f, r)
		if w.Code != tc.status || w.Body.String() != tc.body {
			t.Fatal(tc, w.Code, w.Body.String())
		}
		if tc.status == 405 && w.Header().Get("Allow") != http.MethodGet {
			t.Fatal(w.Header())
		}
	}
	if before != dr3Counts(t, f) || !reflect.DeepEqual(stock, dr3Inventory(t, f)) {
		t.Fatal("read changed inventory or counters")
	}
}

func TestURHTTPSerialize(t *testing.T) {
	n := int64(math.MaxInt64)
	at := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	snapshot := transfers.UnifiedReconciliations{Schema: "luson.transfer-reconciliation/v2", RequestID: n, ReceivedAt: at,
		Original: []transfers.UnifiedOriginalLine{{VariantID: 1, ExpectedQuantity: n}},
		Current:  []transfers.UnifiedCurrentLine{{VariantID: 1, Owner: "legacy", Source: "legacy", SourceDebit: n}},
	}
	b, err := json.Marshal(unifiedReconciliationSnapshotRecord(snapshot))
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err = json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if got["schema"] != snapshot.Schema || got["request_id"] != "9223372036854775807" || got["received_at"] != "2026-10-31T12:00:00Z" {
		t.Fatal(string(b))
	}
	for _, key := range []string{"lines", "operations"} {
		if v, ok := got[key].([]any); !ok || len(v) != 0 {
			t.Fatal(key, string(b))
		}
	}
	current := got["current"].([]any)[0].(map[string]any)
	if current["variant_id"] != float64(1) || current["source_debit"] != "9223372036854775807" {
		t.Fatal(string(b))
	}
	for _, key := range []string{"application_operation_key", "retained_quantity", "origin_unknown", "transit_unknown", "excess"} {
		v, ok := current[key]
		if !ok || v != nil {
			t.Fatal(key, string(b))
		}
	}
	legacy := got["legacy"].(map[string]any)
	for _, key := range []string{"count", "restitution", "dispatch"} {
		item := legacy[key].(map[string]any)
		if _, ok := item["lines"].([]any); !ok {
			t.Fatal(key, string(b))
		}
	}
}
