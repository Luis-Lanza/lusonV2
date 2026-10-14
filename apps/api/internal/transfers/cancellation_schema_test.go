package transfers_test

import (
	"reflect"
	"testing"

	"luson/api/internal/transfers"
)

// Approved release uses the existing SQL transition before any new Go API is
// present, making its baseline failure behavioral rather than a compile error.
func TestC01ApprovedCancellationSchema(t *testing.T) {
	for _, flow := range []struct {
		name         string
		kind         transfers.Kind
		counterparty int
	}{
		{"warehouse_request", transfers.RequestStock, 1},
		{"branch_request", transfers.RequestStock, 3},
		{"warehouse_proposal", transfers.SendToWarehouse, 1},
	} {
		t.Run(flow.name, func(t *testing.T) {
			ctx, p, s := fixture(t)
			in := input()
			in.Kind, in.CounterpartyID = flow.kind, flow.counterparty
			r := create(t, ctx, s, 2, in).Request
			in.RetryKey = "cancellation-independent-key-01"
			other := create(t, ctx, s, 2, in).Request
			for _, request := range []transfers.Request{r, other} {
				if _, err := s.Approve(ctx, actor(request.Approver.ID), request.ID); err != nil {
					t.Fatal("approval setup failed")
				}
			}
			a01Exec(t, ctx, p, "UPDATE inventory_balances SET reserved=reserved+1 WHERE location_id=$1 AND variant_id IN(1,2)", r.Origin.ID)
			before := stocks(t, ctx, p)
			var history string
			const historyQuery = "SELECT row(decision_location_id,decided_at)::text FROM transfer_requests WHERE id=$1"
			if p.QueryRow(ctx, historyQuery, r.ID).Scan(&history) != nil {
				t.Fatal("approval history snapshot failed")
			}
			if _, err := p.Exec(ctx, "UPDATE transfer_requests SET status='cancelled' WHERE id=$1", r.ID); err != nil {
				t.Fatal("valid Approved-to-Cancelled transition refused")
			}
			want := append([]stockRow(nil), before...)
			for i := range want {
				for _, item := range r.Items {
					if want[i].Location == r.Origin.ID && int64(want[i].Variant) == item.VariantID {
						want[i].Reserved -= item.Quantity
						want[i].Available += item.Quantity
					}
				}
			}
			if !reflect.DeepEqual(stocks(t, ctx, p), want) {
				t.Fatal("release changed physical stock, unrelated balances or independent holds")
			}
			var after string
			var released bool
			if p.QueryRow(ctx, `SELECT count(*)=2 AND bool_and(a.released_at=r.cancelled_at AND a.consumed_at IS NULL)
 FROM transfer_request_allocations a JOIN transfer_requests r ON r.id=a.request_id WHERE r.id=$1`, r.ID).Scan(&released) != nil || !released {
				t.Fatal("Approved cancellation did not retain exact released ownership history")
			}
			if p.QueryRow(ctx, historyQuery, r.ID).Scan(&after) != nil || after != history {
				t.Fatal("Approved cancellation replaced original approval history")
			}
			var retained bool
			if p.QueryRow(ctx, `SELECT count(*)=4 AND bool_and(consumed_at IS NULL)
 AND count(*) FILTER (WHERE request_id=$2 AND released_at IS NULL)=2
 FROM transfer_request_allocations WHERE request_id IN ($1,$2)`, r.ID, other.ID).Scan(&retained) != nil || !retained {
				t.Fatal("cancellation deleted, consumed or released unrelated allocation history")
			}
			if _, err := p.Exec(ctx, "UPDATE inventory_balances SET reserved=1 WHERE location_id=$1 AND variant_id=1", r.Origin.ID); !sqlState(err, "23514") {
				t.Fatal("release allowed another request's active ownership to lose coverage")
			}
			if !reflect.DeepEqual(stocks(t, ctx, p), want) {
				t.Fatal("failed coverage reduction changed surviving holds")
			}
		})
	}
}

