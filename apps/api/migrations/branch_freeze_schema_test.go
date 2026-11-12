package migrations_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/testpg"
	"luson/api/migrations"
)

// migration035 is the other half of the settlement vertical: everything that reads or
// writes another table -- the freeze predicate and its wiring, the stock snapshot, the
// offer, the cash ledger and its provenance, the stock the closure applies, and the
// reconciliation guards. It is add-only, like every migration of the vertical: 001-034
// are applied and checksummed, so no admission function of theirs is rewritten and every
// guard is a new trigger.
const migration035 = "035_branch_guards.sql"

// TestBranchFreezeSchemaStructure reads the embedded migration exactly as PostgreSQL
// receives it and asserts the wiring it must install: the freeze predicate with its
// per-branch lock, one guard per branch-facing admission path, the snapshot, the offer,
// the ledger's provenance and the closure -- and no rewrite of anything that exists.
func TestBranchFreezeSchemaStructure(t *testing.T) {
	b, err := migrations.Files.ReadFile(migration035)
	if err != nil {
		t.Fatal("the guards migration must be embedded", err)
	}
	sql := string(b)
	for _, required := range []string{
		// The freeze predicate, and the per-branch advisory lock that makes it
		// synchronise with the settlement instead of racing it (R4-001).
		"CREATE FUNCTION branch_closure_blocker(target smallint) RETURNS boolean LANGUAGE sql STABLE AS $$",
		"CREATE FUNCTION assert_branch_not_frozen(target smallint) RETURNS void LANGUAGE plpgsql AS $$",
		"PERFORM pg_advisory_xact_lock(340251, target::integer);",
		"IF branch_closure_blocker(target) THEN",

		// The count sheet's snapshot and its admission: the expected quantity is the
		// balance at the cut instant, never a caller promise (S4).
		"CREATE FUNCTION seed_closing_count_lines() RETURNS trigger LANGUAGE plpgsql AS $$",
		"CREATE TRIGGER seed_closing_count_lines AFTER INSERT ON branch_closings",
		"CREATE FUNCTION admit_closing_count_line() RETURNS trigger LANGUAGE plpgsql AS $$",
		"CREATE TRIGGER admit_closing_count_line BEFORE INSERT ON closing_count_lines",
		"NEW.expected_quantity := coalesce(balance.existing, 0);",

		// The cash ledger: a branch expense while the branch operates, and the money of a
		// settlement only from its own closure, proven by a transaction-local marker and
		// the trigger depth it can only be set from (R3-003).
		"CREATE FUNCTION admit_branch_cash_movement() RETURNS trigger LANGUAGE plpgsql AS $$",
		"CREATE TRIGGER admit_branch_cash_movement BEFORE INSERT ON branch_cash_movements",
		"current_setting('luson.closing_ledger', true) IS DISTINCT FROM NEW.closing_id::text",
		"pg_trigger_depth() < 2",
		"MESSAGE='A cash movement of a settlement is written by its closure'",

		// The offer the branch is shown (R1-001): the totals of the period from the sale
		// lines and the sale payments of the window, and the commission over the frozen
		// rate, rounded once, half a cent up (S6, S20).
		"CREATE FUNCTION record_branch_closing_offer() RETURNS trigger LANGUAGE plpgsql AS $$",
		"CREATE TRIGGER record_branch_closing_offer BEFORE UPDATE ON branch_closings",
		"FROM sale_lines line",
		"JOIN sales sale ON sale.id = line.sale_id",
		"AND sale.created_at >= NEW.period_start",
		"AND sale.created_at < NEW.cut_at",
		"coalesce(sum(sale.cash_amount),0) AS cash",
		"NEW.sales_total := sold;",
		"NEW.qr_total := 0;",
		"NEW.commission_amount := round(sold * NEW.commission_rate_percent / 100, 2);",

		// The ledger rows of the closure, written while the row still reads as proposed
		// and marked with the settlement they belong to.
		"CREATE FUNCTION record_branch_closing_ledger() RETURNS trigger LANGUAGE plpgsql AS $$",
		"CREATE TRIGGER record_branch_closing_ledger BEFORE UPDATE ON branch_closings",
		"PERFORM set_config('luson.closing_ledger', NEW.id::text, true);",
		"taken := NEW.counted_cash + NEW.contributed_cash - NEW.closing_cash;",
		"abs(taken)",

		// The closure: any open reservation blocks it (R3-002, R4-004), the count is the
		// cut instant's snapshot, and the stock ends exactly as counted (S5).
		"CREATE FUNCTION apply_branch_closing_closure() RETURNS trigger LANGUAGE plpgsql AS $$",
		"CREATE TRIGGER apply_branch_closing_closure AFTER UPDATE ON branch_closings",
		"IF coalesce(balance.reserved, 0) > 0 THEN",
		"MESSAGE='Variant ' || line.variant_id || ' still has reserved stock'",
		"FOR UPDATE",
		"INSERT INTO inventory_balances(location_id, variant_id, existing, reserved)",
		"ON CONFLICT (location_id, variant_id)",
		"DO UPDATE SET existing = EXCLUDED.existing;",

		// The freeze wiring: one guard per branch-facing admission path, refusing with
		// the predicate's own domain error.
		"CREATE FUNCTION admit_sale_when_branch_operating() RETURNS trigger LANGUAGE plpgsql AS $$",
		"CREATE TRIGGER admit_frozen_branch_sale BEFORE INSERT ON sales",
		"CREATE FUNCTION admit_purchase_when_branch_operating() RETURNS trigger LANGUAGE plpgsql AS $$",
		"CREATE TRIGGER admit_frozen_branch_purchase BEFORE INSERT ON purchases",
		"CREATE FUNCTION admit_transfer_when_branches_operating() RETURNS trigger LANGUAGE plpgsql AS $$",
		"CREATE TRIGGER admit_frozen_branch_transfer BEFORE INSERT ON transfer_requests",
		"NEW.origin_location_id <= NEW.destination_location_id",
		"CREATE FUNCTION admit_transfer_move_when_branches_operating() RETURNS trigger LANGUAGE plpgsql AS $$",
		"CREATE TRIGGER admit_frozen_branch_transfer_move BEFORE UPDATE ON transfer_requests",
		"IF OLD.status = 'approved' AND NEW.status = 'in_transit' THEN",
		"ELSIF OLD.status = 'in_transit' AND NEW.status = 'received' THEN",

		// The reconciliation guards of 011/012/013/018 (R4-002): the actor's location and
		// both endpoints of the request, because those operations move a branch's stock.
		"CREATE FUNCTION admit_reconciliation_when_branch_operating() RETURNS trigger LANGUAGE plpgsql AS $$",
		"PERFORM assert_branch_not_frozen(NEW.actor_location_id);",
		"PERFORM assert_branch_not_frozen(header.origin_location_id);",
		"PERFORM assert_branch_not_frozen(header.destination_location_id);",
		"CREATE TRIGGER admit_frozen_branch_count BEFORE INSERT ON transfer_count_operations",
		"CREATE TRIGGER admit_frozen_branch_restitution BEFORE INSERT ON transfer_restitution_operations",
		"CREATE TRIGGER admit_frozen_branch_dispatch BEFORE INSERT ON transfer_dispatch_operations",
		"CREATE TRIGGER admit_frozen_branch_unified BEFORE INSERT ON transfer_unified_operations",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("missing %s", required)
		}
	}
	// Every trigger and every function of this migration is accounted for: a fifteenth
	// trigger would mean a table was wired twice, and a missing one would leave a
	// branch-facing flow operating while the branch is frozen.
	if got := strings.Count(sql, "CREATE TRIGGER"); got != 14 {
		t.Errorf("the guards migration must install fourteen triggers, got %d", got)
	}
	if got := strings.Count(sql, "CREATE FUNCTION"); got != 13 {
		t.Errorf("the guards migration must install thirteen functions, got %d", got)
	}
	// The freeze predicate is called once per branch-bearing column, never duplicated.
	if got := strings.Count(sql, "PERFORM assert_branch_not_frozen("); got != 14 {
		t.Errorf("every branch column of every guarded row is asserted once, got %d", got)
	}
	// PostgreSQL fires the BEFORE ROW triggers of one table in name order: a guard has to
	// sort before the admission or apply trigger it must precede, and the closure's two
	// triggers have to sort after the state machine of 034 that validates the transition
	// and freezes the rate they read.
	for _, pair := range [][2]string{
		{"admit_branch_closing_transition", "record_branch_closing_ledger"},
		{"admit_branch_closing_transition", "record_branch_closing_offer"},
		{"record_branch_closing_ledger", "record_branch_closing_offer"},
		{"admit_frozen_branch_sale", "admit_sale"},
		{"admit_frozen_branch_purchase", "admit_purchase"},
		{"admit_frozen_branch_transfer", "admit_transfer_creation"},
		{"admit_frozen_branch_transfer_move", "admit_transfer_decision"},
		{"admit_frozen_branch_count", "apply_count_operation"},
		{"admit_frozen_branch_restitution", "apply_restitution_operation"},
		{"admit_frozen_branch_dispatch", "apply_transfer_dispatch_operation"},
		{"admit_frozen_branch_unified", "apply_transfer_unified_operation"},
	} {
		if !(pair[0] < pair[1]) {
			t.Errorf("%s must sort before %s to fire first", pair[0], pair[1])
		}
	}
	// The migration decides from the schema, so it says which tables are branch-facing and
	// why, why the other tables that reference a location are left alone, and which
	// finding each guard closes.
	for _, documented := range []string{
		"branch-facing", "warehouse-only", "S3", "S4", "S5", "S6", "S10", "S13", "S20",
		"R1-001", "R3-002", "R3-003", "R4-001", "R4-002", "R4-004",
		"LV001", "LP001", "LS005", "LC002",
		"stock_entries", "stock_adjustments", "inventory_balances", "branch_cash_movements",
		"transfer_count_operations", "transfer_restitution_operations",
		"transfer_dispatch_operations", "transfer_unified_operations",
		"011", "012", "013", "018",
	} {
		if !strings.Contains(sql, documented) {
			t.Errorf("the migration must document its own decision: %s", documented)
		}
	}
	// Add-only: no historical table, function or trigger is rewritten, dropped or given a
	// second owner, because 001-034 are already applied and checksummed. It guards no
	// balance either: the closure of the very settlement that freezes the branch writes
	// that table.
	for _, forbidden := range []string{
		"CREATE TABLE", "ALTER TABLE", "CREATE OR REPLACE", "DROP ", "TRUNCATE ",
		"ON inventory_balances", "ON branch_closings_transition",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("the guards migration must be additive and must not guard a shared table: %s", forbidden)
		}
	}
	// A function is created before the trigger that executes it.
	for _, pair := range [][2]string{
		{"CREATE FUNCTION seed_closing_count_lines", "CREATE TRIGGER seed_closing_count_lines"},
		{"CREATE FUNCTION admit_closing_count_line", "CREATE TRIGGER admit_closing_count_line"},
		{"CREATE FUNCTION admit_branch_cash_movement", "CREATE TRIGGER admit_branch_cash_movement"},
		{"CREATE FUNCTION record_branch_closing_offer", "CREATE TRIGGER record_branch_closing_offer"},
		{"CREATE FUNCTION record_branch_closing_ledger", "CREATE TRIGGER record_branch_closing_ledger"},
		{"CREATE FUNCTION apply_branch_closing_closure", "CREATE TRIGGER apply_branch_closing_closure"},
		{"CREATE FUNCTION admit_sale_when_branch_operating", "CREATE TRIGGER admit_frozen_branch_sale"},
		{"CREATE FUNCTION admit_purchase_when_branch_operating", "CREATE TRIGGER admit_frozen_branch_purchase"},
		{"CREATE FUNCTION admit_transfer_when_branches_operating", "CREATE TRIGGER admit_frozen_branch_transfer "},
		{"CREATE FUNCTION admit_transfer_move_when_branches_operating", "CREATE TRIGGER admit_frozen_branch_transfer_move"},
		{"CREATE FUNCTION admit_reconciliation_when_branch_operating", "CREATE TRIGGER admit_frozen_branch_count"},
	} {
		first, second := strings.Index(sql, pair[0]), strings.Index(sql, pair[1])
		if first < 0 || second < 0 || first > second {
			t.Errorf("%s must be defined before %s", pair[0], pair[1])
		}
	}
}

