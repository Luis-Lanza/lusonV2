package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"luson/api/internal/auth"
	"luson/api/internal/transfers"
)

type r4StoreStub struct {
	calls                           []string
	accessErr, mutationErr, readErr error
	op                              transfers.RestitutionOperation
	snapshot                        transfers.Restitutions
	proposal                        transfers.RestitutionProposalInput
	decision                        transfers.RestitutionDecisionInput
}

func (s *r4StoreStub) CheckRestitutionAccess(context.Context, auth.Identity, int64) error {
	s.calls = append(s.calls, "access")
	return s.accessErr
}
func (s *r4StoreStub) ProposeRestitution(_ context.Context, _ auth.Identity, _ int64, in transfers.RestitutionProposalInput) (transfers.RestitutionOperation, error) {
	s.calls = append(s.calls, "propose")
	s.proposal = in
	return s.op, s.mutationErr
}
func (s *r4StoreStub) DecideRestitution(_ context.Context, _ auth.Identity, _ int64, in transfers.RestitutionDecisionInput) (transfers.RestitutionOperation, error) {
	s.calls = append(s.calls, "decide")
	s.decision = in
	return s.op, s.mutationErr
}
func (s *r4StoreStub) GetRestitutions(context.Context, auth.Identity, int64) (transfers.Restitutions, error) {
	s.calls = append(s.calls, "get")
	return s.snapshot, s.readErr
}
func r4Dispatch(s *r4StoreStub, action, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest("POST", "/api/transfers/1/restitutions", strings.NewReader(body))
	r.SetPathValue("id", "1")
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	dispatchRestitution(w, r, auth.Identity{}, s, action)
	return w
}
func r4HTTPBody(variant int, key, revision, quantity, reason string) string {
	body := fmt.Sprintf(`{"variant_id":%d,"operation_key":%q,"expected_revision":%q,"reason":%q`, variant, key, revision, reason)
	if quantity != "" {
		body += fmt.Sprintf(`,"retained_quantity":%q,"retained_at_origin":true`, quantity)
	}
	return body + "}"
}

// Set up D=5,C=4 through the unchanged real HTTP transitions and their full
// stock proofs. Neither shortage nor a destination assertion creates retention.
func r4HTTPReceived(t *testing.T, f *transferHTTPFixture) transferDTO {
	t.Helper()
	body := `{"kind":"request_stock","counterparty_location_id":1,"retry_key":"r4-http-create-0001","items":[{"variant_id":1,"quantity":"5"},{"variant_id":2,"quantity":"1"}]}`
	original := transferWireRecord(t, f.request(t, 2, "POST", "/api/transfers", body), 201)
	var approved transferDTO
	approval := decisionServe(t, f, f.newRequest(1, "POST", "/api/transfers/"+original.ID+"/approve", "{}"), original)
	if json.Unmarshal(approval.Body.Bytes(), &approved) != nil {
		t.Fatal("approved fixture decode")
	}
	proof := dispatchProof(t, f, approved)
	w := receiptHTTPMutation(f, f.newRequest(1, "POST", "/api/transfers/"+original.ID+"/dispatch", "{}"))
	proof(w)
	var transit transferDTO
	if json.Unmarshal(w.Body.Bytes(), &transit) != nil {
		t.Fatal("dispatched fixture decode")
	}
	receiptProof := receiptHTTPProof(t, f, transit, 4, 1)
	w = receiptHTTPMutation(f, f.newRequest(2, "POST", "/api/transfers/"+original.ID+"/receive", `{"items":[{"variant_id":1,"actual_quantity":"4"},{"variant_id":2,"actual_quantity":"1"},{"variant_id":3,"actual_quantity":"7"}]}`))
	receiptProof(w)
	var received transferDTO
	if json.Unmarshal(w.Body.Bytes(), &received) != nil {
		t.Fatal("received fixture decode")
	}
	return received
}
func r4HTTPOperation(t *testing.T, w *httptest.ResponseRecorder) restitutionOperationDTO {
	t.Helper()
	if len(transferObject(t, w, 200)) != 13 {
		t.Fatal("all persisted operation fields required")
	}
	if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Content-Type-Options") != "nosniff" || len(w.Result().Cookies()) != 0 {
		t.Fatal("operation security headers")
	}
	var op restitutionOperationDTO
	if json.Unmarshal(w.Body.Bytes(), &op) != nil {
		t.Fatal("operation decode")
	}
	stamp, err := time.Parse(time.RFC3339Nano, op.RecordedAt)
	if err != nil || op.RecordedAt != countStamp(stamp) {
		t.Fatal("operation canonical timestamp")
	}
	return op
}
func r4HTTPSnapshot(t *testing.T, f *transferHTTPFixture, actor int, id string) restitutionSnapshotDTO {
	t.Helper()
	w := f.request(t, actor, "GET", "/api/transfers/"+id+"/restitutions", "")
	if len(transferObject(t, w, 200)) != 3 {
		t.Fatal("private snapshot root")
	}
	var out restitutionSnapshotDTO
	if json.Unmarshal(w.Body.Bytes(), &out) != nil || out.RequestID != id {
		t.Fatal("private history decode")
	}
	return out
}

