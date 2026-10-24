package transfers

import (
	"bytes"
	"encoding/json"
	"reflect"
)

// This evidence is private to Store reads, not an HTTP quantity alias. Original
// ExpectedQuantity/BaseCredit fields retain their historical meanings. The
// public validators continue to reject impossible original receipt arithmetic.
type restitutionDispatchPin struct {
	Revision int64 `json:"revision"`
	Dispatch int64 `json:"dispatch"`
}
type restitutionDispatchEvidence struct {
	VariantID              int64                    `json:"variant_id"`
	Dispatch               int64                    `json:"dispatch"`
	ReconciliationRevision int64                    `json:"reconciliation_revision"`
	Proposals              []restitutionDispatchPin `json:"proposals"`
}

func decodeRestitutionDispatchEvidence(raw []byte) (map[int64]restitutionDispatchEvidence, bool) {
	var lines []restitutionDispatchEvidence
	if !completeRestitutionJSON(raw, reflect.TypeOf(lines)) {
		return nil, false
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&lines) != nil {
		return nil, false
	}
	out := make(map[int64]restitutionDispatchEvidence, len(lines))
	var previous int64
	for _, line := range lines {
		if line.VariantID <= previous || line.Dispatch < 0 || line.ReconciliationRevision < 0 {
			return nil, false
		}
		for i, pin := range line.Proposals {
			if pin.Revision != int64(i+1) || pin.Dispatch < 0 {
				return nil, false
			}
		}
		previous = line.VariantID
		out[line.VariantID] = line
	}
	return out, true
}
