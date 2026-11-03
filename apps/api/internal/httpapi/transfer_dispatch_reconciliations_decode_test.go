package httpapi

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
	"time"

	"luson/api/internal/transfers"
)

// The dispatch reconciliation decoder is retired with its HTTP surface; this test
// pins the lossless wire encoding of the historical agreement evidence that the
// unified reconciliation snapshot still embeds.
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
}