// Unlike the destination-only C4 proof, adoption here allows precisely one
// origin credit and nothing else across all 570 balances and original evidence.
func r4HTTPProof(t *testing.T, f *transferHTTPFixture, origin, variant int, delta int64) func(*httptest.ResponseRecorder) {
	t.Helper()
	original := countHTTPOriginal(t, f)
	var expected string
	if f.p.QueryRow(f.ctx, `SELECT jsonb_agg(to_jsonb(b)||jsonb_build_object(
 'existing',b.existing+CASE WHEN location_id=$1 AND variant_id=$2 THEN $3::bigint ELSE 0 END,
 'available',b.available+CASE WHEN location_id=$1 AND variant_id=$2 THEN $3::bigint ELSE 0 END) ORDER BY location_id,variant_id)::text FROM inventory_balances b`, origin, variant, delta).Scan(&expected) != nil {
		t.Fatal("origin credit expectation")
	}
	return func(w *httptest.ResponseRecorder) {
		op := r4HTTPOperation(t, w)
		if op.SourceExistingBefore == nil || op.SourceExistingAfter == nil || op.Action != "accept" {
			t.Fatal("missing persisted stock snapshots")
		}
		if f.stock(t) != expected || countHTTPOriginal(t, f) != original {
			t.Fatal("origin credit changed reservations, destination or original receipt/dispatch")
		}
		f.baseline = expected
	}
}
func r4HTTPEffects(t *testing.T, f *transferHTTPFixture) string {
	t.Helper()
	var got string
	if f.p.QueryRow(f.ctx, `SELECT jsonb_build_array(
 (SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY operation_key),'[]') FROM transfer_restitution_operations o),
 (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY request_id,variant_id,revision),'[]') FROM transfer_restitution_proposals p),
 (SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY request_id,variant_id,revision),'[]') FROM transfer_restitution_decisions d),
 (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY request_id,variant_id,revision),'[]') FROM transfer_restitution_applications a),
 (SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY operation_key),'[]') FROM transfer_count_operations o),
 (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY request_id,variant_id,revision),'[]') FROM transfer_count_proposals p),
 (SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY request_id,variant_id,revision),'[]') FROM transfer_count_decisions d),
 (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY request_id,variant_id,revision),'[]') FROM transfer_count_applications a),
 (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY scope),'[]') FROM realtime_revisions r))::text`).Scan(&got) != nil {
		t.Fatal("complete restitution evidence snapshot")
	}
	return fenceSnapshot(t, f) + countHTTPOriginal(t, f) + got
}

func TestR4RestitutionDispatchExactDTO(t *testing.T) {
	s := &r4StoreStub{snapshot: transfers.Restitutions{RequestID: math.MaxInt64, Lines: []transfers.RestitutionLineState{{
		VariantID: 1, ExpectedQuantity: 5, OriginalCredit: 5, EffectiveDispatch: math.MaxInt64,
		ReconciliationRevision: math.MaxInt64, EffectiveCredit: 7,
		Proposals: []transfers.RestitutionProposal{{BaseDispatch: 9007199254740993}},
	}}}}
	w := r4Dispatch(s, "", "")
	root := transferObject(t, w, 200)
	var lines []map[string]json.RawMessage
	if err := json.Unmarshal(root["lines"], &lines); err != nil {
		t.Fatal(err)
	}
	for field, want := range map[string]string{"expected_quantity": `"5"`, "original_credit": `"5"`, "effective_credit": `"7"`,
		"effective_dispatch": `"9223372036854775807"`, "reconciliation_revision": `"9223372036854775807"`, "count_applied_revision": `"0"`} {
		if string(lines[0][field]) != want {
			t.Fatalf("lossy wire %s: %s", field, lines[0][field])
		}
	}
	var proposals []map[string]json.RawMessage
	if err := json.Unmarshal(lines[0]["proposals"], &proposals); err != nil || string(proposals[0]["base_dispatch"]) != `"9007199254740993"` {
		t.Fatal("historical dispatch replaced or rounded", err)
	}
	if !reflect.DeepEqual(s.calls, []string{"get"}) {
		t.Fatal("GET mutated Store")
	}
}

func TestR4RestitutionDispatchContract(t *testing.T) {
	f := transferFixture(t)
	received := r4HTTPReceived(t, f)
	path := "/api/transfers/" + received.ID + "/restitutions"
	r4HTTPOperation(t, f.request(t, 1, "POST", path+"/propose", r4HTTPBody(1, "t4b-original-proposal", "0", "1", "retained")))
	before := r4HTTPEffects(t, f)
	w := f.request(t, 2, "GET", path, "")
	root := transferObject(t, w, 200)
	var lines []map[string]json.RawMessage
	if err := json.Unmarshal(root["lines"], &lines); err != nil {
		t.Fatal(err)
	}
	for field, want := range map[string]string{"expected_quantity": `"5"`, "original_credit": `"4"`, "effective_dispatch": `"5"`, "reconciliation_revision": `"0"`} {
		if string(lines[0][field]) != want {
			t.Fatalf("wire %s = %s, want %s", field, lines[0][field], want)
		}
	}
	var proposals []map[string]json.RawMessage
	if err := json.Unmarshal(lines[0]["proposals"], &proposals); err != nil || len(proposals) != 1 {
		t.Fatal("proposal wire", err)
	}
	if string(proposals[0]["base_dispatch"]) != `"5"` || len(lines[0]) != 12 || len(proposals[0]) != 16 {
		t.Fatal("required historical dispatch or exact keys missing")
	}
	expectTransferError(t, f.request(t, 3, "GET", path, ""), 404, "not_found")
	expectTransferError(t, f.request(t, 1, "GET", path+"?", ""), 400, "invalid_request")
	if r4HTTPEffects(t, f) != before {
		t.Fatal("GET or invalid GET changed stock/history/counters")
	}
}

