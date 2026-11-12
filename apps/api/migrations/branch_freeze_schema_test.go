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

// migration035 is the freeze wiring of the branch account settlement: 034 owns the state
// machine and the predicate, and this migration attaches that predicate to the admission
// paths of the documents a branch writes ("Correcto, la sucursal se congela", S3). It is
// add-only, like every migration of the vertical: 001-034 are applied and checksummed, so
// no admission function of theirs is rewritten and every guard is a new trigger.
const migration035 = "035_branch_freeze.sql"

// TestBranchFreezeSchemaStructure reads the embedded migration exactly as PostgreSQL
// receives it and asserts the wiring it must install: one guard function and one trigger
// per branch-facing admission path, each one calling the predicate of 034 on the branch
// column of its own row, and no rewrite of anything that already exists.
func TestBranchFreezeSchemaStructure(t *testing.T) {
	b, err := migrations.Files.ReadFile(migration035)
	if err != nil {
		t.Fatal("the freeze migration must be embedded", err)
	}
	sql := string(b)
	for _, required := range []string{
		// The sale of a frozen branch: the branch column of the sale header.
		"CREATE FUNCTION admit_sale_when_branch_operating() RETURNS trigger LANGUAGE plpgsql AS $$",
		"CREATE TRIGGER admit_frozen_branch_sale BEFORE INSERT ON sales",
		"PERFORM assert_branch_not_frozen(NEW.branch_location_id);",

		// The purchase the branch registers while it is being settled.
		"CREATE FUNCTION admit_purchase_when_branch_operating() RETURNS trigger LANGUAGE plpgsql AS $$",
		"CREATE TRIGGER admit_frozen_branch_purchase BEFORE INSERT ON purchases",
		"PERFORM assert_branch_not_frozen(NEW.location_id);",

		// The transfer as a document: both participants are asserted in both orders,
		// because a branch can be the origin that ships or the destination that receives.
		"CREATE FUNCTION admit_transfer_when_branches_operating() RETURNS trigger LANGUAGE plpgsql AS $$",
		"CREATE TRIGGER admit_frozen_branch_transfer BEFORE INSERT ON transfer_requests",
		"PERFORM assert_branch_not_frozen(NEW.origin_location_id);",
		"PERFORM assert_branch_not_frozen(NEW.destination_location_id);",

		// The transfer as a movement: dispatch leaves the origin and receipt enters the
		// destination, and neither creates a second document to guard.
		"CREATE FUNCTION admit_transfer_move_when_branches_operating() RETURNS trigger LANGUAGE plpgsql AS $$",
		"CREATE TRIGGER admit_frozen_branch_transfer_move BEFORE UPDATE ON transfer_requests",
		"IF OLD.status = 'approved' AND NEW.status = 'in_transit' THEN",
		"PERFORM assert_branch_not_frozen(OLD.origin_location_id);",
		"PERFORM assert_branch_not_frozen(OLD.destination_location_id);",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("missing %s", required)
		}
	}
	// Four admission paths, four guards: a fifth trigger would mean a table was wired
	// twice, and a missing one would leave a branch-facing flow trading while frozen.
	if got := strings.Count(sql, "CREATE TRIGGER"); got != 4 {
		t.Errorf("the freeze must install one trigger per admission path, got %d", got)
	}
	if got := strings.Count(sql, "CREATE FUNCTION"); got != 4 {
		t.Errorf("the freeze must install one function per guard, got %d", got)
	}
	// Every guard must call the predicate 034 raises and nothing else: this migration is
	// wiring, so the refusal keeps a single owner and a single message.
	if got := strings.Count(sql, "PERFORM assert_branch_not_frozen("); got != 6 {
		t.Errorf("every branch column of every guarded row is asserted once, got %d", got)
	}
	// The migration decides from the schema, so it says which tables are branch-facing and
	// why, and why the other tables that reference a location are left alone.
	for _, documented := range []string{
		"branch-facing", "warehouse-only", "S3", "R4-001",
		"LV001", "LP001", "LS005", "LC002",
		"stock_entries", "stock_adjustments", "inventory_balances", "branch_cash_movements",
	} {
		if !strings.Contains(sql, documented) {
			t.Errorf("the migration must document its own decision: %s", documented)
		}
	}
	// Add-only: no historical table, function or trigger is rewritten, dropped or given a
	// second owner, because 001-034 are already applied and checksummed.
	for _, forbidden := range []string{
		"CREATE TABLE", "ALTER TABLE", "CREATE OR REPLACE", "DROP ", "TRUNCATE ",
		"ON branch_cash_movements", "ON inventory_balances",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("the freeze must be additive and must not guard a shared table: %s", forbidden)
		}
	}
	// A function is created before the trigger that executes it.
	for _, pair := range [][2]string{
		{"CREATE FUNCTION admit_sale_when_branch_operating", "CREATE TRIGGER admit_frozen_branch_sale"},
		{"CREATE FUNCTION admit_purchase_when_branch_operating", "CREATE TRIGGER admit_frozen_branch_purchase"},
		{"CREATE FUNCTION admit_transfer_when_branches_operating", "CREATE TRIGGER admit_frozen_branch_transfer "},
		{"CREATE FUNCTION admit_transfer_move_when_branches_operating", "CREATE TRIGGER admit_frozen_branch_transfer_move"},
	} {
		first, second := strings.Index(sql, pair[0]), strings.Index(sql, pair[1])
		if first < 0 || second < 0 || first > second {
			t.Errorf("%s must be defined before %s", pair[0], pair[1])
		}
	}
}

// freezeFixture is the settlement fixture of 034 applied through 035: the prefix
// catalogue, one account per location, the balances of the warehouse and of both branches
// and the commission rate the closure reads. It is the same fixture as the settlement
// tests, only one migration later, because the tables this migration guards are written by
// the sale, purchase and transfer paths of the whole schema.
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
	tx, err := p.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var id int64
	// The selling account is the account of the branch: the sale trigger refuses any other.
	if err := tx.QueryRow(ctx, `INSERT INTO sales(branch_location_id,cash_amount,customer_name,total,created_by_account_id)
 VALUES($1::smallint,2000.00,'Cliente',2000.00,$1::integer) RETURNING id`, branch).Scan(&id); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO sale_lines(sale_id,variant_id,quantity,unit_price)
 VALUES($1,1,1,2000.00)`, id); err != nil {
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
// ledgers the closure feeds: a refusal that writes one of them is not a refusal.
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

	// From here the branch operates nothing. Each refusal is the domain error of 034, the
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
