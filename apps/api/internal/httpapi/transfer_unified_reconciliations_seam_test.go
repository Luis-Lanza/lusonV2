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
			body := `{"kind":"request_stock","counterparty_location_id":1,"retry_key":"ur-seam-create-0001","items":[{"variant_id":1,"quantity":"10"},{"variant_id":2,"quantity":"1"},{"variant_id":3,"quantity":"1"}]}`
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
			// Every receipt line is a dispatched variant; variant 3 is dispatched
			// with quantity 1 so its line is admissible.
			receiptProof := receiptHTTPProof(t, f, transit, 8, 1, 1)
			w = receiptHTTPMutation(f, f.newRequest(2, "POST", path+"/receive", `{"items":[{"variant_id":1,"actual_quantity":"8"},{"variant_id":2,"actual_quantity":"1"},{"variant_id":3,"actual_quantity":"1"}]}`))
			receiptProof(w)
			original := append(json.RawMessage(nil), f.request(t, 2, "GET", path, "").Body.Bytes()...)
			if prior {
				// The restitution routes are retired, so the same historical evidence is
				// recorded through the retained SQL writer the retired handler called: one
				// detail-preserving write per operation, with the transaction-local personal
				// account setting the store also uses. The exported sample therefore keeps
				// real persisted consent instead of a fabricated fixture.
				seamRestitution(t, f, created.ID, 1, "propose", "ur-seam-rest-propose", 0, int64(1), true, "verified retention")
				immutable := countHTTPOriginal(t, f)
				var expectedStock string
				if err := f.p.QueryRow(f.ctx, `SELECT jsonb_agg(to_jsonb(b)||jsonb_build_object(
 'existing',b.existing+CASE WHEN location_id=1 AND variant_id=1 THEN 1::bigint ELSE 0 END,
 'available',b.available+CASE WHEN location_id=1 AND variant_id=1 THEN 1::bigint ELSE 0 END) ORDER BY location_id,variant_id)::text FROM inventory_balances b`).Scan(&expectedStock); err != nil {
					t.Fatal("restitution stock expectation")
				}
				seamRestitution(t, f, created.ID, 2, "accept", "ur-seam-rest-accept", 1, nil, nil, "verified")
				// The acceptance credits exactly one origin unit, nothing else, and
				// records the persisted source balances the strict client reads.
				if f.stock(t) != expectedStock || countHTTPOriginal(t, f) != immutable {
					t.Fatal("restitution changed reservations, destination or originals")
				}
				var credited string
				if err := f.p.QueryRow(f.ctx, `SELECT (source_existing_after-source_existing_before)::text FROM transfer_restitution_operations
 WHERE operation_key='ur-seam-rest-accept' AND action='accept'`).Scan(&credited); err != nil || credited != "1" {
					t.Fatal("persisted restitution evidence", err, credited)
				}
				f.baseline = expectedStock
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

// seamRestitution records one restitution operation through the retained SQL
// writer the retired route called. The account setting is transaction-local and
// mirrors the store writers, so the personal activity evidence is identical.
func seamRestitution(t *testing.T, f *transferHTTPFixture, id string, account int, action, key string, revision int, retained, attested any, reason string) {
	t.Helper()
	tx, err := f.p.Begin(f.ctx)
	if err != nil {
		t.Fatal("restitution transaction", err)
	}
	defer func() { _ = tx.Rollback(f.ctx) }()
	if _, err = tx.Exec(f.ctx, `SELECT set_config('luson.transfer_account_id',$1,true), pg_advisory_xact_lock(714025,1)`, strconv.Itoa(account)); err != nil {
		t.Fatal("restitution account setting", err)
	}
	if err = tx.QueryRow(f.ctx, `SELECT revision FROM transfer_restitute($1::bigint,1::integer,$2::smallint,$3,$4,$5::bigint,$6::bigint,$7::boolean,$8)`,
		id, account, key, action, revision, retained, attested, reason).Scan(new(int)); err != nil {
		t.Fatalf("restitution %s seed: %v", action, err)
	}
	if err = tx.Commit(f.ctx); err != nil {
		t.Fatalf("restitution %s commit: %v", action, err)
	}
}