// freezeFixture is the settlement block applied through 035: the prefix catalogue, one
// account per location, the balances of the warehouse and of both branches, one price per
// branch and the commission rate the closure reads.
func freezeFixture(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	applyMigrationRange(t, ctx, p, 35)
	seedPrefixCatalog(t, ctx, p)
	// Account i+1 belongs to location i+1, exactly like the provisioned installation.
	if _, err := p.Exec(ctx, `INSERT INTO auth_accounts(location_id,username,password_hash)
 VALUES(1,'almacen','x'),(2,'sucursal_a','x'),(3,'sucursal_b','x')`); err != nil {
		t.Fatal("the accounts could not be provisioned")
	}
	// The warehouse ships and stores; branch 2 is the one that gets settled and branch 3
	// is the one that must keep operating. Variant 2 exists only in branch 2, so the count
	// sheet of its settlement has two lines.
	if _, err := p.Exec(ctx, `INSERT INTO inventory_balances(location_id,variant_id,existing,reserved)
 VALUES(1,1,20,0),(2,1,10,0),(2,2,4,0),(3,1,5,0)`); err != nil {
		t.Fatal("the stock could not be provisioned")
	}
	// One price per branch: the sale trigger refuses a battery the branch has no pair for.
	if _, err := p.Exec(ctx, `INSERT INTO branch_prices(branch_location_id,catalog_entry_id,min_price,suggested_price,updated_by_account_id)
 VALUES(2,1,2000.00,2500.00,1),(3,1,2000.00,2500.00,1)`); err != nil {
		t.Fatal("the branch prices could not be configured")
	}
	// The rate the closure needs when the warehouse proposes: the freeze is reversible
	// only if the settlement can actually close.
	if _, err := p.Exec(ctx, `INSERT INTO branch_settings(branch_location_id,commission_rate_percent,updated_by_account_id)
 VALUES(2,12.50,1)`); err != nil {
		t.Fatal("the branch commission could not be configured")
	}
	return ctx, p
}