func TestR4RestitutionHTTPAdmission(t *testing.T) {
	f := transferFixture(t)
	received := r4HTTPReceived(t, f)
	path := "/api/transfers/" + received.ID + "/restitutions"
	before := r4HTTPEffects(t, f)
	for _, action := range []string{"", "/propose", "/accept", "/reject"} {
		verb, wrong := "POST", "GET"
		if action == "" {
			verb, wrong = "GET", "POST"
		}
		expectTransferError(t, f.request(t, 0, wrong, path+action, "junk"), 405, "method_not_allowed")
		expectTransferError(t, f.request(t, 0, verb, path+action, "junk"), 401, "unauthenticated")
		expectTransferError(t, f.request(t, 1, verb, path+action+"?", "junk"), 400, "invalid_request")
		r := f.newRequest(1, verb, path+action, "junk")
		r.AddCookie(&http.Cookie{Name: sessionCookie, Value: f.tokens[0]})
		expectTransferError(t, f.serve(t, r), 400, "invalid_request")
	}
	for _, suffix := range []string{"/", "/accept/", "/unknown", "/propose/extra", "/accept/extra"} {
		w := f.request(t, 1, "POST", path+suffix, "junk")
		expectTransferError(t, w, 404, "not_found")
		if w.Header().Get("Location") != "" {
			t.Fatal("denial route redirected")
		}
	}
	for _, id := range []string{"0", "01", "-1", "1.0", "9223372036854775808"} {
		expectTransferError(t, f.request(t, 1, "GET", "/api/transfers/"+id+"/restitutions", ""), 400, "invalid_request")
	}
	expectTransferError(t, f.request(t, 1, "POST", "/api/transfers/%31/restitutions/propose", "junk"), 400, "invalid_request")
	expectTransferError(t, f.request(t, 1, "POST", "/api/transfers//1/restitutions/propose", "junk"), 404, "not_found")
	for _, action := range []string{"propose", "accept", "reject"} {
		for _, guard := range []string{"site", "empty_site", "duplicate_site", "origin", "foreign_origin", "duplicate_origin", "csrf", "foreign_csrf", "duplicate_csrf"} {
			r := f.newRequest(1, "POST", "/api/transfers/01/restitutions/"+action, "junk")
			switch guard {
			case "site":
				r.Header.Set("Sec-Fetch-Site", "cross-site")
			case "empty_site":
				r.Header.Set("Sec-Fetch-Site", "")
			case "duplicate_site":
				r.Header.Add("Sec-Fetch-Site", "same-origin")
			case "origin":
				r.Header.Del("Origin")
			case "foreign_origin":
				r.Header.Set("Origin", "https://foreign.invalid")
			case "duplicate_origin":
				r.Header.Add("Origin", f.cfg.Origin)
			case "csrf":
				r.Header.Del("X-CSRF-Token")
			case "foreign_csrf":
				r.Header.Set("X-CSRF-Token", "wrong")
			case "duplicate_csrf":
				r.Header.Add("X-CSRF-Token", r.Header.Get("X-CSRF-Token"))
			}
			expectTransferError(t, f.serve(t, r), 403, "forbidden")
		}
		// Malformed private bodies never bypass the lightweight participant fence.
		for _, body := range []string{"junk", "null", r4Proposal} {
			expectTransferError(t, f.request(t, 3, "POST", path+"/"+action, body), 404, "not_found")
			expectTransferError(t, f.request(t, 1, "POST", "/api/transfers/9223372036854775807/restitutions/"+action, body), 404, "not_found")
		}
	}
	expectTransferError(t, f.request(t, 3, "GET", path, ""), 404, "not_found")
	expectTransferError(t, f.request(t, 1, "GET", "/api/transfers/9223372036854775807/restitutions", ""), 404, "not_found")
	r := f.newRequest(1, "POST", path+"/propose", r4HTTPBody(1, "r4-admission-overlimit", "0", "2", "exceeds debit"))
	r.Header.Del("Sec-Fetch-Site")
	expectTransferError(t, f.serve(t, r), 409, "decision_conflict")
	expectTransferError(t, f.request(t, 2, "POST", path+"/propose", r4HTTPBody(1, "r4-admission-wrongrole", "0", "1", "retained")), 403, "forbidden")
	for _, body := range []string{
		"null", r4Proposal + " {}", r4Proposal + strings.Repeat(" ", 64<<10),
		strings.Replace(r4Proposal, "☃", string([]byte{0xff}), 1),
		strings.Replace(r4Proposal, `"variant_id":1`, `"variant_id":1,"variant\u005fid":1`, 1),
		strings.Replace(r4Proposal, `"expected_revision":"0"`, `"expected_revision":0`, 1),
		strings.Replace(r4Proposal, `"retained_at_origin":true`, `"retained_at_origin":false`, 1),
		strings.TrimSuffix(r4Proposal, "}") + `,"actor_location_id":1`,
	} {
		expectTransferError(t, f.request(t, 1, "POST", path+"/propose", body), 400, "invalid_request")
	}
	r = f.newRequest(1, "POST", path+"/propose", r4Proposal)
	r.Header.Set("Content-Type", "text/plain")
	expectTransferError(t, f.serve(t, r), 400, "invalid_request")
	r = f.newRequest(1, "POST", path+"/propose", r4Proposal)
	r.Header.Add("Content-Type", "application/json")
	expectTransferError(t, f.serve(t, r), 400, "invalid_request")
	r = f.newRequest(1, "POST", path+"/propose", r4Proposal)
	r.Body = r4ReadError{}
	expectTransferError(t, f.serve(t, r), 400, "invalid_request")
	if r4HTTPEffects(t, f) != before {
		t.Fatal("guard/privacy/schema failure changed stock or evidence")
	}
	origin := r4HTTPSnapshot(t, f, 1, received.ID)
	destination := r4HTTPSnapshot(t, f, 2, received.ID)
	if !reflect.DeepEqual(origin, destination) || len(origin.Lines) != 2 || len(origin.Operations) != 0 || origin.Lines[0].ExpectedQuantity != "5" || origin.Lines[0].OriginalCredit != "4" || origin.Lines[0].EffectiveCredit != "4" {
		t.Fatal("initial bilateral expected-line history")
	}
	f.clock.Add(int64(2 * time.Minute))
	sessionBefore := passiveState(t, f)
	r = f.newRequest(1, "GET", path, "")
	r.Header.Set(passiveHeader, "1")
	transferObject(t, f.serve(t, r), 200)
	if passiveState(t, f) != sessionBefore {
		t.Fatal("passive history touched session")
	}
	transferObject(t, f.request(t, 1, "GET", path, ""), 200)
	if passiveState(t, f) == sessionBefore {
		t.Fatal("normal history bypassed Current")
	}
}

