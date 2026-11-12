package migrations_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/testpg"
	"luson/api/migrations"
)

// migration037 is the fourth payment of a sale (S13). 027 gave a sale one amount per
// admitted method and derived the label from them; this migration adds the QR amount, so
// the sum the database compares against the total and the label it derives have to admit
// four amounts. It is add-only for every earlier version: no issued sale is rewritten and
// no applied migration is edited -- the one function of 035 that has to read the new column
// is redefined here instead of being changed in place.
const migration037 = "037_sale_qr_payment.sql"

// TestSaleQRMigrationStructure reads the embedded migration exactly as PostgreSQL receives
// it: the fourth amount, its bound, the sum over four amounts, the label rebuilt to admit
// 'qr' and every combination through 'mixed', and the settlement offer redefined to sum the
// new column. It also proves the migration rewrites nothing it does not own: every ALTER
// targets the sale header, no guard is disarmed and no issued sale is updated.
func TestSaleQRMigrationStructure(t *testing.T) {
	b, err := migrations.Files.ReadFile(migration037)
	if err != nil {
		t.Fatal("the QR payment migration must be embedded", err)
	}
	sql := string(b)
	for _, required := range []string{
		// The fourth amount, added with the honest zero of a sale that never used it.
		"ALTER TABLE sales ADD COLUMN qr_amount numeric(12,2) NOT NULL DEFAULT 0",

		// The label is derived by the database again, over the four amounts: two or more
		// paying methods are 'mixed' and a single method is its own label, QR included.
		"(cash_amount > 0)::int + (card_amount > 0)::int + (transfer_amount > 0)::int + (qr_amount > 0)::int > 1 THEN 'mixed'",
		"WHEN cash_amount > 0 THEN 'cash'",
		"WHEN card_amount > 0 THEN 'card'",
		"WHEN transfer_amount > 0 THEN 'transfer'",
		"ELSE 'qr'",
		"STORED;",

		// The settlement rules restated over four amounts: no method negative or NaN, at
		// least one method paid, and the four amounts close against the total exactly.
		"ALTER TABLE sales ADD CONSTRAINT sales_qr_amount_bounded",
		"qr_amount >= 0 AND qr_amount <> 'NaN'::numeric",
		"cash_amount > 0 OR card_amount > 0 OR transfer_amount > 0 OR qr_amount > 0",
		"cash_amount + card_amount + transfer_amount + qr_amount = total",

		// The offer of the settlement reads the new column: 035 cannot be edited, so its
		// one function is redefined whole, with the same totals and the QR sum.
		"CREATE OR REPLACE FUNCTION record_branch_closing_offer() RETURNS trigger LANGUAGE plpgsql AS $$",
		"coalesce(sum(sale.qr_amount),0) AS qr",
		"NEW.qr_total := payments.qr;",
		"NEW.commission_amount := round(sold * NEW.commission_rate_percent / 100, 2);",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("037 must install %q", required)
		}
	}
	// The fourth amount is added before the label that reads it and before the sum that
	// compares it.
	if strings.Index(sql, "ALTER TABLE sales ADD COLUMN qr_amount") >
		strings.Index(sql, "GENERATED ALWAYS AS") {
		t.Error("the QR amount must be added before the label that reads it")
	}
	if strings.Index(sql, "ELSE 'qr'") >
		strings.Index(sql, "cash_amount + card_amount + transfer_amount + qr_amount = total") {
		t.Error("the sum over the four amounts is stated after the label, never before the column")
	}
	// No issued sale is rewritten and no immutability guard is disarmed: the new amount is
	// a stored default, so the rows already issued keep their amounts untouched.
	for _, forbidden := range []string{"DISABLE TRIGGER", "UPDATE sales", "DROP TRIGGER", "DROP TABLE"} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("037 must not contain %q: an issued sale is never rewritten", forbidden)
		}
	}
	// The sale header is the only table this version alters.
	for _, line := range strings.Split(sql, "\n") {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "ALTER TABLE ") {
			continue
		}
		if !strings.HasPrefix(trimmed, "ALTER TABLE sales ") {
			t.Errorf("037 must alter the sale header only: %s", trimmed)
		}
	}
	// The two decisions a reader has to be able to check are documented where they happen.
	for _, documented := range []string{"backfill", "035"} {
		if !strings.Contains(sql, documented) {
			t.Errorf("037 must document %q", documented)
		}
	}
}

