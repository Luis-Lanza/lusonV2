package httpapi

import (
	"context"
	"encoding/json"
	"testing"
)

func TestDR3HTTPMutationPredecessorAndRestitution(t *testing.T) {
	f := transferFixture(t)
	detail := dr3Received(t, f)
	path := detail + "/dispatch-reconciliations"
	dr3Apply(t, f, f.newRequest(1, "POST", path+"/propose", dr3Body("dr3-stale-propose-001", "0", "7")), 0, 0)
	cp := detail + "/count-corrections"
	dr3Apply(t, f, f.newRequest(2, "POST", cp+"/propose", countHTTPBody(1, "dr3-stale-count-propose", "0", "4", "recount")), 0, 0)
	dr3Apply(t, f, f.newRequest(1, "POST", cp+"/accept", countHTTPBody(1, "dr3-stale-count-accept", "1", "", "agree")), 0, -1)
	dr3Reject(t, f, path, f.newRequest(2, "POST", path+"/accept", dr3Body("dr3-stale-accept-001", "1", "")), 409, "decision_conflict")
	// Rejection must not depend on stale acceptance-only pins or arithmetic.
	dr3Apply(t, f, f.newRequest(2, "POST", path+"/reject", dr3Body("dr3-stale-reject-001", "1", "")), 0, 0)
	var state dispatchReconciliationSnapshotDTO
	if json.Unmarshal([]byte(dr3Get(t, f, path)), &state) != nil || state.Lines[0].Proposals[0].State != "rejected" || state.Lines[0].Proposals[0].Decision.Accepted || state.Lines[0].Proposals[0].Application != nil {
		t.Fatal("rejection history")
	}
	rp := detail + "/restitutions"
	dr3Apply(t, f, f.newRequest(1, "POST", rp+"/propose", r4HTTPBody(1, "dr3-retain-propose-001", "0", "1", "retained")), 0, 0)
	dr3Apply(t, f, f.newRequest(2, "POST", rp+"/accept", r4HTTPBody(1, "dr3-retain-accept-001", "1", "", "agree")), 1, 0)
	dr3Reject(t, f, path, f.newRequest(2, "POST", path+"/propose", dr3Body("dr3-retain-excluded-001", "1", "4")), 409, "decision_conflict")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	dr3Reject(t, f, path, f.newRequest(2, "POST", path+"/propose", "junk").WithContext(ctx), 503, "service_unavailable")
}
