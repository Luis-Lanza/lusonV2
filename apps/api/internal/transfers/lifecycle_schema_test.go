package transfers_test

import (
	"context"
	"fmt"
	"math"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/transfers"
)

func TestA01LifecycleSchema(t *testing.T) {
	t.Run("whole_rejection", func(t *testing.T) {
		ctx, p, s := fixture(t)
		before := stocks(t, ctx, p)
		r := create(t, ctx, s, 2, input())
		if _, err := p.Exec(ctx, "UPDATE transfer_requests SET status='rejected' WHERE id=$1", r.Request.ID); err != nil {
			t.Fatal("valid Pending-to-Rejected transition refused")
		}
		if scalar(t, ctx, p, "SELECT count(*) FROM transfer_requests WHERE status='rejected' AND decision_location_id=approver_location_id AND decided_at>=created_at") != 1 {
			t.Fatal("rejection did not persist the actual approver and server decision time")
		}
		unchanged(t, before, stocks(t, ctx, p))
	})
	t.Run("whole_approval_all_flows", a01WholeApproval)
	t.Run("immutable_payload_and_decision", a01Immutability)
	t.Run("illegal_creation_and_transitions", a01IllegalTransitions)
	t.Run("allocation_and_coverage_failures", a01AllocationFailures)
	t.Run("current_final_rows_and_immediate_constraints", a01FinalRows)
	t.Run("creation_and_decision_in_one_transaction", a01CreationDecision)
	t.Run("numeric_sum_exceeds_int64", a01NumericSum)
	t.Run("non_read_committed_writes", a01Isolation)
	t.Run("decision_then_reserved_reduction", a01DecisionFirst)
	t.Run("reserved_reduction_then_decision", a01ReductionFirst)
	t.Run("competing_approvals_reversed_items", a01CompetingApprovals)
	t.Run("approval_rejection_race", a01DecisionRace)
	t.Run("deliberate_prelocking_may_abort", a01Prelocking)
}

// Helpers use only this test's freshly admitted owned database. Errors are
// reported by assertion/SQLSTATE, never by raw driver or connection output.
type a01Executor interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

func a01Exec(t *testing.T, ctx context.Context, e a01Executor, query string, args ...any) {
	t.Helper()
	if _, err := e.Exec(ctx, query, args...); err != nil {
		t.Fatal("lifecycle setup/write failed")
	}
}

func a01Begin(t *testing.T, ctx context.Context, p *pgxpool.Pool) pgx.Tx {
	t.Helper()
	tx, err := p.Begin(ctx)
	if err != nil {
		t.Fatal("lifecycle transaction begin failed")
	}
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	return tx
}

func a01Commit(t *testing.T, ctx context.Context, tx pgx.Tx) {
	t.Helper()
	if tx.Commit(ctx) != nil {
		t.Fatal("valid lifecycle transaction commit refused")
	}
}

func a01Allocate(t *testing.T, ctx context.Context, tx pgx.Tx, id int64, reverse bool) {
	t.Helper()
	order := "ASC"
	if reverse {
		order = "DESC"
	}
	// Omit source: the trigger derives it from the immutable header.
	a01Exec(t, ctx, tx, `INSERT INTO transfer_request_allocations(request_id,variant_id,quantity)
 SELECT request_id,variant_id,quantity FROM transfer_request_items WHERE request_id=$1 ORDER BY variant_id `+order, id)
}

func a01Reserve(t *testing.T, ctx context.Context, tx pgx.Tx, id int64) {
	t.Helper()
	a01Exec(t, ctx, tx, `UPDATE inventory_balances b SET reserved=b.reserved+i.quantity
 FROM transfer_request_items i JOIN transfer_requests r ON r.id=i.request_id
 WHERE i.request_id=$1 AND b.location_id=r.origin_location_id AND b.variant_id=i.variant_id`, id)
}

func a01Approve(t *testing.T, ctx context.Context, tx pgx.Tx, id int64, reverse bool) {
	t.Helper()
	a01Allocate(t, ctx, tx, id, reverse)
	a01Reserve(t, ctx, tx, id)
	a01Exec(t, ctx, tx, "UPDATE transfer_requests SET status='approved' WHERE id=$1", id)
}