// trySale writes one complete sale of one variant on one branch, exactly like the counter
// does: the header with the cash it was paid with, the commercial line and the unit of the
// battery that left with its serial. It returns the error instead of asserting, so the
// same call is used where the sale must be admitted and where it must be refused.
func trySale(ctx context.Context, p *pgxpool.Pool, branch int, serial string) error {
	return sell(ctx, p, branch, serial, "2000.00", "2000.00", "0.00", "0.00")
}

// sell is one sale of one unit of variant 1 at the asked price, paid with the asked mix:
// the three amounts 027 stores on the header have to add up to the total, which is what
// the sale's own settlement check enforces.
func sell(ctx context.Context, p *pgxpool.Pool, branch int, serial, price, cash, card, transfer string) error {
	tx, err := p.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var id int64
	// The selling account is the account of the branch: the sale trigger refuses any other.
	if err := tx.QueryRow(ctx, `INSERT INTO sales(branch_location_id,cash_amount,card_amount,
 transfer_amount,customer_name,total,created_by_account_id)
 VALUES($1::smallint,$2::numeric,$3::numeric,$4::numeric,'Cliente',$5::numeric,$1::integer)
 RETURNING id`, branch, cash, card, transfer, price).Scan(&id); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO sale_lines(sale_id,variant_id,quantity,unit_price)
 VALUES($1,1,1,$2::numeric)`, id, price); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO sale_units(sale_id,variant_id,unit_ordinal,serial_number)
 VALUES($1,1,1,$2)`, id, serial); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// tryPurchase records one purchase of a branch: a used battery at a typed price, paid in
// cash. The line is what makes the document add up, and the document is what the freeze
// has to refuse.
func tryPurchase(ctx context.Context, p *pgxpool.Pool, branch int, key string) error {
	tx, err := p.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var id int64
	if err := tx.QueryRow(ctx, `INSERT INTO purchases(operation_key,location_id,total,paid_cash,paid_transfer,created_by_account_id)
 VALUES($1,$2::smallint,25000.00,25000.00,0.00,$2::integer) RETURNING id`, key, branch).Scan(&id); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO purchase_used_lines(purchase_id,model,quantity,unit_price)
 VALUES($1,'NS60ZL',1,25000.00)`, id); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// tryTransfer is the request a branch makes when it needs stock: the warehouse is the origin
// and the branch is the destination and the creator of its own request.
func tryTransfer(ctx context.Context, p *pgxpool.Pool, branch int, key string) error {
	tx, err := p.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var id int64
	if err := tx.QueryRow(ctx, `INSERT INTO transfer_requests(creator_location_id,kind,origin_location_id,
 destination_location_id,approver_location_id,retry_key,payload_sha256)
 VALUES($1::smallint,'request_stock',1,$1::smallint,1,$2,decode(repeat('00',32),'hex')) RETURNING id`, branch, key).Scan(&id); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO transfer_request_items(request_id,variant_id,quantity)
 VALUES($1,1,2)`, id); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// createTransfer writes one request with its item: the branch asks the warehouse for stock