func TestR4RestitutionHTTPWorkflowReplay(t *testing.T) {
	f := transferFixture(t)
	var initialOrigin, initialDestination int64
	if f.p.QueryRow(f.ctx, `SELECT (SELECT existing FROM inventory_balances WHERE location_id=1 AND variant_id=1),(SELECT existing FROM inventory_balances WHERE location_id=2 AND variant_id=1)`).Scan(&initialOrigin, &initialDestination) != nil {
		t.Fatal("initial bilateral stock")
	}
	received := r4HTTPReceived(t, f)
	path := "/api/transfers/" + received.ID + "/restitutions"
	original := countHTTPOriginal(t, f)
	propose := r4HTTPBody(1, "r4-workflow-propose-001", "0", "1", "  retained ☃  ")
	first := f.request(t, 1, "POST", path+"/propose", propose)
	op := r4HTTPOperation(t, first)
	if op.ActorLocationID != 1 || op.RequestID != received.ID || op.RetainedQuantity == nil || *op.RetainedQuantity != "1" || op.RetainedAtOrigin == nil || !*op.RetainedAtOrigin || op.Reason != "  retained ☃  " || op.Revision != "1" || op.SourceExistingBefore != nil {
		t.Fatal("proposal literal wire")
	}
	pending := r4HTTPSnapshot(t, f, 2, received.ID).Lines[0].Proposals[0]
	if pending.State != "pending" || pending.Decision != nil || pending.Application != nil || pending.BaseRevision != "0" || pending.CountGeneration != "0" || pending.CountAppliedRevision != "0" || pending.BaseCredit != "4" || pending.BaseRestitution != "0" {
		t.Fatal("pending consent pins")
	}
	reject := r4HTTPBody(1, "r4-workflow-reject-001", "1", "", "not confirmed")
	expectTransferError(t, f.request(t, 1, "POST", path+"/reject", reject), 403, "forbidden")
	rejected := f.request(t, 2, "POST", path+"/reject", reject)
	decision := r4HTTPOperation(t, rejected)
	if decision.RetainedQuantity != nil || decision.RetainedAtOrigin != nil || decision.SourceExistingBefore != nil || decision.SourceExistingAfter != nil {
		t.Fatal("decision retention not null")
	}
	fresh := r4HTTPBody(1, "r4-workflow-propose-002", "1", "1", "fresh attestation")
	second := f.request(t, 1, "POST", path+"/propose", fresh)
	r4HTTPOperation(t, second)
	accept := r4HTTPBody(1, "r4-workflow-accept-002", "2", "", "confirmed")
	expectTransferError(t, f.request(t, 1, "POST", path+"/accept", accept), 403, "forbidden")
	proof := r4HTTPProof(t, f, 1, 1, 1)
	accepted := receiptHTTPMutation(f, f.newRequest(2, "POST", path+"/accept", accept))
	proof(accepted)
	acceptedOp := r4HTTPOperation(t, accepted)
	if acceptedOp.RetainedQuantity != nil || acceptedOp.RetainedAtOrigin != nil || *acceptedOp.SourceExistingBefore != countInt(initialOrigin-5) || *acceptedOp.SourceExistingAfter != countInt(initialOrigin-4) {
		t.Fatal("immutable source before/after")
	}
	var origin, destination int64
	if f.p.QueryRow(f.ctx, `SELECT (SELECT existing FROM inventory_balances WHERE location_id=1 AND variant_id=1),(SELECT existing FROM inventory_balances WHERE location_id=2 AND variant_id=1)`).Scan(&origin, &destination) != nil || origin != initialOrigin-4 || destination != initialDestination+4 || origin+destination != initialOrigin+initialDestination {
		t.Fatal("D5 C4 R1 conservation")
	}
	state := r4HTTPSnapshot(t, f, 1, received.ID)
	line := state.Lines[0]
	if line.WorkflowRevision != "2" || line.AppliedRevision != "2" || line.AppliedRetainedQuantity != "1" || line.OriginalCredit != "4" || line.EffectiveCredit != "4" || len(line.Proposals) != 2 || line.Proposals[0].State != "rejected" || line.Proposals[1].State != "applied" || line.Proposals[1].Application.Quantity != "1" || line.Proposals[1].Application.OriginLocationID != 1 {
		t.Fatal("complete immutable history")
	}
	before := r4HTTPEffects(t, f)
	for _, retry := range []struct {
		actor        int
		action, body string
		prior        *httptest.ResponseRecorder
	}{{1, "propose", propose, first}, {2, "reject", reject, rejected}, {1, "propose", fresh, second}, {2, "accept", accept, accepted}} {
		w := f.request(t, retry.actor, "POST", path+"/"+retry.action, retry.body)
		if w.Code != 200 || w.Body.String() != retry.prior.Body.String() {
			t.Fatal("persisted retry changed JSON")
		}
	}
	expectTransferError(t, f.request(t, 1, "POST", path+"/propose", strings.Replace(propose, "retained ☃", "changed", 1)), 409, "retry_conflict")
	expectTransferError(t, f.request(t, 2, "POST", path+"/reject", accept), 409, "retry_conflict")
	expectTransferError(t, f.request(t, 2, "POST", path+"/accept", r4HTTPBody(1, "r4-workflow-duplicate-key", "2", "", "again")), 409, "decision_conflict")
	expectTransferError(t, f.request(t, 1, "POST", path+"/propose", r4HTTPBody(1, "r4-workflow-duplicate-proposal", "2", "1", "again")), 409, "decision_conflict")
	expectTransferError(t, f.request(t, 3, "POST", path+"/accept", accept), 404, "not_found")
	if r4HTTPEffects(t, f) != before || countHTTPOriginal(t, f) != original {
		t.Fatal("replays/conflicts double credited or rewrote history")
	}
	if !reflect.DeepEqual(state, r4HTTPSnapshot(t, f, 2, received.ID)) {
		t.Fatal("bilateral complete history differs")
	}
	// Test-owned setup alters today's origin stock after application; an exact
	// retry must still expose the original committed snapshots, never today's.
	r4HTTPStockSetup(t, f, 1, 1, 10)
	before = r4HTTPEffects(t, f)
	replay := f.request(t, 2, "POST", path+"/accept", accept)
	if replay.Code != 200 || replay.Body.String() != accepted.Body.String() || r4HTTPEffects(t, f) != before {
		t.Fatal("replay recomputed stock snapshots")
	}
}