// qrSaleFixture is the prefix catalogue with one battery priced in branch 2 and the stock
// its sales decrement, applied through 037: everything the sale header rules below read,
// and nothing else.
func qrSaleFixture(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	applyMigrationRange(t, ctx, p, 37)
	seedPrefixCatalog(t, ctx, p)
	if _, err := p.Exec(ctx, `INSERT INTO auth_accounts(location_id,username,password_hash)
 VALUES(1,'almacen','x'),(2,'sucursal_a','x')`); err != nil {
		t.Fatal("the accounts could not be provisioned")
	}
	if _, err := p.Exec(ctx, `INSERT INTO branch_prices(branch_location_id,catalog_entry_id,min_price,suggested_price,updated_by_account_id)
 VALUES(2,1,2000.00,2500.00,1)`); err != nil {
		t.Fatal("the branch price could not be configured")
	}
	seedBranchStock(t, ctx, p, 50, 1)
	return ctx, p
}

// issueSale writes one complete sale of variant 1 for 2000.00 with the four amounts the
// caller states, exactly like the counter does: the header, the commercial line and the
// unit of the battery that left with its serial. It returns the error instead of asserting,
// so the same call proves what is admitted and what is refused.
func issueSale(ctx context.Context, p *pgxpool.Pool, serial, cash, card, transfer, qr string) error {
	tx, err := p.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var id int64
	if err := tx.QueryRow(ctx, `INSERT INTO sales(branch_location_id,cash_amount,card_amount,
 transfer_amount,qr_amount,customer_name,total,created_by_account_id)
 VALUES(2,$1::numeric,$2::numeric,$3::numeric,$4::numeric,'Cliente',2000.00,2) RETURNING id`,
		cash, card, transfer, qr).Scan(&id); err != nil {
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

// saleLabel reads the label the database derived for the one sale of the asked serial.
func saleLabel(t *testing.T, ctx context.Context, p *pgxpool.Pool, serial string) string {
	t.Helper()
	var label string
	if err := p.QueryRow(ctx, `SELECT s.payment_method FROM sales s
 JOIN sale_units u ON u.sale_id=s.id WHERE u.serial_number=$1`, serial).Scan(&label); err != nil {
		t.Fatalf("the derived label of %s could not be read: %v", serial, err)
	}
	return label
}

// saleQR reads the QR amount the database stored for the one sale of the asked serial.
func saleQR(t *testing.T, ctx context.Context, p *pgxpool.Pool, serial string) string {
	t.Helper()
	var qr string
	if err := p.QueryRow(ctx, `SELECT s.qr_amount::text FROM sales s
 JOIN sale_units u ON u.sale_id=s.id WHERE u.serial_number=$1`, serial).Scan(&qr); err != nil {
		t.Fatalf("the QR amount of %s could not be read: %v", serial, err)
	}
	return qr
}

// TestSaleQRIsTheFourthPayment proves S13 on a live database: a sale paid only by QR is
// admitted and labelled 'qr', a sale where QR pays together with cash is 'mixed', all four
// methods together are 'mixed', and a sale whose four amounts do not close against the
// total -- or whose QR amount is negative or not a number -- is refused by the database and
// writes nothing. The three former labels keep their own behaviour.
func TestSaleQRIsTheFourthPayment(t *testing.T) {
	ctx, p := qrSaleFixture(t)
	// The settlement shapes the sale header admits, with the label the database derives
	// from the amounts and nothing else.
	for i, tc := range []struct {
		cash, card, transfer, qr, label string
	}{
		// The fourth method on its own, which used to be impossible to state.
		{"0.00", "0.00", "0.00", "2000.00", "qr"},
		// QR with another method: the combination is the derived 'mixed' (S13).
		{"1200.00", "0.00", "0.00", "800.00", "mixed"},
		{"0.00", "0.00", "300.00", "1700.00", "mixed"},
		{"0.00", "1000.00", "0.00", "1000.00", "mixed"},
		// Every admitted method at once is still one sale and still 'mixed'.
		{"500.00", "300.00", "200.00", "1000.00", "mixed"},
		// The three former methods keep the label 027 gave them.
		{"2000.00", "0.00", "0.00", "0.00", "cash"},
		{"0.00", "2000.00", "0.00", "0.00", "card"},
		{"0.00", "0.00", "2000.00", "0.00", "transfer"},
		{"0.00", "700.00", "1300.00", "0.00", "mixed"},
	} {
		serial := "QR-" + string(rune('A'+i))
		if err := issueSale(ctx, p, serial, tc.cash, tc.card, tc.transfer, tc.qr); err != nil {
			t.Fatalf("%s must be admitted: %v", tc.label, err)
		}
		label := saleLabel(t, ctx, p, serial)
		stored := saleQR(t, ctx, p, serial)
		if label != tc.label || stored != tc.qr {
			t.Fatalf("the settlement %s/%s/%s/%s must be derived as %s with qr %s, got %s/%s",
				tc.cash, tc.card, tc.transfer, tc.qr, tc.label, tc.qr, label, stored)
		}
	}
	issued := countRows(t, ctx, p, "SELECT count(*) FROM sales")
	// Every refusal names the constraint that proves the amounts themselves -- and not some
	// other guard -- were the reason, and leave no sale behind.
	for _, tc := range []struct {
		name, cash, card, transfer, qr string
		constraints                    []string
	}{
		// The fourth amount is part of the sum: it falls short, and it overshoots.
		{"four_below_total", "1000.00", "0.00", "0.00", "500.00",
			[]string{"sales_payments_total"}},
		{"four_above_total", "1000.00", "0.00", "0.00", "1500.00",
			[]string{"sales_payments_total"}},
		// A sale nothing was paid with is not a sale, even with a fourth column.
		{"nothing_paid", "0.00", "0.00", "0.00", "0.00",
			[]string{"sales_payments_nonzero", "sales_payments_total"}},
		// The QR amount obeys the same bound as the other three: the four amounts still
		// close, so the bound is what refuses the header.
		{"negative_qr", "2001.00", "0.00", "0.00", "-1.00",
			[]string{"sales_qr_amount_bounded"}},
		{"qr_not_a_number", "2000.00", "0.00", "0.00", "NaN",
			[]string{"sales_qr_amount_bounded", "sales_payments_total"}},
	} {
		_, err := p.Exec(ctx, `INSERT INTO sales(branch_location_id,cash_amount,card_amount,
 transfer_amount,qr_amount,customer_name,total,created_by_account_id)
 VALUES(2,$1::numeric,$2::numeric,$3::numeric,$4::numeric,'Cliente',2000.00,2)`,
			tc.cash, tc.card, tc.transfer, tc.qr)
		var pg *pgconn.PgError
		if !errors.As(err, &pg) {
			t.Fatalf("%s must be refused by the database: %v", tc.name, err)
		}
		admitted := false
		for _, constraint := range tc.constraints {
			admitted = admitted || pg.ConstraintName == constraint
		}
		if !admitted {
			t.Fatalf("%s must be refused by %v, got %q: %v", tc.name, tc.constraints,
				pg.ConstraintName, err)
		}
	}
	if after := countRows(t, ctx, p, "SELECT count(*) FROM sales"); after != issued {
		t.Fatalf("a refused settlement must not persist a sale: %d before, %d after", issued, after)
	}
	t.Logf("037: QR is a fourth amount, its own label, and part of the exact sum")
}

// TestSaleQRKeepsEveryIssuedSale proves the backfill on a live database: the sales issued
// before 037 keep every amount they had, gain the honest zero of the fourth method and are
// not reclassified, and the immutability guard of 025 is still installed afterwards.
func TestSaleQRKeepsEveryIssuedSale(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	// The schema before the fourth method exists.
	applyMigrationRange(t, ctx, p, 36)
	seedPrefixCatalog(t, ctx, p)
	if _, err := p.Exec(ctx, `INSERT INTO auth_accounts(location_id,username,password_hash)
 VALUES(1,'almacen','x'),(2,'sucursal_a','x')`); err != nil {
		t.Fatal("the accounts could not be provisioned")
	}
	if _, err := p.Exec(ctx, `INSERT INTO branch_prices(branch_location_id,catalog_entry_id,min_price,suggested_price,updated_by_account_id)
 VALUES(2,1,2000.00,2500.00,1)`); err != nil {
		t.Fatal("the branch price could not be configured")
	}
	seedBranchStock(t, ctx, p, 50, 1)
	// One issued sale per former settlement shape, at the discount the counter charged.
	type issued struct{ cash, card, transfer, label string }
	shapes := map[string]issued{
		"cash":     {"2000.00", "0.00", "0.00", "cash"},
		"card":     {"0.00", "2000.00", "0.00", "card"},
		"transfer": {"0.00", "0.00", "2000.00", "transfer"},
		"mixed":    {"1200.00", "0.00", "800.00", "mixed"},
	}
	ids := make(map[string]int64, len(shapes))
	for name, shape := range shapes {
		tx, err := p.Begin(ctx)
		if err != nil {
			t.Fatal("the pre-QR sale transaction failed")
		}
		var id int64
		if err := tx.QueryRow(ctx, `INSERT INTO sales(branch_location_id,cash_amount,card_amount,
 transfer_amount,customer_name,total,created_by_account_id)
 VALUES(2,$1::numeric,$2::numeric,$3::numeric,'Cliente',2000.00,2) RETURNING id`,
			shape.cash, shape.card, shape.transfer).Scan(&id); err != nil {
			t.Fatalf("the pre-QR %s sale must be issued: %v", name, err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO sale_lines(sale_id,variant_id,quantity,unit_price)
 VALUES($1,1,1,2000.00)`, id); err != nil {
			t.Fatalf("the pre-QR %s line must be issued: %v", name, err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO sale_units(sale_id,variant_id,unit_ordinal,serial_number)
 VALUES($1,1,1,$2)`, id, "PRE-QR-"+name); err != nil {
			t.Fatalf("the pre-QR %s unit must be issued: %v", name, err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatalf("the pre-QR %s sale must be committed: %v", name, err)
		}
		label := saleLabel(t, ctx, p, "PRE-QR-"+name)
		if label != shape.label {
			t.Fatalf("the pre-QR %s sale must already declare its label, got %s", name, label)
		}
		ids[name] = id
	}
	// Now the migration runs against a database that already has issued sales.
	migration, err := migrations.Files.ReadFile(migration037)
	if err != nil {
		t.Fatal("the QR payment migration must be embedded", err)
	}
	t.Logf("037 pre-backfill: %d issued sale(s) with %d frozen line(s)",
		countRows(t, ctx, p, "SELECT count(*) FROM sales"),
		countRows(t, ctx, p, "SELECT count(*) FROM sale_lines"))
	if _, err := p.Exec(ctx, string(migration)); err != nil {
		t.Fatalf("the QR payment migration failed on a live database: %v", err)
	}
	// Every issued sale keeps its amounts, its total and its label, and carries the honest
	// zero of a method that was never collected.
	for name, shape := range shapes {
		var cash, card, transfer, qr, label, total string
		if err := p.QueryRow(ctx, `SELECT cash_amount::text,card_amount::text,transfer_amount::text,
  qr_amount::text,payment_method,total::text FROM sales WHERE id=$1`, ids[name]).Scan(&cash,
			&card, &transfer, &qr, &label, &total); err != nil {
			t.Fatalf("the backfilled %s sale could not be read: %v", name, err)
		}
		if cash != shape.cash || card != shape.card || transfer != shape.transfer ||
			qr != "0.00" || label != shape.label || total != "2000.00" {
			t.Fatalf("the issued %s sale changed: %s/%s/%s/%s/%s/%s", name, cash, card, transfer,
				qr, label, total)
		}
	}
	if n := countRows(t, ctx, p, "SELECT count(*) FROM sales"); n != int64(len(shapes)) {
		t.Fatalf("the fourth method must keep every issued sale, got %d", n)
	}
	t.Logf("037 post-backfill: every sale kept its amounts and its label, and gained qr 0.00")
	// The immutability guard of 025 is untouched: 037 never rewrote an issued sale, so it
	// never had to disarm it.
	if _, err := p.Exec(ctx, "UPDATE sales SET total=1.00"); err == nil {
		t.Fatal("037 must leave the immutability guard enabled")
	}
}

// qrClosingFixture is the settlement block applied through 037: the catalogue, one account
// per location, the stock of branch 2, its price and its commission rate. It duplicates
// closingFixture because that one stops at 035, before the fourth method exists.
func qrClosingFixture(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	applyMigrationRange(t, ctx, p, 37)
	seedPrefixCatalog(t, ctx, p)
	if _, err := p.Exec(ctx, `INSERT INTO auth_accounts(location_id,username,password_hash)
 VALUES(1,'almacen','x'),(2,'sucursal_a','x'),(3,'sucursal_b','x')`); err != nil {
		t.Fatal("the accounts could not be provisioned")
	}
	if _, err := p.Exec(ctx, `INSERT INTO inventory_balances(location_id,variant_id,existing,reserved)
 VALUES(2,1,10,0),(2,2,4,0)`); err != nil {
		t.Fatal("the branch stock could not be provisioned")
	}
	if _, err := p.Exec(ctx, `INSERT INTO branch_prices(branch_location_id,catalog_entry_id,min_price,suggested_price,updated_by_account_id)
 VALUES(2,1,0.01,2500.00,1)`); err != nil {
		t.Fatal("the branch price could not be configured")
	}
	if _, err := p.Exec(ctx, `INSERT INTO branch_settings(branch_location_id,commission_rate_percent,updated_by_account_id)
 VALUES(2,12.50,1)`); err != nil {
		t.Fatal("the branch commission could not be configured")
	}
	return ctx, p
}

// sellWithQR is one sale of one unit of variant 1 paid with the four amounts the test
// states, so the settlement below can be sold into with the QR method the counter now
// admits.
func sellWithQR(ctx context.Context, p *pgxpool.Pool, branch int, serial, price, cash, card,
	transfer, qr string) error {
	tx, err := p.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var id int64
	if err := tx.QueryRow(ctx, `INSERT INTO sales(branch_location_id,cash_amount,card_amount,
 transfer_amount,qr_amount,customer_name,total,created_by_account_id)
 VALUES($1::smallint,$2::numeric,$3::numeric,$4::numeric,$5::numeric,'Cliente',$6::numeric,$1::integer)
 RETURNING id`, branch, cash, card, transfer, qr, price).Scan(&id); err != nil {
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

// TestSaleQRReachesTheSettlementOffer proves S13 at the settlement: the offer the branch is
// asked to accept reports the QR money of the period on its own, next to the cash, card and
// transfer totals of the same window, and the closure applies exactly that offer.
func TestSaleQRReachesTheSettlementOffer(t *testing.T) {
	ctx, p := qrClosingFixture(t)

	// A first settlement closes empty-handed, so the branch has a period to sell into.
	first := openSettlement(t, ctx, p, 2)
	countAll(t, ctx, p, first, map[int]int{1: 10, 2: 4})
	closeSettlement(t, ctx, p, first, "0.00", "0.00", "0.00")

	// Two sales of the open period: one paid only by QR, and one settled in cash and QR.
	if err := sellWithQR(ctx, p, 2, "OFFER-QR-1", "2500.00",
		"0.00", "0.00", "0.00", "2500.00"); err != nil {
		t.Fatalf("the QR-only sale must be admitted: %v", err)
	}
	if err := sellWithQR(ctx, p, 2, "OFFER-QR-2", "1500.00",
		"1000.00", "0.00", "0.00", "500.00"); err != nil {
		t.Fatalf("the cash and QR sale must be admitted: %v", err)
	}

	closing := openSettlement(t, ctx, p, 2)
	countAll(t, ctx, p, closing, map[int]int{1: 8, 2: 4})
	proposeRound(t, ctx, p, closing, `{"fund":"500.00"}`)
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='proposed',counted_cash=1000.00,
 contributed_cash=0.00,closing_cash=500.00 WHERE id=$1`, closing); err != nil {
		t.Fatalf("the settlement could not be proposed: %v", err)
	}
	// 4000.00 sold; 1000.00 in cash and 3000.00 by QR, nothing by card or transfer; the
	// commission is 12.50% of 4000.00 = 500.00.
	const offer = "4000.00:1000.00:0.00:0.00:3000.00:500.00:12.50"
	if state := settlementState(t, ctx, p, closing); !strings.HasSuffix(state, offer) {
		t.Fatalf("the proposal must record the QR money of the period, got %s, want %s", state, offer)
	}
	// The QR money never enters the drawer: the cash collected is only the cash amount, and
	// the closure records the offer it was accepted with.
	decideRound(t, ctx, p, closing, "accepted", "")
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='closed' WHERE id=$1`, closing); err != nil {
		t.Fatalf("the accepted round must close the settlement: %v", err)
	}
	if state := settlementState(t, ctx, p, closing); !strings.HasPrefix(state, "closed:") ||
		!strings.HasSuffix(state, offer) {
		t.Fatalf("the closure must keep the offer it accepted, got %s", state)
	}
	t.Logf("037: the settlement reports the QR money of the period and never adds it to the till")
}