// or sends stock to it. Everything else about the request (its decision, its dispatch, its
// receipt) is history that only exists afterwards.
func createTransfer(t *testing.T, ctx context.Context, p *pgxpool.Pool, creator int, kind string,
	origin, destination, approver int, key string, quantity int64) int64 {
	t.Helper()
	tx, err := p.Begin(ctx)
	if err != nil {
		t.Fatal("the transfer transaction could not start")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var id int64
	if err := tx.QueryRow(ctx, `INSERT INTO transfer_requests(creator_location_id,kind,origin_location_id,
 destination_location_id,approver_location_id,retry_key,payload_sha256)
 VALUES($1,$2,$3,$4,$5,$6,decode(repeat('00',32),'hex')) RETURNING id`,
		creator, kind, origin, destination, approver, key).Scan(&id); err != nil {
		t.Fatalf("the request could not be created: %v", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO transfer_request_items(request_id,variant_id,quantity)
 VALUES($1,1,$2)`, id, quantity); err != nil {
		t.Fatalf("the request item could not be created: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("the request must be admitted: %v", err)
	}
	return id
}

// approveTransfer owns the request's stock the way the store does: every item allocated at
// the origin, the origin reservation raised, and only then the approval that the deferred
// ownership rule accepts.
func approveTransfer(t *testing.T, ctx context.Context, p *pgxpool.Pool, id int64) {
	t.Helper()
	tx, err := p.Begin(ctx)
	if err != nil {
		t.Fatal("the approval transaction could not start")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	for _, statement := range []string{
		`INSERT INTO transfer_request_allocations(request_id,variant_id,quantity)
 SELECT request_id,variant_id,quantity FROM transfer_request_items WHERE request_id=$1 ORDER BY variant_id`,
		`UPDATE inventory_balances b SET reserved=b.reserved+i.quantity
 FROM transfer_request_items i JOIN transfer_requests r ON r.id=i.request_id
 WHERE i.request_id=$1 AND b.location_id=r.origin_location_id AND b.variant_id=i.variant_id`,
		`UPDATE transfer_requests SET status='approved' WHERE id=$1`,
	} {
		if _, err := tx.Exec(ctx, statement, id); err != nil {
			t.Fatalf("the request could not be approved: %v", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("the approval must be admitted: %v", err)
	}
}

// dispatchTransfer moves an approved request in transit: the origin's stock actually leaves.
func dispatchTransfer(ctx context.Context, p *pgxpool.Pool, id int64) error {
	_, err := p.Exec(ctx, `UPDATE transfer_requests SET status='in_transit' WHERE id=$1`, id)
	return err
}

// receiveTransfer records everything that arrived and finalizes the request, which is the
// mobile the stock enters with. The refusal is returned, so the caller proves that neither
// half of the receipt reached the database.
func receiveTransfer(t *testing.T, ctx context.Context, p *pgxpool.Pool, id int64) error {
	t.Helper()
	tx, err := p.Begin(ctx)
	if err != nil {
		t.Fatal("the receipt transaction could not start")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(ctx, `INSERT INTO transfer_receipt_lines(request_id,variant_id,expected_quantity,
 actual_quantity,available_quantity)
 SELECT request_id,variant_id,quantity,quantity,quantity FROM transfer_request_items WHERE request_id=$1`, id); err != nil {
		t.Fatalf("the receipt lines could not be recorded: %v", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE transfer_requests SET status='received' WHERE id=$1`, id); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// receiveStockedTransfer builds the transfer every reconciliation operation needs: a
// request the warehouse ships to the branch and the branch receives, so the request is
// 'received' with its receipt line and the corrections have something to correct.
func receiveStockedTransfer(t *testing.T, ctx context.Context, p *pgxpool.Pool, key string) int64 {
	t.Helper()
	id := createTransfer(t, ctx, p, 2, "request_stock", 1, 2, 1, key, 2)
	approveTransfer(t, ctx, p, id)
	if err := dispatchTransfer(ctx, p, id); err != nil {
		t.Fatalf("the warehouse must be able to ship to the branch: %v", err)
	}
	if err := receiveTransfer(t, ctx, p, id); err != nil {
		t.Fatalf("the branch must be able to receive the shipment: %v", err)
	}
	return id
}

// tryShipment is the warehouse's own transfer: it authorizes and reserves at creation and
// then owns every item, which is the only shape a direct shipment is admitted in.
func tryShipment(t *testing.T, ctx context.Context, p *pgxpool.Pool, destination int, key string) error {
	t.Helper()
	tx, err := p.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var id int64
	if err := tx.QueryRow(ctx, `INSERT INTO transfer_requests(creator_location_id,kind,origin_location_id,
 destination_location_id,approver_location_id,status,retry_key,payload_sha256)
 VALUES(1,'direct_shipment',1,$1,1,'approved',$2,decode(repeat('00',32),'hex')) RETURNING id`,
		destination, key).Scan(&id); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO transfer_request_items(request_id,variant_id,quantity)
 VALUES($1,1,2)`, id); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE inventory_balances b SET reserved=b.reserved+i.quantity
 FROM transfer_request_items i WHERE i.request_id=$1 AND b.location_id=1 AND b.variant_id=i.variant_id`, id); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO transfer_request_allocations(request_id,variant_id,quantity)
 SELECT request_id,variant_id,quantity FROM transfer_request_items WHERE request_id=$1`, id); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// tryStockEntry is the warehouse's stock ingress, the one document a branch can never
// write: it is warehouse-only, so it is exactly what the freeze must not touch.
func tryStockEntry(ctx context.Context, p *pgxpool.Pool, key string) error {
	tx, err := p.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var id int64
	if err := tx.QueryRow(ctx, `INSERT INTO stock_entries(operation_key,location_id,note,created_by_account_id)
 VALUES($1,1,'',1) RETURNING id`, key).Scan(&id); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO stock_entry_lines(entry_id,variant_id,quantity)
 VALUES($1,1,5)`, id); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// stocks is the whole balance matrix as one value: "writes nothing and moves no counter" is
// then one comparison instead of a promise about several tables.
func stocks(t *testing.T, ctx context.Context, p *pgxpool.Pool) string {
	t.Helper()
	var snapshot string
	if err := p.QueryRow(ctx, `SELECT coalesce(string_agg(location_id||':'||variant_id||':'
         ||existing||':'||reserved,',' ORDER BY location_id,variant_id),'') FROM inventory_balances`).Scan(&snapshot); err != nil {
		t.Fatal("the balance matrix could not be read")
	}
	return snapshot
}

// documents counts every row a refused branch write could have left behind, including the
// ledgers the closure feeds and the reconciliation evidence: a refusal that writes one of
// them is not a refusal.
func documents(t *testing.T, ctx context.Context, p *pgxpool.Pool) string {
	t.Helper()
	var snapshot string
	if err := p.QueryRow(ctx, `SELECT (SELECT count(*) FROM sales)||':'||(SELECT count(*) FROM sale_lines)
         ||':'||(SELECT count(*) FROM sale_units)||':'||(SELECT count(*) FROM purchases)
         ||':'||(SELECT count(*) FROM purchase_used_lines)||':'||(SELECT count(*) FROM transfer_requests)
         ||':'||(SELECT count(*) FROM transfer_request_items)
         ||':'||(SELECT count(*) FROM transfer_request_allocations)
         ||':'||(SELECT count(*) FROM transfer_receipt_lines)
         ||':'||(SELECT count(*) FROM stock_entries)
         ||':'||(SELECT count(*) FROM branch_cash_movements)`).Scan(&snapshot); err != nil {
		t.Fatal("the document snapshot could not be read")
	}
	return snapshot
}

// reconciliationEvidence counts the operation tables of 011, 012, 013 and 018: no refused
// reconciliation may leave a row in any of them.
func reconciliationEvidence(t *testing.T, ctx context.Context, p *pgxpool.Pool) string {
	t.Helper()
	var snapshot string
	if err := p.QueryRow(ctx, `SELECT (SELECT count(*) FROM transfer_count_operations)
         ||':'||(SELECT count(*) FROM transfer_restitution_operations)
         ||':'||(SELECT count(*) FROM transfer_dispatch_operations)
         ||':'||(SELECT count(*) FROM transfer_unified_operations)`).Scan(&snapshot); err != nil {
		t.Fatal("the reconciliation evidence could not be read")
	}
	return snapshot
}

// branchSequence is the last correlative the branch allocated, which is the counter a
// refused sale must not move.
func branchSequence(t *testing.T, ctx context.Context, p *pgxpool.Pool, branch int) int64 {
	t.Helper()
	var sequence int64
	if err := p.QueryRow(ctx, `SELECT coalesce(max(branch_sequence),0) FROM sales
 WHERE branch_location_id=$1`, branch).Scan(&sequence); err != nil {
		t.Fatal("the branch correlative could not be read")
	}
	return sequence
}

// transferStatus is where the request stands, so a refused transition is proven not to have
// moved the document one step forward.
func transferStatus(t *testing.T, ctx context.Context, p *pgxpool.Pool, id int64) string {
	t.Helper()
	var status string
	if err := p.QueryRow(ctx, `SELECT status FROM transfer_requests WHERE id=$1`, id).Scan(&status); err != nil {
		t.Fatal("the request status could not be read")
	}
	return status
}

// TestBranchFreezeRefusesBranchTrading proves the freeze on a live database: while branch 2
// has a live settlement, its sale, its purchase and its transfer request are refused with
// LC001, the transfer it had already approved can be neither dispatched nor received, and
// none of those attempts writes a row or moves a counter. The warehouse and the branch that
// is not being settled keep working, which is the other half of S3.
func TestBranchFreezeRefusesBranchTrading(t *testing.T) {
	ctx, p := freezeFixture(t)

	// The two movements that were already in flight when the warehouse arrived: branch 2
	// had sent stock to it, and a shipment of the warehouse to branch 2 was already on its
	// way. Both were legal when they happened, and neither may move now.
	outbound := createTransfer(t, ctx, p, 2, "send_to_warehouse", 2, 1, 1, "freeze-outbound-0001", 2)
	approveTransfer(t, ctx, p, outbound)
	inbound := createTransfer(t, ctx, p, 2, "request_stock", 1, 2, 1, "freeze-inbound-00001", 2)
	approveTransfer(t, ctx, p, inbound)
	if err := dispatchTransfer(ctx, p, inbound); err != nil {
		t.Fatalf("the warehouse must be able to ship to branch 2 while it still operates: %v", err)
	}
	before, documentsBefore := stocks(t, ctx, p), documents(t, ctx, p)

	openSettlement(t, ctx, p, 2)
	if transferStatus(t, ctx, p, outbound) != "approved" ||
		transferStatus(t, ctx, p, inbound) != "in_transit" {
		t.Fatal("the fixture must hold one approved and one in-transit movement")
	}

	// From here the branch operates nothing. Each refusal is the domain error of 035, the
	// one that says the branch has an open settlement.
	for _, refused := range []struct {
		name string
		err  error
	}{
		{"sell", trySale(ctx, p, 2, "FROZEN-0001")},
		{"record a purchase", tryPurchase(ctx, p, 2, "freeze-purchase-0001")},
		{"ask for stock", tryTransfer(ctx, p, 2, "freeze-request-0001")},
		{"dispatch", dispatchTransfer(ctx, p, outbound)},
		{"receive the shipment", receiveTransfer(t, ctx, p, inbound)},
	} {
		if refused.err == nil {
			t.Fatalf("a frozen branch must not %s", refused.name)
		}
		execRefusalMessage(t, refused.err, "LC001", "open account settlement")
	}

	// Nothing was written: no document, no line, no unit, no allocation, no receipt line
	// and no cash movement, and the balance matrix is exactly the one from before.
	if after := documents(t, ctx, p); after != documentsBefore {
		t.Fatalf("a refused attempt must write nothing, got %s before %s", documentsBefore, after)
	}
	if after := stocks(t, ctx, p); after != before {
		t.Fatalf("a refused attempt must not move stock, got %s before %s", before, after)
	}
	if transferStatus(t, ctx, p, outbound) != "approved" || transferStatus(t, ctx, p, inbound) != "in_transit" {
		t.Fatal("a refused movement must not advance the request")
	}
	// The refused sale did not consume a correlative either: the branch numeration starts
	// where the last admitted sale left it.
	if sequence := branchSequence(t, ctx, p, 2); sequence != 0 {
		t.Fatalf("a refused sale must not allocate a branch correlative, got %d", sequence)
	}

	// The warehouse is not frozen, and neither is a branch that is not being settled: the
	// guard reads the branch of each row instead of a global "some branch is frozen".
	if err := trySale(ctx, p, 3, "OPERATING-0001"); err != nil {
		t.Fatalf("a branch that is not being settled must keep selling: %v", err)
	}
	// This request names the frozen branch nowhere: the warehouse is the origin and branch
	// 3 the destination, so branch_closure_blocker(1) and (3) are both false.
	if err := tryTransfer(ctx, p, 3, "freeze-operating-0001"); err != nil {
		t.Fatalf("the warehouse must keep shipping to an operating branch: %v", err)
	}
	if err := tryShipment(t, ctx, p, 3, "freeze-shipment-0001"); err != nil {
		t.Fatalf("the warehouse must keep authorizing a direct shipment: %v", err)
	}
	if err := tryStockEntry(ctx, p, "freeze-stock-entry-01"); err != nil {
		t.Fatalf("the warehouse must keep receiving stock: %v", err)
	}
	t.Logf("035: a frozen branch wrote nothing; the warehouse and branch 3 kept operating")
}

// TestBranchFreezeReopensWhenSettlementCloses proves the freeze is reversible and exactly as
// long as the settlement: the same sale, purchase and request are admitted before it, refused
// while it is open and admitted again after it closes, and the branch correlative and the
// stock are where the last admitted document left them.
func TestBranchFreezeReopensWhenSettlementCloses(t *testing.T) {
	ctx, p := freezeFixture(t)

	// The branch trades normally before the warehouse arrives.
	if err := trySale(ctx, p, 2, "REOPEN-0001"); err != nil {
		t.Fatalf("the branch must sell before the settlement: %v", err)
	}
	if sequence := branchSequence(t, ctx, p, 2); sequence != 1 {
		t.Fatalf("the first sale must take the first correlative, got %d", sequence)
	}
	before := stocks(t, ctx, p)

	// The settlement opens on the stock the sale left behind: variant 1 keeps 9 units and
	// variant 2 keeps its 4.
	closing := openSettlement(t, ctx, p, 2)
	for _, refused := range []struct {
		name string
		err  error
	}{
		{"sell", trySale(ctx, p, 2, "REOPEN-0002")},
		{"record a purchase", tryPurchase(ctx, p, 2, "reopen-purchase-01")},
		{"ask for stock", tryTransfer(ctx, p, 2, "reopen-request-0001")},
	} {
		if refused.err == nil {
			t.Fatalf("a frozen branch must not %s", refused.name)
		}
		execRefusalMessage(t, refused.err, "LC001", "open account settlement")
	}
	if after := stocks(t, ctx, p); after != before {
		t.Fatalf("the refusals must leave the stock untouched, got %s before %s", before, after)
	}
	if sequence := branchSequence(t, ctx, p, 2); sequence != 1 {
		t.Fatalf("the refused sale must not consume the next correlative, got %d", sequence)
	}

	// The settlement closes over exactly the stock it photographed, so the branch is
	// released by the same state machine that froze it.
	countAll(t, ctx, p, closing, map[int]int{1: 9, 2: 4})
	closeSettlement(t, ctx, p, closing, "100.00", "0.00", "40.00")
	var blocker bool
	if err := p.QueryRow(ctx, `SELECT branch_closure_blocker(2::smallint)`).Scan(&blocker); err != nil || blocker {
		t.Fatalf("a closed settlement must not freeze its branch: %v %v", blocker, err)
	}

	// The same three documents are admitted again, and the sale continues the branch's own
	// numeration: the freeze refused the write, it did not consume its place in the ledger.
	if err := trySale(ctx, p, 2, "REOPEN-0002"); err != nil {
		t.Fatalf("a released branch must sell again: %v", err)
	}
	if sequence := branchSequence(t, ctx, p, 2); sequence != 2 {
		t.Fatalf("the admitted sale must continue the branch correlative, got %d", sequence)
	}
	if err := tryPurchase(ctx, p, 2, "reopen-purchase-01"); err != nil {
		t.Fatalf("a released branch must record its purchase again: %v", err)
	}
	if err := tryTransfer(ctx, p, 2, "reopen-request-0001"); err != nil {
		t.Fatalf("a released branch must ask for stock again: %v", err)
	}
	t.Logf("035: the freeze ended with the settlement and the branch traded again")
}

// TestBranchFreezeSynchronisesWithTheSettlement pins R4-001: every freeze guard takes the
// same per-branch advisory lock the opener and the closure take, before it reads the
// predicate. Without it a sale would read "no settlement" from a snapshot taken before a
// concurrent opener committed, pass the guard and commit after the settlement opened, and
// the closure would then refuse that brand new sale with LC018, leaving the settlement
// impossible to close.
func TestBranchFreezeSynchronisesWithTheSettlement(t *testing.T) {
	ctx, p := freezeFixture(t)
	if err := trySale(ctx, p, 2, "BEFORE-0001"); err != nil {
		t.Fatalf("the branch must sell before the settlement opens: %v", err)
	}
	before := stocks(t, ctx, p)

	// The warehouse opens the settlement in a transaction that has not committed yet.
	tx, err := p.Begin(ctx)
	if err != nil {
		t.Fatal("the opening transaction could not start")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(ctx, `INSERT INTO branch_closings(branch_location_id,period_start,
 commission_rate_percent,opened_by_account_id) VALUES(2,now(),0,1)`); err != nil {
		t.Fatalf("the settlement could not be opened: %v", err)
	}

	// A sale of the same branch, from another connection, must wait for that commit: while
	// the opener holds the lock the guard cannot read the settlement away.
	done := make(chan error, 1)
	go func() { done <- trySale(ctx, p, 2, "RACE-0001") }()
	select {
	case err := <-done:
		t.Fatalf("the sale must wait for the settlement that is opening, got %v", err)
	case <-time.After(500 * time.Millisecond):
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("the settlement could not be committed: %v", err)
	}
	select {
	case err := <-done:
		// The sale now sees the committed settlement and is refused with the domain error.
		execRefusalMessage(t, err, "LC001", "open account settlement")
	case <-time.After(30 * time.Second):
		t.Fatal("the sale must be decided once the settlement commits")
	}
	// The branch is at the stock the settlement photographed, and no sale was written.
	if after := stocks(t, ctx, p); after != before {
		t.Fatalf("the refused sale must not move stock, got %s before %s", before, after)
	}
	if sequence := branchSequence(t, ctx, p, 2); sequence != 1 {
		t.Fatalf("the refused sale must not take a correlative, got %d", sequence)
	}
	t.Logf("035: a sale waits for the settlement that opens and is then refused")
}

// TestBranchFreezeRefusesReconciliation pins R4-002: the reconciliation operations of 011,
// 012, 013 and 018 are operated by a branch account and move a branch's balances, so a
// frozen branch cannot reconcile through any of them. Both the branch's own account and the
// warehouse's are refused, because the balance that would move belongs to the frozen branch.
func TestBranchFreezeRefusesReconciliation(t *testing.T) {
	ctx, p := freezeFixture(t)
	request := receiveStockedTransfer(t, ctx, p, "freeze-reconcile-01")
	before := stocks(t, ctx, p)

	openSettlement(t, ctx, p, 2)
	for _, operation := range []struct {
		name string
		key  string
		stmt string
	}{
		{
			"corrected count", "frozen-count-0001",
			`INSERT INTO transfer_count_operations(operation_key,request_id,variant_id,
 actor_location_id,action,expected_revision,actual_quantity,reason,revision,recorded_at)
 VALUES($3,$1,1,$2,'propose',0,1,'conteo corregido',1,now())`,
		},
		{
			"restitution", "frozen-restitution-001",
			`INSERT INTO transfer_restitution_operations(operation_key,request_id,variant_id,
 actor_location_id,action,expected_revision,retained_quantity,retained_at_origin,reason,revision,recorded_at)
 VALUES($3,$1,1,$2,'propose',0,1,true,'quedó en sucursal',1,now())`,
		},
		{
			"dispatch reconciliation", "frozen-dispatch-0001",
			`INSERT INTO transfer_dispatch_operations(operation_key,request_id,variant_id,
 actor_location_id,action,expected_revision,dispatch_quantity,reason,revision,recorded_at)
 VALUES($3,$1,1,$2,'propose',0,0,'no se despachó',1,now())`,
		},
		{
			"unified reconciliation", "frozen-unified-0001",
			`INSERT INTO transfer_unified_operations(operation_key,request_id,variant_id,
 actor_location_id,action,expected_revision,dispatch_quantity,arrival_quantity,
 retained_quantity,retained_at_origin,reason,revision,recorded_at)
 VALUES($3,$1,1,$2,'propose',0,0,0,0,false,'conciliación',1,now())`,
		},
	} {
		for _, actor := range []struct {
			name     string
			account  int
			location int
		}{
			{"the branch", 2, 2},
			{"the warehouse", 1, 1},
		} {
			_, err := p.Exec(ctx, operation.stmt, request, actor.location, operation.key)
			if err == nil {
				t.Fatalf("%s from %s must be refused on a frozen branch", operation.name, actor.name)
			}
			execRefusalMessage(t, err, "LC001", "open account settlement")
		}
	}
	// No evidence and no stock moved: the branch's balances are the ones the count sheet
	// photographed, so the settlement can still close.
	if evidence := reconciliationEvidence(t, ctx, p); evidence != "0:0:0:0" {
		t.Fatalf("a refused reconciliation must write no evidence, got %s", evidence)
	}
	if after := stocks(t, ctx, p); after != before {
		t.Fatalf("a refused reconciliation must not move stock, got %s before %s", before, after)
	}
	t.Logf("035: a frozen branch reconciles nothing, whichever endpoint operates it")
}

// TestBranchFreezeRecordsTheOfferAtProposal pins R1-001: at open|rejected -> proposed the
// database records the offer -- the totals of the window and the commission they pay -- and
// from then on those five plus the rate are immutable, so the closure applies the numbers
// the branch accepted instead of recomputing them.
func TestBranchFreezeRecordsTheOfferAtProposal(t *testing.T) {
	ctx, p := freezeFixture(t)

	// A first settlement closes empty-handed, so the branch has a period to sell into.
	first := openSettlement(t, ctx, p, 2)
	countAll(t, ctx, p, first, map[int]int{1: 10, 2: 4})
	closeSettlement(t, ctx, p, first, "0.00", "0.00", "0.00")

	// Two sales of the open period: a mixed one, and one whose commission falls exactly on
	// half a cent, which the database rounds up once (S20).
	if err := sell(ctx, p, 2, "OFFER-0001", "2130.00", "2100.00", "20.00", "10.00"); err != nil {
		t.Fatalf("the mixed sale must be admitted: %v", err)
	}
	if err := sell(ctx, p, 2, "OFFER-0002", "2000.12", "2000.12", "0.00", "0.00"); err != nil {
		t.Fatalf("the second sale must be admitted: %v", err)
	}

	// The settlement of the period: the count sheet is what the two sales left behind.
	closing := openSettlement(t, ctx, p, 2)
	countAll(t, ctx, p, closing, map[int]int{1: 8, 2: 4})
	proposeRound(t, ctx, p, closing, `{"fund":"40.00"}`)
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='proposed',counted_cash=100.00,
 contributed_cash=0.00,closing_cash=40.00 WHERE id=$1`, closing); err != nil {
		t.Fatalf("the settlement could not be proposed: %v", err)
	}
	// 2130.00 + 2000.12 sold; 4100.12 in cash, 20.00 by card and 10.00 by transfer; the
	// commission is 12.50% of 4130.12 = 516.265, rounded once to 516.27.
	const offer = "4130.12:4100.12:20.00:10.00:0.00:516.27:12.50"
	if state := settlementState(t, ctx, p, closing); !strings.HasSuffix(state, offer) {
		t.Fatalf("the proposal must record the offer of the period, got %s, want %s", state, offer)
	}

	// The branch accepts, and from then on the base of the offer is immutable: a closing
	// update cannot change any of the five totals, the commission or the rate.
	decideRound(t, ctx, p, closing, "accepted", "")
	for _, statement := range []string{
		`UPDATE branch_closings SET status='closed',sales_total=1.00 WHERE id=$1`,
		`UPDATE branch_closings SET status='closed',cash_sales=1.00 WHERE id=$1`,
		`UPDATE branch_closings SET status='closed',card_total=1.00 WHERE id=$1`,
		`UPDATE branch_closings SET status='closed',transfer_total=1.00 WHERE id=$1`,
		`UPDATE branch_closings SET status='closed',qr_total=1.00 WHERE id=$1`,
		`UPDATE branch_closings SET status='closed',commission_amount=1.00 WHERE id=$1`,
	} {
		_, err := p.Exec(ctx, statement, closing)
		execRefusalMessage(t, err, "LC005", "recorded when it is proposed")
	}
	// The rate is frozen with the offer, by its own refusal.
	_, err := p.Exec(ctx, `UPDATE branch_closings SET status='closed',
 commission_rate_percent=1.00 WHERE id=$1`, closing)
	execRefusalMessage(t, err, "LC005", "frozen when the settlement is proposed")
	// The closure applies exactly the offer the branch accepted, and the stock of the count.
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='closed' WHERE id=$1`, closing); err != nil {
		t.Fatalf("the accepted round must close the settlement: %v", err)
	}
	if state := settlementState(t, ctx, p, closing); !strings.HasPrefix(state, "closed:") ||
		!strings.HasSuffix(state, offer) {
		t.Fatalf("the closure must not rewrite the offer, got %s", state)
	}
	var stock string
	if err := p.QueryRow(ctx, `SELECT string_agg(variant_id||':'||existing,',' ORDER BY variant_id)
 FROM inventory_balances WHERE location_id=2`).Scan(&stock); err != nil || stock != "1:8,2:4" {
		t.Fatalf("the closure must apply the counted stock: %q %v", stock, err)
	}
	t.Logf("035: the offer is recorded at the proposal and the closure applies it unchanged")
}

// TestBranchFreezeRefusesTheClosureWithAnOpenReservation pins R3-002 and R4-004: any open
// reservation of a counted variant blocks the closure, naming the variant, even when the
// counted quantity covers the reservation. A reserved unit is stock the branch already
// promised, so closing underneath it would promise it twice.
func TestBranchFreezeRefusesTheClosureWithAnOpenReservation(t *testing.T) {
	ctx, p := freezeFixture(t)
	// The branch already promised two units of variant 1 to a transfer.
	if _, err := p.Exec(ctx, `UPDATE inventory_balances SET reserved=2
 WHERE location_id=2 AND variant_id=1`); err != nil {
		t.Fatal("the reservation could not be provisioned")
	}
	before := stocks(t, ctx, p)

	closing := openSettlement(t, ctx, p, 2)
	// Counting more than is reserved is exactly what the old rule accepted.
	countAll(t, ctx, p, closing, map[int]int{1: 10, 2: 4})
	proposeRound(t, ctx, p, closing, `{"fund":"0.00"}`)
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='proposed',counted_cash=0.00,
 closing_cash=0.00 WHERE id=$1`, closing); err != nil {
		t.Fatalf("the settlement could not be proposed: %v", err)
	}
	decideRound(t, ctx, p, closing, "accepted", "")
	_, err := p.Exec(ctx, `UPDATE branch_closings SET status='closed' WHERE id=$1`, closing)
	execRefusalMessage(t, err, "LC007", "Variant 1")
	if after := stocks(t, ctx, p); after != before {
		t.Fatalf("a refused closure must leave the stock untouched, got %s before %s", before, after)
	}
	var live bool
	if err := p.QueryRow(ctx, `SELECT status='proposed' FROM branch_closings WHERE id=$1`, closing).Scan(&live); err != nil || !live {
		t.Fatalf("a refused closure must leave the settlement proposed: %v %v", live, err)
	}

	// Releasing the reservation is what unblocks the same closure: it is the reservation,
	// not the arithmetic of counted against reserved, that refused it.
	if _, err := p.Exec(ctx, `UPDATE inventory_balances SET reserved=0
 WHERE location_id=2 AND variant_id=1`); err != nil {
		t.Fatal("the reservation could not be released")
	}
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='closed' WHERE id=$1`, closing); err != nil {
		t.Fatalf("a released branch must close: %v", err)
	}
	t.Logf("035: an open reservation blocks the closure and names the variant")
}

// TestBranchFreezeRefusesAManualLedgerRow pins R3-003: the settlement ledger rows are
// written only by the closure. A manual aporte or recaudacion of a proposed settlement is
// refused even for the warehouse account and even when the caller sets the provenance
// marker itself, because the marker alone is not what the guard requires.
func TestBranchFreezeRefusesAManualLedgerRow(t *testing.T) {
	ctx, p := freezeFixture(t)
	closing := openSettlement(t, ctx, p, 2)
	countAll(t, ctx, p, closing, map[int]int{1: 10, 2: 4})
	proposeRound(t, ctx, p, closing, `{"fund":"10.00"}`)
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='proposed',counted_cash=50.00,
 contributed_cash=0.00,closing_cash=10.00 WHERE id=$1`, closing); err != nil {
		t.Fatalf("the settlement could not be proposed: %v", err)
	}

	// The warehouse is the only account that may move the money of a settlement, and even
	// it cannot state the settlement's own money by hand.
	for _, kind := range []string{"aporte", "recaudacion"} {
		_, err := p.Exec(ctx, `INSERT INTO branch_cash_movements(branch_location_id,closing_id,kind,
 amount,description,created_by_account_id) VALUES(2,$1,$2,10.00,'a mano',1)`, closing, kind)
		execRefusalMessage(t, err, "LC020", "written by its closure")
	}
	// Setting the marker by hand is not provenance either: a client statement runs at
	// trigger depth 1, and the closure writes at depth 2.
	tx, err := p.Begin(ctx)
	if err != nil {
		t.Fatal("the transaction could not start")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('luson.closing_ledger',
 (SELECT id::text FROM branch_closings WHERE id=$1),true)`, closing); err != nil {
		t.Fatalf("the marker could not be set: %v", err)
	}
	_, err = tx.Exec(ctx, `INSERT INTO branch_cash_movements(branch_location_id,closing_id,kind,
 amount,description,created_by_account_id) VALUES(2,$1,'aporte',10.00,'con marcador',1)`, closing)
	execRefusalMessage(t, err, "LC020", "written by its closure")
	if err := tx.Rollback(ctx); err != nil {
		t.Fatalf("the transaction could not be rolled back: %v", err)
	}
	var movements int
	if err := p.QueryRow(ctx, `SELECT count(*) FROM branch_cash_movements WHERE closing_id=$1`,
		closing).Scan(&movements); err != nil || movements != 0 {
		t.Fatalf("a refused ledger row must write nothing, got %d %v", movements, err)
	}

	// The closure still writes its own rows: counted 50 and fund 10 is one collection.
	decideRound(t, ctx, p, closing, "accepted", "")
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='closed' WHERE id=$1`, closing); err != nil {
		t.Fatalf("the accepted round must close the settlement: %v", err)
	}
	var ledger string
	if err := p.QueryRow(ctx, `SELECT string_agg(kind||':'||amount,',' ORDER BY id)
 FROM branch_cash_movements WHERE closing_id=$1`, closing).Scan(&ledger); err != nil ||
		ledger != "recaudacion:40.00" {
		t.Fatalf("the closure must write its own ledger row: %q %v", ledger, err)
	}
	t.Logf("035: the settlement ledger is written by the closure and by nothing else")
}
