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

func TestT10PersonalActivitySchema(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	p := testpg.Open(t)
	if err := bootstrap.Initialize(ctx, p, config.LocalTrial); err != nil {
		t.Fatal(err)
	}
	exec := func(sql string) {
		t.Helper()
		if _, err := p.Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO auth_accounts(location_id,username,password_hash) VALUES(1,'warehouse','opaque'),(2,'operator','opaque'),(3,'other','opaque')`)
	snapshot := func() string {
		t.Helper()
		var s string
		if p.QueryRow(ctx, `SELECT jsonb_build_array(
   (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM transfer_requests r),
   (SELECT jsonb_agg(to_jsonb(e) ORDER BY request_id,category,operation_identity) FROM transfer_personal_activity e),
   (SELECT jsonb_agg(to_jsonb(b) ORDER BY location_id,variant_id) FROM inventory_balances b),
   (SELECT jsonb_agg(to_jsonb(v) ORDER BY scope) FROM realtime_revisions v))::text`).Scan(&s) != nil {
			t.Fatal("schema snapshot failed")
		}
		return s
	}
	before := snapshot()
	tx, err := p.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT set_config('luson.transfer_account_id','2',true);
 INSERT INTO transfer_requests(creator_location_id,kind,origin_location_id,destination_location_id,approver_location_id,retry_key,payload_sha256) VALUES(2,'request_stock',1,2,1,'t10-schema-rollback',decode(repeat('00',32),'hex'))`); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err == nil {
		t.Fatal("incomplete request committed")
	}
	if before != snapshot() {
		t.Fatal("deferred failure leaked author, request, inventory or revisions")
	}
	// A plain owner-level write remains unknown, even after a pooled transaction
	// previously supplied authenticated context. There is no migration backfill.
	exec(`WITH r AS (INSERT INTO transfer_requests(creator_location_id,kind,origin_location_id,destination_location_id,approver_location_id,retry_key,payload_sha256) VALUES(2,'request_stock',1,2,1,'t10-schema-unknown',decode(repeat('00',32),'hex')) RETURNING id)
 INSERT INTO transfer_request_items(request_id,variant_id,quantity) SELECT id,1,1 FROM r`)
	var events int
	if p.QueryRow(ctx, `SELECT count(*) FROM transfer_personal_activity`).Scan(&events) != nil || events != 0 {
		t.Fatal("owner SQL manufactured author")
	}
	tx, err = p.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT set_config('luson.transfer_account_id','2',true);
 WITH r AS (INSERT INTO transfer_requests(creator_location_id,kind,origin_location_id,destination_location_id,approver_location_id,retry_key,payload_sha256) VALUES(2,'request_stock',1,2,1,'t10-schema-personal',decode(repeat('00',32),'hex')) RETURNING id)
 INSERT INTO transfer_request_items(request_id,variant_id,quantity) SELECT id,1,1 FROM r`); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	before = snapshot()
	for _, sql := range []string{
		`UPDATE transfer_personal_activity SET display_name='Forged'`,
		`DELETE FROM transfer_personal_activity`,
		`TRUNCATE transfer_personal_activity`,
		`INSERT INTO transfer_personal_activity SELECT * FROM transfer_personal_activity`,
	} {
		if _, err = p.Exec(ctx, sql); err == nil {
			t.Fatal("personal evidence mutation admitted")
		}
		if before != snapshot() {
			t.Fatal("rejected evidence mutation changed stored state")
		}
	}
	if err = db.Apply(ctx, p); err != nil {
		t.Fatal("migration reapply", err)
	}
	if before != snapshot() {
		t.Fatal("migration reapply changed historical authorship")
	}
}