// Isolated fixture-only stock setup proves the exact full transformation before
// adopting it. No production guard is disabled and original evidence survives.
func r4HTTPStockSetup(t *testing.T, f *transferHTTPFixture, location, variant int, delta int64) {
	t.Helper()
	original := countHTTPOriginal(t, f)
	var expected string
	if f.p.QueryRow(f.ctx, `SELECT jsonb_agg(to_jsonb(b)||jsonb_build_object(
 'existing',b.existing+CASE WHEN location_id=$1 AND variant_id=$2 THEN $3::bigint ELSE 0 END,
 'available',b.available+CASE WHEN location_id=$1 AND variant_id=$2 THEN $3::bigint ELSE 0 END) ORDER BY location_id,variant_id)::text FROM inventory_balances b`, location, variant, delta).Scan(&expected) != nil {
		t.Fatal("owned stock setup expectation")
	}
	if _, err := f.p.Exec(f.ctx, `UPDATE inventory_balances SET existing=existing+$3 WHERE location_id=$1 AND variant_id=$2`, location, variant, delta); err != nil {
		t.Fatal("owned stock setup failed")
	}
	if f.stock(t) != expected || countHTTPOriginal(t, f) != original {
		t.Fatal("owned setup changed other stock/evidence")
	}
	f.baseline = expected
}

