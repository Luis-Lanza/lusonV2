package httpapi

import (
	"encoding/json"
	"math"
	"strings"
	"testing"

	"luson/api/internal/transfers"
)

// The dispatch reconciliation HTTP routes are retired. This test pins the
// lossless wire encoding of the historical agreement evidence that the unified
// reconciliation snapshot still embeds.
func TestDR3HTTPDecodeWire(t *testing.T) {
	n := int64(math.MaxInt64)
	op := dispatchReconciliationOperationRecord(transfers.DispatchReconciliationOperation{RequestID: n, ExpectedRevision: n, SourceExistingBefore: &n})
	raw, err := json.Marshal(op)
	if err != nil || op.RequestID != "9223372036854775807" || op.SourceExistingBefore == nil || *op.SourceExistingBefore != "9223372036854775807" || !strings.Contains(string(raw), `"destination_existing_after":null`) {
		t.Fatal("lossy/null wire", string(raw))
	}
}
