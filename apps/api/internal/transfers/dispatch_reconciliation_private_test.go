package transfers

import (
	"encoding/json"
	"errors"
	"testing"
)

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
