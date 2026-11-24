package migrations_test

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/testpg"
	"luson/api/migrations"
)

// The finding on the shelf writes the stock off (S16): a branch that detects a failed battery
// before selling it cannot get the unit off its books today, because 021 and 022 refuse every
// branch with LS005 and no document of this repository frees a branch's balance. The case is that
// document, and this is the single, explicitly scoped exception to LS005: the admission of a
// `stock_defect` decrements the balance of the case's own branch, for the case's own variant, in
// the same transaction, and nothing else of this vertical ever writes stock.
const writeOffMigration = "067_stock_defect_writes_off_stock.sql"

// writeOffCaseSQL opens the second door with the reason the write-off states about itself (S16):
// the branch, the variant and the quantity are the case's, and the account is the branch's own.
const writeOffCaseSQL = `INSERT INTO warranty_cases(branch_location_id,origin,variant_id,quantity,
 reason,declared_failure,created_by_account_id)
 VALUES($1,'stock_defect',$2,$3,$4,'No retiene carga tras la prueba',$5) RETURNING id`

// writeOffQuerier is what a balance read needs: the pool in a test that has already committed, and
// the transaction in a test that proves the decrement belongs to the admission's own transaction.
type writeOffQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// TestStockDefectWriteOffShape reads the embedded version exactly as PostgreSQL receives it. It
// proves the file states the exception where it is written -- one balance lock, one signed
// quantity, one conditional update, one reason in the shape of 022 -- and that it stays exactly
// where S16 puts it: no document of the warehouse, no rewrite of an applied version and no row of
// its own.
func TestStockDefectWriteOffShape(t *testing.T) {
	b, err := migrations.Files.ReadFile(writeOffMigration)
	if err != nil {
		t.Fatal("the stock defect write-off migration must be embedded", err)
	}
	// Comments may name the untouched contract; only executable statements prove what this
	// migration does.
	sql := statements(string(b))
	for _, required := range []string{
		// The reason is a text of its own, in the shape 022 already uses, and it is stated by a
		// stock defect and by nothing else (S16).
		"ALTER TABLE warranty_cases",
		"ADD COLUMN reason text",
		"ADD CONSTRAINT warranty_cases_reason_shape CHECK (reason IS NULL",
		"OR char_length(btrim(reason)) BETWEEN 1 AND 500)",
		"ADD CONSTRAINT warranty_cases_writeoff_reason CHECK ((origin = 'stock_defect') = (reason IS NOT NULL))",
		// The write-off, in the order 021, 022, 025 and 026 apply a balance: the case's row, then
		// the balance row, then the signed quantity, then the two refusals, then the update.
		"CREATE FUNCTION write_off_stock_defect() RETURNS trigger LANGUAGE plpgsql AS $$",
		"IF NEW.origin <> 'stock_defect' THEN",
		"SELECT * INTO header FROM warranty_cases WHERE id=NEW.id FOR UPDATE;",
		"WHERE location_id=header.branch_location_id AND variant_id=header.variant_id FOR UPDATE;",
		"total := balance.existing::numeric - header.quantity::numeric;",
		"IF total < 0 THEN",
		"IF total < balance.reserved THEN",
		"UPDATE inventory_balances SET existing=total::bigint",
		"WHERE location_id=header.branch_location_id AND variant_id=header.variant_id;",
		// It runs inside the transaction that admits the case, and nowhere else (S16).
		"CREATE TRIGGER write_off_stock_defect AFTER INSERT ON warranty_cases",
		// What left the shelf is evidence: the reason is frozen once written, like the rest of
		// what a case is about (S16, LW010).
		"CREATE FUNCTION guard_warranty_case_writeoff() RETURNS trigger LANGUAGE plpgsql AS $$",
		"CREATE TRIGGER guard_warranty_case_writeoff BEFORE UPDATE ON warranty_cases",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("the write-off migration is incomplete: missing %s", required)
		}
	}
	// The exception is one statement of one function: exactly one balance update in the whole
	// file, no new table, no new index, and no document of the warehouse standing in for it.
	if count := strings.Count(sql, "UPDATE inventory_balances"); count != 1 {
		t.Fatalf("the exception is one balance update and no more, got %d", count)
	}
	for _, forbidden := range []string{
		"CREATE TABLE", "CREATE INDEX", "CREATE UNIQUE INDEX",
		"INSERT INTO stock_entries", "INSERT INTO stock_adjustments",
		"INSERT INTO stock_entry_lines", "INSERT INTO stock_adjustment_lines",
		"INSERT INTO warranty_cases", "INSERT INTO transfer_",
		"UPDATE stock_", "DELETE FROM", "DROP ",
		// An applied version is never redefined and never edited: the exception arrives as a
		// trigger of its own beside the guards of 065.
		"CREATE OR REPLACE", "ALTER TABLE warranty_cases ALTER COLUMN", "ALTER TABLE inventory_balances",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("the write-off migration must not contain %s", forbidden)
		}
	}
	// A claim writes nothing: the only write of stock is inside the `stock_defect` branch, which
	// the guard states as its first statement.
	if from := strings.Index(sql, "IF NEW.origin <> 'stock_defect' THEN"); from < 0 {
		t.Fatal("the write-off must refuse every origin but a stock defect")
	} else if update := strings.Index(sql, "UPDATE inventory_balances"); update < from {
		t.Fatal("the balance update must come after the origin guard")
	}
	// The codes of the write-off are this vertical's and never a reused number (S23): 065 states
	// 001 to 015, so these are the next ones.
	used := map[string]bool{}
	for _, match := range regexp.MustCompile(`ERRCODE='(LW[0-9]{3})'`).FindAllStringSubmatch(sql, -1) {
		used[match[1]] = true
	}
	declared := []string{"LW016", "LW017", "LW018"}
	got := make([]string, 0, len(used))
	for code := range used {
		got = append(got, code)
	}
	sort.Strings(got)
	if strings.Join(got, ",") != strings.Join(declared, ",") {
		t.Fatalf("the write-off states exactly its own new LW codes, got %v", got)
	}
	// No other version borrows them, and this one borrows nothing of 065.
	entries, err := migrations.Files.ReadDir(".")
	if err != nil {
		t.Fatal("embedded migrations are unreadable")
	}
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".sql") || entry.Name() == writeOffMigration {
			continue
		}
		version, err := migrations.Files.ReadFile(entry.Name())
		if err != nil {
			t.Fatalf("embedded migration %s is unreadable", entry.Name())
		}
		for code := range used {
			if strings.Contains(string(version), "ERRCODE='"+code+"'") {
				t.Fatalf("%s reuses the code %s of the write-off", entry.Name(), code)
			}
		}
	}
	// The file documents why the exception exists and exactly how narrow it is, so the next reader
	// does not have to reconstruct either.
	for _, documented := range []string{
		"S16", "LS005", "021", "022", "065", "stock_defect", "warranty_claim", "reserved",
		"S11", "rendición", "excepción",
	} {
		if !strings.Contains(string(b), documented) {
			t.Errorf("the write-off must document its own decision: %s", documented)
		}
	}
}

