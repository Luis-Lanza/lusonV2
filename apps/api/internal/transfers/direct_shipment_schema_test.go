package transfers_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"time"
)

const w01SQLHeader = `INSERT INTO transfer_requests
 (creator_location_id,kind,origin_location_id,destination_location_id,approver_location_id,status,retry_key,payload_sha256)
 VALUES(1,'direct_shipment',1,2,1,'approved','w01-schema-create-01',decode(repeat('00',32),'hex')) RETURNING id`

func w01SQLCreate(t *testing.T, ctx context.Context, tx pgx.Tx) int64 {
	t.Helper()
	var id int64
	if tx.QueryRow(ctx, w01SQLHeader).Scan(&id) != nil {
		t.Fatal("direct SQL header setup failed")
	}
	a01Exec(t, ctx, tx, "INSERT INTO transfer_request_items(request_id,variant_id,quantity) VALUES($1,1,2),($1,2,1)", id)
	return id
}

func TestW01DirectShipmentSchemaGuards(t *testing.T) {
	ctx, p, s := fixture(t)
	for _, tc := range []struct{ name, old, replacement string }{
		{"branch_creator", "VALUES(1,", "VALUES(2,"},
		{"branch_origin", "'direct_shipment',1,2,1", "'direct_shipment',3,2,1"},
		{"warehouse_destination", "'direct_shipment',1,2,1", "'direct_shipment',1,1,1"},
		{"branch_approver", "'direct_shipment',1,2,1", "'direct_shipment',1,2,2"},
		{"pending", "'approved'", "'pending'"},
		{"rejected", "'approved'", "'rejected'"},
		{"cancelled", "'approved'", "'cancelled'"},
		{"in_transit", "'approved'", "'in_transit'"},
		{"received", "'approved'", "'received'"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := receiptSnapshot(t, ctx, p)
			tx := a01Begin(t, ctx, p)
			_, err := tx.Exec(ctx, strings.Replace(w01SQLHeader, tc.old, tc.replacement, 1))
			var pgerr *pgconn.PgError
			if !errors.As(err, &pgerr) || pgerr.Code != "23514" {
				t.Fatal("forged direct SQL creation was not rejected by a check")
			}
			if tx.Rollback(ctx) != nil || receiptSnapshot(t, ctx, p) != before {
				t.Fatal("forged creation changed persisted state")
			}
		})
	}
	for _, tc := range []struct{ field, value string }{
		{"decision_location_id", "2"}, {"decided_at", "now()+interval '1 second'"},
		{"created_at", "now()-interval '1 day'"}, {"creation_xid", "'1'::xid8"},
		{"dispatch_location_id", "1"}, {"dispatched_at", "now()"},
		{"receipt_location_id", "2"}, {"received_at", "now()"},
		{"cancellation_location_id", "1"}, {"cancelled_at", "now()"},
	} {
		t.Run("premature_"+tc.field, func(t *testing.T) {
			query := strings.Replace(w01SQLHeader, "payload_sha256)", "payload_sha256,"+tc.field+")", 1)
			query = strings.Replace(query, "'hex')) RETURNING", "'hex'),"+tc.value+") RETURNING", 1)
			tx := a01Begin(t, ctx, p)
			_, err := tx.Exec(ctx, query)
			var pgerr *pgconn.PgError
			if !errors.As(err, &pgerr) || pgerr.Code != "23514" {
				t.Fatal("conflicting supplied metadata admitted")
			}
			if tx.Rollback(ctx) != nil {
				t.Fatal("metadata refusal rollback failed")
			}
		})
	}
	for _, mode := range []string{"no_items", "no_allocations", "partial_allocations", "no_coverage", "wrong_quantity", "wrong_source"} {
		t.Run(mode, func(t *testing.T) {
			before := receiptSnapshot(t, ctx, p)
			tx := a01Begin(t, ctx, p)
			var id int64
			if mode == "no_items" {
				if tx.QueryRow(ctx, w01SQLHeader).Scan(&id) != nil {
					t.Fatal("deferred header setup failed")
				}
			} else {
				id = w01SQLCreate(t, ctx, tx)
			}
			var err error
			switch mode {
			case "partial_allocations":
				a01Reserve(t, ctx, tx, id)
				a01Exec(t, ctx, tx, "INSERT INTO transfer_request_allocations(request_id,variant_id,quantity) VALUES($1,1,2)", id)
			case "no_coverage":
				a01Allocate(t, ctx, tx, id, false)
			case "wrong_quantity":
				_, err = tx.Exec(ctx, "INSERT INTO transfer_request_allocations(request_id,variant_id,quantity) VALUES($1,1,1)", id)
			case "wrong_source":
				_, err = tx.Exec(ctx, "INSERT INTO transfer_request_allocations(request_id,variant_id,quantity,origin_location_id) VALUES($1,1,2,2)", id)
			}
			if err == nil {
				err = tx.Commit(ctx)
			} else {
				_ = tx.Rollback(ctx)
			}
			var pgerr *pgconn.PgError
			if !errors.As(err, &pgerr) || pgerr.Code != "23514" || receiptSnapshot(t, ctx, p) != before {
				t.Fatal("incomplete direct ownership committed or left partial state")
			}
		})
	}
	r := create(t, ctx, s, 1, w01Input(2)).Request
	before := receiptSnapshot(t, ctx, p)
	for _, query := range []string{
		"UPDATE transfer_requests SET kind='request_stock' WHERE id=$1",
		"UPDATE transfer_requests SET creator_location_id=2 WHERE id=$1",
		"UPDATE transfer_requests SET destination_location_id=3 WHERE id=$1",
		"UPDATE transfer_requests SET payload_sha256=decode(repeat('ff',32),'hex') WHERE id=$1",
		"UPDATE transfer_requests SET retry_key='w01-forged-retry-key' WHERE id=$1",
		"UPDATE transfer_requests SET created_at=created_at+interval '1 second' WHERE id=$1",
		"UPDATE transfer_requests SET decided_at=decided_at+interval '1 second' WHERE id=$1",
		"UPDATE transfer_requests SET status='pending',decision_location_id=NULL,decided_at=NULL WHERE id=$1",
		"UPDATE transfer_requests SET status='rejected' WHERE id=$1",
		"UPDATE transfer_requests SET status='cancelled',decision_location_id=NULL,decided_at=NULL WHERE id=$1",
		"UPDATE transfer_request_items SET quantity=quantity+1 WHERE request_id=$1",
		"UPDATE transfer_request_allocations SET quantity=quantity+1 WHERE request_id=$1",
		"UPDATE transfer_request_allocations SET consumed_at=now() WHERE request_id=$1",
		"UPDATE transfer_request_allocations SET released_at=now() WHERE request_id=$1",
		"DELETE FROM transfer_request_items WHERE request_id=$1",
		"DELETE FROM transfer_request_allocations WHERE request_id=$1",
	} {
		if _, err := p.Exec(ctx, query, r.ID); err == nil || receiptSnapshot(t, ctx, p) != before {
			t.Fatal("direct immutable payload or lifecycle bypass admitted")
		}
	}
	if _, err := p.Exec(ctx, "UPDATE inventory_balances SET reserved=0 WHERE location_id=1 AND variant_id=1"); err == nil || receiptSnapshot(t, ctx, p) != before {
		t.Fatal("direct active owned coverage was removed")
	}
}