func TestR4RestitutionHTTPCrossWorkflow(t *testing.T) {
	f := transferFixture(t)
	received := r4HTTPReceived(t, f)
	root := "/api/transfers/" + received.ID
	path := root + "/restitutions"
	counts := root + "/count-corrections"
	countHTTPOperation(t, f.request(t, 1, "POST", counts+"/propose", countHTTPBody(1, "r4-count-propose-001", "0", "3", "recount")))
	before := r4HTTPEffects(t, f)
	expectTransferError(t, f.request(t, 1, "POST", path+"/propose", r4HTTPBody(1, "r4-pending-blocked-001", "0", "1", "retained")), 409, "decision_conflict")
	if r4HTTPEffects(t, f) != before {
		t.Fatal("pending count conflict changed evidence")
	}
	countHTTPOperation(t, f.request(t, 2, "POST", counts+"/reject", countHTTPBody(1, "r4-count-reject-001", "1", "", "reject")))
	r4HTTPOperation(t, f.request(t, 1, "POST", path+"/propose", r4HTTPBody(1, "r4-pinned-proposal-001", "0", "1", "retained")))
	pinned := r4HTTPSnapshot(t, f, 1, received.ID).Lines[0].Proposals[0]
	if pinned.CountGeneration != "2" || pinned.CountAppliedRevision != "0" || pinned.BaseCredit != "4" {
		t.Fatal("count-generation predecessor not pinned")
	}
	countHTTPOperation(t, f.request(t, 1, "POST", counts+"/propose", countHTTPBody(1, "r4-count-propose-002", "1", "3", "fresh recount")))
	countHTTPOperation(t, f.request(t, 2, "POST", counts+"/reject", countHTTPBody(1, "r4-count-reject-002", "2", "", "reject")))
	before = r4HTTPEffects(t, f)
	expectTransferError(t, f.request(t, 2, "POST", path+"/accept", r4HTTPBody(1, "r4-stale-count-accept", "1", "", "confirmed")), 409, "decision_conflict")
	if r4HTTPEffects(t, f) != before {
		t.Fatal("stale count consent changed evidence")
	}
	r4HTTPOperation(t, f.request(t, 1, "POST", path+"/propose", r4HTTPBody(1, "r4-pinned-proposal-002", "1", "1", "fresh retained")))
	pinned = r4HTTPSnapshot(t, f, 1, received.ID).Lines[0].Proposals[1]
	if pinned.CountGeneration != "4" || pinned.BaseRevision != "1" || pinned.CountAppliedRevision != "0" {
		t.Fatal("replacement did not refresh consent")
	}
	proof := r4HTTPProof(t, f, 1, 1, 1)
	w := receiptHTTPMutation(f, f.newRequest(2, "POST", path+"/accept", r4HTTPBody(1, "r4-pinned-accept-002", "2", "", "confirmed")))
	proof(w)
	countHTTPOperation(t, f.request(t, 1, "POST", counts+"/propose", countHTTPBody(1, "r4-cap-count-propose", "2", "5", "recount full")))
	before = r4HTTPEffects(t, f)
	countBefore := countHTTPSnapshot(t, f, received.ID)
	expectTransferError(t, f.request(t, 2, "POST", counts+"/accept", countHTTPBody(1, "r4-cap-count-accept", "3", "", "confirmed")), 409, "decision_conflict")
	if r4HTTPEffects(t, f) != before || !reflect.DeepEqual(countBefore, countHTTPSnapshot(t, f, received.ID)) {
		t.Fatal("R+C cap failure changed either workflow")
	}
	countHTTPOperation(t, f.request(t, 2, "POST", counts+"/reject", countHTTPBody(1, "r4-cap-count-reject", "3", "", "reject")))
	countHTTPOperation(t, f.request(t, 1, "POST", counts+"/propose", countHTTPBody(1, "r4-lower-count-propose", "3", "3", "lower credit")))
	proofCount := countHTTPProof(t, f, 2, 1, -1)
	w = receiptHTTPMutation(f, f.newRequest(2, "POST", counts+"/accept", countHTTPBody(1, "r4-lower-count-accept", "4", "", "confirmed")))
	proofCount(w)
	line := r4HTTPSnapshot(t, f, 1, received.ID).Lines[0]
	if line.CountGeneration != "8" || line.CountAppliedRevision != "4" || line.EffectiveCredit != "3" || line.AppliedRetainedQuantity != "1" || line.Proposals[1].CountGeneration != "4" || line.Proposals[1].CountAppliedRevision != "0" || line.Proposals[1].BaseCredit != "4" {
		t.Fatal("current count pins overwrote historical predecessor")
	}
}

func TestR4RestitutionHTTPAppliedCountPins(t *testing.T) {
	f := transferFixture(t)
	received := r4HTTPReceived(t, f)
	root := "/api/transfers/" + received.ID
	counts := root + "/count-corrections"
	path := root + "/restitutions"
	countHTTPOperation(t, f.request(t, 1, "POST", counts+"/propose", countHTTPBody(1, "r4-count-pin-propose", "0", "3", "recount")))
	countProof := countHTTPProof(t, f, 2, 1, -1)
	w := receiptHTTPMutation(f, f.newRequest(2, "POST", counts+"/accept", countHTTPBody(1, "r4-count-pin-accept", "1", "", "confirmed")))
	countProof(w)
	r4HTTPOperation(t, f.request(t, 1, "POST", path+"/propose", r4HTTPBody(1, "r4-after-count-propose", "0", "1", "one of two retained")))
	line := r4HTTPSnapshot(t, f, 1, received.ID).Lines[0]
	p := line.Proposals[0]
	if line.CountGeneration != "2" || line.CountAppliedRevision != "1" || line.EffectiveCredit != "3" || p.CountGeneration != "2" || p.CountAppliedRevision != "1" || p.BaseCredit != "3" || p.BaseRestitution != "0" {
		t.Fatal("applied count predecessor tuple not transported")
	}
	proof := r4HTTPProof(t, f, 1, 1, 1)
	w = receiptHTTPMutation(f, f.newRequest(2, "POST", path+"/accept", r4HTTPBody(1, "r4-after-count-accept", "1", "", "confirmed")))
	proof(w)
	line = r4HTTPSnapshot(t, f, 2, received.ID).Lines[0]
	if line.AppliedRetainedQuantity != "1" || line.EffectiveCredit != "3" || line.OriginalCredit != "4" || line.Proposals[0].Application.Quantity != "1" {
		t.Fatal("partial settlement conservation history")
	}
	before := r4HTTPEffects(t, f)
	expectTransferError(t, f.request(t, 1, "POST", path+"/propose", r4HTTPBody(1, "r4-second-partial-key", "1", "1", "another retained")), 409, "decision_conflict")
	if r4HTTPEffects(t, f) != before {
		t.Fatal("partial settlement allowed a second application")
	}
}

