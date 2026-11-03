package httpapi

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
	"time"

	"luson/api/internal/transfers"
)

// The count-correction decoder is retired with its HTTP surface; this test pins
// the lossless wire encoding of the historical count evidence that the unified
// reconciliation snapshot still embeds.
func TestC3CountDTOExactWire(t *testing.T) {
	actual := int64(math.MaxInt64)
	stamp := time.Date(2026, 1, 2, 3, 4, 5, 6, time.FixedZone("offset", 3600))
	op := transfers.CountOperation{OperationKey: "count-http-key-001", RequestID: math.MaxInt64, VariantID: math.MaxInt32, ActorLocationID: 3, Action: "propose", ExpectedRevision: math.MaxInt64 - 1, Actual: &actual, Reason: " exact ", Revision: math.MaxInt64, RecordedAt: stamp}
	snapshot := transfers.CountCorrections{RequestID: math.MaxInt64, Operations: []transfers.CountOperation{op}, Lines: []transfers.CountLineState{{EffectiveDispatch: math.MaxInt64, ReconciliationRevision: math.MaxInt64, VariantID: math.MaxInt32, ExpectedQuantity: math.MaxInt64, OriginalActual: math.MaxInt64, OriginalCredit: math.MaxInt64, WorkflowRevision: math.MaxInt64, AppliedRevision: math.MaxInt64, EffectiveActual: math.MaxInt64, EffectiveCredit: math.MaxInt64, Proposals: []transfers.CountProposal{{Revision: math.MaxInt64, Actual: math.MaxInt64, BaseRevision: math.MaxInt64 - 1, BaseCredit: math.MaxInt64, RecordedAt: stamp, Application: &transfers.CountApplication{EffectiveCredit: 0, Delta: -math.MaxInt64, RecordedAt: stamp}}}}}}
	body, err := json.Marshal(countSnapshotRecord(snapshot))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"effective_dispatch":"9223372036854775807"`, `"reconciliation_revision":"9223372036854775807"`, `"request_id":"9223372036854775807"`, `"expected_revision":"9223372036854775806"`, `"actual_quantity":"9223372036854775807"`, `"delta":"-9223372036854775807"`, `"variant_id":2147483647`, `"actor_location_id":3`, `"decision":null`, `"recorded_at":"2026-01-02T02:04:05.000000006Z"`} {
		if !strings.Contains(string(body), want) {
			t.Fatalf("missing exact wire member %s", want)
		}
	}
	op.Actual = nil
	encoded, _ := json.Marshal(countOperationRecord(op))
	if !strings.Contains(string(encoded), `"actual_quantity":null`) {
		t.Fatal("decision null omitted")
	}
	empty, _ := json.Marshal(countSnapshotRecord(transfers.CountCorrections{RequestID: 1}))
	if string(empty) != `{"request_id":"1","lines":[],"operations":[]}` {
		t.Fatal("empty arrays changed", string(empty))
	}
}
