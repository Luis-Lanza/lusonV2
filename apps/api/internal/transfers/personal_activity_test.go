package transfers_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/inventory"

	"luson/api/internal/auth"
	"luson/api/internal/transfers"
)

func t10Inventory(t *testing.T, ctx context.Context, p *pgxpool.Pool, who auth.Identity) []inventory.Page {
	t.Helper()
	result := []inventory.Page{}
	for location := 1; location <= 3; location++ {
		for page := 1; page <= 4; page++ {
			got, err := inventory.New(p).List(ctx, who, inventory.Query{LocationID: location, Page: page, PageSize: 50})
			if err != nil {
				t.Fatal(err)
			}
			result = append(result, got)
		}
	}
	return result
}

func TestT10ConcurrentPeerAttribution(t *testing.T) {
	ctx, p, s := fixture(t)
	if _, err := p.Exec(ctx, `INSERT INTO auth_accounts(id,location_id,username,password_hash) VALUES(20,2,'t10_concurrent_peer','opaque')`); err != nil {
		t.Fatal(err)
	}
	peer := auth.Identity{AccountID: 20, Location: auth.Location{ID: 2}}
	in := input()
	in.CounterpartyID = 3
	type reply struct {
		result transfers.CreateResult
		err    error
	}
	results := make(chan reply, 2)
	start := make(chan struct{})
	var workers sync.WaitGroup
	for _, who := range []auth.Identity{actor(2), peer} {
		workers.Add(1)
		go func(who auth.Identity) {
			defer workers.Done()
			<-start
			r, err := s.Create(ctx, who, in)
			results <- reply{r, err}
		}(who)
	}
	close(start)
	workers.Wait()
	a, b := <-results, <-results
	if a.err != nil || b.err != nil || !reflect.DeepEqual(a.result.Request, b.result.Request) || a.result.Replayed == b.result.Replayed {
		t.Fatal("concurrent location retry lost original author", a.err, b.err)
	}
	r := a.result.Request
	if len(r.Activity) != 1 || (r.Activity[0].Actor.AccountID != "2" && r.Activity[0].Actor.AccountID != "20") {
		t.Fatal("concurrent creation evidence", r.Activity)
	}
	if _, err := s.Approve(ctx, actor(3), r.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Dispatch(ctx, actor(3), r.ID); err != nil {
		t.Fatal(err)
	}
	var err error
	r, err = s.Receive(ctx, actor(2), r.ID, transfers.ReceiptInput{Items: []transfers.Line{{VariantID: 1, Quantity: 1}, {VariantID: 2, Quantity: 1}}})
	if err != nil {
		t.Fatal(err)
	}
	proposal := transfers.CountProposalInput{VariantID: 1, OperationKey: "t10-concurrent-count", Actual: 2, Reason: "verified"}
	type opReply struct {
		op  transfers.CountOperation
		err error
	}
	ops := make(chan opReply, 2)
	start = make(chan struct{})
	for _, who := range []auth.Identity{actor(2), peer} {
		workers.Add(1)
		go func(who auth.Identity) {
			defer workers.Done()
			<-start
			op, err := s.ProposeCount(ctx, who, r.ID, proposal)
			ops <- opReply{op, err}
		}(who)
	}
	close(start)
	workers.Wait()
	x, y := <-ops, <-ops
	if x.err != nil || y.err != nil || !reflect.DeepEqual(x.op, y.op) {
		t.Fatal("concurrent workflow replay", x.err, y.err)
	}
	got, err := s.Get(ctx, peer, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Activity) != len(r.Activity)+1 {
		t.Fatal("duplicate workflow actor evidence", got.Activity)
	}
	original := got
	inventoryBefore := t10Inventory(t, ctx, p, peer)
	countsBefore, err := s.Counts(ctx, peer)
	if err != nil {
		t.Fatal(err)
	}
	historyBefore, err := s.GetCountCorrections(ctx, peer, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	proposal.Actual = 3
	if _, err = s.ProposeCount(ctx, peer, r.ID, proposal); !errors.Is(err, transfers.ErrRetryConflict) {
		t.Fatal("conflicting retry", err)
	}
	got, err = s.Get(ctx, peer, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	countsAfter, err := s.Counts(ctx, peer)
	if err != nil {
		t.Fatal(err)
	}
	historyAfter, err := s.GetCountCorrections(ctx, peer, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(original, got) || !reflect.DeepEqual(inventoryBefore, t10Inventory(t, ctx, p, peer)) || !reflect.DeepEqual(countsBefore, countsAfter) || !reflect.DeepEqual(historyBefore, historyAfter) {
		t.Fatal("rejected workflow changed public effects")
	}
	for _, who := range []auth.Identity{actor(1), actor(99)} {
		want := transfers.ErrNotFound
		if who.AccountID == 99 {
			want = transfers.ErrForbidden
		}
		if _, err = s.GetCountCorrections(ctx, who, r.ID); !errors.Is(err, want) {
			t.Fatal("count history privacy", err)
		}
		if _, err = s.GetRestitutions(ctx, who, r.ID); !errors.Is(err, want) {
			t.Fatal("restitution history privacy", err)
		}
		if _, err = s.GetDispatchReconciliations(ctx, who, r.ID); !errors.Is(err, want) {
			t.Fatal("reconciliation history privacy", err)
		}
	}
}

func t10Activity(t *testing.T, r transfers.Request) []map[string]any {
	t.Helper()
	raw, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		Activity []map[string]any `json:"activity"`
	}
	if json.Unmarshal(raw, &out) != nil {
		t.Fatal("activity decoding")
	}
	return out.Activity
}
func t10Assert(t *testing.T, r transfers.Request, category, action, account string) {
	t.Helper()
	for _, e := range t10Activity(t, r) {
		if e["category"] == category && e["action"] == action {
			person, ok := e["actor"].(map[string]any)
			if !ok || person["account_id"] != account || person["username"] == "" || e["location_name"] == "" || e["recorded_at"] == "" {
				t.Fatal("incomplete actor snapshot", e)
			}
			return
		}
	}
	t.Fatalf("missing personal evidence %s/%s in %+v", category, action, t10Activity(t, r))
}
func TestT10PersonalLifecycle(t *testing.T) {
	ctx, p, s := fixture(t)
	if _, err := p.Exec(ctx, `UPDATE auth_accounts SET display_name='Ana' WHERE id=2;
 INSERT INTO auth_accounts(id,location_id,username,password_hash) VALUES(20,2,'t10_peer','opaque')`); err != nil {
		t.Fatal(err)
	}
	peer := auth.Identity{AccountID: 20, Location: auth.Location{ID: 2}}
	made := create(t, ctx, s, 2, input())
	t10Assert(t, made.Request, "transfer", "create", "2")
	replay, err := s.Create(ctx, peer, input())
	if err != nil || !replay.Replayed || !reflect.DeepEqual(made.Request, replay.Request) {
		t.Fatal("peer replay changed creation", err)
	}
	r, err := s.Approve(ctx, actor(1), made.Request.ID)
	if err != nil {
		t.Fatal(err)
	}
	t10Assert(t, r, "transfer", "approve", "1")
	r, err = s.Dispatch(ctx, actor(1), r.ID)
	if err != nil {
		t.Fatal(err)
	}
	t10Assert(t, r, "transfer", "dispatch", "1")
	r, err = s.Receive(ctx, actor(2), r.ID, transfers.ReceiptInput{Items: []transfers.Line{{VariantID: 1, Quantity: 1}, {VariantID: 2, Quantity: 1}}})
	if err != nil {
		t.Fatal(err)
	}
	t10Assert(t, r, "transfer", "receive", "2")
	before := r
	if _, err = p.Exec(ctx, `UPDATE auth_accounts SET display_name='Renamed',location_id=3,enabled=false WHERE id=2`); err != nil {
		t.Fatal(err)
	}
	r, err = s.Get(ctx, peer, r.ID)
	if err != nil || !reflect.DeepEqual(before, r) {
		t.Fatal("account lifecycle rewrote history", err)
	}
	for _, e := range t10Activity(t, r) {
		if e["actor"].(map[string]any)["account_id"] == "2" && e["actor"].(map[string]any)["display_name"] != "Ana" {
			t.Fatal("snapshot changed", e)
		}
	}
	stock := t10Inventory(t, ctx, p, peer)
	counts, err := s.Counts(ctx, peer)
	if err != nil {
		t.Fatal(err)
	}
	identical, err := s.Receive(ctx, peer, r.ID, transfers.ReceiptInput{Items: []transfers.Line{{VariantID: 1, Quantity: 1}, {VariantID: 2, Quantity: 1}}})
	if err != nil || !reflect.DeepEqual(identical, r) {
		t.Fatal("same-branch receipt replay changed original actor", err)
	}
	if _, err = s.Cancel(ctx, peer, r.ID); !errors.Is(err, transfers.ErrDecisionConflict) {
		t.Fatal(err)
	}
	if _, err = s.Receive(ctx, peer, r.ID, transfers.ReceiptInput{Items: []transfers.Line{{VariantID: 1, Quantity: 2}, {VariantID: 2, Quantity: 1}}}); !errors.Is(err, transfers.ErrRetryConflict) {
		t.Fatal(err)
	}
	after, err := s.Get(ctx, peer, r.ID)
	afterCounts, countErr := s.Counts(ctx, peer)
	if err != nil || countErr != nil || !reflect.DeepEqual(r, after) || !reflect.DeepEqual(stock, t10Inventory(t, ctx, p, peer)) || !reflect.DeepEqual(counts, afterCounts) {
		t.Fatal("rejection changed public effects", err, countErr)
	}
	for _, who := range []auth.Identity{actor(3), actor(99)} {
		_, err = s.Get(ctx, who, r.ID)
		want := transfers.ErrNotFound
		if who.AccountID == 99 {
			want = transfers.ErrForbidden
		}
		if !errors.Is(err, want) {
			t.Fatal("privacy", err)
		}
	}
}
func TestT10ActivityRetainsWriteOrder(t *testing.T) {
	ctx, p, s := fixture(t)
	in := input()
	in.RetryKey = "t10-same-statement-time"
	intent, err := transfers.Validate(actor(2), in)
	if err != nil {
		t.Fatal(err)
	}
	tx, err := p.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT set_config('luson.transfer_account_id','2',true)`); err != nil {
		t.Fatal(err)
	}
	// One SQL statement records both business effects with the same action time.
	// This is explicit personal context, unlike the legacy owner fixtures.
	_, err = tx.Exec(ctx, `DO $$ DECLARE rid bigint; BEGIN
 INSERT INTO transfer_requests(creator_location_id,kind,origin_location_id,destination_location_id,approver_location_id,retry_key,payload_sha256,created_at)
 VALUES(2,'request_stock',1,2,1,'t10-same-statement-time',decode('`+fmt.Sprintf("%x", intent.Fingerprint)+`','hex'),statement_timestamp()) RETURNING id INTO rid;
 INSERT INTO transfer_request_items(request_id,variant_id,quantity) VALUES(rid,1,2),(rid,2,1);
 UPDATE transfer_requests SET status='cancelled' WHERE id=rid;
 END $$`)
	if err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	replay, err := s.Create(ctx, actor(2), in)
	if err != nil {
		t.Fatal(err)
	}
	if len(replay.Request.Activity) != 2 || replay.Request.Activity[0].Action != "create" || replay.Request.Activity[1].Action != "cancel" {
		t.Fatal("activity reordered the immutable creation prefix", replay.Request.Activity)
	}
}

func TestT10TerminalAndLegacy(t *testing.T) {
	ctx, p, s := fixture(t)
	r := create(t, ctx, s, 2, input()).Request
	r, err := s.Reject(ctx, actor(1), r.ID)
	if err != nil {
		t.Fatal(err)
	}
	t10Assert(t, r, "transfer", "reject", "1")
	in := input()
	in.RetryKey = "t10-cancel-key-0001"
	r = create(t, ctx, s, 2, in).Request
	r, err = s.Cancel(ctx, actor(2), r.ID)
	if err != nil {
		t.Fatal(err)
	}
	t10Assert(t, r, "transfer", "cancel", "2")
	// SQL/owner fixture operations have no authenticated personal context.
	in.RetryKey = "t10-legacy-key-0001"
	intent, err := transfers.Validate(actor(2), in)
	if err != nil {
		t.Fatal(err)
	}
	var id int64
	tx, err := p.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	err = tx.QueryRow(ctx, `INSERT INTO transfer_requests(creator_location_id,kind,origin_location_id,destination_location_id,approver_location_id,retry_key,payload_sha256) VALUES(2,'request_stock',1,2,1,$1,$2) RETURNING id`, in.RetryKey, intent.Fingerprint[:]).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range in.Items {
		if _, err = tx.Exec(ctx, `INSERT INTO transfer_request_items(request_id,variant_id,quantity) VALUES($1,$2,$3)`, id, line.VariantID, line.Quantity); err != nil {
			t.Fatal(err)
		}
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	old, err := s.Get(ctx, actor(2), id)
	if err != nil || len(t10Activity(t, old)) != 0 {
		t.Fatal("manufactured historical author", err)
	}
	retry, err := s.Create(ctx, actor(2), in)
	if err != nil || !retry.Replayed || len(t10Activity(t, retry.Request)) != 0 {
		t.Fatal("legacy replay acquired author", err)
	}
}
func TestT10WorkflowActors(t *testing.T) {
	ctx, p, r := c2Receipt(t, false)
	s := transfers.New(p)
	c2StorePropose(t, ctx, s, r, r.Origin.ID, 1, 0, 2, "t10-count-propose-1")
	c2StoreDecide(t, ctx, s, r, r.Destination.ID, 1, 1, false, "t10-count-reject-01")
	c2StorePropose(t, ctx, s, r, r.Origin.ID, 1, 1, 1, "t10-count-propose-2")
	c2StoreDecide(t, ctx, s, r, r.Destination.ID, 1, 2, true, "t10-count-accept-01")
	// The accepted count retains a one-unit shortage on variant 1.
	_, err := s.ProposeRestitution(ctx, actor(r.Origin.ID), r.ID, transfers.RestitutionProposalInput{VariantID: 1, OperationKey: "t10-return-propose1", ExpectedRevision: 0, RetainedQuantity: 1, RetainedAtOrigin: true, Reason: "verified"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.DecideRestitution(ctx, actor(r.Destination.ID), r.ID, transfers.RestitutionDecisionInput{VariantID: 1, OperationKey: "t10-return-reject01", ExpectedRevision: 1, Reason: "verified"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.ProposeRestitution(ctx, actor(r.Origin.ID), r.ID, transfers.RestitutionProposalInput{VariantID: 1, OperationKey: "t10-return-propose2", ExpectedRevision: 1, RetainedQuantity: 1, RetainedAtOrigin: true, Reason: "verified"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.DecideRestitution(ctx, actor(r.Destination.ID), r.ID, transfers.RestitutionDecisionInput{VariantID: 1, OperationKey: "t10-return-accept01", ExpectedRevision: 2, Accept: true, Reason: "verified"})
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.Get(ctx, actor(r.Origin.ID), r.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, category := range []string{"count", "restitution"} {
		for _, action := range []string{"propose", "accept", "reject"} {
			account := "1"
			if action != "propose" {
				account = "2"
			}
			t10Assert(t, got, category, action, account)
		}
	}
	if len(got.Activity) != 11 {
		t.Fatal("owner receipt falsely acquired personal author or an action was omitted", got.Activity)
	}
	if _, err = p.Exec(ctx, `INSERT INTO auth_accounts(id,location_id,username,password_hash) VALUES(20,2,'t10_workflow_peer','opaque')`); err != nil {
		t.Fatal(err)
	}
	peer := auth.Identity{AccountID: 20, Location: auth.Location{ID: 2}}
	if _, err = s.DecideCount(ctx, peer, r.ID, transfers.CountDecisionInput{VariantID: 1, OperationKey: "t10-count-accept-01", ExpectedRevision: 2, Accept: true, Reason: "count confirmed"}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.DecideRestitution(ctx, peer, r.ID, transfers.RestitutionDecisionInput{VariantID: 1, OperationKey: "t10-return-accept01", ExpectedRevision: 2, Accept: true, Reason: "verified"}); err != nil {
		t.Fatal(err)
	}
	after, err := s.Get(ctx, peer, r.ID)
	if err != nil || !reflect.DeepEqual(got, after) {
		t.Fatal("workflow peer replay reassigned authors", err)
	}
}
func TestT10ReconciliationActors(t *testing.T) {
	ctx, p, s, r := dr2Fixture(t)
	dr2Propose(t, ctx, s, r, r.Origin.ID, 0, 7, "t10-propose1")
	_, err := s.DecideDispatchReconciliation(ctx, actor(r.Destination.ID), r.ID, transfers.DispatchReconciliationDecisionInput{VariantID: 1, OperationKey: "t10-dr-reject-0001", ExpectedRevision: 1, Reason: "verified"})
	if err != nil {
		t.Fatal(err)
	}
	dr2Propose(t, ctx, s, r, r.Origin.ID, 1, 7, "t10-propose2")
	dr2Decide(t, ctx, s, r, r.Destination.ID, 2, "t10-accept")
	got, err := s.Get(ctx, actor(r.Origin.ID), r.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, action := range []string{"propose", "accept", "reject"} {
		account := "1"
		if action != "propose" {
			account = "2"
		}
		t10Assert(t, got, "reconciliation", action, account)
	}
	if _, err = p.Exec(ctx, `INSERT INTO auth_accounts(id,location_id,username,password_hash) VALUES(20,2,'t10_dispatch_peer','opaque')`); err != nil {
		t.Fatal(err)
	}
	peer := auth.Identity{AccountID: 20, Location: auth.Location{ID: 2}}
	if _, err = s.DecideDispatchReconciliation(ctx, peer, r.ID, transfers.DispatchReconciliationDecisionInput{VariantID: 1, OperationKey: "dispatch-store-t10-accept", ExpectedRevision: 2, Accept: true, Reason: "verified"}); err != nil {
		t.Fatal(err)
	}
	after, err := s.Get(ctx, peer, r.ID)
	if err != nil || !reflect.DeepEqual(got, after) {
		t.Fatal("reconciliation peer replay changed author", err)
	}
}
