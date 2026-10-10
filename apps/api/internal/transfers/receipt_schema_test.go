package transfers_test

import (
	"context"
	"reflect"
	"testing"

	"luson/api/internal/transfers"
)

func TestR1ReceiptSchemaAdmission(t *testing.T) {
	ctx, p, s := fixture(t)
	r := create(t, ctx, s, 2, input()).Request
	if _, err := s.Approve(ctx, actor(r.Approver.ID), r.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Dispatch(ctx, actor(r.Origin.ID), r.ID); err != nil {
		t.Fatal(err)
	}
	tx := a01Begin(t, ctx, p)
	defer tx.Rollback(ctx)
	a01Exec(t, ctx, tx, `INSERT INTO transfer_receipt_lines(request_id,variant_id,expected_quantity,actual_quantity,available_quantity) SELECT request_id,variant_id,quantity,quantity,quantity FROM transfer_request_items WHERE request_id=$1`, r.ID)
	a01Exec(t, ctx, tx, "UPDATE transfer_requests SET status='received' WHERE id=$1", r.ID)
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if scalar(t, ctx, p, "SELECT count(*) FROM transfer_requests WHERE status='received'") != 1 {
		t.Fatal("receipt not finalized")
	}
}

func TestR1ReceiptSchemaGuards(t *testing.T) {
	ctx, p, s := fixture(t)
	r := receiptDispatch(t, ctx, s, input())
	before := receiptSnapshot(t, ctx, p)
	for _, query := range []string{
		"UPDATE transfer_requests SET status='received' WHERE id=$1",
		"UPDATE transfer_requests SET receipt_location_id=2 WHERE id=$1",
		"INSERT INTO transfer_receipt_lines(request_id,variant_id,expected_quantity,actual_quantity,available_quantity) VALUES($1,1,2,2,2)",
		"INSERT INTO transfer_receipt_lines(request_id,variant_id,expected_quantity,actual_quantity,available_quantity) VALUES($1,1,3,2,2)",
		"INSERT INTO transfer_receipt_lines(request_id,variant_id,expected_quantity,actual_quantity,available_quantity) VALUES($1,1,2,3,3)",
		"INSERT INTO transfer_receipt_lines(request_id,variant_id,expected_quantity,actual_quantity,available_quantity) VALUES($1,191,0,1,0)",
		"INSERT INTO transfer_receipt_exceptions(request_id,variant_id,kind,quantity) VALUES($1,1,'shortage',1)",
	} {
		if _, err := p.Exec(ctx, query, r.ID); err == nil {
			t.Fatal("standalone/header-only receipt bypass", query)
		}
		if receiptSnapshot(t, ctx, p) != before {
			t.Fatal("SQL refusal changed receipt state")
		}
	}
	for _, mode := range []string{"incomplete", "all_zero", "caller_location", "caller_time", "payload_tamper", "overflow", "repeatable_read"} {
		t.Run(mode, func(t *testing.T) {
			if mode == "overflow" {
				a01Exec(t, ctx, p, "UPDATE inventory_balances SET existing=9223372036854775807 WHERE location_id=2 AND variant_id=2")
			}
			before := receiptSnapshot(t, ctx, p)
			tx := a01Begin(t, ctx, p)
			defer tx.Rollback(context.Background())
			if mode == "repeatable_read" {
				a01Exec(t, ctx, tx, "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
			}
			quantity := int64(1)
			if mode == "all_zero" {
				quantity = 0
			}
			_, err := tx.Exec(ctx, `INSERT INTO transfer_receipt_lines(request_id,variant_id,expected_quantity,actual_quantity,available_quantity) VALUES($1,1,2,$2,$2)`, r.ID, quantity)
			if mode != "repeatable_read" && err != nil {
				t.Fatal("valid first line refused")
			}
			if mode == "repeatable_read" && err == nil {
				t.Fatal("stale write isolation admitted")
			}
			if err == nil && mode != "incomplete" {
				a01Exec(t, ctx, tx, `INSERT INTO transfer_receipt_lines(request_id,variant_id,expected_quantity,actual_quantity,available_quantity) VALUES($1,2,1,$2,$2)`, r.ID, quantity)
			}
			if err == nil {
				query := "UPDATE transfer_requests SET status='received' WHERE id=$1"
				switch mode {
				case "caller_location":
					query = "UPDATE transfer_requests SET status='received',receipt_location_id=1 WHERE id=$1"
				case "caller_time":
					query = "UPDATE transfer_requests SET status='received',received_at=created_at WHERE id=$1"
				case "payload_tamper":
					query = "UPDATE transfer_requests SET status='received',retry_key='tampered-receipt-key-001' WHERE id=$1"
				}
				if _, err = tx.Exec(ctx, query, r.ID); err == nil {
					err = tx.Commit(ctx)
				}
				if err == nil {
					t.Fatal("invalid finalization admitted", mode)
				}
			}
			_ = tx.Rollback(ctx)
			if receiptSnapshot(t, ctx, p) != before {
				t.Fatal("failed direct SQL finalization left partial writes")
			}
			if mode == "overflow" {
				a01Exec(t, ctx, p, "UPDATE inventory_balances SET existing=20 WHERE location_id=2 AND variant_id=2")
			}
		})
	}
	// Raw SQL must credit exactly the expected minimum and derive discrepancies.
	stock := stocks(t, ctx, p)
	tx := a01Begin(t, ctx, p)
	defer tx.Rollback(ctx)
	a01Exec(t, ctx, tx, `INSERT INTO transfer_receipt_lines(request_id,variant_id,expected_quantity,actual_quantity,available_quantity) VALUES($1,1,2,1,1),($1,2,1,3,1),($1,3,0,7,0)`, r.ID)
	a01Exec(t, ctx, tx, "UPDATE transfer_requests SET status='received' WHERE id=$1", r.ID)
	if err := tx.Commit(ctx); err != nil {
		t.Fatal("valid SQL receipt did not commit")
	}
	for i := range stock {
		if stock[i].Location == 2 && (stock[i].Variant == 1 || stock[i].Variant == 2) {
			stock[i].Existing++
			stock[i].Available++
		}
	}
	if !reflect.DeepEqual(stock, stocks(t, ctx, p)) {
		t.Fatal("SQL header bypassed exact credit")
	}
	settled := receiptSnapshot(t, ctx, p)
	for _, query := range []string{
		"UPDATE transfer_requests SET status='received' WHERE id=$1",
		"UPDATE transfer_requests SET status='in_transit' WHERE id=$1",
		"UPDATE transfer_requests SET received_at=statement_timestamp() WHERE id=$1",
		"UPDATE transfer_requests SET dispatch_location_id=2 WHERE id=$1",
		"UPDATE transfer_receipt_lines SET actual_quantity=actual_quantity WHERE request_id=$1",
		"DELETE FROM transfer_receipt_lines WHERE request_id=$1",
		"UPDATE transfer_receipt_exceptions SET quantity=quantity WHERE request_id=$1",
		"DELETE FROM transfer_receipt_exceptions WHERE request_id=$1",
		"INSERT INTO transfer_receipt_lines(request_id,variant_id,expected_quantity,actual_quantity,available_quantity) VALUES($1,4,0,1,0)",
		"UPDATE transfer_request_allocations SET consumed_at=NULL WHERE request_id=$1",
	} {
		if _, err := p.Exec(ctx, query, r.ID); err == nil {
			t.Fatal("finalized history mutation admitted", query)
		}
		if receiptSnapshot(t, ctx, p) != settled {
			t.Fatal("immutable history changed")
		}
	}
	for _, table := range []string{"transfer_receipt_lines", "transfer_receipt_exceptions"} {
		if _, err := p.Exec(ctx, "TRUNCATE "+table+" CASCADE"); err == nil {
			t.Fatal("receipt truncate bypass admitted")
		}
	}
	if receiptSnapshot(t, ctx, p) != settled {
		t.Fatal("truncate changed final receipt")
	}
}

func TestR1ReceiptRollback(t *testing.T) {
	for _, mode := range []string{"second_credit", "deferred_commit"} {
		t.Run(mode, func(t *testing.T) {
			ctx, p, s := fixture(t)
			r := receiptDispatch(t, ctx, s, input())
			before := receiptSnapshot(t, ctx, p)
			if mode == "second_credit" {
				a01Exec(t, ctx, p, `CREATE FUNCTION r1_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.variant_id=2 THEN RAISE EXCEPTION 'injected receipt credit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER r1_fail BEFORE UPDATE ON inventory_balances FOR EACH ROW EXECUTE FUNCTION r1_fail()`)
			} else {
				a01Exec(t, ctx, p, `CREATE FUNCTION r1_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='received' THEN RAISE EXCEPTION 'injected receipt commit failure'; END IF; RETURN NULL; END $$; CREATE CONSTRAINT TRIGGER r1_fail AFTER UPDATE ON transfer_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION r1_fail()`)
			}
			got, err := s.Receive(ctx, actor(2), r.ID, receiptInput(r))
			a02Error(t, got, err, transfers.ErrUnavailable)
			if receiptSnapshot(t, ctx, p) != before {
				t.Fatal("receipt failure leaked credit, metadata, lines, exceptions or revisions")
			}
		})
	}
}

func TestR1ActionCountTransitions(t *testing.T) {
	ctx, _, s := fixture(t)
	in := input()
	in.Kind = "send_to_warehouse"
	r := create(t, ctx, s, 2, in).Request
	if _, err := s.Approve(ctx, actor(1), r.ID); err != nil {
		t.Fatal(err)
	}
	counts, err := s.Counts(ctx, actor(2))
	if err != nil || counts.PendingTotal != 0 || counts.ActionCount != 1 {
		t.Fatalf("approved origin action: %+v %v", counts, err)
	}
	if _, err := s.Dispatch(ctx, actor(2), r.ID); err != nil {
		t.Fatal(err)
	}
	counts, err = s.Counts(ctx, actor(1))
	if err != nil || counts.PendingTotal != 0 || counts.ActionCount != 1 {
		t.Fatalf("transit destination action: %+v %v", counts, err)
	}
}
