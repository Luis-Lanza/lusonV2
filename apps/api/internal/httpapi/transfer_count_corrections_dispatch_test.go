package httpapi

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestT4cCountDispatchHTTP(t *testing.T) {
	f := transferFixture(t)
	created := transferWireRecord(t, f.request(t, 2, "POST", "/api/transfers", `{"kind":"request_stock","counterparty_location_id":1,"retry_key":"t4c-http-create-key","items":[{"variant_id":1,"quantity":"5"},{"variant_id":2,"quantity":"1"}]}`), 201)
	path := "/api/transfers/" + created.ID
	var approved, transit transferDTO
	approval := decisionServe(t, f, f.newRequest(1, "POST", path+"/approve", "{}"), created)
	if err := json.Unmarshal(approval.Body.Bytes(), &approved); err != nil {
		t.Fatal(err)
	}
	dispatch := dispatchProof(t, f, approved)
	sent := receiptHTTPMutation(f, f.newRequest(1, "POST", path+"/dispatch", "{}"))
	dispatch(sent)
	if err := json.Unmarshal(sent.Body.Bytes(), &transit); err != nil {
		t.Fatal(err)
	}
	receive := receiptHTTPProof(t, f, transit, 5, 1)
	receive(receiptHTTPMutation(f, f.newRequest(2, "POST", path+"/receive", `{"items":[{"variant_id":1,"actual_quantity":"7"},{"variant_id":2,"actual_quantity":"1"},{"variant_id":3,"actual_quantity":"2"}]}`)))
	original := countHTTPOriginal(t, f)
	initial := countHTTPSnapshot(t, f, created.ID)
	if initial.Lines[0].EffectiveDispatch != "5" || initial.Lines[0].ReconciliationRevision != "0" || initial.Lines[2].EffectiveDispatch != "0" || initial.Lines[2].ReconciliationRevision != "0" {
		t.Fatal("original dispatch evidence", initial)
	}
	// Seed the already-tested SQL agreement; no reconciliation route is registered.
	var expected string
	if err := f.p.QueryRow(f.ctx, `SELECT jsonb_agg(to_jsonb(b)||jsonb_build_object(
 'existing',b.existing+CASE WHEN variant_id=1 AND location_id=1 THEN -2 WHEN variant_id=1 AND location_id=2 THEN 2 ELSE 0 END,
 'available',b.available+CASE WHEN variant_id=1 AND location_id=1 THEN -2 WHEN variant_id=1 AND location_id=2 THEN 2 ELSE 0 END) ORDER BY location_id,variant_id)::text FROM inventory_balances b`).Scan(&expected); err != nil {
		t.Fatal(err)
	}
	for _, action := range []struct {
		who         int
		key, action string
		revision    int
		quantity    any
	}{
		{1, "t4c-http-dispatch-propose", "propose", 0, 7}, {2, "t4c-http-dispatch-accept", "accept", 1, nil},
	} {
		var revision int
		if err := f.p.QueryRow(f.ctx, `SELECT revision FROM transfer_dispatch_reconcile($1::bigint,1,$2::smallint,$3,$4,$5::bigint,$6::bigint,'physical dispatch verified')`, created.ID, action.who, action.key, action.action, action.revision, action.quantity).Scan(&revision); err != nil || revision != 1 {
			t.Fatal("SQL agreement", err)
		}
	}
	if f.stock(t) != expected || countHTTPOriginal(t, f) != original {
		t.Fatal("agreement changed wrong stock or originals")
	}
	f.baseline = expected
	snapshot := countHTTPSnapshot(t, f, created.ID)
	line := snapshot.Lines[0]
	if line.ExpectedQuantity != "5" || line.OriginalCredit != "5" || line.EffectiveDispatch != "7" || line.ReconciliationRevision != "1" || line.EffectiveCredit != "7" || line.AppliedRevision != "0" || len(line.Proposals) != 0 {
		t.Fatal("reconciled transport evidence", line)
	}
	before := decisionRevisions(t, f)
	expectTransferError(t, f.request(t, 3, "GET", path+"/count-corrections", ""), 404, "not_found")
	expectTransferError(t, f.request(t, 1, "POST", path+"/count-corrections/propose", `{"variant_id":1,"operation_key":"t4c-http-invalid-key","expected_revision":"0","actual_quantity":"8","reason":"recount","effective_dispatch":"7"}`), 400, "invalid_request")
	if !reflect.DeepEqual(snapshot, countHTTPSnapshot(t, f, created.ID)) || decisionRevisions(t, f) != before || countHTTPOriginal(t, f) != original {
		t.Fatal("rejected request changed public history, originals or counters")
	}
}