func TestR4RestitutionHTTPFailuresRollback(t *testing.T) {
	for _, mode := range []string{"overflow", "deferred_commit"} {
		t.Run(mode, func(t *testing.T) {
			f := transferFixture(t)
			received := r4HTTPReceived(t, f)
			path := "/api/transfers/" + received.ID + "/restitutions"
			for _, variant := range []int{3, 4} {
				expectTransferError(t, f.request(t, 1, "POST", path+"/propose", r4HTTPBody(variant, "r4-unexpected-line-key", "0", "1", "retained")), 400, "invalid_request")
			}
			r4HTTPOperation(t, f.request(t, 1, "POST", path+"/propose", r4HTTPBody(1, "r4-failure-proposal-key", "0", "1", "retained")))
			accept := r4HTTPBody(1, "r4-failure-accept-key", "1", "", "confirmed")
			status, code := 503, "service_unavailable"
			if mode == "overflow" {
				var existing int64
				if f.p.QueryRow(f.ctx, `SELECT existing FROM inventory_balances WHERE location_id=1 AND variant_id=1`).Scan(&existing) != nil {
					t.Fatal("overflow setup read")
				}
				r4HTTPStockSetup(t, f, 1, 1, math.MaxInt64-existing)
				status, code = 409, "insufficient_stock"
			} else {
				if _, err := f.p.Exec(f.ctx, `CREATE FUNCTION r4_fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private injected commit failure'; END $$;
 CREATE CONSTRAINT TRIGGER r4_fail_commit AFTER INSERT ON transfer_restitution_applications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION r4_fail_commit()`); err != nil {
					t.Fatal("owned deferred constraint setup")
				}
				before := r4HTTPEffects(t, f)
				tx, err := f.p.Begin(f.ctx)
				if err != nil {
					t.Fatal("deferred probe begin")
				}
				var revision int64
				err = tx.QueryRow(f.ctx, `SELECT revision FROM transfer_restitute($1::bigint,1,2::smallint,'r4-precommit-probe-key','accept',1,NULL,NULL,'confirmed')`, received.ID).Scan(&revision)
				if err != nil {
					_ = tx.Rollback(f.ctx)
					t.Fatal("deferred probe failed before COMMIT")
				}
				if revision != 1 {
					_ = tx.Rollback(f.ctx)
					t.Fatal("probe missing precommit operation")
				}
				if tx.Commit(f.ctx) == nil {
					t.Fatal("deferred probe COMMIT unexpectedly succeeded")
				}
				if r4HTTPEffects(t, f) != before {
					t.Fatal("failed probe COMMIT leaked effects")
				}
				session, _, err := f.svc.Peek(f.ctx, f.tokens[1])
				if err != nil {
					t.Fatal("owned session identity")
				}
				op, err := transfers.New(f.p).DecideRestitution(f.ctx, session.Identity, mustR4ID(t, received.ID), transfers.RestitutionDecisionInput{VariantID: 1, OperationKey: "r4-zero-operation-proof", ExpectedRevision: 1, Accept: true, Reason: "confirmed"})
				if !errors.Is(err, transfers.ErrUnavailable) || !reflect.DeepEqual(op, transfers.RestitutionOperation{}) || r4HTTPEffects(t, f) != before {
					t.Fatal("deferred failure did not return zero operation/rollback")
				}
			}
			before := r4HTTPEffects(t, f)
			expectTransferError(t, f.request(t, 2, "POST", path+"/accept", accept), status, code)
			if r4HTTPEffects(t, f) != before {
				t.Fatal("HTTP failed mutation leaked credit/evidence/invalidation")
			}
			history := r4HTTPSnapshot(t, f, 1, received.ID).Lines[0]
			if history.AppliedRetainedQuantity != "0" || history.Proposals[0].Decision != nil || history.Proposals[0].Application != nil {
				t.Fatal("failed mutation published partial history")
			}
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			r := f.newRequest(1, "POST", path+"/propose", r4Proposal).WithContext(ctx)
			expectTransferError(t, f.serve(t, r), 503, "service_unavailable")
			if r4HTTPEffects(t, f) != before {
				t.Fatal("canceled request changed effects")
			}
		})
	}
}
func mustR4ID(t *testing.T, id string) int64 {
	t.Helper()
	n, err := canonicalTransferInteger(id, math.MaxInt64)
	if err != nil {
		t.Fatal("fixture ID")
	}
	return n
}

