package migrations_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"luson/api/internal/testpg"
	"luson/api/migrations"
)

// 042 owns one rule: the instant of a branch expense is the database's, not the caller's.
func TestBranchExpenseInstantSchemaStructure(t *testing.T) {
	b, err := migrations.Files.ReadFile("042_branch_expense_instant.sql")
	if err != nil {
		t.Fatal("the expense instant migration must be embedded", err)
	}
	sql := string(b)
	for _, required := range []string{
		"CREATE FUNCTION stamp_branch_expense()",
		"IF NEW.kind = 'gasto' THEN",
		"NEW.occurred_at := now();",
		"CREATE TRIGGER stamp_branch_expense_before_insert BEFORE INSERT ON branch_cash_movements",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("the expense instant migration must state %q", required)
		}
	}
	for _, forbidden := range []string{"CREATE TABLE", "ALTER TABLE", "DROP "} {
		if strings.Contains(sql, forbidden) {
			t.Fatalf("042 adds a trigger only, it must not use %q", forbidden)
		}
	}
}

// S12: a hand-written expense cannot be dated into a settlement that is already closed, so
// the list a settlement publishes stays the history its branch signed.
func TestBranchExpenseIsStampedWithItsOwnInstant(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	applyMigrationRange(t, ctx, p, 42)
	seedPrefixCatalog(t, ctx, p)
	if _, err := p.Exec(ctx, `INSERT INTO auth_accounts(location_id,username,password_hash)
 VALUES(1,'almacen','x'),(2,'sucursal_a','x')`); err != nil {
		t.Fatal("the accounts could not be provisioned")
	}
	// The rate the proposal needs: a settlement cannot be offered without one.
	if _, err := p.Exec(ctx, `INSERT INTO branch_settings(branch_location_id,
 commission_rate_percent,updated_by_account_id) VALUES(2,0.00,1)`); err != nil {
		t.Fatal("the commission rate could not be configured")
	}

	// A caller that states a date of its own is overwritten: the row carries the instant it
	// was written, so it cannot land in the window of an older settlement.
	var written time.Time
	if err := p.QueryRow(ctx, `INSERT INTO branch_cash_movements(branch_location_id,kind,amount,
 description,occurred_at,created_by_account_id)
 VALUES(2,'gasto',30.00,'Flete','2020-01-01T00:00:00Z',2) RETURNING occurred_at`).Scan(&written); err != nil {
		t.Fatalf("the expense could not be recorded: %v", err)
	}
	if age := time.Since(written); age < 0 || age > time.Minute {
		t.Fatalf("an expense is stamped with the instant it is written, got %s", written)
	}

	// The settlement transfer keeps the instant its closure writes, so this trigger must not
	// reach it: a settlement opened now proposes and closes with its own ledger rows.
	var id int64
	if err := p.QueryRow(ctx, `INSERT INTO branch_closings(branch_location_id,period_start,
 commission_rate_percent,opened_by_account_id) VALUES(2,now(),0,1) RETURNING id`).Scan(&id); err != nil {
		t.Fatalf("the settlement could not be opened: %v", err)
	}
	if _, err := p.Exec(ctx, `INSERT INTO closing_proposals(closing_id,round,proposed_payload,
 proposed_by_account_id) VALUES($1,1,'{}'::jsonb,1)`, id); err != nil {
		t.Fatalf("the round could not be recorded: %v", err)
	}
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='proposed',counted_cash=100.00,
 closing_cash=60.00 WHERE id=$1`, id); err != nil {
		t.Fatalf("the settlement could not be proposed: %v", err)
	}
	if _, err := p.Exec(ctx, `UPDATE closing_proposals SET decision='accepted',
 decided_by_account_id=2 WHERE closing_id=$1`, id); err != nil {
		t.Fatalf("the branch could not accept: %v", err)
	}
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='closed' WHERE id=$1`, id); err != nil {
		t.Fatalf("the settlement could not close: %v", err)
	}
	var transfer string
	if err := p.QueryRow(ctx, `SELECT kind||':'||amount::text FROM branch_cash_movements
 WHERE closing_id=$1 ORDER BY id LIMIT 1`, id).Scan(&transfer); err != nil {
		t.Fatalf("the closure transfer could not be read: %v", err)
	}
	if transfer != "recaudacion:40.00" {
		t.Fatalf("the closure still writes its own transfer, got %s", transfer)
	}
}
