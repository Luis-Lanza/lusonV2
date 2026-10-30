package migrations_test

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/bootstrap"
	"luson/api/internal/config"
	"luson/api/internal/testpg"
)

func retirementSchema(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	p := testpg.Open(t)
	if err := bootstrap.Initialize(ctx, p, config.LocalTrial); err != nil {
		t.Fatal(err)
	}
	retirementExec(t, ctx, p, `INSERT INTO auth_accounts(location_id,username,password_hash)
 VALUES(1,'warehouse','opaque'),(2,'branch_a','opaque'),(3,'branch_b','opaque')`)
	return ctx, p
}

func retirementExec(t *testing.T, ctx context.Context, p *pgxpool.Pool, sql string) {
	t.Helper()
	if _, err := p.Exec(ctx, sql); err != nil {
		t.Fatal(err)
	}
}

func retirementAssert(t *testing.T, ctx context.Context, p *pgxpool.Pool, sql string) {
	t.Helper()
	var ok bool
	if err := p.QueryRow(ctx, sql).Scan(&ok); err != nil || !ok {
		t.Fatalf("schema contract failed: %s; error: %v", sql, err)
	}
}

// This suite exercises the public SQL schema contract in helper-owned databases.
// Snapshots prove rejected statements leave identities, balances and revisions intact.
func retirementReject(t *testing.T, ctx context.Context, p *pgxpool.Pool, sql string) error {
	t.Helper()
	snapshot := func() string {
		t.Helper()
		var value string
		if err := p.QueryRow(ctx, `SELECT jsonb_build_array(
 (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM auth_accounts a),
 (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM locations l),
 (SELECT jsonb_agg(to_jsonb(b) ORDER BY location_id,variant_id) FROM inventory_balances b),
 (SELECT jsonb_agg(to_jsonb(r) ORDER BY scope) FROM realtime_revisions r),
 (SELECT jsonb_agg(to_jsonb(h) ORDER BY id) FROM transfer_requests h),
 (SELECT jsonb_agg(to_jsonb(o) ORDER BY operation_key) FROM transfer_count_operations o),
 (SELECT jsonb_agg(to_jsonb(o) ORDER BY operation_key) FROM transfer_restitution_operations o),
 (SELECT jsonb_agg(to_jsonb(o) ORDER BY operation_key) FROM transfer_dispatch_operations o))::text`).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	before := snapshot()
	_, err := p.Exec(ctx, sql)
	if err == nil {
		t.Fatalf("accepted unsafe statement: %s", sql)
	}
	if snapshot() != before {
		t.Fatalf("rejected statement changed stored state: %s", sql)
	}
	return err
}

func retirementRejectActive(t *testing.T, ctx context.Context, p *pgxpool.Pool, sql string) {
	t.Helper()
	err := retirementReject(t, ctx, p, sql)
	var e *pgconn.PgError
	if !errors.As(err, &e) || e.Code != "23514" ||
		e.ConstraintName != "active_location_required" || e.Message != "New work requires active locations" {
		t.Fatalf("expected active-location rejection; got %v", err)
	}
}

func TestAdministrativeRetirementDefaults(t *testing.T) {
	ctx, p := retirementSchema(t)
	retirementAssert(t, ctx, p, `SELECT
 (SELECT count(*) FROM auth_accounts WHERE deleted_at IS NULL)=3
 AND (SELECT count(*) FROM locations WHERE deleted_at IS NULL)=3
 AND (SELECT count(*) FROM inventory_balances)=570`)
	for _, sql := range []string{
		`UPDATE auth_accounts SET deleted_at=now() WHERE id=1`,
		`UPDATE auth_accounts SET enabled=false,deleted_at=now() WHERE id=1`,
		`UPDATE locations SET deleted_at=now() WHERE id=1`,
		`DELETE FROM locations WHERE id=2`,
		`UPDATE locations SET name='Renamed' WHERE id=2`,
	} {
		retirementReject(t, ctx, p, sql)
	}
	if err := bootstrap.Check(ctx, p); err != nil {
		t.Fatal(err)
	}
}

func TestAdministrativeRetirementUserMarker(t *testing.T) {
	ctx, p := retirementSchema(t)
	retirementExec(t, ctx, p, `INSERT INTO auth_accounts(location_id,username,password_hash)
 VALUES(2,'retired_operator','opaque')`)
	retirementReject(t, ctx, p, `UPDATE auth_accounts SET deleted_at=now() WHERE id=4`)
	retirementExec(t, ctx, p, `UPDATE auth_accounts SET enabled=false,deleted_at=now() WHERE id=4`)
	retirementAssert(t, ctx, p, `SELECT id=4 AND username='retired_operator' AND NOT enabled
 AND deleted_at IS NOT NULL FROM auth_accounts WHERE id=4`)
	retirementReject(t, ctx, p, `UPDATE auth_accounts SET enabled=true WHERE id=4`)
	retirementReject(t, ctx, p, `INSERT INTO auth_accounts(location_id,username,password_hash)
 VALUES(2,'retired_operator','opaque')`)
	retirementExec(t, ctx, p, `INSERT INTO auth_accounts(location_id,username,password_hash)
 VALUES(2,'next_operator','opaque')`)
	retirementAssert(t, ctx, p, `SELECT id=5 FROM auth_accounts WHERE username='next_operator'`)
}

func TestAdministrativeRetirementBranchMarker(t *testing.T) {
	ctx, p := retirementSchema(t)
	retirementExec(t, ctx, p, `SELECT create_branch('Retired branch')`)
	retirementExec(t, ctx, p, `UPDATE locations SET deleted_at=now() WHERE id=4`)
	retirementAssert(t, ctx, p, `SELECT
 (SELECT name='Retired branch' AND deleted_at IS NOT NULL FROM locations WHERE id=4)
 AND (SELECT count(*) FROM inventory_balances WHERE location_id=4 AND existing=0 AND reserved=0)=190
 AND (SELECT count(*) FROM realtime_revisions WHERE scope='transfers:4')=1`)
	retirementReject(t, ctx, p, `UPDATE inventory_balances SET existing=1 WHERE location_id=4 AND variant_id=1`)
	retirementReject(t, ctx, p, `UPDATE locations SET deleted_at=NULL WHERE id=4`)
	retirementReject(t, ctx, p, `INSERT INTO auth_accounts(location_id,username,password_hash) VALUES(4,'late_assignee','opaque')`)
	retirementRejectActive(t, ctx, p, `WITH request AS (
 INSERT INTO transfer_requests(creator_location_id,kind,origin_location_id,destination_location_id,
 approver_location_id,retry_key,payload_sha256)
 VALUES(4,'request_stock',1,4,1,'retired-pending-key',decode(repeat('00',32),'hex')) RETURNING id)
 INSERT INTO transfer_request_items(request_id,variant_id,quantity) SELECT id,1,1 FROM request`)
	retirementReject(t, ctx, p, `SELECT create_branch('Retired branch')`)
	retirementExec(t, ctx, p, `SELECT create_branch('Next branch')`)
	retirementAssert(t, ctx, p, `SELECT id=5 FROM locations WHERE name='Next branch'`)
	if err := bootstrap.Check(ctx, p); err != nil {
		t.Fatal(err)
	}
}

// A received shortfall can have no destination stock but still has historical
// endpoints: retirement must reject new work from the active counterpart too.
func TestAdministrativeRetirementReceivedAdmission(t *testing.T) {
	ctx, p := retirementSchema(t)
	retirementExec(t, ctx, p, `SELECT create_branch('Shortfall branch');
 UPDATE inventory_balances SET existing=1,reserved=1 WHERE location_id=1 AND variant_id=1;
 BEGIN;
 INSERT INTO transfer_requests(creator_location_id,kind,origin_location_id,destination_location_id,
 approver_location_id,retry_key,payload_sha256,status)
 VALUES(1,'direct_shipment',1,4,1,'retirement-shortfall',decode(repeat('00',32),'hex'),'approved');
 INSERT INTO transfer_request_items(request_id,variant_id,quantity)
 SELECT id,1,1 FROM transfer_requests WHERE retry_key='retirement-shortfall';
 INSERT INTO transfer_request_allocations(request_id,variant_id,quantity)
 SELECT id,1,1 FROM transfer_requests WHERE retry_key='retirement-shortfall';
 COMMIT;
 UPDATE transfer_requests SET status='in_transit' WHERE retry_key='retirement-shortfall';
 BEGIN;
 INSERT INTO transfer_receipt_lines(request_id,variant_id,expected_quantity,actual_quantity,available_quantity)
 SELECT id,1,1,0,0 FROM transfer_requests WHERE retry_key='retirement-shortfall';
 INSERT INTO transfer_receipt_lines(request_id,variant_id,expected_quantity,actual_quantity,available_quantity)
 SELECT id,2,0,1,0 FROM transfer_requests WHERE retry_key='retirement-shortfall';
 UPDATE transfer_requests SET status='received' WHERE retry_key='retirement-shortfall';
 COMMIT;
 UPDATE locations SET deleted_at=now() WHERE id=4`)
	for _, sql := range []string{
		`SELECT transfer_restitute(id,1,1::smallint,'late-restitution','propose',0,1,true,'retained') FROM transfer_requests WHERE retry_key='retirement-shortfall'`,
		`SELECT transfer_count_correct(id,1,1::smallint,'late-count','propose',0,1,'count') FROM transfer_requests WHERE retry_key='retirement-shortfall'`,
		`SELECT transfer_dispatch_reconcile(id,1,1::smallint,'late-dispatch','propose',0,0,'dispatch') FROM transfer_requests WHERE retry_key='retirement-shortfall'`,
		`INSERT INTO transfer_restitution_operations(operation_key,request_id,variant_id,actor_location_id,action,expected_revision,retained_quantity,retained_at_origin,reason)
 SELECT 'direct-late',id,1,1,'propose',0,1,true,'retained' FROM transfer_requests WHERE retry_key='retirement-shortfall'`,
	} {
		retirementRejectActive(t, ctx, p, sql)
	}
}

func TestAdministrativeRetirementBranchBlockers(t *testing.T) {
	ctx, p := retirementSchema(t)
	retirementExec(t, ctx, p, `SELECT create_branch('Blocked branch')`)
	retirementAssert(t, ctx, p, `SELECT deleted_at IS NULL FROM locations WHERE id=4`)
	// Zero available is not sufficient: physically present and reserved stock still blocks.
	retirementExec(t, ctx, p, `UPDATE inventory_balances SET existing=1,reserved=1 WHERE location_id=4 AND variant_id=1`)
	retirementReject(t, ctx, p, `UPDATE locations SET deleted_at=now() WHERE id=4`)
	retirementExec(t, ctx, p, `UPDATE inventory_balances SET existing=0,reserved=0 WHERE location_id=4 AND variant_id=1`)
	retirementExec(t, ctx, p, `INSERT INTO auth_accounts(location_id,username,password_hash,enabled)
 VALUES(4,'disabled_assignee','opaque',false)`)
	retirementReject(t, ctx, p, `UPDATE locations SET deleted_at=now() WHERE id=4`)
	retirementExec(t, ctx, p, `UPDATE auth_accounts SET deleted_at=now() WHERE username='disabled_assignee'`)
	retirementExec(t, ctx, p, `WITH request AS (
 INSERT INTO transfer_requests(creator_location_id,kind,origin_location_id,destination_location_id,
 approver_location_id,retry_key,payload_sha256)
 VALUES(4,'request_stock',1,4,1,'retirement-pending',decode(repeat('00',32),'hex')) RETURNING id)
 INSERT INTO transfer_request_items(request_id,variant_id,quantity) SELECT id,1,1 FROM request`)
	retirementReject(t, ctx, p, `UPDATE locations SET deleted_at=now() WHERE id=4`)
}