func a01Original(t *testing.T, ctx context.Context, p *pgxpool.Pool, id int64) string {
	t.Helper()
	var value string
	if p.QueryRow(ctx, `SELECT jsonb_build_object('header',to_jsonb(r)-ARRAY['status','decision_location_id','decided_at'],
 'items',(SELECT jsonb_agg(to_jsonb(i) ORDER BY variant_id) FROM transfer_request_items i WHERE request_id=r.id))::text
 FROM transfer_requests r WHERE id=$1`, id).Scan(&value) != nil {
		t.Fatal("immutable payload snapshot failed")
	}
	return value
}

func a01Invariant(t *testing.T, ctx context.Context, p *pgxpool.Pool) {
	t.Helper()
	if scalar(t, ctx, p, `SELECT count(*) FROM transfer_requests r WHERE
 (r.status='pending' AND (decision_location_id IS NOT NULL OR decided_at IS NOT NULL)) OR
 (r.status<>'pending' AND (decision_location_id IS DISTINCT FROM approver_location_id OR decided_at IS NULL OR decided_at<created_at)) OR
 (r.status='approved' AND EXISTS(SELECT 1 FROM transfer_request_items i
 LEFT JOIN transfer_request_allocations a USING(request_id,variant_id)
 WHERE i.request_id=r.id AND (a.request_id IS NULL OR a.quantity<>i.quantity OR a.origin_location_id<>r.origin_location_id))) OR
 (r.status<>'approved' AND EXISTS(SELECT 1 FROM transfer_request_allocations a WHERE a.request_id=r.id))`) != 0 {
		t.Fatal("committed lifecycle invariant violated")
	}
	if scalar(t, ctx, p, `SELECT count(*) FROM
 (SELECT origin_location_id,variant_id,sum(quantity) AS owned FROM transfer_request_allocations GROUP BY 1,2) a
 LEFT JOIN inventory_balances b ON b.location_id=a.origin_location_id AND b.variant_id=a.variant_id
 WHERE b.reserved IS NULL OR b.reserved::numeric<a.owned`) != 0 {
		t.Fatal("committed allocation coverage invariant violated")
	}
}

func a01WholeApproval(t *testing.T) {
	for _, flow := range []struct {
		name                 string
		kind                 transfers.Kind
		counterparty, source int
	}{
		{"warehouse_request", transfers.RequestStock, 1, 1},
		{"branch_request", transfers.RequestStock, 3, 3},
		{"warehouse_proposal", transfers.SendToWarehouse, 1, 2},
	} {
		t.Run(flow.name, func(t *testing.T) {
			ctx, p, s := fixture(t)
			in := input()
			in.Kind, in.CounterpartyID = flow.kind, flow.counterparty
			r := create(t, ctx, s, 2, in)
			original := a01Original(t, ctx, p, r.Request.ID)
			// Independent holds must survive and need not equal owned totals.
			a01Exec(t, ctx, p, "UPDATE inventory_balances SET reserved=1 WHERE location_id=$1 AND variant_id IN(1,2)", flow.source)
			before := stocks(t, ctx, p)
			tx := a01Begin(t, ctx, p)
			a01Approve(t, ctx, tx, r.Request.ID, false)
			a01Commit(t, ctx, tx)
			if a01Original(t, ctx, p, r.Request.ID) != original {
				t.Fatal("approval changed original payload or items")
			}
			want := append([]stockRow(nil), before...)
			for i := range want {
				if want[i].Location == flow.source && (want[i].Variant == 1 || want[i].Variant == 2) {
					quantity := int64(1)
					if want[i].Variant == 1 {
						quantity = 2
					}
					want[i].Reserved += quantity
					want[i].Available -= quantity
				}
			}
			if !reflect.DeepEqual(want, stocks(t, ctx, p)) {
				t.Fatal("approval changed physical stock, destination or other holds")
			}
			if scalar(t, ctx, p, "SELECT count(*) FROM transfer_request_allocations") != 2 {
				t.Fatal("whole approval did not persist exactly two owned items")
			}
			a01Invariant(t, ctx, p)
		})
	}
}

