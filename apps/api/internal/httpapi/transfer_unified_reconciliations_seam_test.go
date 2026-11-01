package httpapi

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"testing"

	"luson/api/internal/auth"
	"luson/api/internal/transfers"
)

// Opt-in export contains only public authenticated GET bodies, never sessions or
// fixture configuration. The parent captures stdout outside the worktree.
func TestURHTTPCodecSeam(t *testing.T) {
	if os.Getenv("LUSON_UNIFIED_SEAM_EXPORT") != "1" {
		t.Skip("set LUSON_UNIFIED_SEAM_EXPORT=1 with the authorized isolated fixture")
	}
	type capture struct {
		Name     string          `json:"name"`
		Original json.RawMessage `json:"original"`
		Before   json.RawMessage `json:"before"`
		After    json.RawMessage `json:"after"`
	}
	var captures []capture
	for _, prior := range []bool{false, true} {
		name := "sample"
		if prior {
			name = "prior-restoration"
		}
		t.Run(name, func(t *testing.T) {
			f := transferFixture(t)
			body := `{"kind":"request_stock","counterparty_location_id":1,"retry_key":"ur-seam-create-0001","items":[{"variant_id":1,"quantity":"10"},{"variant_id":2,"quantity":"1"}]}`
			created := transferWireRecord(t, f.request(t, 2, "POST", "/api/transfers", body), 201)
			path := "/api/transfers/" + created.ID
			approval := decisionServe(t, f, f.newRequest(1, "POST", path+"/approve", "{}"), created)
			var approved, transit transferDTO
			if json.Unmarshal(approval.Body.Bytes(), &approved) != nil {
				t.Fatal("approval decode")
			}
			proof := dispatchProof(t, f, approved)
			w := receiptHTTPMutation(f, f.newRequest(1, "POST", path+"/dispatch", "{}"))
			proof(w)
			if json.Unmarshal(w.Body.Bytes(), &transit) != nil {
				t.Fatal("dispatch decode")
			}
			receiptProof := receiptHTTPProof(t, f, transit, 8, 1)
			w = receiptHTTPMutation(f, f.newRequest(2, "POST", path+"/receive", `{"items":[{"variant_id":1,"actual_quantity":"8"},{"variant_id":2,"actual_quantity":"1"},{"variant_id":3,"actual_quantity":"7"}]}`))
			receiptProof(w)
			original := append(json.RawMessage(nil), f.request(t, 2, "GET", path, "").Body.Bytes()...)
			if prior {
				r4HTTPOperation(t, f.request(t, 1, "POST", path+"/restitutions/propose", r4HTTPBody(1, "ur-seam-rest-propose", "0", "1", "verified retention")))
				restProof := r4HTTPProof(t, f, 1, 1, 1)
				w = receiptHTTPMutation(f, f.newRequest(2, "POST", path+"/restitutions/accept", r4HTTPBody(1, "ur-seam-rest-accept", "1", "", "verified")))
				restProof(w)
			}
			read := func() json.RawMessage {
				w := f.request(t, 2, "GET", path+"/unified-reconciliations", "")
				if w.Code != 200 {
					t.Fatal("snapshot status", w.Code)
				}
				return append(json.RawMessage(nil), w.Body.Bytes()...)
			}
			before := read()
			id, err := strconv.ParseInt(created.ID, 10, 64)
			if err != nil {
				t.Fatal(err)
			}
			s := transfers.New(f.p)
			origin := auth.Identity{AccountID: 1, Location: auth.Location{ID: 1}}
			destination := auth.Identity{AccountID: 2, Location: auth.Location{ID: 2}}
			_, err = s.ProposeUnifiedReconciliation(f.ctx, origin, id, transfers.UnifiedReconciliationProposalInput{VariantID: 1, OperationKey: "ur-seam-unified-propose", DispatchQuantity: 9, ArrivalQuantity: 8, RetainedQuantity: 1, RetainedAtOrigin: true, Reason: "verified origin"})
			if err != nil {
				t.Fatal(err)
			}
			wantDelta := int64(1)
			if prior {
				wantDelta = 0
			}
			immutable := countHTTPOriginal(t, f)
			var expectedStock string
			if err := f.p.QueryRow(f.ctx, `SELECT jsonb_agg(to_jsonb(b)||jsonb_build_object(
 'existing',b.existing+CASE WHEN location_id=1 AND variant_id=1 THEN $1::bigint ELSE 0 END,
 'available',b.available+CASE WHEN location_id=1 AND variant_id=1 THEN $1::bigint ELSE 0 END) ORDER BY location_id,variant_id)::text FROM inventory_balances b`, wantDelta).Scan(&expectedStock); err != nil {
				t.Fatal("unified stock expectation")
			}
			op, err := s.DecideUnifiedReconciliation(f.ctx, destination, id, transfers.UnifiedReconciliationDecisionInput{VariantID: 1, OperationKey: "ur-seam-unified-accept", ExpectedRevision: 1, Accept: true, Reason: "verified destination"})
			if err != nil {
				t.Fatal(err)
			}
			// Audit the complete stock transformation before advancing the
			// existing passive fixture baseline, as the HTTP mutation helpers do.
			if op.SourceExistingAfter == nil || op.SourceExistingBefore == nil || *op.SourceExistingAfter-*op.SourceExistingBefore != wantDelta || op.DestinationExistingAfter == nil || op.DestinationExistingBefore == nil || *op.DestinationExistingAfter != *op.DestinationExistingBefore {
				t.Fatal("unexpected application deltas")
			}
			if f.stock(t) != expectedStock || countHTTPOriginal(t, f) != immutable {
				t.Fatal("unified changed unrelated stock or original evidence")
			}
			f.baseline = expectedStock
			after := read()
			captures = append(captures, capture{name, original, before, after})
		})
	}
	if t.Failed() {
		return
	}
	b, err := json.Marshal(captures)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Printf("LUSON_UNIFIED_SEAM=%s\n", b)
}