func TestR4RestitutionDispatch(t *testing.T) {
	t.Run("privacy precedes body", func(t *testing.T) {
		for _, tc := range []struct {
			err    error
			status int
			code   string
		}{{transfers.ErrNotFound, 404, "not_found"}, {transfers.ErrForbidden, 403, "forbidden"}, {transfers.ErrUnavailable, 503, "service_unavailable"}} {
			s := &r4StoreStub{accessErr: tc.err}
			w := r4Dispatch(s, "propose", "junk")
			expectTransferError(t, w, tc.status, tc.code)
			if !reflect.DeepEqual(s.calls, []string{"access"}) {
				t.Fatal("POST must fence before decode and never load history")
			}
		}
	})
	t.Run("persisted replay without history", func(t *testing.T) {
		q := int64(7)
		s := &r4StoreStub{op: transfers.RestitutionOperation{RequestID: 1, Revision: 8, SourceExistingBefore: &q, SourceExistingAfter: &q}, readErr: transfers.ErrReadUnavailable}
		first := r4Dispatch(s, "propose", r4Proposal)
		second := r4Dispatch(s, "propose", r4Proposal)
		if first.Code != 200 || first.Body.String() != second.Body.String() || !reflect.DeepEqual(s.calls, []string{"access", "propose", "access", "propose"}) {
			t.Fatal("retry must return exact persisted operation without history")
		}
		if s.proposal.Reason != "  retained ☃  " || !s.proposal.RetainedAtOrigin {
			t.Fatal("proposal identity changed")
		}
	})
	t.Run("route owns decision", func(t *testing.T) {
		for _, action := range []string{"accept", "reject"} {
			s := &r4StoreStub{}
			w := r4Dispatch(s, action, r4Decision)
			if w.Code != 200 || s.decision.Accept != (action == "accept") || !reflect.DeepEqual(s.calls, []string{"access", "decide"}) {
				t.Fatal("decision dispatch")
			}
		}
		s := &r4StoreStub{}
		expectTransferError(t, r4Dispatch(s, "unknown", r4Decision), 400, "invalid_request")
		if len(s.calls) != 0 {
			t.Fatal("unknown action defaulted to rejection")
		}
	})
	t.Run("GET exactly one history call", func(t *testing.T) {
		s := &r4StoreStub{snapshot: transfers.Restitutions{RequestID: 1}}
		w := r4Dispatch(s, "", "")
		if w.Code != 200 || !reflect.DeepEqual(s.calls, []string{"get"}) {
			t.Fatal("GET access/history fanout")
		}
		s = &r4StoreStub{snapshot: transfers.Restitutions{RequestID: 123}, readErr: transfers.ErrReadUnavailable}
		w = r4Dispatch(s, "", "")
		expectTransferError(t, w, 503, "service_unavailable")
		if strings.Contains(w.Body.String(), "123") {
			t.Fatal("partial history leak")
		}
	})
	t.Run("sanitized mutation errors", func(t *testing.T) {
		for _, tc := range []struct {
			err    error
			status int
			code   string
		}{{transfers.ErrInvalid, 400, "invalid_request"}, {transfers.ErrForbidden, 403, "forbidden"}, {transfers.ErrNotFound, 404, "not_found"}, {transfers.ErrRetryConflict, 409, "retry_conflict"}, {transfers.ErrDecisionConflict, 409, "decision_conflict"}, {transfers.ErrInsufficientStock, 409, "insufficient_stock"}, {transfers.ErrUnavailable, 503, "service_unavailable"}, {context.Canceled, 503, "service_unavailable"}, {context.DeadlineExceeded, 503, "service_unavailable"}, {errors.New("private SQL error"), 503, "service_unavailable"}} {
			s := &r4StoreStub{op: transfers.RestitutionOperation{RequestID: 999}, mutationErr: tc.err}
			expectTransferError(t, r4Dispatch(s, "propose", r4Proposal), tc.status, tc.code)
		}
	})
	t.Run("invalid body stops mutation", func(t *testing.T) {
		s := &r4StoreStub{}
		expectTransferError(t, r4Dispatch(s, "propose", "null"), 400, "invalid_request")
		if !reflect.DeepEqual(s.calls, []string{"access"}) {
			t.Fatal("decode failure mutated")
		}
	})
	t.Run("query and canonical ID before Store", func(t *testing.T) {
		for _, path := range []string{"/api/transfers/1/restitutions?", "/api/transfers/1/restitutions?a=1"} {
			r := httptest.NewRequest(http.MethodGet, path, nil)
			r.SetPathValue("id", "1")
			s := &r4StoreStub{}
			w := httptest.NewRecorder()
			dispatchRestitution(w, r, auth.Identity{}, s, "")
			expectTransferError(t, w, 400, "invalid_request")
			if len(s.calls) != 0 {
				t.Fatal("query reached Store")
			}
		}
		for _, id := range []string{"0", "01", "-1", "1.0", "9223372036854775808"} {
			r := httptest.NewRequest(http.MethodGet, "/", nil)
			r.SetPathValue("id", id)
			s := &r4StoreStub{}
			w := httptest.NewRecorder()
			dispatchRestitution(w, r, auth.Identity{}, s, "")
			expectTransferError(t, w, 400, "invalid_request")
			if len(s.calls) != 0 {
				t.Fatal("invalid ID reached Store")
			}
		}
	})
}
