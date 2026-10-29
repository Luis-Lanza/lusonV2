package migrations_test

import (
	"context"
	"testing"

	"luson/api/internal/bootstrap"
	"luson/api/internal/config"
	"luson/api/internal/testpg"
)

func TestDynamicBranchAudiences(t *testing.T) {
	ctx := context.Background()
	p := testpg.Open(t)
	if err := bootstrap.Initialize(ctx, p, config.LocalTrial); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Exec(ctx, `SELECT create_branch('Sucursal C'); INSERT INTO locations(id,name) VALUES(32767,'Upper branch')`); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Exec(ctx, `INSERT INTO auth_accounts(id,location_id,username,password_hash) VALUES
 (1,1,'warehouse','opaque'),(20,4,'operator_c','opaque')`); err != nil {
		t.Fatal(err)
	}
	// Stable usernames must not prevent the already authorized lifecycle edits.
	if _, err := p.Exec(ctx, `UPDATE auth_accounts SET username=username,display_name='Operator C',
 password_hash='replacement',location_id=3,enabled=false,must_change_password=false,
 authority_version=authority_version+1 WHERE id=20`); err != nil {
		t.Fatal("allowed account lifecycle edit rejected", err)
	}
	var lifecycle bool
	if err := p.QueryRow(ctx, `SELECT username='operator_c' AND display_name='Operator C'
 AND password_hash='replacement' AND location_id=3 AND NOT enabled
 AND NOT must_change_password AND authority_version=2 FROM auth_accounts WHERE id=20`).Scan(&lifecycle); err != nil || !lifecycle {
		t.Fatal("allowed account lifecycle edit not preserved", err)
	}
	var complete bool
	if err := p.QueryRow(ctx, `SELECT
 (SELECT count(*) FROM inventory_balances WHERE location_id IN (4,32767) AND existing=0 AND reserved=0)=380
 AND (SELECT count(*) FROM realtime_revisions WHERE scope IN ('transfers:4','transfers:32767') AND revision=0)=2`).Scan(&complete); err != nil || !complete {
		t.Fatal("stock/audience initialization incomplete", err)
	}
	snapshot := func() string {
		t.Helper()
		var data string
		if err := p.QueryRow(ctx, `SELECT jsonb_build_array(
 (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM locations l),
 (SELECT jsonb_agg(to_jsonb(b) ORDER BY location_id,variant_id) FROM inventory_balances b),
 (SELECT jsonb_agg(to_jsonb(r) ORDER BY scope) FROM realtime_revisions r),
 (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM auth_accounts a))::text`).Scan(&data); err != nil {
			t.Fatal(err)
		}
		return data
	}
	for _, sql := range []string{
		`UPDATE auth_accounts SET username='renamed_warehouse' WHERE id=1`,
		`UPDATE auth_accounts SET username='renamed_operator' WHERE id=20`,
		`UPDATE auth_accounts SET id=21 WHERE id=20`,
		`DELETE FROM auth_accounts WHERE id=1`,
		`INSERT INTO realtime_revisions(scope) VALUES('transfers:99')`,
		`INSERT INTO realtime_revisions(scope) VALUES('transfers:04')`,
		`UPDATE realtime_revisions SET revision=0 WHERE scope='transfers:4'`,
		`UPDATE realtime_revisions SET scope='transfers:99' WHERE scope='transfers:4'`,
		`DELETE FROM realtime_revisions WHERE scope='transfers:4'`,
		`INSERT INTO locations(id,name) VALUES(32768,'Overflow branch')`,
		`SELECT create_branch('Exhausted range')`,
	} {
		before := snapshot()
		if _, err := p.Exec(ctx, sql); err == nil {
			t.Fatal("accepted invalid audience or account identity", sql)
		}
		if snapshot() != before {
			t.Fatal("rejected statement changed accounts, stock or revisions")
		}
	}
	if err := bootstrap.Check(ctx, p); err != nil {
		t.Fatal(err)
	}
}
