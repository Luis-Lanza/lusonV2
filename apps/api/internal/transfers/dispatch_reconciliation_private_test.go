package transfers

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"
)

func TestDR1HistoricalDispatchExposure(t *testing.T) {
	stamp := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	q, yes := int64(1), true
	line := RestitutionLineState{VariantID: 1, ExpectedQuantity: 5, OriginalCredit: 5, EffectiveCredit: 6,
		WorkflowRevision: 1, Proposals: []RestitutionProposal{{Revision: 1, OperationKey: "t4b-historical-proposal", InitiatorLocationID: 1,
			RetainedQuantity: 1, RetainedAtOrigin: true, BaseCredit: 6, Reason: "retained", RecordedAt: stamp, State: "pending"}}}
	ops, _ := json.Marshal([]RestitutionOperation{{OperationKey: "t4b-historical-proposal", RequestID: 1, VariantID: 1,
		ActorLocationID: 1, Action: "propose", RetainedQuantity: &q, RetainedAtOrigin: &yes, Reason: "retained", Revision: 1, RecordedAt: stamp}})
	proof := `[{"variant_id":1,"dispatch":6,"reconciliation_revision":2,"proposals":[{"revision":1,"dispatch":7}]}]`
	lines, _ := json.Marshal([]RestitutionLineState{line})
	got, err := decodeRestitutionHistory(1, 1, 2, lines, ops, []byte(proof))
	if err != nil {
		t.Fatal("historical dispatch must not use current or original capacity", err)
	}
	field := reflect.ValueOf(got.Lines[0].Proposals[0]).FieldByName("BaseDispatch")
	if !field.IsValid() || field.Kind() != reflect.Int64 || field.Int() != 7 {
		t.Fatal("historical dispatch evidence was not exposed")
	}
	for _, bad := range []string{
		`[{"variant_id":1,"dispatch":6,"reconciliation_revision":2,"proposals":[{"revision":1,"dispatch":6}]}]`,
		`[{"variant_id":1,"dispatch":6,"reconciliation_revision":2,"proposals":[{"revision":2,"dispatch":7}]}]`,
		`[{"variant_id":1,"dispatch":6,"reconciliation_revision":2,"proposals":[{"revision":1}]}]`,
		`[{"variant_id":1,"dispatch":6,"reconciliation_revision":2,"proposals":[{"revision":1,"dispatch":7,"unknown":0}]}]`,
	} {
		if out, err := decodeRestitutionHistory(1, 1, 2, lines, ops, []byte(bad)); !errors.Is(err, ErrReadUnavailable) || out.RequestID != 0 {
			t.Fatal("forged historical capacity/evidence admitted")
		}
	}
	line.OriginalCredit = 6
	lines, _ = json.Marshal([]RestitutionLineState{line})
	if _, err := decodeRestitutionHistory(1, 1, 2, lines, ops, []byte(proof)); !errors.Is(err, ErrReadUnavailable) {
		t.Fatal("reconciliation weakened original-credit bound")
	}
}

func TestDR1PrivateDispatchEvidence(t *testing.T) {
	line := RestitutionLineState{VariantID: 1, ExpectedQuantity: 5, OriginalCredit: 5, EffectiveCredit: 7, Proposals: []RestitutionProposal{}}
	lines, err := json.Marshal([]RestitutionLineState{line})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decodeRestitutionHistory(1, 1, 2, lines, []byte("[]")); !errors.Is(err, ErrReadUnavailable) {
		t.Fatal("ordinary history validation was weakened")
	}
	proof := []byte(`[{"variant_id":1,"dispatch":7,"reconciliation_revision":1,"proposals":[]}]`)
	out, err := decodeRestitutionHistory(1, 1, 2, lines, []byte("[]"), proof)
	if err != nil || out.Lines[0].ExpectedQuantity != 5 || out.Lines[0].EffectiveCredit != 7 {
		t.Fatal("private reconciled evidence not admitted independently of original quantities", err)
	}
	for _, bad := range []string{
		`null`, `[]`, `[{}]`,
		`[{"variant_id":1,"dispatch":7,"reconciliation_revision":0,"proposals":[]}]`,
		`[{"variant_id":1,"dispatch":6,"reconciliation_revision":1,"proposals":[]}]`,
		`[{"variant_id":1,"dispatch":-1,"reconciliation_revision":1,"proposals":[]}]`,
		`[{"variant_id":1,"dispatch":7,"reconciliation_revision":-1,"proposals":[]}]`,
		`[{"variant_id":1,"dispatch":7,"reconciliation_revision":1,"proposals":null}]`,
		`[{"variant_id":1,"dispatch":7,"reconciliation_revision":1,"proposals":[],"unknown":0}]`,
	} {
		if got, err := decodeRestitutionHistory(1, 1, 2, lines, []byte("[]"), []byte(bad)); !errors.Is(err, ErrReadUnavailable) || got.RequestID != 0 {
			t.Fatalf("malformed private dispatch evidence admitted: %s", bad)
		}
	}
	// Public arithmetic still requires an internally coherent original line;
	// callers cannot relabel excess receipt credit as reconciled evidence.
	if _, err := CalculateRestitution(ReceiptLine{VariantID: 1, ExpectedQuantity: 5, ActualQuantity: 7, AvailableQuantity: 7}, 0, 1); !errors.Is(err, ErrInvalid) {
		t.Fatal("public original-line arithmetic validation was weakened")
	}
}