func TestW01DirectShipmentSchemaCreation(t *testing.T) {
	ctx, p, _ := fixture(t)
	tx := a01Begin(t, ctx, p)
	var id int64
	var decision int
	var created, decided time.Time
	err := tx.QueryRow(ctx, `INSERT INTO transfer_requests
 (creator_location_id,kind,origin_location_id,destination_location_id,approver_location_id,status,retry_key,payload_sha256)
 VALUES(1,'direct_shipment',1,2,1,'approved','w01-schema-create-01',decode(repeat('00',32),'hex'))
 RETURNING id,decision_location_id,created_at,decided_at`).Scan(&id, &decision, &created, &decided)
	if err != nil {
		t.Fatal("legitimate direct SQL creation must derive initial warehouse authorization")
	}
	if decision != 1 || created.IsZero() || !created.Equal(decided) {
		t.Fatal("direct authorization is not simultaneous with creation")
	}
	a01Exec(t, ctx, tx, "INSERT INTO transfer_request_items(request_id,variant_id,quantity) VALUES($1,1,2),($1,2,1)", id)
	a01Reserve(t, ctx, tx, id)
	a01Allocate(t, ctx, tx, id, false)
	a01Commit(t, ctx, tx)
	if scalar(t, ctx, p, "SELECT count(*) FROM transfer_request_allocations WHERE origin_location_id=1 AND consumed_at IS NULL AND released_at IS NULL") != 2 {
		t.Fatal("SQL creation did not retain both active warehouse allocations")
	}
}