func a01Immutability(t *testing.T) {
	for _, outcome := range []string{"approved", "rejected"} {
		t.Run(outcome, func(t *testing.T) {
			ctx, p, s := fixture(t)
			r := create(t, ctx, s, 2, input())
			original := a01Original(t, ctx, p, r.Request.ID)
			tx := a01Begin(t, ctx, p)
			if outcome == "approved" {
				a01Approve(t, ctx, tx, r.Request.ID, false)
			} else {
				a01Exec(t, ctx, tx, "UPDATE transfer_requests SET status='rejected' WHERE id=$1", r.Request.ID)
			}
			a01Commit(t, ctx, tx)
			before := stocks(t, ctx, p)
			var decision string
			if p.QueryRow(ctx, "SELECT row(status,decision_location_id,decided_at)::text FROM transfer_requests WHERE id=$1", r.Request.ID).Scan(&decision) != nil {
				t.Fatal("decision snapshot failed")
			}
			for _, mutation := range []string{
				"status=status", "status='pending'", "status='approved'", "status='rejected'",
				"decision_location_id=NULL", "decision_location_id=3", "decided_at=NULL", "decided_at=statement_timestamp()",
				"id=id+100", "creator_location_id=3", "kind='send_to_warehouse'", "origin_location_id=3",
				"destination_location_id=3", "approver_location_id=3", "retry_key='changed-valid-key-0001'",
				"payload_sha256=decode(repeat('00',32),'hex')", "created_at=statement_timestamp()", "creation_xid=pg_current_xact_id()",
			} {
				if _, err := p.Exec(ctx, "UPDATE transfer_requests SET "+mutation+" WHERE id=$1", r.Request.ID); err == nil {
					t.Fatalf("terminal mutation accepted: %s", mutation)
				}
			}
			for _, query := range []string{
				"DELETE FROM transfer_requests", "TRUNCATE transfer_requests CASCADE",
				"UPDATE transfer_request_items SET quantity=quantity+1", "DELETE FROM transfer_request_items", "TRUNCATE transfer_request_items CASCADE",
				"INSERT INTO transfer_request_items(request_id,variant_id,quantity) SELECT id,3,1 FROM transfer_requests",
				"UPDATE transfer_request_allocations SET quantity=quantity", "DELETE FROM transfer_request_allocations", "TRUNCATE transfer_request_allocations",
				"TRUNCATE inventory_balances", "TRUNCATE locations CASCADE",
			} {
				// Row guards do not fire for an empty Rejected allocation table.
				if outcome == "rejected" && (query == "UPDATE transfer_request_allocations SET quantity=quantity" || query == "DELETE FROM transfer_request_allocations") {
					continue
				}
				if _, err := p.Exec(ctx, query); err == nil {
					t.Fatalf("immutable table mutation accepted: %s", query)
				}
			}
			if outcome == "approved" {
				for _, query := range []string{
					"UPDATE transfer_request_allocations SET request_id=request_id+100",
					"UPDATE transfer_request_allocations SET variant_id=3",
					"UPDATE transfer_request_allocations SET quantity=quantity+1",
					"UPDATE transfer_request_allocations SET origin_location_id=3",
					"DELETE FROM inventory_balances WHERE location_id=1 AND variant_id=1",
				} {
					if _, err := p.Exec(ctx, query); err == nil {
						t.Fatal("committed allocation mutation or allocated balance deletion admitted")
					}
				}
			}
			var after string
			if p.QueryRow(ctx, "SELECT row(status,decision_location_id,decided_at)::text FROM transfer_requests WHERE id=$1", r.Request.ID).Scan(&after) != nil || after != decision {
				t.Fatal("failed mutations changed immutable decision history")
			}
			if a01Original(t, ctx, p, r.Request.ID) != original {
				t.Fatal("failed mutations changed original payload")
			}
			unchanged(t, before, stocks(t, ctx, p))
			a01Invariant(t, ctx, p)
		})
	}
}

func a01IllegalTransitions(t *testing.T) {
	ctx, p, s := fixture(t)
	r := create(t, ctx, s, 2, input())
	before := stocks(t, ctx, p)
	original := a01Original(t, ctx, p, r.Request.ID)
	for _, mutation := range []string{
		"status='pending'", "status='dispatched'", "status='rejected',decision_location_id=3",
		"status='rejected',decided_at='2000-01-01'", "status='rejected',decided_at='2100-01-01'",
		"status='rejected',id=id+100", "status='rejected',creator_location_id=3",
		"status='rejected',kind='send_to_warehouse'", "status='rejected',origin_location_id=3",
		"status='rejected',destination_location_id=3", "status='rejected',approver_location_id=3",
		"status='rejected',retry_key='changed-valid-key-0001'", "status='rejected',payload_sha256=decode(repeat('00',32),'hex')",
		"status='rejected',created_at=statement_timestamp()", "status='rejected',creation_xid=pg_current_xact_id()",
	} {
		if _, err := p.Exec(ctx, "UPDATE transfer_requests SET "+mutation+" WHERE id=$1", r.Request.ID); !sqlState(err, "23514") {
			t.Fatalf("illegal Pending transition did not fail with 23514: %s", mutation)
		}
	}
	for _, outcome := range []string{"approved", "rejected", "pending"} {
		extra := "NULL,NULL"
		if outcome == "pending" {
			extra = "1,statement_timestamp()"
		}
		_, err := p.Exec(ctx, `INSERT INTO transfer_requests(creator_location_id,kind,origin_location_id,destination_location_id,
 approver_location_id,retry_key,payload_sha256,status,decision_location_id,decided_at)
 VALUES(2,'request_stock',1,2,1,'illegal-direct-key-0001',decode(repeat('00',32),'hex'),$1,`+extra+`)`, outcome)
		if !sqlState(err, "23514") {
			t.Fatal("non-Pending creation or predecided Pending insert admitted")
		}
	}
	if scalar(t, ctx, p, "SELECT count(*) FROM transfer_requests WHERE status='pending' AND decision_location_id IS NULL AND decided_at IS NULL") != 1 || a01Original(t, ctx, p, r.Request.ID) != original {
		t.Fatal("failed transitions changed original Pending request")
	}
	unchanged(t, before, stocks(t, ctx, p))
}

