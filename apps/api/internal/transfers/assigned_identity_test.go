package transfers_test

import (
	"errors"
	"reflect"
	"testing"

	"luson/api/internal/auth"
	"luson/api/internal/inventory"
	"luson/api/internal/transfers"
)

func TestStoreAssignedBinding(t *testing.T) {
	ctx, p, s := fixture(t)
	if _, err := p.Exec(ctx, `SELECT create_branch('Assigned branch');
 INSERT INTO auth_accounts(id,location_id,username,password_hash)
 VALUES(20,4,'assigned_operator','opaque'),(21,4,'assigned_peer','opaque')`); err != nil {
		t.Fatal(err)
	}
	operator := auth.Identity{AccountID: 20, Location: auth.Location{ID: 4}}
	peer := auth.Identity{AccountID: 21, Location: auth.Location{ID: 4}}
	in := transfers.CreateInput{Kind: transfers.DirectShipment, CounterpartyID: 4,
		RetryKey: "assigned-direct-key", Items: []transfers.Line{{VariantID: 1, Quantity: 2}}}
	created, err := s.Create(ctx, actor(1), in)
	if err != nil {
		t.Fatal(err)
	}
	id := created.Request.ID
	if _, err = s.Dispatch(ctx, actor(1), id); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Receive(ctx, peer, id, transfers.ReceiptInput{Items: []transfers.Line{{VariantID: 1, Quantity: 2}}}); err != nil {
		t.Fatal(err)
	}
	// Independent same-branch peers share public operations and durable retries.
	request := transfers.CreateInput{Kind: transfers.RequestStock, CounterpartyID: 1,
		RetryKey: "assigned-request-key", Items: []transfers.Line{{VariantID: 1, Quantity: 1}}}
	pending, err := s.Create(ctx, operator, request)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := s.Create(ctx, peer, request)
	if err != nil || !replay.Replayed || replay.Request.ID != pending.Request.ID {
		t.Fatal("same-branch retry", err)
	}
	if _, err = s.Cancel(ctx, peer, pending.Request.ID); err != nil {
		t.Fatal(err)
	}
	observe := func() []any {
		t.Helper()
		var values []any
		for _, who := range []auth.Identity{operator, peer, actor(1)} {
			detail, err := s.Get(ctx, who, id)
			if err != nil {
				t.Fatal(err)
			}
			counts, err := s.Counts(ctx, who)
			if err != nil {
				t.Fatal(err)
			}
			page, err := s.List(ctx, who, transfers.Query{Status: "all"})
			if err != nil {
				t.Fatal(err)
			}
			countHistory, err := s.GetCountCorrections(ctx, who, id)
			if err != nil {
				t.Fatal(err)
			}
			returns, err := s.GetRestitutions(ctx, who, id)
			if err != nil {
				t.Fatal(err)
			}
			dispatch, err := s.GetDispatchReconciliations(ctx, who, id)
			if err != nil {
				t.Fatal(err)
			}
			values = append(values, detail, counts, page, countHistory, returns, dispatch)
		}
		stock := inventory.New(p)
		for location := 1; location <= 4; location++ {
			for page := 1; page <= 4; page++ {
				balances, err := stock.List(ctx, operator, inventory.Query{LocationID: location, Page: page, PageSize: 50})
				if err != nil {
					t.Fatal(err)
				}
				values = append(values, balances)
			}
		}
		return values
	}
	before := observe()
	for _, who := range []auth.Identity{
		actor(4), // Location 4 exists, but account 4 is not provisioned.
		{AccountID: 99, Location: auth.Location{ID: 4}},
		{AccountID: 20, Location: auth.Location{ID: 2}},
		{AccountID: 2, Location: auth.Location{ID: 4}},
	} {
		for _, operation := range []struct {
			name string
			run func() (any, error)
		}{
			{"create", func() (any, error) { return s.Create(ctx, who, request) }},
			{"get", func() (any, error) { return s.Get(ctx, who, id) }},
			{"list", func() (any, error) { return s.List(ctx, who, transfers.Query{Status: "all", RequiresAction: true}) }},
			{"counts", func() (any, error) { return s.Counts(ctx, who) }},
			{"approve", func() (any, error) { return s.Approve(ctx, who, id) }},
			{"reject", func() (any, error) { return s.Reject(ctx, who, id) }},
			{"dispatch", func() (any, error) { return s.Dispatch(ctx, who, id) }},
			{"receive", func() (any, error) { return s.Receive(ctx, who, id, transfers.ReceiptInput{}) }},
			{"cancel", func() (any, error) { return s.Cancel(ctx, who, id) }},
			{"count proposal", func() (any, error) { return s.ProposeCount(ctx, who, id, transfers.CountProposalInput{}) }},
			{"count decision", func() (any, error) { return s.DecideCount(ctx, who, id, transfers.CountDecisionInput{}) }},
			{"count history", func() (any, error) { return s.GetCountCorrections(ctx, who, id) }},
			{"restitution proposal", func() (any, error) { return s.ProposeRestitution(ctx, who, id, transfers.RestitutionProposalInput{}) }},
			{"restitution decision", func() (any, error) { return s.DecideRestitution(ctx, who, id, transfers.RestitutionDecisionInput{}) }},
			{"restitution history", func() (any, error) { return s.GetRestitutions(ctx, who, id) }},
			{"restitution access", func() (any, error) { return struct{}{}, s.CheckRestitutionAccess(ctx, who, id) }},
			{"dispatch proposal", func() (any, error) { return s.ProposeDispatchReconciliation(ctx, who, id, transfers.DispatchReconciliationProposalInput{}) }},
			{"dispatch decision", func() (any, error) { return s.DecideDispatchReconciliation(ctx, who, id, transfers.DispatchReconciliationDecisionInput{}) }},
			{"dispatch history", func() (any, error) { return s.GetDispatchReconciliations(ctx, who, id) }},
			{"dispatch access", func() (any, error) { return struct{}{}, s.CheckDispatchReconciliationAccess(ctx, who, id) }},
		} {
			got, err := operation.run()
			if !errors.Is(err, transfers.ErrForbidden) || !reflect.DeepEqual(got, reflect.Zero(reflect.TypeOf(got)).Interface()) {
				t.Fatalf("%s account=%d location=%d: expected zero/forbidden, got %+v %v", operation.name, who.AccountID, who.Location.ID, got, err)
			}
		}
		if !reflect.DeepEqual(before, observe()) {
			t.Fatal("rejected identity changed public balances, reservations, history or counters")
		}
	}
	if _, err := s.Get(ctx, actor(3), id); !errors.Is(err, transfers.ErrNotFound) {
		t.Fatal("valid nonparticipant lost private not-found contract", err)
	}
}
