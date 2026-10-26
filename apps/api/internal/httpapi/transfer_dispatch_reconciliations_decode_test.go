package httpapi

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"luson/api/internal/transfers"
)

func TestDR3HTTPDecodeRejected(t *testing.T) {
	f := transferFixture(t)
	detail := dr3Received(t, f)
	path := detail + "/dispatch-reconciliations"
	body := dr3Body("dr3-decoder-key-001", "0", "7")
	bad := map[string]string{"empty": "{}", "null": "null", "array": "[]", "truncated": strings.TrimSuffix(body, "}"), "trailing": body + "{}", "utf8": body + "\xff", "oversized": body + strings.Repeat(" ", 64<<10)}
	for _, field := range []string{`"variant_id":1,`, `"operation_key":"dr3-decoder-key-001",`, `"expected_revision":"0",`, `,"reason":"evidence"`, `,"dispatch_quantity":"7"`} {
		bad["missing_"+field] = strings.Replace(body, field, "", 1)
	}
	for _, member := range []string{`"actor_location_id":1`, `"account_id":1`, `"location_id":1`, `"effective_credit":"7"`, `"actual_quantity":"7"`, `"request_id":"1"`, `"variant_id":1`, `"variant_\u0069d":1`, `"Reason":"evidence"`} {
		bad["extra_"+member] = strings.TrimSuffix(body, "}") + "," + member + "}"
	}
	for _, field := range []string{"dispatch_quantity", "expected_revision"} {
		old := `"` + field + `":"7"`
		if field == "expected_revision" {
			old = `"expected_revision":"0"`
		}
		for _, token := range []string{`"00"`, `"01"`, `"-0"`, `"-1"`, `"+1"`, `"1.0"`, `"1e0"`, `" 1"`, `"1 "`, `"9223372036854775808"`, `1`, `null`, `true`, `[]`, `{}`} {
			bad[field+token] = strings.Replace(body, old, `"`+field+`":`+token, 1)
		}
	}
	bad["revision_max"] = strings.Replace(body, `"expected_revision":"0"`, `"expected_revision":"9223372036854775807"`, 1)
	for _, token := range []string{`"1"`, `0`, `-1`, `1.0`, `1e0`, `2147483648`, `null`, `true`} {
		bad["variant"+token] = strings.Replace(body, `"variant_id":1`, `"variant_id":`+token, 1)
	}
	for _, token := range []string{`null`, `1`, `""`, `"   "`, `"\u0000"`, `"` + strings.Repeat("x", 2001) + `"`} {
		bad["reason"+token] = strings.Replace(body, `"evidence"`, token, 1)
	}
	for _, token := range []string{`null`, `1`, `"short"`, `"dr3-decoder-key-001!"`, `"` + strings.Repeat("k", 129) + `"`} {
		bad["key"+token] = strings.Replace(body, `"dr3-decoder-key-001"`, token, 1)
	}
	for name, payload := range bad {
		t.Run(name, func(t *testing.T) {
			dr3Reject(t, f, path, f.newRequest(2, "POST", path+"/propose", payload), 400, "invalid_request")
		})
	}
	for i, media := range [][]string{nil, {"text/plain"}, {"application/json;"}, {"application/json; charset=latin1"}, {"application/json; x=y"}, {"application/json; charset=utf-8; charset=utf-8"}, {"application/json", "application/json"}} {
		t.Run(fmt.Sprintf("media_%d", i), func(t *testing.T) {
			r := f.newRequest(2, "POST", path+"/propose", body)
			r.Header.Del("Content-Type")
			for _, v := range media {
				r.Header.Add("Content-Type", v)
			}
			dr3Reject(t, f, path, r, 400, "invalid_request")
		})
	}
	for _, action := range []string{"accept", "reject"} {
		dr3Reject(t, f, path, f.newRequest(2, "POST", path+"/"+action, body), 400, "invalid_request")
	}
}
func TestDR3HTTPDecodeExactEvidence(t *testing.T) {
	max := int64(math.MaxInt64)
	zero := int64(0)
	large := int64(9007199254740993)
	stamp := time.Date(2026, 1, 2, 3, 4, 5, 6, time.FixedZone("offset", 3600))
	snapshot := transfers.DispatchReconciliations{RequestID: max, Operations: []transfers.DispatchReconciliationOperation{{RequestID: max, VariantID: math.MaxInt32, ActorLocationID: 3, ExpectedRevision: max - 1, Revision: max, DispatchQuantity: &large, SourceExistingBefore: &max, SourceExistingAfter: &zero, DestinationExistingBefore: nil, DestinationExistingAfter: &large, RecordedAt: stamp}}, Lines: []transfers.DispatchReconciliationLineState{{VariantID: 1, ExpectedQuantity: max, OriginalActual: large, OriginalCredit: max, EffectiveDispatch: large, EffectiveActual: large, EffectiveCredit: large, WorkflowRevision: max, AppliedRevision: max, CountGeneration: max, CountAppliedRevision: max, RestitutionGeneration: max, ReconciliationGeneration: max, Proposals: []transfers.DispatchReconciliationProposal{{Revision: max, DispatchQuantity: large, BaseDispatch: max, BaseActual: large, BaseCredit: max, CountGeneration: max, RestitutionGeneration: max, ReconciliationGeneration: max, RecordedAt: stamp, Decision: &transfers.DispatchReconciliationDecision{Accepted: true, RecordedAt: stamp}, Application: &transfers.DispatchReconciliationApplication{EffectiveDispatch: large, SourceDelta: -max, DestinationDelta: 0, RecordedAt: stamp}}}}}}
	raw, err := json.Marshal(dispatchReconciliationSnapshotRecord(snapshot))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"request_id":"9223372036854775807"`, `"variant_id":2147483647`, `"actor_location_id":3`, `"dispatch_quantity":"9007199254740993"`, `"source_delta":"-9223372036854775807"`, `"destination_delta":"0"`, `"source_existing_before":"9223372036854775807"`, `"source_existing_after":"0"`, `"destination_existing_before":null`, `"destination_existing_after":"9007199254740993"`, `"recorded_at":"2026-01-02T02:04:05.000000006Z"`} {
		if !strings.Contains(string(raw), want) {
			t.Fatal("missing exact wire", want)
		}
	}
	var root map[string]json.RawMessage
	if json.Unmarshal(raw, &root) != nil || len(root) != 3 {
		t.Fatal("root contract")
	}
	var lines, ops []map[string]json.RawMessage
	json.Unmarshal(root["lines"], &lines)
	json.Unmarshal(root["operations"], &ops)
	if len(lines[0]) != 15 || len(ops[0]) != 14 {
		t.Fatal("incomplete field set")
	}
	for _, key := range []string{"workflow_revision", "applied_revision", "count_generation", "count_applied_revision", "restitution_generation", "reconciliation_generation"} {
		if string(lines[0][key]) != `"9223372036854775807"` {
			t.Fatal("lossy field", key)
		}
	}
	empty, _ := json.Marshal(dispatchReconciliationSnapshotRecord(transfers.DispatchReconciliations{RequestID: 1}))
	if string(empty) != `{"request_id":"1","lines":[],"operations":[]}` {
		t.Fatal("null array")
	}
	for _, propose := range []bool{true, false} {
		quantity := ""
		if propose {
			quantity = "9223372036854775807"
		}
		body := dr3Body(strings.Repeat("k", 128), "9223372036854775806", quantity)
		body = strings.Replace(body, `"variant_id":1`, `"variant_id":2147483647`, 1)
		body = strings.Replace(body, `"evidence"`, `"  `+strings.Repeat("界", 2000)+`  "`, 1)
		r := httptest.NewRequest("POST", "/", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json; charset=UTF-8")
		in, err := decodeDispatchReconciliationMutation(r, propose)
		if err != nil || in.ExpectedRevision != max-1 || in.VariantID != math.MaxInt32 || in.Reason != "  "+strings.Repeat("界", 2000)+"  " {
			t.Fatal("boundary rejected", err)
		}
	}
}
