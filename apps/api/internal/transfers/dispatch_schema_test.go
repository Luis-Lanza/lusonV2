package transfers_test

import (
	"reflect"
	"testing"
)

func TestD01DispatchSchema(t *testing.T) {
	ctx, p, s := fixture(t)
	r := create(t, ctx, s, 2, input()).Request
	if _, err := s.Approve(ctx, actor(r.Approver.ID), r.ID); err != nil {
		t.Fatal(err)
	}
	before := outcomeSnapshot(t, ctx, p)
	for _, query := range []string{
		"UPDATE transfer_requests SET status='in_transit',dispatch_location_id=2 WHERE id=$1",
		"UPDATE transfer_requests SET status='in_transit',dispatched_at=created_at WHERE id=$1",
		"UPDATE transfer_requests SET status='in_transit',retry_key='tampered-key-000000' WHERE id=$1",
		"UPDATE transfer_request_allocations SET consumed_at=statement_timestamp() WHERE request_id=$1",
		"DELETE FROM transfer_request_allocations WHERE request_id=$1",
		"UPDATE transfer_request_allocations SET quantity=quantity+1 WHERE request_id=$1",
	} {
		if _, err := p.Exec(ctx, query, r.ID); err == nil {
			t.Fatal("direct SQL bypass accepted", query)
		}
		if outcomeSnapshot(t, ctx, p) != before {
			t.Fatal("refused SQL changed state")
		}
	}
	// Inject a failure on the second balance. The first deduction and all
	// metadata/ownership changes must roll back together.
	a01Exec(t, ctx, p, `CREATE FUNCTION d01_fail() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN IF NEW.variant_id=2 THEN RAISE EXCEPTION 'injected dispatch failure'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER d01_fail BEFORE UPDATE ON inventory_balances FOR EACH ROW EXECUTE FUNCTION d01_fail()`)
	if _, err := s.Dispatch(ctx, actor(r.Origin.ID), r.ID); err == nil {
		t.Fatal("injected dispatch succeeded")
	}
	if outcomeSnapshot(t, ctx, p) != before {
		t.Fatal("midwrite failure did not roll back")
	}
	a01Exec(t, ctx, p, "DROP TRIGGER d01_fail ON inventory_balances")
	// A raw header transition is admitted only with real stock consumption.
	stock := stocks(t, ctx, p)
	a01Exec(t, ctx, p, "UPDATE transfer_requests SET status='in_transit' WHERE id=$1", r.ID)
	for i := range stock {
		for _, item := range r.Items {
			if stock[i].Location == r.Origin.ID && int64(stock[i].Variant) == item.VariantID {
				stock[i].Existing -= item.Quantity
				stock[i].Reserved -= item.Quantity
			}
		}
	}
	if !reflect.DeepEqual(stocks(t, ctx, p), stock) {
		t.Fatal("raw dispatch bypassed stock effects")
	}
	settled := outcomeSnapshot(t, ctx, p)
	for _, query := range []string{
		"UPDATE transfer_requests SET status='approved' WHERE id=$1",
		"UPDATE transfer_requests SET dispatched_at=statement_timestamp() WHERE id=$1",
		"UPDATE transfer_request_allocations SET consumed_at=NULL WHERE request_id=$1",
		"INSERT INTO transfer_request_allocations(request_id,variant_id,quantity) VALUES($1,1,1)",
	} {
		if _, err := p.Exec(ctx, query, r.ID); err == nil {
			t.Fatal("consumed history mutation accepted", query)
		}
		if outcomeSnapshot(t, ctx, p) != settled {
			t.Fatal("history mutation changed state")
		}
	}
}
