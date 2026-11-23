package migrations_test

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/testpg"
	"luson/api/migrations"
)

// The commission of a settlement is paid on the batteries it sold and on nothing else: "la
// comision debe ser solamente de la venta de baterias, la venta de 'otros productos' como agua
// acidulada no cuentan para la comision" (S1). The migration is additive in both directions --
// one nullable column and one function redefined whole -- and it rewrites no settlement: an acta
// recorded before the rule keeps the commission it recorded and states no base at all (S8).
const commissionBaseMigration = "064_commission_on_battery_sales.sql"

// TestCommissionOnBatterySalesStructure reads the embedded version exactly as PostgreSQL receives
// it and asserts the shape it installs: one nullable column with no default, the offer function
// redefined whole with the base filtered by the catalogue kind of the line, the commission
// computed on that base and `sales_total` still the sum of every line of the window.
func TestCommissionOnBatterySalesStructure(t *testing.T) {
	b, err := migrations.Files.ReadFile(commissionBaseMigration)
	if err != nil {
		t.Fatal("the commission migration must be embedded", err)
	}
	// Comments may name the historical contract; only executable statements prove what this
	// migration does.
	sql := statements(string(b))
	for _, required := range []string{
		// The base it multiplied, nullable and with no default: an acta recorded before this
		// rule states no base instead of a backfilled one (S6, S8).
		"ALTER TABLE branch_closings ADD COLUMN commission_base numeric(12,2)",
		// The sibling money columns' own check: a base is an amount, never a signed reading.
		"CHECK (commission_base >= 0);",

		// The offer is 037's, redefined whole because a checksummed migration cannot be edited
		// in place.
		"CREATE OR REPLACE FUNCTION record_branch_closing_offer() RETURNS trigger LANGUAGE plpgsql AS $$",
		"NEW.commission_rate_percent IS NULL",
		"RAISE EXCEPTION USING ERRCODE='LC003'",

		// The period total keeps counting every sale of the window, of both kinds, exactly as
		// 037 does: `Plata del período` and the cross-check `sales.total == today.sold` do not
		// narrow with the commission (S4).
		"SELECT coalesce(sum(line.subtotal),0) INTO sold",
		"NEW.sales_total := sold;",

		// The base is the same window joined through the line's own catalogue identity and
		// filtered by kind (S2).
		"SELECT coalesce(sum(line.subtotal),0) INTO commission_sold",
		"JOIN catalog_variants variant ON variant.id = line.variant_id",
		"JOIN catalog_entries entry ON entry.id = variant.catalog_entry_id",
		"AND entry.kind = 'battery'",

		// The base is recorded and the commission is the one rounding of 035 over it (S3, S5).
		"NEW.commission_base := commission_sold;",
		"NEW.commission_amount := round(commission_sold * NEW.commission_rate_percent / 100, 2);",

		// The base is frozen with the offer it produced, so an acta cannot keep a commission
		// whose base says something else (S5).
		"CREATE TRIGGER keep_branch_closing_commission_base",
		"NEW.commission_base IS DISTINCT FROM OLD.commission_base",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("the commission migration is incomplete: missing %s", required)
		}
	}
	// The commission is never the rate over the whole sale again: that was the rule this
	// migration replaces.
	if strings.Contains(sql, "NEW.commission_amount := round(sold *") {
		t.Error("the commission must not be computed on the unfiltered total")
	}
	// Additive and without backfill: the column is nullable with no default, and no executable
	// statement writes an existing settlement (S6, S7, S8).
	for _, forbidden := range []string{
		"UPDATE branch_closings SET", "UPDATE sales SET", "INSERT INTO branch_closings",
		"DELETE FROM", "TRUNCATE", "DEFAULT", "NOT NULL", "DROP COLUMN", "DROP TABLE",
		"SET commission_base", "numeric(12,2) NOT NULL",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("the commission migration must not rewrite a settled period: found %s", forbidden)
		}
	}
	// The single rounding of the vertical is reused and never restated: no second arithmetic of
	// the same money appears beside it.
	if strings.Contains(sql, "round(commission_sold * NEW.commission_rate_percent / 100, 2) +") {
		t.Error("the commission is one rounding and no other term")
	}
}