func a01AllocationFailures(t *testing.T) {
	for _, name := range []string{
		"missing_all", "missing_one", "extra_variant", "wrong_quantity", "wrong_source", "duplicate",
		"pending_owns", "rejected_owns", "aggregate_undercoverage", "missing_balance", "delete_balance", "relocate_balance",
	} {
		t.Run(name, func(t *testing.T) {
			ctx, p, s := fixture(t)
			r := create(t, ctx, s, 2, input())
			if name == "missing_balance" {
				a01Exec(t, ctx, p, "DELETE FROM inventory_balances WHERE location_id=1 AND variant_id=1")
			}
			before := stocksOrMissing(t, ctx, p, name == "missing_balance")
			original := a01Original(t, ctx, p, r.Request.ID)
			tx := a01Begin(t, ctx, p)
			var err error
			switch name {
			case "extra_variant", "wrong_quantity", "wrong_source", "duplicate":
				a01Allocate(t, ctx, tx, r.Request.ID, false)
				query := "INSERT INTO transfer_request_allocations VALUES($1,3,1,1)"
				if name == "wrong_quantity" {
					query = "INSERT INTO transfer_request_allocations VALUES($1,1,1,3)"
				} else if name == "wrong_source" {
					query = "INSERT INTO transfer_request_allocations VALUES($1,1,3,2)"
				} else if name == "duplicate" {
					query = "INSERT INTO transfer_request_allocations VALUES($1,1,1,2)"
				}
				_, err = tx.Exec(ctx, query, r.Request.ID)
			case "missing_all":
				a01Exec(t, ctx, tx, "UPDATE transfer_requests SET status='approved' WHERE id=$1", r.Request.ID)
			case "missing_one":
				a01Exec(t, ctx, tx, "INSERT INTO transfer_request_allocations VALUES($1,1,1,2)", r.Request.ID)
				a01Reserve(t, ctx, tx, r.Request.ID)
				a01Exec(t, ctx, tx, "UPDATE transfer_requests SET status='approved' WHERE id=$1", r.Request.ID)
			case "pending_owns", "rejected_owns":
				a01Allocate(t, ctx, tx, r.Request.ID, false)
				a01Reserve(t, ctx, tx, r.Request.ID)
				if name == "rejected_owns" {
					a01Exec(t, ctx, tx, "UPDATE transfer_requests SET status='rejected' WHERE id=$1", r.Request.ID)
				}
			case "aggregate_undercoverage":
				in := input()
				in.RetryKey = "second-aggregate-key-0001"
				r2 := create(t, ctx, s, 2, in)
				a01Approve(t, ctx, tx, r.Request.ID, false)
				a01Allocate(t, ctx, tx, r2.Request.ID, false)
				a01Exec(t, ctx, tx, "UPDATE transfer_requests SET status='approved' WHERE id=$1", r2.Request.ID)
			case "missing_balance":
				a01Allocate(t, ctx, tx, r.Request.ID, false)
				a01Reserve(t, ctx, tx, r.Request.ID)
				a01Exec(t, ctx, tx, "UPDATE transfer_requests SET status='approved' WHERE id=$1", r.Request.ID)
			case "delete_balance", "relocate_balance":
				a01Approve(t, ctx, tx, r.Request.ID, false)
				if name == "delete_balance" {
					a01Exec(t, ctx, tx, "DELETE FROM inventory_balances WHERE location_id=1 AND variant_id=1")
				} else {
					a01Exec(t, ctx, tx, "DELETE FROM inventory_balances WHERE location_id=3 AND variant_id=1")
					a01Exec(t, ctx, tx, "UPDATE inventory_balances SET location_id=3 WHERE location_id=1 AND variant_id=1")
				}
			}
			if err == nil {
				err = tx.Commit(ctx)
			} else {
				_ = tx.Rollback(ctx)
			}
			want := "23514"
			if name == "duplicate" {
				want = "23505"
			}
			if !sqlState(err, want) {
				t.Fatalf("invalid allocation transaction did not fail with %s", want)
			}
			if a01Original(t, ctx, p, r.Request.ID) != original || scalar(t, ctx, p, "SELECT count(*) FROM transfer_request_allocations") != 0 || scalar(t, ctx, p, "SELECT count(*) FROM transfer_requests WHERE status<>'pending'") != 0 {
				t.Fatal("failed decision transaction left partial lifecycle state")
			}
			if !reflect.DeepEqual(before, stocksOrMissing(t, ctx, p, name == "missing_balance")) {
				t.Fatal("failed decision transaction changed stock snapshot")
			}
		})
	}
}

