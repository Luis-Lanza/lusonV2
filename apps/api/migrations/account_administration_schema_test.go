package migrations_test

import (
	"context"
	"testing"
	"time"

	"luson/api/internal/bootstrap"
	"luson/api/internal/config"
	"luson/api/internal/db"
	"luson/api/internal/testpg"
)

func TestAccountAdministrationSchema(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	p := testpg.Open(t)
	if err := db.Apply(ctx, p); err != nil {
		t.Fatal(err)
	}
	if err := bootstrap.Seed(ctx, p, config.LocalTrial); err != nil {
		t.Fatal(err)
	}
	exec := func(sql string) {
		t.Helper()
		if _, err := p.Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
	}
	scalar := func(sql string) string {
		t.Helper()
		var s string
		if err := p.QueryRow(ctx, sql).Scan(&s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	// Same insert interface as the unchanged private bootstrap, without password hashing costs.
	exec(`INSERT INTO auth_accounts(location_id,username,password_hash) VALUES (1,'warehouse','opaque-hash'),(2,'branch_a','opaque-hash'),(3,'branch_b','opaque-hash')`)
	if got := scalar(`SELECT string_agg(id::text,',' ORDER BY id) FROM auth_accounts`); got != "1,2,3" {
		t.Fatal(got)
	}
	snapshot := func() string {
		return scalar(`SELECT jsonb_build_array(
 (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM auth_accounts a),
 (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM locations l),
 (SELECT jsonb_agg(to_jsonb(b) ORDER BY location_id,variant_id) FROM inventory_balances b),
 (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM transfer_requests r),
 (SELECT jsonb_agg(to_jsonb(r) ORDER BY scope) FROM realtime_revisions r))::text`)
	}
	reject := func(sql string) {
		t.Helper()
		before := snapshot()
		if _, err := p.Exec(ctx, sql); err == nil {
			t.Fatalf("accepted unsafe SQL: %s", sql)
		}
		if after := snapshot(); after != before {
			t.Fatalf("rejected statement changed state: %s", sql)
		}
	}
	for _, sql := range []string{
		`INSERT INTO auth_accounts(id,location_id,username,password_hash) VALUES(20,1,'second_admin','x')`,
		`INSERT INTO auth_accounts(id,location_id,username,password_hash) VALUES(0,2,'zero_id','x')`,
		`INSERT INTO auth_accounts(id,location_id,username,password_hash) VALUES(20,99,'missing_branch','x')`,
		`INSERT INTO auth_accounts(id,location_id,username,password_hash) VALUES(20,2,'!bad','x')`,
		`UPDATE auth_accounts SET enabled=false WHERE id=1`,
		`UPDATE auth_accounts SET location_id=2 WHERE id=1`,
		`UPDATE auth_accounts SET id=20 WHERE id=1`,
		`DELETE FROM auth_accounts WHERE id=1`,
		`TRUNCATE auth_accounts CASCADE`,
		`UPDATE locations SET name='Other warehouse' WHERE id=1`,
		`INSERT INTO locations(id,name) VALUES(0,'Second warehouse')`,
		`DELETE FROM locations WHERE id=1`,
		`UPDATE catalog_entries SET model='changed' WHERE id=1`,
	} {
		reject(sql)
	}
	exec(`INSERT INTO auth_accounts(id,location_id,username,password_hash,display_name) VALUES(20,2,'personal_a','opaque-hash','Personal A')`)
	if got := scalar(`SELECT count(*)::text FROM auth_accounts WHERE location_id=2`); got != "2" {
		t.Fatal(got)
	}
	exec(`UPDATE auth_accounts SET display_name='Administrator',password_hash='new-opaque-hash',must_change_password=false,authority_version=authority_version+1 WHERE id=1`)
	exec(`UPDATE auth_accounts SET location_id=3,enabled=false,must_change_password=true,authority_version=authority_version+1 WHERE id=20`)
	exec(`UPDATE auth_accounts SET enabled=true WHERE id=20`)
	exec(`SELECT create_branch('Sucursal C')`)
	if got := scalar(`SELECT count(*)::text FROM inventory_balances WHERE location_id=4 AND existing=0 AND reserved=0 AND available=0`); got != "190" {
		t.Fatal(got)
	}
	reject(`SELECT create_branch('Sucursal C')`)
	reject(`INSERT INTO locations(id,name) VALUES(5,'Almacén')`)
	exec(`INSERT INTO auth_accounts(id,location_id,username,password_hash) VALUES(21,4,'new_branch','opaque-hash')`)
	// Branch insertion and stock initialization roll back together.
	before := snapshot()
	tx, err := p.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `SELECT create_branch('Rolled back')`); err != nil {
		t.Fatal(err)
	}
	if err = tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if snapshot() != before {
		t.Fatal("branch transaction leaked state")
	}
	// Transfer creators remain locations, even when no personal account is assigned there.
	exec(`DELETE FROM auth_accounts WHERE id=2`)
	exec(`WITH request AS (INSERT INTO transfer_requests(creator_location_id,kind,origin_location_id,destination_location_id,approver_location_id,retry_key,payload_sha256) VALUES(2,'request_stock',1,2,1,'schema-preserve-key',decode(repeat('00',32),'hex')) RETURNING id) INSERT INTO transfer_request_items(request_id,variant_id,quantity) SELECT id,1,1 FROM request`)
	if got := scalar(`SELECT creator_location_id::text || ':' || retry_key || ':' || encode(payload_sha256,'hex') FROM transfer_requests`); got != "2:schema-preserve-key:0000000000000000000000000000000000000000000000000000000000000000" {
		t.Fatal(got)
	}
	// Existing session insertion still uses legacy initial IDs; FK now identifies accounts.
	exec(`INSERT INTO auth_sessions(token_hash,account_id,created_at,last_seen_at,absolute_deadline,idle_deadline) VALUES(decode(repeat('01',32),'hex'),1,now(),now(),now()+interval '1 hour',now()+interval '1 hour')`)
	if err := db.Apply(ctx, p); err != nil {
		t.Fatal(err)
	}
}
