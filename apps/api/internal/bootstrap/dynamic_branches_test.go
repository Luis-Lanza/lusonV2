package bootstrap_test

import (
	"context"
	"testing"

	"luson/api/internal/bootstrap"
	"luson/api/internal/config"
	"luson/api/internal/testpg"
)

func TestDynamicBranchBootstrap(t *testing.T) {
	ctx := context.Background()
	p := testpg.Open(t)
	if err := bootstrap.Initialize(ctx, p, config.LocalTrial); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Exec(ctx, `SELECT create_branch('Sucursal C')`); err != nil {
		t.Fatal(err)
	}
	if err := bootstrap.Check(ctx, p); err != nil {
		t.Fatal(err)
	}
	if err := bootstrap.Seed(ctx, p, config.LocalTrial); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := p.QueryRow(ctx, `SELECT count(*) FROM inventory_balances WHERE location_id=4 AND existing=0 AND reserved=0 AND available=0`).Scan(&count); err != nil || count != 190 {
		t.Fatal("zero balances", count, err)
	}
	if _, err := p.Exec(ctx, `DELETE FROM inventory_balances WHERE location_id=4 AND variant_id=190`); err != nil {
		t.Fatal(err)
	}
	if err := bootstrap.Check(ctx, p); err == nil {
		t.Fatal("accepted partial branch matrix")
	}
	if err := bootstrap.Seed(ctx, p, config.LocalTrial); err == nil {
		t.Fatal("repaired partial branch matrix")
	}
	if err := p.QueryRow(ctx, `SELECT count(*) FROM inventory_balances WHERE location_id=4`).Scan(&count); err != nil || count != 189 {
		t.Fatal("partial data changed", count, err)
	}
}