// A missing-balance case deliberately has 569 rows; all other failure cases
// use the original helper's strict 570-row snapshot assertion.
func stocksOrMissing(t *testing.T, ctx context.Context, p *pgxpool.Pool, missing bool) []stockRow {
	t.Helper()
	if !missing {
		return stocks(t, ctx, p)
	}
	rows, err := p.Query(ctx, "SELECT location_id,variant_id,existing,reserved,available FROM inventory_balances ORDER BY location_id,variant_id")
	if err != nil {
		t.Fatal("missing-balance snapshot failed")
	}
	defer rows.Close()
	var result []stockRow
	for rows.Next() {
		var r stockRow
		if rows.Scan(&r.Location, &r.Variant, &r.Existing, &r.Reserved, &r.Available) != nil {
			t.Fatal("missing-balance snapshot scan failed")
		}
		result = append(result, r)
	}
	if rows.Err() != nil || len(result) != 569 {
		t.Fatal("unexpected missing-balance snapshot size")
	}
	return result
}

func a01FinalRows(t *testing.T) {
	for _, immediate := range []bool{false, true} {
		t.Run(fmt.Sprintf("immediate_%t", immediate), func(t *testing.T) {
			ctx, p, s := fixture(t)
			r := create(t, ctx, s, 2, input())
			tx := a01Begin(t, ctx, p)
			// Queue an invalid intermediate balance image, then restore final
			// coverage. Allocate while Pending, then decide: queued NEW images
			// are not the final state and must not cause a false rejection.
			a01Exec(t, ctx, tx, "UPDATE inventory_balances SET reserved=0 WHERE location_id=1 AND variant_id IN(1,2)")
			a01Approve(t, ctx, tx, r.Request.ID, true)
			if immediate {
				a01Exec(t, ctx, tx, "SET CONSTRAINTS ALL IMMEDIATE")
			}
			a01Commit(t, ctx, tx)
			before := stocks(t, ctx, p)
			tx = a01Begin(t, ctx, p)
			a01Exec(t, ctx, tx, "UPDATE inventory_balances SET reserved=0 WHERE location_id=1 AND variant_id=1")
			var err error
			if immediate {
				_, err = tx.Exec(ctx, "SET CONSTRAINTS ALL IMMEDIATE")
				_ = tx.Rollback(ctx)
			} else {
				err = tx.Commit(ctx)
			}
			if !sqlState(err, "23514") {
				t.Fatal("current final undercoverage was not refused")
			}
			unchanged(t, before, stocks(t, ctx, p))
			// DELETE's queued OLD image must inspect a replacement final row.
			tx = a01Begin(t, ctx, p)
			a01Exec(t, ctx, tx, "DELETE FROM inventory_balances WHERE location_id=1 AND variant_id=1")
			a01Exec(t, ctx, tx, "INSERT INTO inventory_balances(location_id,variant_id,existing,reserved) VALUES(1,1,18,2)")
			if immediate {
				a01Exec(t, ctx, tx, "SET CONSTRAINTS ALL IMMEDIATE")
			}
			a01Commit(t, ctx, tx)
			unchanged(t, before, stocks(t, ctx, p))
			a01Invariant(t, ctx, p)
		})
	}
}