func TestC01CancellationSchemaGuards(t *testing.T) {
	for _, approved := range []bool{false, true} {
		name := "pending"
		if approved {
			name = "approved"
		}
		t.Run(name, func(t *testing.T) {
			ctx, p, s := fixture(t)
			r := create(t, ctx, s, 2, input()).Request
			if approved {
				if _, err := s.Approve(ctx, actor(1), r.ID); err != nil {
					t.Fatal("approval setup failed")
				}
			}
			before := outcomeSnapshot(t, ctx, p)
			for _, status := range []string{"pending", "cancelled"} {
				_, err := p.Exec(ctx, `INSERT INTO transfer_requests(creator_location_id,kind,origin_location_id,destination_location_id,
 approver_location_id,retry_key,payload_sha256,status,cancellation_location_id,cancelled_at)
 VALUES(2,'request_stock',1,2,1,'invalid-cancel-creation-key',decode(repeat('00',32),'hex'),$1,2,statement_timestamp())`, status)
				if !sqlState(err, "23514") {
					t.Fatal("direct cancelled or pre-cancelled Pending creation admitted")
				}
			}
			for _, query := range []string{
				"UPDATE transfer_requests SET status='cancelled',cancellation_location_id=1 WHERE id=$1",
				"UPDATE transfer_requests SET status='cancelled',cancelled_at=created_at-interval '1 day' WHERE id=$1",
				"UPDATE transfer_requests SET status='cancelled',cancelled_at=statement_timestamp()+interval '1 day' WHERE id=$1",
				"UPDATE transfer_requests SET status='cancelled',creator_location_id=3 WHERE id=$1",
				"UPDATE transfer_requests SET status='cancelled',decision_location_id=NULL,decided_at=NULL,retry_key='tampered-original-key' WHERE id=$1",
				"UPDATE transfer_requests SET cancellation_location_id=2,cancelled_at=statement_timestamp() WHERE id=$1",
				"INSERT INTO transfer_request_allocations(request_id,variant_id,quantity,released_at) VALUES($1,1,2,statement_timestamp())",
				"UPDATE transfer_request_allocations SET released_at=statement_timestamp() WHERE request_id=$1",
				"DELETE FROM transfer_request_allocations WHERE request_id=$1",
			} {
				if !approved && (query == "UPDATE transfer_request_allocations SET released_at=statement_timestamp() WHERE request_id=$1" || query == "DELETE FROM transfer_request_allocations WHERE request_id=$1") {
					continue
				}
				if _, err := p.Exec(ctx, query, r.ID); !sqlState(err, "23514") {
					t.Fatal("SQL cancellation tamper/bypass not refused with 23514", query)
				}
				if outcomeSnapshot(t, ctx, p) != before {
					t.Fatal("refused SQL changed lifecycle or inventory")
				}
			}
			// Pending cannot acquire ownership then erase its obligation through
			// cancellation in the same transaction; deferred guards use final rows.
			if !approved {
				tx := a01Begin(t, ctx, p)
				a01Allocate(t, ctx, tx, r.ID, false)
				a01Reserve(t, ctx, tx, r.ID)
				a01Exec(t, ctx, tx, "UPDATE transfer_requests SET status='cancelled' WHERE id=$1", r.ID)
				if !sqlState(tx.Commit(ctx), "23514") {
					t.Fatal("cancelled Pending committed allocation ownership")
				}
				if outcomeSnapshot(t, ctx, p) != before {
					t.Fatal("deferred refusal left ownership or release")
				}
			}
			if _, err := s.Cancel(ctx, actor(2), r.ID); err != nil {
				t.Fatal("valid cancellation failed")
			}
			settled := outcomeSnapshot(t, ctx, p)
			for _, query := range []string{
				"UPDATE transfer_requests SET status='pending' WHERE id=$1",
				"UPDATE transfer_requests SET status='approved' WHERE id=$1",
				"UPDATE transfer_requests SET status='in_transit' WHERE id=$1",
				"UPDATE transfer_requests SET cancelled_at=statement_timestamp() WHERE id=$1",
				"UPDATE transfer_requests SET decision_location_id=1,decided_at=statement_timestamp() WHERE id=$1",
				"UPDATE transfer_request_items SET quantity=quantity+1 WHERE request_id=$1",
				"INSERT INTO transfer_request_allocations(request_id,variant_id,quantity) VALUES($1,1,2)",
			} {
				if _, err := p.Exec(ctx, query, r.ID); err == nil {
					t.Fatal("Cancelled history reopened or replaced", query)
				}
				if outcomeSnapshot(t, ctx, p) != settled {
					t.Fatal("history refusal changed cancellation")
				}
			}
			if approved {
				for _, mutation := range []string{"released_at=NULL", "consumed_at=statement_timestamp()", "released_at=statement_timestamp()", "quantity=quantity+1"} {
					if _, err := p.Exec(ctx, "UPDATE transfer_request_allocations SET "+mutation+" WHERE request_id=$1", r.ID); !sqlState(err, "23514") {
						t.Fatal("released history mutation admitted")
					}
				}
				if outcomeSnapshot(t, ctx, p) != settled {
					t.Fatal("released history mutation changed state")
				}
			}
		})
	}
}