// TestCommissionOnBatterySalesOnALiveDatabase proves the version on the admitted fixture: a
// settlement proposed before the rule keeps the commission it recorded and gains no base, and a
// period that sells a battery and an other product proposes a base that is the battery only while
// its `sales_total` states both (S2, S4, S5, S6, S8). The fixture stops at 063 and applies 064 by
// hand, which is what makes "recorded before this rule" a real row instead of a simulation.
func TestCommissionOnBatterySalesOnALiveDatabase(t *testing.T) {
	ctx, p, product := commissionFixture(t)

	// A first settlement closes empty-handed, so the branch has a period to sell into.
	first := openSettlement(t, ctx, p, 2)
	countExpected(t, ctx, p, first)
	closeSettlement(t, ctx, p, first, "0.00", "0.00", "0.00")

	// The period sells two batteries and three bottles of an other product, both in cash. The
	// battery line is 200.00 and the product line 15.00, so no reading of this period can make
	// the two look alike.
	stockBranch(t, ctx, p, map[int]int{1: 10, product: 10})
	sellBattery(t, ctx, p, 1, 2, "100.00", "200.00", "BASE-1")
	sellProduct(t, ctx, p, product, 3, "5.00", "15.00")

	// The offer 063 writes: the whole sale is the commission base, as it always was.
	recorded := openSettlement(t, ctx, p, 2)
	countExpected(t, ctx, p, recorded)
	proposeRound(t, ctx, p, recorded, `{"fund":"0.00"}`)
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='proposed',counted_cash=215.00,
 contributed_cash=0.00,closing_cash=0.00 WHERE id=$1`, recorded); err != nil {
		t.Fatalf("the settlement could not be proposed before the rule: %v", err)
	}
	// 215.00 sold, 12.50% of it is 26.8750, rounded once to 26.88 (S3).
	if sales, commission := offeredMoney(t, ctx, p, recorded); sales != "215.00" || commission != "26.88" {
		t.Fatalf("the offer before the rule must charge the whole sale: %s %s", sales, commission)
	}
	decideRound(t, ctx, p, recorded, "accepted", "")
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='closed' WHERE id=$1`, recorded); err != nil {
		t.Fatalf("the accepted round must close the settlement: %v", err)
	}
	// The acta records what it settled; the closure never recomputes an offer.
	if sales, commission := offeredMoney(t, ctx, p, recorded); sales != "215.00" || commission != "26.88" {
		t.Fatalf("the closure must keep the offer it accepted: %s %s", sales, commission)
	}

	// The version arrives. It adds one nullable column and redefines the offer function; it
	// rewrites no row (S8), so the acta above keeps its money and its commission.
	version, err := migrations.Files.ReadFile(commissionBaseMigration)
	if err != nil {
		t.Fatal("the commission migration must be embedded", err)
	}
	if _, err := p.Exec(ctx, string(version)); err != nil {
		t.Fatalf("the commission migration must apply to an existing database: %v", err)
	}
	var base *string
	var sales, commission string
	if err := p.QueryRow(ctx, `SELECT commission_base::text,sales_total::text,
 commission_amount::text FROM branch_closings WHERE id=$1`, recorded).
		Scan(&base, &sales, &commission); err != nil {
		t.Fatalf("the recorded acta could not be read: %v", err)
	}
	if base != nil {
		t.Fatalf("an acta recorded before the rule states no base, got %q", *base)
	}
	if sales != "215.00" || commission != "26.88" {
		t.Fatalf("no acta is rewritten by this migration: %s:%s", sales, commission)
	}

	// From now on the offer multiplies the batteries of the period and states the whole sale
	// beside it (S2, S4). The branch sells a battery and an other product again.
	stockBranch(t, ctx, p, map[int]int{1: 5, product: 5})
	sellBattery(t, ctx, p, 1, 1, "100.00", "100.00", "BASE-2")
	sellProduct(t, ctx, p, product, 1, "5.00", "5.00")

	current := openSettlement(t, ctx, p, 2)
	countExpected(t, ctx, p, current)
	proposeRound(t, ctx, p, current, `{"fund":"0.00"}`)
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='proposed',counted_cash=105.00,
 contributed_cash=0.00,closing_cash=0.00 WHERE id=$1`, current); err != nil {
		t.Fatalf("the settlement could not be proposed: %v", err)
	}
	var offeredBase *string
	var offeredSales, offeredCommission string
	if err := p.QueryRow(ctx, `SELECT commission_base::text,sales_total::text,
 commission_amount::text FROM branch_closings WHERE id=$1`, current).
		Scan(&offeredBase, &offeredSales, &offeredCommission); err != nil {
		t.Fatalf("the offer could not be read: %v", err)
	}
	// 105.00 sold, 100.00 of it in batteries: the base is the battery line and 12.50% of 100.00
	// is 12.50, while `Plata del período` still states both kinds (S4).
	if offeredBase == nil || *offeredBase != "100.00" {
		t.Fatalf("only the battery line is the commission base, got %v", offeredBase)
	}
	if offeredSales != "105.00" || offeredCommission != "12.50" {
		t.Fatalf("the offer must state the whole sale and the battery commission: %s:%s",
			offeredSales, offeredCommission)
	}

	// The guard the version installs: the base is written by the propose path and then frozen with
	// the offer, so an acta can neither gain a base it never multiplied nor restate the one it did
	// (S5). The first probe is the pre-rule acta of this very test.
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET commission_base=50.00 WHERE id=$1`,
		recorded); err == nil {
		t.Fatal("an acta recorded before the rule must not gain a base afterwards")
	}
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET commission_base=90.00 WHERE id=$1`,
		current); err == nil {
		t.Fatal("a settlement must not restate the base of the offer it is deciding")
	}
	decideRound(t, ctx, p, current, "accepted", "")
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='closed' WHERE id=$1`,
		current); err != nil {
		t.Fatalf("the accepted round must close the settlement: %v", err)
	}
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET commission_base=90.00 WHERE id=$1`,
		current); err == nil {
		t.Fatal("a closed acta must refuse a base that is not the one it closed with")
	}
}

// commissionFixture is the closingFixture of the settlement tests applied up to the version before
// this change, plus one other product of the catalogue: a battery and a bottle are the two kinds
// the commission has to tell apart.
func commissionFixture(t *testing.T) (context.Context, *pgxpool.Pool, int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	applyMigrationRange(t, ctx, p, 63)
	seedPrefixCatalog(t, ctx, p)
	if _, err := p.Exec(ctx, `INSERT INTO auth_accounts(location_id,username,password_hash)
 VALUES(1,'almacen','x'),(2,'sucursal_a','x'),(3,'sucursal_b','x')`); err != nil {
		t.Fatal("the accounts could not be provisioned")
	}
	var product int64
	if err := p.QueryRow(ctx, `INSERT INTO catalog_entries(kind,name) VALUES('other','Agua acidulada')
 RETURNING id`).Scan(&product); err != nil {
		t.Fatalf("the product fixture failed: %v", err)
	}
	var variant int
	if err := p.QueryRow(ctx, `INSERT INTO catalog_variants(catalog_entry_id) VALUES($1) RETURNING id`,
		product).Scan(&variant); err != nil {
		t.Fatalf("the product variant fixture failed: %v", err)
	}
	// The branch holds no stock yet: the first settlement counts zero and ships nothing, which is
	// how a branch gets a period to sell into.
	if _, err := p.Exec(ctx, `INSERT INTO inventory_balances(location_id,variant_id,existing,reserved)
 VALUES(2,1,0,0),(2,2,0,0),(2,$1,0,0)`, variant); err != nil {
		t.Fatalf("the branch stock could not be provisioned: %v", err)
	}
	if _, err := p.Exec(ctx, `INSERT INTO branch_prices(branch_location_id,catalog_entry_id,min_price,suggested_price,updated_by_account_id)
 VALUES(2,1,0.01,100.00,1),(2,$1,1.00,5.00,1)`, product); err != nil {
		t.Fatalf("the branch prices could not be configured: %v", err)
	}
	if _, err := p.Exec(ctx, `INSERT INTO branch_settings(branch_location_id,commission_rate_percent,updated_by_account_id)
 VALUES(2,12.50,1)`); err != nil {
		t.Fatalf("the branch commission could not be configured: %v", err)
	}
	return ctx, p, variant
}

// countExpected counts every line of the sheet at the quantity the sheet expects, so the closure
// ships exactly the stock the branch holds and nothing is pending (LC019).
func countExpected(t *testing.T, ctx context.Context, p *pgxpool.Pool, closing int64) {
	t.Helper()
	if _, err := p.Exec(ctx, `UPDATE closing_count_lines SET counted_quantity=expected_quantity
 WHERE closing_id=$1`, closing); err != nil {
		t.Fatalf("the count sheet could not be counted: %v", err)
	}
}

// offeredMoney reads the period total and the commission one settlement recorded, exactly as the
// database stores them.
func offeredMoney(t *testing.T, ctx context.Context, p *pgxpool.Pool, closing int64) (string, string) {
	t.Helper()
	var sales, commission string
	if err := p.QueryRow(ctx, `SELECT sales_total::text,commission_amount::text
 FROM branch_closings WHERE id=$1`, closing).Scan(&sales, &commission); err != nil {
		t.Fatalf("the offer of settlement %d could not be read: %v", closing, err)
	}
	return sales, commission
}

// stockBranch puts the stock the next sale of branch 2 decrements: the closure of the previous
// period shipped it to the warehouse, so the branch restocks through the balance row it has.
func stockBranch(t *testing.T, ctx context.Context, p *pgxpool.Pool, existing map[int]int) {
	t.Helper()
	for variant, quantity := range existing {
		if _, err := p.Exec(ctx, `UPDATE inventory_balances SET existing=$2,reserved=0
 WHERE location_id=2 AND variant_id=$1`, variant, quantity); err != nil {
			t.Fatalf("the branch stock of variant %d could not be stated: %v", variant, err)
		}
	}
}

// sellBattery records one battery sale of branch 2 the way the counter writes it: one unit per
// sold piece, the serial a battery document needs and the customer the warranty prints (057).
func sellBattery(t *testing.T, ctx context.Context, p *pgxpool.Pool, variant, quantity int,
	unitPrice, total, serial string) {
	t.Helper()
	recordSale(t, ctx, p, variant, quantity, unitPrice, total, warrantySale, serial)
}

// sellProduct records one product sale of branch 2: a bottle is counted and never serialized, so
// its line carries no unit and the document names no customer.
func sellProduct(t *testing.T, ctx context.Context, p *pgxpool.Pool, variant, quantity int,
	unitPrice, total string) {
	t.Helper()
	recordSale(t, ctx, p, variant, quantity, unitPrice, total, productSale, "")
}

// warrantySale and productSale are the two shapes a sale of this fixture takes: a battery document
// is a warranty that names its client and carries one unit per piece, and a product document names
// nobody and carries no unit at all.
const (
	warrantySale = true
	productSale  = false
)

// recordSale stores the header, the one line and -- for a battery document -- the unit of every sold
// piece, all of them in the transaction the database judges at commit (056, 057).
func recordSale(t *testing.T, ctx context.Context, p *pgxpool.Pool, variant, quantity int,
	unitPrice, total string, warranty bool, serial string) int64 {
	t.Helper()
	tx, err := p.Begin(ctx)
	if err != nil {
		t.Fatalf("the sale transaction could not start: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var id int64
	var query string
	if warranty {
		query = `INSERT INTO sales(branch_location_id,cash_amount,customer_name,customer_phone,
 customer_document,total,created_by_account_id)
 VALUES(2,$1::numeric,'Cliente de sucursal','700-00000','CI-123456',$2::numeric,2) RETURNING id`
	} else {
		query = `INSERT INTO sales(branch_location_id,cash_amount,customer_name,total,created_by_account_id)
 VALUES(2,$1::numeric,'Consumidor final',$2::numeric,2) RETURNING id`
	}
	if err := tx.QueryRow(ctx, query, total, total).Scan(&id); err != nil {
		t.Fatalf("the sale header could not be stored: %v", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO sale_lines(sale_id,variant_id,quantity,unit_price)
 VALUES($1,$2,$3,$4::numeric)`, id, variant, quantity, unitPrice); err != nil {
		t.Fatalf("the sale line could not be stored: %v", err)
	}
	if warranty {
		for ordinal := 1; ordinal <= quantity; ordinal++ {
			if _, err := tx.Exec(ctx, `INSERT INTO sale_units(sale_id,variant_id,unit_ordinal,serial_number)
 VALUES($1,$2,$3,$4)`, id, variant, ordinal, fmt.Sprintf("%s/%d", serial, ordinal)); err != nil {
				t.Fatalf("the battery unit %d must be admitted: %v", ordinal, err)
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("the sale must commit: %v", err)
	}
	return id
}