func a01CreationDecision(t *testing.T) {
	for _, immediate := range []bool{false, true} {
		t.Run(fmt.Sprintf("immediate_%t", immediate), func(t *testing.T) {
			ctx, p, _ := fixture(t)
			tx := a01Begin(t, ctx, p)
			var id int64
			if tx.QueryRow(ctx, `INSERT INTO transfer_requests(creator_location_id,kind,origin_location_id,destination_location_id,
 approver_location_id,retry_key,payload_sha256) VALUES(2,'request_stock',1,2,1,'same-transaction-key-0001',decode(repeat('00',32),'hex'))
 RETURNING id`).Scan(&id) != nil {
				t.Fatal("direct Pending creation failed")
			}
			a01Exec(t, ctx, tx, "INSERT INTO transfer_request_items VALUES($1,1,2),($1,2,1)", id)
			a01Approve(t, ctx, tx, id, false)
			// Header INSERT queued a Pending NEW image. Its deferred event must
			// query the now-Approved header, not refuse legitimate owned items.
			if immediate {
				a01Exec(t, ctx, tx, "SET CONSTRAINTS ALL IMMEDIATE")
			}
			a01Commit(t, ctx, tx)
			a01Invariant(t, ctx, p)
		})
	}
	t.Run("future_creation_cannot_be_decided_early", func(t *testing.T) {
		ctx, p, _ := fixture(t)
		before := stocks(t, ctx, p)
		tx := a01Begin(t, ctx, p)
		var id int64
		if tx.QueryRow(ctx, `INSERT INTO transfer_requests(creator_location_id,kind,origin_location_id,destination_location_id,
 approver_location_id,retry_key,payload_sha256,created_at)
 VALUES(2,'request_stock',1,2,1,'future-creation-key-0001',decode(repeat('00',32),'hex'),statement_timestamp()+interval '1 day') RETURNING id`).Scan(&id) != nil {
			t.Fatal("future timestamp setup failed")
		}
		a01Exec(t, ctx, tx, "INSERT INTO transfer_request_items VALUES($1,1,2)", id)
		_, err := tx.Exec(ctx, "UPDATE transfer_requests SET status='rejected' WHERE id=$1", id)
		if !sqlState(err, "23514") {
			t.Fatal("server decision predating creation was admitted")
		}
		_ = tx.Rollback(ctx)
		unchanged(t, before, stocks(t, ctx, p))
		if scalar(t, ctx, p, "SELECT count(*) FROM transfer_requests") != 0 {
			t.Fatal("failed same-transaction creation/decision left a header")
		}
	})
}

func a01NumericSum(t *testing.T) {
	ctx, p, s := fixture(t)
	a01Exec(t, ctx, p, "UPDATE inventory_balances SET existing=$1 WHERE location_id=1 AND variant_id=1", int64(math.MaxInt64))
	in := input()
	in.Items = []transfers.Line{{VariantID: 1, Quantity: math.MaxInt64}}
	r := create(t, ctx, s, 2, in)
	in.RetryKey = "numeric-overflow-key-0002"
	r2 := create(t, ctx, s, 2, in)
	tx := a01Begin(t, ctx, p)
	a01Approve(t, ctx, tx, r.Request.ID, false)
	a01Commit(t, ctx, tx)
	before := stocks(t, ctx, p)
	tx = a01Begin(t, ctx, p)
	a01Allocate(t, ctx, tx, r2.Request.ID, false)
	a01Exec(t, ctx, tx, "UPDATE transfer_requests SET status='approved' WHERE id=$1", r2.Request.ID)
	if err := tx.Commit(ctx); !sqlState(err, "23514") {
		t.Fatal("SUM greater than int64 did not fail cleanly with coverage SQLSTATE 23514")
	}
	unchanged(t, before, stocks(t, ctx, p))
	if scalar(t, ctx, p, "SELECT count(*) FROM transfer_requests WHERE status='approved'") != 1 {
		t.Fatal("numeric coverage failure persisted second decision")
	}
	a01Invariant(t, ctx, p)
}

