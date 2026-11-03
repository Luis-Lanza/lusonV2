package httpapi

import (
	"encoding/json"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"

	"luson/api/internal/transfers"
)

// The restitution decoder is retired with its HTTP surface; this test pins the
// lossless wire encoding of the historical restitution evidence that the unified
// reconciliation snapshot still embeds.
func r4Wire(t *testing.T, v any) map[string]json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal("DTO marshal")
	}
	var out map[string]json.RawMessage
	if json.Unmarshal(b, &out) != nil {
		t.Fatal("DTO object")
	}
	return out
}
func TestR4RestitutionDTOExactWire(t *testing.T) {
	n := int64(math.MaxInt64)
	yes := true
	stamp := time.Date(2026, 1, 2, 3, 4, 5, 123456789, time.FixedZone("offset", 3600))
	op := transfers.RestitutionOperation{OperationKey: "restitution-wire-001", RequestID: n, VariantID: 2147483647, ActorLocationID: 1, Action: "accept", ExpectedRevision: n - 1, RetainedQuantity: &n, RetainedAtOrigin: &yes, Reason: "literal", Revision: n, SourceExistingBefore: &n, SourceExistingAfter: &n, RecordedAt: stamp}
	got := r4Wire(t, restitutionOperationRecord(op))
	want := map[string]string{"operation_key": `"restitution-wire-001"`, "request_id": `"9223372036854775807"`, "variant_id": `2147483647`, "actor_location_id": `1`, "action": `"accept"`, "expected_revision": `"9223372036854775806"`, "retained_quantity": `"9223372036854775807"`, "retained_at_origin": `true`, "reason": `"literal"`, "revision": `"9223372036854775807"`, "source_existing_before": `"9223372036854775807"`, "source_existing_after": `"9223372036854775807"`, "recorded_at": `"2026-01-02T02:04:05.123456789Z"`}
	if len(got) != len(want) {
		t.Fatal("operation must expose exactly all 13 persisted fields")
	}
	for k, v := range want {
		if string(got[k]) != v {
			t.Fatalf("operation %s wire", k)
		}
	}
	op.RetainedQuantity = nil
	op.RetainedAtOrigin = nil
	op.SourceExistingBefore = nil
	op.SourceExistingAfter = nil
	got = r4Wire(t, restitutionOperationRecord(op))
	for _, k := range []string{"retained_quantity", "retained_at_origin", "source_existing_before", "source_existing_after"} {
		if string(got[k]) != "null" {
			t.Fatal("nullable operation evidence omitted")
		}
	}
	root := r4Wire(t, restitutionSnapshotRecord(transfers.Restitutions{RequestID: n}))
	if len(root) != 3 || string(root["lines"]) != "[]" || string(root["operations"]) != "[]" || string(root["request_id"]) != `"9223372036854775807"` {
		t.Fatal("root empty arrays or bigint wire")
	}
	p := transfers.RestitutionProposal{Revision: n, OperationKey: "p", InitiatorLocationID: 1, RetainedQuantity: n, RetainedAtOrigin: true, BaseRevision: n - 1, CountGeneration: n, CountAppliedRevision: n - 1, BaseCredit: n, BaseRestitution: n, BaseDispatch: n, Reason: "  evidence  ", RecordedAt: stamp, State: "applied", Decision: &transfers.RestitutionDecision{OperationKey: "d", ActorLocationID: 2, Accepted: true, Reason: "confirmed", RecordedAt: stamp}, Application: &transfers.RestitutionApplication{OperationKey: "d", OriginLocationID: 1, Quantity: n, RecordedAt: stamp}}
	line := transfers.RestitutionLineState{VariantID: 1, ExpectedQuantity: n, OriginalCredit: n, WorkflowRevision: n, AppliedRevision: n, CountGeneration: n, CountAppliedRevision: n, EffectiveCredit: n, EffectiveDispatch: n, ReconciliationRevision: n, AppliedRetainedQuantity: n, Proposals: []transfers.RestitutionProposal{p}}
	root = r4Wire(t, restitutionSnapshotRecord(transfers.Restitutions{RequestID: n, Lines: []transfers.RestitutionLineState{line}, Operations: []transfers.RestitutionOperation{op}}))
	var lines []map[string]json.RawMessage
	if json.Unmarshal(root["lines"], &lines) != nil || len(lines) != 1 || len(lines[0]) != 12 {
		t.Fatal("complete line contract")
	}
	for k, v := range lines[0] {
		if k != "variant_id" && k != "proposals" && string(v) != `"9223372036854775807"` {
			t.Fatalf("line %s bigint", k)
		}
	}
	var ps []map[string]json.RawMessage
	if json.Unmarshal(lines[0]["proposals"], &ps) != nil || len(ps[0]) != 16 {
		t.Fatal("complete proposal contract")
	}
	for _, k := range []string{"base_revision", "count_applied_revision"} {
		if string(ps[0][k]) != `"9223372036854775806"` {
			t.Fatal("predecessor pins")
		}
	}
	for _, k := range []string{"revision", "retained_quantity", "count_generation", "base_credit", "base_restitution", "base_dispatch"} {
		if string(ps[0][k]) != `"9223372036854775807"` {
			t.Fatal("proposal bigint")
		}
	}
	if string(ps[0]["retained_at_origin"]) != "true" || string(ps[0]["reason"]) != `"  evidence  "` || string(ps[0]["recorded_at"]) != `"2026-01-02T02:04:05.123456789Z"` {
		t.Fatal("proposal literal evidence")
	}
	var decision map[string]json.RawMessage
	if json.Unmarshal(ps[0]["decision"], &decision) != nil || len(decision) != 5 || string(decision["operation_key"]) != `"d"` || string(decision["actor_location_id"]) != "2" || string(decision["accepted"]) != "true" || string(decision["reason"]) != `"confirmed"` || string(decision["recorded_at"]) != `"2026-01-02T02:04:05.123456789Z"` {
		t.Fatal("decision complete exact wire")
	}
	var app map[string]json.RawMessage
	if json.Unmarshal(ps[0]["application"], &app) != nil || len(app) != 4 || string(app["quantity"]) != `"9223372036854775807"` {
		t.Fatal("application complete wire")
	}
	if string(app["operation_key"]) != `"d"` || string(app["origin_location_id"]) != "1" || string(app["recorded_at"]) != `"2026-01-02T02:04:05.123456789Z"` {
		t.Fatal("application exact wire")
	}
	empty := r4Wire(t, restitutionSnapshotRecord(transfers.Restitutions{Lines: []transfers.RestitutionLineState{{VariantID: 1}}}))
	var emptyLines []map[string]json.RawMessage
	if json.Unmarshal(empty["lines"], &emptyLines) != nil || string(emptyLines[0]["proposals"]) != "[]" {
		t.Fatal("line proposals must never be null")
	}
	p.Decision = nil
	p.Application = nil
	line.Proposals = []transfers.RestitutionProposal{p}
	one := restitutionSnapshotRecord(transfers.Restitutions{Lines: []transfers.RestitutionLineState{line}})
	two := restitutionSnapshotRecord(transfers.Restitutions{Lines: []transfers.RestitutionLineState{line}})
	if !reflect.DeepEqual(one, two) {
		t.Fatal("unstable wire")
	}
	b, _ := json.Marshal(one)
	if !strings.Contains(string(b), `"decision":null`) || !strings.Contains(string(b), `"application":null`) {
		t.Fatal("proposal null evidence")
	}
}