// TestStockDefectWriteOffTakesTheStockOfItsBranch proves the decrement on the admitted fixture: the
// admission of a stock defect takes the case's quantity off the case's variant at the case's
// branch in its own transaction (S16), the case states who wrote it off, when and why, and a
// transaction that rolls back takes nothing at all.
func TestStockDefectWriteOffTakesTheStockOfItsBranch(t *testing.T) {
	ctx, p := writeOffFixture(t)
	if before := writeOffBalances(t, ctx, p); before != "2:1=10/0,3:1=10/0" {
		t.Fatalf("the fixture states its own stock, got %s", before)
	}
	tx, err := p.Begin(ctx)
	if err != nil {
		t.Fatalf("the admission transaction could not start: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var id int64
	if err := tx.QueryRow(ctx, writeOffCaseSQL, 2, 1, 3, "Probada en mostrador: no arranca", 2).
		Scan(&id); err != nil {
		t.Fatalf("a stock defect with stock behind it must be admitted: %v", err)
	}
	// The same transaction already sees the decrement: it is the admission's own write and not a
	// second document that could arrive later or not at all (S16).
	if got := writeOffExisting(t, ctx, tx, 2, 1); got != 7 {
		t.Fatalf("the admission takes its quantity off the branch in its own transaction, got %d", got)
	}
	// The case is the evidence of the write-off: the actor, the instant, the reason and the
	// quantity are persisted with it, and the reason is a text of its own beside the failure.
	var (
		actor    int
		written  time.Time
		reason   string
		quantity int64
		reserved int64
	)
	if err := tx.QueryRow(ctx, `SELECT created_by_account_id,created_at,reason,quantity
 FROM warranty_cases WHERE id=$1`, id).Scan(&actor, &written, &reason, &quantity); err != nil {
		t.Fatalf("the evidence of the write-off could not be read: %v", err)
	}
	if actor != 2 || reason != "Probada en mostrador: no arranca" || quantity != 3 || written.IsZero() {
		t.Fatalf("the write-off keeps its actor, its instant and its reason, got %d:%s:%d:%v",
			actor, reason, quantity, written)
	}
	if err := tx.QueryRow(ctx, `SELECT reserved FROM inventory_balances
 WHERE location_id=2 AND variant_id=1`).Scan(&reserved); err != nil {
		t.Fatalf("the reserve of the branch could not be read: %v", err)
	}
	if reserved != 0 {
		t.Fatalf("a write-off never writes reserved, got %d", reserved)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("the admission must commit: %v", err)
	}
	if got := writeOffBalances(t, ctx, p); got != "2:1=7/0,3:1=10/0" {
		t.Fatalf("the write-off takes the stock of its own branch and of nobody else, got %s", got)
	}
	// A second finding of the same branch takes its own quantity, and another branch is untouched.
	if _, err := p.Exec(ctx, writeOffCaseSQL, 2, 1, 2, "Se hinchó en góndola", 2); err != nil {
		t.Fatalf("a second stock defect must be admitted: %v", err)
	}
	if got := writeOffBalances(t, ctx, p); got != "2:1=5/0,3:1=10/0" {
		t.Fatalf("each finding takes its own quantity, got %s", got)
	}
	// The write-off belongs to the transaction of the admission: an admission that rolls back
	// leaves the branch's stock exactly as it was.
	if err := writeOffRollback(ctx, p); err != nil {
		t.Fatalf("the rolled back admission must leave nothing: %v", err)
	}
	if got := writeOffBalances(t, ctx, p); got != "2:1=5/0,3:1=10/0" {
		t.Fatalf("a rolled back write-off takes no stock, got %s", got)
	}
	if cases := writeOffRowCount(t, ctx, p, "warranty_cases"); cases != 2 {
		t.Fatalf("a rolled back admission writes no case either, got %d", cases)
	}
	t.Logf("067: 10 - 3 - 2 = 5, in the admission's own transaction")
}

// TestStockDefectWriteOffRefusesStockTheBranchDoesNotHave proves the two refusals of S16 on a live
// database and that a refusal writes nothing: a quantity the branch does not have, a variant the
// branch never held, and a write-off that would leave `existing` below `reserved` are refused with
// their own codes, and the balance matrix is exactly what it was.
func TestStockDefectWriteOffRefusesStockTheBranchDoesNotHave(t *testing.T) {
	ctx, p := writeOffFixture(t)
	before := writeOffBalances(t, ctx, p)
	cases := writeOffRowCount(t, ctx, p, "warranty_cases")

	// The branch holds ten, so eleven is not a quantity it has.
	_, err := p.Exec(ctx, writeOffCaseSQL, 2, 1, 11, "Probadas y falladas todas", 2)
	execRefusalMessage(t, err, "LW016", "exceeds the stock")
	// A variant the branch has no balance row for is a quantity it does not have either: the
	// write-off never invents a balance row and never writes negative stock.
	_, err = p.Exec(ctx, writeOffCaseSQL, 2, 3, 1, "Apareció en el fondo del depósito", 2)
	execRefusalMessage(t, err, "LW016", "holds none")
	// Stock the branch already promised is not stock it may write off (S16): with eight of the ten
	// reserved, three would leave seven, and seven is below what was promised.
	if _, err := p.Exec(ctx, `UPDATE inventory_balances SET reserved=8
 WHERE location_id=2 AND variant_id=1`); err != nil {
		t.Fatalf("the reserve of the branch could not be stated: %v", err)
	}
	_, err = p.Exec(ctx, writeOffCaseSQL, 2, 1, 3, "Probada en mostrador: no arranca", 2)
	execRefusalMessage(t, err, "LW017", "not already reserved")

	// None of the three refusals wrote a case and none of them moved a balance.
	if got := writeOffRowCount(t, ctx, p, "warranty_cases"); got != cases {
		t.Fatalf("a refused write-off writes no case: %d before, %d after", cases, got)
	}
	if got := writeOffBalances(t, ctx, p); got != "2:1=10/8,3:1=10/0" {
		t.Fatalf("a refused write-off moves nothing, the reserve is the only change: got %s", got)
	}

	// The exception is exactly as wide as the stock the branch has free: the two unreserved units
	// are a write-off it may state, and it stops exactly at the promise behind the other eight.
	if _, err := p.Exec(ctx, writeOffCaseSQL, 2, 1, 2, "Probada en mostrador: no arranca", 2); err != nil {
		t.Fatalf("the unreserved stock of the branch is a write-off it may state: %v", err)
	}
	if got := writeOffBalances(t, ctx, p); got != "2:1=8/8,3:1=10/0" {
		t.Fatalf("the write-off stops at the reserved stock, got %s", got)
	}
	_, err = p.Exec(ctx, writeOffCaseSQL, 2, 1, 1, "Y una más que ya no está", 2)
	execRefusalMessage(t, err, "LW017", "not already reserved")
	if got := writeOffBalances(t, ctx, p); got != "2:1=8/8,3:1=10/0" {
		t.Fatalf("the balance of the branch never falls below its reserve, got %s", got)
	}
	if got := before; got != "2:1=10/0,3:1=10/0" {
		t.Fatalf("the fixture states its own stock, got %s", got)
	}
	t.Logf("067: 11 of 10 is LW016, no row is LW016, below reserved is LW017, and 8 stays covered")
}

// TestWarrantyClaimWritesNoStock proves the half of S16 that is a prohibition: a claim named by the
// serial of a sold unit never writes stock, because the battery it is about was sold and never
// belonged to the branch's shelf, and the claim states no reason because it writes nothing off.
func TestWarrantyClaimWritesNoStock(t *testing.T) {
	ctx, p := writeOffFixture(t)
	sale := sellWarrantyUnit(t, ctx, p, 2, 1, "100.00", "CUB-1/1", term(12), time.Now())
	var soldQuantity int64
	if err := p.QueryRow(ctx, `SELECT existing FROM inventory_balances
 WHERE location_id=2 AND variant_id=1`).Scan(&soldQuantity); err != nil {
		t.Fatalf("the stock of the branch could not be read: %v", err)
	}
	if soldQuantity != 9 {
		t.Fatalf("the sale of the fixture is one battery, got %d", soldQuantity)
	}
	before := writeOffBalances(t, ctx, p)
	var claim int64
	if err := p.QueryRow(ctx, claimCaseSQL, 2, "CUB-1/1", 2).Scan(&claim); err != nil {
		t.Fatalf("the covered claim must be admitted: %v", err)
	}
	if got := writeOffBalances(t, ctx, p); got != before {
		t.Fatalf("a warranty claim never writes stock: %s became %s", before, got)
	}
	var (
		origin  string
		reason  *string
		claimed *int64
	)
	if err := p.QueryRow(ctx, `SELECT origin,reason,sale_id FROM warranty_cases WHERE id=$1`,
		claim).Scan(&origin, &reason, &claimed); err != nil {
		t.Fatalf("the claim could not be read: %v", err)
	}
	if origin != "warranty_claim" || reason != nil {
		t.Fatalf("a claim states no write-off reason, got %s:%v", origin, reason)
	}
	if claimed == nil || *claimed != sale {
		t.Fatalf("the claim is the sale of its serial, got %v", claimed)
	}
	// The prohibition is the schema's: a claim cannot state the reason of a write-off, because it
	// never writes one off.
	_, err := p.Exec(ctx, `INSERT INTO warranty_cases(branch_location_id,origin,serial_number,
 reason,declared_failure,created_by_account_id)
 VALUES(2,'warranty_claim','CUB-1/1','Se dio de baja en góndola','No arranca el motor',2)`)
	requireRowViolation(t, err)
	if got := writeOffBalances(t, ctx, p); got != before {
		t.Fatalf("a refused claim writes no stock either: %s became %s", before, got)
	}
	t.Logf("067: a claim states no reason and moves no balance")
}

// TestStockDefectWriteOffReasonIsEvidence proves the shape of the reason S16 asks for -- a required
// text of its own, one to five hundred characters like the reason of 022 -- and that it is frozen
// with the rest of what the case is about: the motive of a write-off is evidence of stock that
// left the branch and is never rewritten.
func TestStockDefectWriteOffReasonIsEvidence(t *testing.T) {
	ctx, p := writeOffFixture(t)
	before := writeOffBalances(t, ctx, p)
	// A stock defect states its reason: without one the row itself is refused, and nothing is
	// written off.
	_, err := p.Exec(ctx, `INSERT INTO warranty_cases(branch_location_id,origin,variant_id,quantity,
 declared_failure,created_by_account_id) VALUES(2,'stock_defect',1,1,'No retiene carga',2)`)
	requireRowViolation(t, err)
	for _, blank := range []string{" ", "   ", ""} {
		_, err = p.Exec(ctx, writeOffCaseSQL, 2, 1, 1, blank, 2)
		requireRowViolation(t, err)
	}
	_, err = p.Exec(ctx, writeOffCaseSQL, 2, 1, 1, strings.Repeat("x", 501), 2)
	requireRowViolation(t, err)
	if got := writeOffBalances(t, ctx, p); got != before {
		t.Fatalf("a refused reason writes nothing off: %s became %s", before, got)
	}
	if got := writeOffRowCount(t, ctx, p, "warranty_cases"); got != 0 {
		t.Fatalf("a refused reason writes no case: %d", got)
	}
	// Five hundred characters are a reason, and the motive stays with the case it explains.
	reason := strings.Repeat("a", 500)
	var id int64
	if err := p.QueryRow(ctx, writeOffCaseSQL, 2, 1, 1, reason, 2).Scan(&id); err != nil {
		t.Fatalf("a five hundred character reason is a reason: %v", err)
	}
	if got := writeOffBalances(t, ctx, p); got != "2:1=9/0,3:1=10/0" {
		t.Fatalf("the write-off of one battery took one battery, got %s", got)
	}
	// The reason is the evidence of what left the shelf, so it is frozen exactly like the branch,
	// the variant and the quantity of the case (LW010).
	_, err = p.Exec(ctx, `UPDATE warranty_cases SET reason='Otra cosa' WHERE id=$1`, id)
	execRefusalMessage(t, err, "LW018", "is frozen")
	var stored string
	if err := p.QueryRow(ctx, `SELECT reason FROM warranty_cases WHERE id=$1`, id).Scan(&stored); err != nil {
		t.Fatalf("the reason of the write-off could not be read: %v", err)
	}
	if stored != reason {
		t.Fatalf("a refused statement never rewrites the reason, got %d characters",
			len(stored))
	}
	if got := writeOffBalances(t, ctx, p); got != "2:1=9/0,3:1=10/0" {
		t.Fatalf("a refused statement moves no balance, got %s", got)
	}
	// The guards of 065 keep working with the write-off installed: the case still moves its phase
	// with its own event -- which rewrites the very row this version guards -- and the resolution it
	// reaches is still storable, because what is frozen is the reason and nothing else.
	if _, err := p.Exec(ctx, journeySQL, id, "in_transit", "", 2, "Enviada al Almacén"); err != nil {
		t.Fatalf("a case with a write-off still moves its phase with its own event: %v", err)
	}
	if stored := warrantyPhase(t, ctx, p, id); stored != "in_transit" {
		t.Fatalf("the phase of the case is still the phase of its last tramo, got %s", stored)
	}
	if _, err := p.Exec(ctx, `UPDATE warranty_cases SET verdict='replaced',stock_destination='stock'
 WHERE id=$1`, id); err != nil {
		t.Fatalf("the resolution of a stock defect is still storable: %v", err)
	}
	if got := writeOffBalances(t, ctx, p); got != "2:1=9/0,3:1=10/0" {
		t.Fatalf("neither the phase nor the verdict of a case writes stock: got %s", got)
	}
	t.Logf("067: the reason is required, 1..500 characters and frozen")
}

// TestSettlementOpenedAfterAWriteOffChargesNoShortage proves the last check of S16 on a live
// database: a write-off registered before a settlement opens is already inside the expectation of
// its sheet, so the branch is charged no shortage for that unit. The settlement knows nothing about
// the case, and does not have to: `seed_closing_count_lines` (035) photographs the live balances of
// the branch when the settlement opens.
func TestSettlementOpenedAfterAWriteOffChargesNoShortage(t *testing.T) {
	ctx, p := writeOffFixture(t)
	if _, err := p.Exec(ctx, writeOffCaseSQL, 2, 1, 2, "Probada en mostrador: no arranca", 2); err != nil {
		t.Fatalf("the write-off must be admitted: %v", err)
	}
	closing := openSettlement(t, ctx, p, 2)
	var expected int64
	if err := p.QueryRow(ctx, `SELECT expected_quantity FROM closing_count_lines
 WHERE closing_id=$1 AND variant_id=1`, closing).Scan(&expected); err != nil {
		t.Fatalf("the sheet of the settlement could not be read: %v", err)
	}
	if expected != 8 {
		t.Fatalf("the sheet expects the stock the branch has after the write-off, got %d", expected)
	}
	// The admin counts the eight batteries that are on the shelf: the two the case took are not a
	// shortage of the branch, they are the batteries the case explains.
	countAll(t, ctx, p, closing, map[int]int{1: 8})
	var counted int64
	if err := p.QueryRow(ctx, `SELECT counted_quantity FROM closing_count_lines
 WHERE closing_id=$1 AND variant_id=1`, closing).Scan(&counted); err != nil {
		t.Fatalf("the count of the settlement could not be read: %v", err)
	}
	if difference := counted - expected; difference != 0 {
		t.Fatalf("the settlement charges no shortage for a written off unit, got %d", difference)
	}
	t.Logf("067: the sheet of a later settlement expects 8 of 10 and charges no shortage")
}

// writeOffFixture is the stock of the two branches and the account of each location: the warehouse,
// two branches and their own batteries, which is what a write-off and a claim of this vertical need.
func writeOffFixture(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	applyMigrationRange(t, ctx, p, 67)
	seedPrefixCatalog(t, ctx, p)
	if _, err := p.Exec(ctx, `INSERT INTO auth_accounts(location_id,username,password_hash)
 VALUES(1,'almacen','x'),(2,'sucursal_a','x'),(3,'sucursal_b','x')`); err != nil {
		t.Fatal("the accounts could not be provisioned")
	}
	if _, err := p.Exec(ctx, `INSERT INTO inventory_balances(location_id,variant_id,existing,reserved)
 VALUES(2,1,10,0),(3,1,10,0)`); err != nil {
		t.Fatal("the branch stock could not be provisioned")
	}
	// The claim of the fixture is judged against a sale, and a sale needs the battery priced.
	if _, err := p.Exec(ctx, `INSERT INTO branch_prices(branch_location_id,catalog_entry_id,min_price,
 suggested_price,updated_by_account_id) VALUES(2,1,0.01,100.00,1)`); err != nil {
		t.Fatal("the branch prices could not be configured")
	}
	return ctx, p
}

// writeOffBalances is the whole stock matrix of the fixture, in one comparable string.
func writeOffBalances(t *testing.T, ctx context.Context, p *pgxpool.Pool) string {
	t.Helper()
	rows, err := p.Query(ctx, `SELECT location_id,variant_id,existing,reserved
 FROM inventory_balances ORDER BY location_id,variant_id`)
	if err != nil {
		t.Fatalf("the stock matrix could not be read: %v", err)
	}
	defer rows.Close()
	matrix := make([]string, 0, 8)
	for rows.Next() {
		var location, variant int
		var existing, reserved int64
		if err := rows.Scan(&location, &variant, &existing, &reserved); err != nil {
			t.Fatalf("a balance row could not be read: %v", err)
		}
		matrix = append(matrix, fmt.Sprintf("%d:%d=%d/%d", location, variant, existing, reserved))
	}
	if rows.Err() != nil {
		t.Fatalf("the stock matrix could not be read: %v", rows.Err())
	}
	return strings.Join(matrix, ",")
}

// writeOffExisting reads the existing quantity of one balance row through the pool or through the
// transaction that is proving the decrement belongs to it.
func writeOffExisting(t *testing.T, ctx context.Context, q writeOffQuerier, location,
	variant int) int64 {
	t.Helper()
	var existing int64
	if err := q.QueryRow(ctx, `SELECT existing FROM inventory_balances
 WHERE location_id=$1 AND variant_id=$2`, location, variant).Scan(&existing); err != nil {
		t.Fatalf("the balance of %d:%d could not be read: %v", location, variant, err)
	}
	return existing
}

// writeOffRollback admits a stock defect and rolls the transaction back, which is how "the same
// transaction of the admission" is proven from the outside.
func writeOffRollback(ctx context.Context, p *pgxpool.Pool) error {
	tx, err := p.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var id int64
	if err := tx.QueryRow(ctx, writeOffCaseSQL, 2, 1, 4, "Probada y devuelta al depósito", 2).
		Scan(&id); err != nil {
		return err
	}
	var existing int64
	if err := tx.QueryRow(ctx, `SELECT existing FROM inventory_balances
 WHERE location_id=2 AND variant_id=1`).Scan(&existing); err != nil {
		return err
	}
	if existing != 1 {
		return fmt.Errorf("the admission must decrement inside its own transaction, got %d", existing)
	}
	return tx.Rollback(ctx)
}

// writeOffRowCount counts the rows of one table of the fixture.
func writeOffRowCount(t *testing.T, ctx context.Context, p *pgxpool.Pool, table string) int {
	t.Helper()
	var rows int
	if err := p.QueryRow(ctx, `SELECT count(*) FROM `+table).Scan(&rows); err != nil {
		t.Fatalf("the rows of %s could not be counted: %v", table, err)
	}
	return rows
}