func a01Isolation(t *testing.T) {
	ctx, p, s := fixture(t)
	r := create(t, ctx, s, 2, input())
	before := stocks(t, ctx, p)
	for _, level := range []pgx.TxIsoLevel{pgx.RepeatableRead, pgx.Serializable} {
		for _, query := range []string{
			"UPDATE transfer_requests SET status='rejected' WHERE id=$1",
			"INSERT INTO transfer_request_allocations(request_id,variant_id,quantity) VALUES($1,1,2)",
			"UPDATE inventory_balances SET reserved=reserved WHERE location_id=1 AND variant_id=1 AND $1>0",
			"DELETE FROM inventory_balances WHERE location_id=1 AND variant_id=1 AND $1>0",
		} {
			tx, err := p.BeginTx(ctx, pgx.TxOptions{IsoLevel: level})
			if err != nil {
				t.Fatal("isolation test begin failed")
			}
			_, err = tx.Exec(ctx, query, r.Request.ID)
			_ = tx.Rollback(ctx)
			if !sqlState(err, "25000") {
				t.Fatal("non-READ-COMMITTED protected write was not refused")
			}
		}
		tx, err := p.BeginTx(ctx, pgx.TxOptions{IsoLevel: level, AccessMode: pgx.ReadOnly})
		if err != nil {
			t.Fatal("read-only isolation begin failed")
		}
		var n int
		if tx.QueryRow(ctx, "SELECT count(*) FROM transfer_requests").Scan(&n) != nil || n != 1 {
			t.Fatal("non-READ-COMMITTED read was restricted")
		}
		a01Commit(t, ctx, tx)
	}
	unchanged(t, before, stocks(t, ctx, p))
}

// Wait on a specific connection's actual DB lock event. No sleeps, timing
// guesses or unbounded polling; the fixture context also bounds all goroutines.
func a01Wait(t *testing.T, ctx context.Context, p *pgxpool.Pool, pid uint32, event string) {
	t.Helper()
	wait, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	for {
		var blocked bool
		if p.QueryRow(wait, "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock' AND wait_event=$2)", pid, event).Scan(&blocked) != nil {
			t.Fatal("reservation lock handshake failed")
		}
		if blocked {
			return
		}
		if wait.Err() != nil {
			t.Fatal("reservation lock handshake timed out")
		}
	}
}

func a01DecisionFirst(t *testing.T) {
	ctx, p, s := fixture(t)
	r := create(t, ctx, s, 2, input())
	tx := a01Begin(t, ctx, p)
	a01Allocate(t, ctx, tx, r.Request.ID, false)
	other := a01Begin(t, ctx, p)
	done := make(chan error, 1)
	go func() {
		_, err := other.Exec(ctx, "UPDATE inventory_balances SET reserved=0 WHERE location_id=1 AND variant_id IN(1,2)")
		done <- err
	}()
	a01Wait(t, ctx, p, other.Conn().PgConn().PID(), "advisory")
	a01Reserve(t, ctx, tx, r.Request.ID)
	a01Exec(t, ctx, tx, "UPDATE transfer_requests SET status='approved' WHERE id=$1", r.Request.ID)
	a01Commit(t, ctx, tx)
	before := stocks(t, ctx, p)
	if <-done != nil {
		t.Fatal("serialized balance statement failed before deferred validation")
	}
	if err := other.Commit(ctx); !sqlState(err, "23514") {
		t.Fatal("waiting reduction used a stale snapshot and escaped owned coverage")
	}
	unchanged(t, before, stocks(t, ctx, p))
	a01Invariant(t, ctx, p)
}

func a01ReductionFirst(t *testing.T) {
	ctx, p, s := fixture(t)
	r := create(t, ctx, s, 2, input())
	tx := a01Begin(t, ctx, p)
	a01Exec(t, ctx, tx, "UPDATE inventory_balances SET existing=0,reserved=0 WHERE location_id=1 AND variant_id IN(1,2)")
	other := a01Begin(t, ctx, p)
	done := make(chan error, 1)
	go func() {
		_, err := other.Exec(ctx, `INSERT INTO transfer_request_allocations(request_id,variant_id,quantity)
 SELECT request_id,variant_id,quantity FROM transfer_request_items WHERE request_id=$1`, r.Request.ID)
		done <- err
	}()
	a01Wait(t, ctx, p, other.Conn().PgConn().PID(), "advisory")
	a01Commit(t, ctx, tx)
	before := stocks(t, ctx, p)
	if <-done != nil {
		t.Fatal("waiting allocation statement failed")
	}
	a01Exec(t, ctx, other, "UPDATE transfer_requests SET status='approved' WHERE id=$1", r.Request.ID)
	if err := other.Commit(ctx); !sqlState(err, "23514") {
		t.Fatal("waiting approval ignored committed balance reduction")
	}
	unchanged(t, before, stocks(t, ctx, p))
	a01Invariant(t, ctx, p)
}

