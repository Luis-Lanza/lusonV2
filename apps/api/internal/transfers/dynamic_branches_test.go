package transfers_test

import (
	"errors"
	"reflect"
	"testing"

	"luson/api/internal/auth"
	"luson/api/internal/bootstrap"
	"luson/api/internal/inventory"
	"luson/api/internal/transfers"
)

func TestDynamicBranchOperations(t *testing.T) {
	ctx, p, s := fixture(t)
	if _, err := p.Exec(ctx, `SELECT create_branch('Sucursal C'); INSERT INTO auth_accounts(id,location_id,username,password_hash,must_change_password) VALUES(20,4,'operator_c','opaque',false),(21,4,'operator_c2','opaque',false)`); err != nil {
		t.Fatal(err)
	}
	if err := bootstrap.Check(ctx, p); err != nil {
		t.Fatal("bootstrap after branch:", err)
	}
	a := auth.Identity{AccountID: 20, Location: auth.Location{ID: 4}}
	b := auth.Identity{AccountID: 21, Location: auth.Location{ID: 4}}
	stock := inventory.New(p)
	snapshot := func() []inventory.Page {
		t.Helper()
		var pages []inventory.Page
		for _, loc := range []int{1, 2, 3, 4} {
			for page := 1; page <= 4; page++ {
				got, err := stock.List(ctx, a, inventory.Query{LocationID: loc, Page: page, PageSize: 50})
				if err != nil {
					t.Fatal(err)
				}
				pages = append(pages, got)
			}
		}
		return pages
	}
	meta, err := stock.Metadata(ctx, a)
	if err != nil || len(meta.Locations) != 4 {
		t.Fatalf("metadata: %+v %v", meta, err)
	}
	before := snapshot()
	for _, page := range before[12:] {
		for _, item := range page.Items {
			if item.Existing != 0 || item.Reserved != 0 || item.Available != 0 {
				t.Fatal("new branch not empty")
			}
		}
	}
	in := transfers.CreateInput{Kind: transfers.DirectShipment, CounterpartyID: 4, RetryKey: "dynamic-direct-key", Items: []transfers.Line{{VariantID: 1, Quantity: 2}}}
	created, err := s.Create(ctx, actor(1), in)
	if err != nil {
		t.Fatal("direct:", err)
	}
	if _, err = s.Dispatch(ctx, actor(1), created.Request.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Receive(ctx, b, created.Request.ID, transfers.ReceiptInput{Items: []transfers.Line{{VariantID: 1, Quantity: 2}}}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Get(ctx, a, created.Request.ID); err != nil {
		t.Fatal("same branch participant:", err)
	}
	id := created.Request.ID
	if _, err = s.ProposeCount(ctx, a, id, transfers.CountProposalInput{VariantID: 1, OperationKey: "dynamic-count-propose", Actual: 1, Reason: "Verified count"}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.DecideCount(ctx, actor(1), id, transfers.CountDecisionInput{VariantID: 1, OperationKey: "dynamic-count-accept", ExpectedRevision: 1, Accept: true, Reason: "Verified count"}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.ProposeRestitution(ctx, actor(1), id, transfers.RestitutionProposalInput{VariantID: 1, OperationKey: "dynamic-return-propose", RetainedQuantity: 1, RetainedAtOrigin: true, Reason: "Retained at origin"}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.DecideRestitution(ctx, b, id, transfers.RestitutionDecisionInput{VariantID: 1, OperationKey: "dynamic-return-accept", ExpectedRevision: 1, Accept: true, Reason: "Agreed return"}); err != nil {
		t.Fatal(err)
	}
	// Reconciliation remains excluded after restitution. Use a separate received
	// transfer with a shortage, preserving that existing business invariant.
	in.RetryKey = "dynamic-second-direct"
	reconciled, err := s.Create(ctx, actor(1), in)
	if err != nil {
		t.Fatal(err)
	}
	rid := reconciled.Request.ID
	if _, err = s.Dispatch(ctx, actor(1), rid); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Receive(ctx, b, rid, transfers.ReceiptInput{Items: []transfers.Line{{VariantID: 1, Quantity: 1}}}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.ProposeDispatchReconciliation(ctx, a, rid, transfers.DispatchReconciliationProposalInput{VariantID: 1, OperationKey: "dynamic-dispatch-propose", DispatchQuantity: 1, Reason: "Verified dispatch"}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.DecideDispatchReconciliation(ctx, actor(1), rid, transfers.DispatchReconciliationDecisionInput{VariantID: 1, OperationKey: "dynamic-dispatch-accept", ExpectedRevision: 1, Accept: true, Reason: "Agreed dispatch"}); err != nil {
		t.Fatal(err)
	}
	for _, participant := range []auth.Identity{a, b, actor(1)} {
		if _, err = s.GetCountCorrections(ctx, participant, id); err != nil {
			t.Fatal(err)
		}
		if _, err = s.GetRestitutions(ctx, participant, id); err != nil {
			t.Fatal(err)
		}
		if _, err = s.GetDispatchReconciliations(ctx, participant, rid); err != nil {
			t.Fatal(err)
		}
	}
	stable := snapshot()
	counts, err := s.Counts(ctx, a)
	if err != nil {
		t.Fatal(err)
	}
	history, err := s.List(ctx, a, transfers.Query{Page: 1, PageSize: 10, Status: "all"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Get(ctx, actor(2), created.Request.ID); !errors.Is(err, transfers.ErrNotFound) {
		t.Fatal("foreign participant:", err)
	}
	if _, err = s.Dispatch(ctx, a, created.Request.ID); !errors.Is(err, transfers.ErrForbidden) {
		t.Fatal("foreign dispatch:", err)
	}
	if _, err = s.GetCountCorrections(ctx, actor(2), id); !errors.Is(err, transfers.ErrNotFound) {
		t.Fatal("foreign count history:", err)
	}
	if _, err = s.GetRestitutions(ctx, actor(2), id); !errors.Is(err, transfers.ErrNotFound) {
		t.Fatal("foreign restitution history:", err)
	}
	if _, err = s.GetDispatchReconciliations(ctx, actor(2), rid); !errors.Is(err, transfers.ErrNotFound) {
		t.Fatal("foreign reconciliation history:", err)
	}
	invalid := in
	invalid.CounterpartyID, invalid.RetryKey = 99, "missing-branch-key"
	if _, err = s.Create(ctx, actor(1), invalid); !errors.Is(err, transfers.ErrInvalid) {
		t.Fatal("missing destination:", err)
	}
	if !reflect.DeepEqual(stable, snapshot()) {
		t.Fatal("rejection changed stock")
	}
	afterCounts, err := s.Counts(ctx, a)
	if err != nil || !reflect.DeepEqual(counts, afterCounts) {
		t.Fatal("rejection changed counters", err)
	}
	afterHistory, err := s.List(ctx, a, transfers.Query{Page: 1, PageSize: 10, Status: "all"})
	if err != nil || !reflect.DeepEqual(history, afterHistory) {
		t.Fatal("rejection changed history", err)
	}
	request := transfers.CreateInput{Kind: transfers.RequestStock, CounterpartyID: 1, RetryKey: "dynamic-request-key", Items: []transfers.Line{{VariantID: 1, Quantity: 1}}}
	r, err := s.Create(ctx, a, request)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := s.Create(ctx, b, request)
	if err != nil || !replay.Replayed || replay.Request.ID != r.Request.ID {
		t.Fatal("location-owned replay", err)
	}
	if _, err = s.Cancel(ctx, b, r.Request.ID); err != nil {
		t.Fatal(err)
	}
	inbound := request
	inbound.CounterpartyID, inbound.RetryKey = 2, "dynamic-from-branch-two"
	incoming, err := s.Create(ctx, a, inbound)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Approve(ctx, actor(2), incoming.Request.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Cancel(ctx, b, incoming.Request.ID); err != nil {
		t.Fatal(err)
	}
	send := request
	send.Kind, send.RetryKey = transfers.SendToWarehouse, "dynamic-send-warehouse"
	proposal, err := s.Create(ctx, a, send)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Reject(ctx, actor(1), proposal.Request.ID); err != nil {
		t.Fatal(err)
	}
	send.RetryKey = "dynamic-send-complete"
	proposal, err = s.Create(ctx, b, send)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Approve(ctx, actor(1), proposal.Request.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Dispatch(ctx, a, proposal.Request.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Receive(ctx, actor(1), proposal.Request.ID, transfers.ReceiptInput{Items: []transfers.Line{{VariantID: 1, Quantity: 1}}}); err != nil {
		t.Fatal(err)
	}
	request.CounterpartyID, request.RetryKey = 4, "branch-to-four-key"
	r, err = s.Create(ctx, actor(2), request)
	if err != nil {
		t.Fatal(err)
	}
	actions, err := s.List(ctx, b, transfers.Query{Status: "all", RequiresAction: true})
	if err != nil || actions.Total != 1 || len(actions.Records) != 1 || actions.Records[0].ID != r.Request.ID ||
		!reflect.DeepEqual(actions.RequiredActions[r.Request.ID], []string{"approve"}) {
		t.Fatal("dynamic approval action list", err)
	}
	totals, err := s.Counts(ctx, a)
	if err != nil || totals.PendingTotal != 1 || totals.ActionCount != 1 || totals.Actions.Approve != 1 {
		t.Fatal("dynamic approval counters", err)
	}
	if _, err = s.Approve(ctx, b, r.Request.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Dispatch(ctx, a, r.Request.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Receive(ctx, actor(2), r.Request.ID, transfers.ReceiptInput{Items: []transfers.Line{{VariantID: 1, Quantity: 1}}}); err != nil {
		t.Fatal(err)
	}
}
