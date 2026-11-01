package httpapi

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestURMutationDecode(t *testing.T) {
	proposal := `{"variant_id":1,"operation_key":"unified-proposal1","expected_revision":"0","dispatch_quantity":"9223372036854775807","arrival_quantity":"0","retained_quantity":"0","retained_at_origin":false,"reason":" exact reason "}`
	decision := `{"variant_id":1,"operation_key":"unified-decision1","expected_revision":"1","retained_at_origin":true,"reason":"accept"}`
	for _, tc := range []struct {
		name, body, mime string
		propose, valid   bool
	}{
		{"proposal", proposal, "application/json", true, true},
		{"decision", decision, "application/json; charset=utf-8", false, true},
		{"duplicate", strings.Replace(proposal, `"variant_id":1`, `"variant_id":1,"variant_id":1`, 1), "application/json", true, false},
		{"escaped duplicate", strings.Replace(proposal, `"variant_id":1`, `"variant_id":1,"variant_\u0069d":1`, 1), "application/json", true, false},
		{"actor", strings.Replace(proposal, `"variant_id":1`, `"actor_location_id":1,"variant_id":1`, 1), "application/json", true, false},
		{"missing", strings.Replace(proposal, `"retained_at_origin":false,`, "", 1), "application/json", true, false},
		{"numeric quantity", strings.Replace(proposal, `"arrival_quantity":"0"`, `"arrival_quantity":0`, 1), "application/json", true, false},
		{"leading zero", strings.Replace(proposal, `"arrival_quantity":"0"`, `"arrival_quantity":"00"`, 1), "application/json", true, false},
		{"variant string", strings.Replace(proposal, `"variant_id":1`, `"variant_id":"1"`, 1), "application/json", true, false},
		{"bool string", strings.Replace(proposal, `"retained_at_origin":false`, `"retained_at_origin":"false"`, 1), "application/json", true, false},
		{"caller accept", strings.Replace(decision, `"variant_id":1`, `"accept":true,"variant_id":1`, 1), "application/json", false, false},
		{"decision quantities", proposal, "application/json", false, false},
		{"trailing", proposal + ` {}`, "application/json", true, false},
		{"mime", proposal, "text/plain", true, false},
		{"duplicate charset", proposal, "application/json; charset=utf-8; charset=utf-8", true, false},
		{"utf8", proposal + string([]byte{255}), "application/json", true, false},
		{"key", strings.Replace(proposal, "unified-proposal1", "bad", 1), "application/json", true, false},
		{"reason", strings.Replace(proposal, " exact reason ", "  ", 1), "application/json", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "/", strings.NewReader(tc.body))
			r.Header.Set("Content-Type", tc.mime)
			in, err := decodeUnifiedReconciliationMutation(r, tc.propose)
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%v error=%v", tc.valid, err)
			}
			if tc.valid && tc.propose && (in.DispatchQuantity != 9223372036854775807 || in.Reason != " exact reason ") {
				t.Fatalf("precision/text lost: %+v", in)
			}
		})
	}
}