func a01CompetingApprovals(t *testing.T) {
	ctx, p, s := fixture(t)
	in := input()
	in.Items = []transfers.Line{{VariantID: 1, Quantity: 10}, {VariantID: 2, Quantity: 13}}
	r := create(t, ctx, s, 2, in)
	in.RetryKey = "competing-approval-key-0002"
	r2 := create(t, ctx, s, 2, in)
	tx := a01Begin(t, ctx, p)
	a01Approve(t, ctx, tx, r.Request.ID, false)
	other := a01Begin(t, ctx, p)
	done := make(chan error, 1)
	go func() {
		_, err := other.Exec(ctx, `INSERT INTO transfer_request_allocations(request_id,variant_id,quantity)
 SELECT request_id,variant_id,quantity FROM transfer_request_items WHERE request_id=$1 ORDER BY variant_id DESC`, r2.Request.ID)
		done <- err
	}()
	a01Wait(t, ctx, p, other.Conn().PgConn().PID(), "advisory")
	a01Commit(t, ctx, tx)
	before := stocks(t, ctx, p)
	if <-done != nil {
		t.Fatal("competing allocation insert failed")
	}
	_, err := other.Exec(ctx, `UPDATE inventory_balances b SET reserved=b.reserved+i.quantity
 FROM transfer_request_items i WHERE i.request_id=$1 AND b.location_id=1 AND b.variant_id=i.variant_id`, r2.Request.ID)
	if !sqlState(err, "23514") {
		t.Fatal("competing approval exceeded physical stock without failing")
	}
	_ = other.Rollback(ctx)
	unchanged(t, before, stocks(t, ctx, p))
	if scalar(t, ctx, p, "SELECT count(*) FROM transfer_requests WHERE status='approved'") != 1 || scalar(t, ctx, p, "SELECT count(*) FROM transfer_request_allocations") != 2 {
		t.Fatal("competing failure left partial decision/allocations")
	}
	a01Invariant(t, ctx, p)
}

func a01DecisionRace(t *testing.T) {
	ctx, p, s := fixture(t)
	r := create(t, ctx, s, 2, input())
	tx := a01Begin(t, ctx, p)
	a01Approve(t, ctx, tx, r.Request.ID, true)
	other := a01Begin(t, ctx, p)
	done := make(chan error, 1)
	go func() {
		_, err := other.Exec(ctx, "UPDATE transfer_requests SET status='rejected' WHERE id=$1", r.Request.ID)
		done <- err
	}()
	a01Wait(t, ctx, p, other.Conn().PgConn().PID(), "advisory")
	a01Commit(t, ctx, tx)
	before := stocks(t, ctx, p)
	if err := <-done; !sqlState(err, "23514") {
		t.Fatal("losing rejection reopened or replaced committed approval")
	}
	_ = other.Rollback(ctx)
	unchanged(t, before, stocks(t, ctx, p))
	a01Invariant(t, ctx, p)
}

func a01Prelocking(t *testing.T) {
	ctx, p, s := fixture(t)
	r := create(t, ctx, s, 2, input())
	before := stocks(t, ctx, p)
	first := a01Begin(t, ctx, p)
	second := a01Begin(t, ctx, p)
	// Deliberately violate the future A02 lock order. This is not promised to
	// succeed: a PostgreSQL deadlock abort is an acceptable safe outcome.
	a01Exec(t, ctx, second, "SELECT id FROM transfer_requests WHERE id=$1 FOR UPDATE", r.Request.ID)
	a01Exec(t, ctx, first, "UPDATE inventory_balances SET reserved=reserved WHERE location_id=1 AND variant_id=1")
	secondDone := make(chan error, 1)
	go func() {
		_, err := second.Exec(ctx, "UPDATE transfer_requests SET status='rejected' WHERE id=$1", r.Request.ID)
		secondDone <- err
	}()
	a01Wait(t, ctx, p, second.Conn().PgConn().PID(), "advisory")
	firstDone := make(chan error, 1)
	go func() {
		_, err := first.Exec(ctx, "UPDATE transfer_requests SET status='rejected' WHERE id=$1", r.Request.ID)
		firstDone <- err
	}()
	firstErr, secondErr := <-firstDone, <-secondDone
	if !((sqlState(firstErr, "40P01") && secondErr == nil) || (sqlState(secondErr, "40P01") && firstErr == nil)) {
		t.Fatal("deliberate prelocking did not produce exactly one safe deadlock abort")
	}
	if firstErr == nil {
		a01Commit(t, ctx, first)
		_ = second.Rollback(ctx)
	} else {
		_ = first.Rollback(ctx)
		a01Commit(t, ctx, second)
	}
	unchanged(t, before, stocks(t, ctx, p))
	a01Invariant(t, ctx, p)
}