func TestC01CancellationRollback(t *testing.T) {
	for _, failure := range []string{"second_item", "deferred_commit"} {
		t.Run(failure, func(t *testing.T) {
			ctx, p, s := fixture(t)
			r := create(t, ctx, s, 2, input()).Request
			if _, err := s.Approve(ctx, actor(1), r.ID); err != nil {
				t.Fatal("approval setup failed")
			}
			a01Exec(t, ctx, p, "CREATE SEQUENCE c01_failure_seen")
			if failure == "second_item" {
				a01Exec(t, ctx, p, `CREATE FUNCTION c01_fail() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN IF NEW.variant_id=2 AND NEW.reserved<OLD.reserved THEN
 PERFORM nextval('c01_failure_seen'); RAISE EXCEPTION 'injected release failure'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER c01_fail BEFORE UPDATE ON inventory_balances FOR EACH ROW EXECUTE FUNCTION c01_fail()`)
			} else {
				a01Exec(t, ctx, p, `CREATE FUNCTION c01_fail() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN IF NEW.status='cancelled' THEN PERFORM nextval('c01_failure_seen');
 RAISE EXCEPTION 'injected deferred cancellation failure'; END IF; RETURN NULL; END $$;
 CREATE CONSTRAINT TRIGGER c01_fail AFTER UPDATE ON transfer_requests DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION c01_fail()`)
			}
			before := outcomeSnapshot(t, ctx, p)
			if _, err := s.Cancel(ctx, actor(2), r.ID); err == nil {
				t.Fatal("injected cancellation failure succeeded")
			}
			var reached bool
			if p.QueryRow(ctx, "SELECT is_called FROM c01_failure_seen").Scan(&reached) != nil || !reached {
				t.Fatal("failure did not reach intended SQL stage")
			}
			if outcomeSnapshot(t, ctx, p) != before {
				t.Fatal("release/metadata/ownership did not roll back atomically")
			}
		})
	}
}

func TestC01PendingCancellationSchema(t *testing.T) {
	for _, flow := range []struct {
		name         string
		kind         transfers.Kind
		counterparty int
	}{
		{"warehouse_request", transfers.RequestStock, 1},
		{"branch_request", transfers.RequestStock, 3},
		{"warehouse_proposal", transfers.SendToWarehouse, 1},
	} {
		t.Run(flow.name, func(t *testing.T) {
			ctx, p, s := fixture(t)
			in := input()
			in.Kind, in.CounterpartyID = flow.kind, flow.counterparty
			r := create(t, ctx, s, 2, in).Request
			before := stocks(t, ctx, p)
			t.Cleanup(func() { unchanged(t, before, stocks(t, ctx, p)) })

			// Include original approval history in the immutable snapshot. A
			// Pending cancellation must preserve its absence, not invent approval.
			const originalQuery = `SELECT jsonb_build_object(
 'header',jsonb_build_array(r.id,r.creator_location_id,r.kind,r.origin_location_id,
 r.destination_location_id,r.approver_location_id,r.retry_key,r.payload_sha256,
 r.created_at,r.creation_xid,r.decision_location_id,r.decided_at,
 r.dispatch_location_id,r.dispatched_at,r.receipt_location_id,r.received_at),
 'items',(SELECT jsonb_agg(to_jsonb(i) ORDER BY variant_id)
 FROM transfer_request_items i WHERE i.request_id=r.id))::text
 FROM transfer_requests r WHERE r.id=$1`
			var original string
			if p.QueryRow(ctx, originalQuery, r.ID).Scan(&original) != nil {
				t.Fatal("original request and approval history snapshot failed")
			}

			// This uses existing columns so baseline failure is refusal of the
			// actual transition, not an absent future metadata/release column.
			if _, err := p.Exec(ctx, "UPDATE transfer_requests SET status='cancelled' WHERE id=$1", r.ID); err != nil {
				t.Fatal("valid Pending-to-Cancelled transition refused")
			}
			var valid bool
			if p.QueryRow(ctx, `SELECT status='cancelled'
 AND cancellation_location_id=creator_location_id AND cancelled_at>=created_at
 AND decision_location_id IS NULL AND decided_at IS NULL
 AND dispatch_location_id IS NULL AND dispatched_at IS NULL
 AND receipt_location_id IS NULL AND received_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM transfer_request_allocations WHERE request_id=$1)
 FROM transfer_requests WHERE id=$1`, r.ID).Scan(&valid) != nil || !valid {
				t.Fatal("Pending cancellation fabricated approval, dispatch, receipt or ownership")
			}
			var after string
			if p.QueryRow(ctx, originalQuery, r.ID).Scan(&after) != nil || after != original {
				t.Fatal("cancellation changed original request, items or approval history")
			}
			unchanged(t, before, stocks(t, ctx, p))
		})
	}
}
