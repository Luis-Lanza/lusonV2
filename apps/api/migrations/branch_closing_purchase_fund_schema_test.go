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

// migration044 is the purchase fund (S1-S4, S12): the second envelope of physical money a
// branch keeps apart from its operating drawer, the purchase rule that keeps a branch from
// spending more than it holds, and the two columns of the settlement that state what the
// warehouse counted and the amount that opens the next period. 001-043 are applied and
// checksummed, so the transition guard of 034 is replaced whole instead of edited.
const migration044 = "044_purchase_fund.sql"

// TestPurchaseFundMigrationShape reads the embedded migration exactly as PostgreSQL
// receives it. It proves the file does the two things it exists for -- the envelope as two
// nullable columns of the settlement and the purchase rule that reads it -- and nothing
// else: no table, no drop, no data written, and the transition guard of 034 redefined
// rather than edited.
func TestPurchaseFundMigrationShape(t *testing.T) {
	b, err := migrations.Files.ReadFile(migration044)
	if err != nil {
		t.Fatal("the purchase fund migration must be embedded", err)
	}
	sql := string(b)
	for _, required := range []string{
		// The envelope as two nullable columns of the settlement: the envelope the warehouse
		// counted and the amount that opens the next period, both stated by the version that
		// builds the screen (T2) and therefore nullable here.
		"ALTER TABLE branch_closings",
		"ADD COLUMN purchase_fund_counted numeric(12,2) CHECK (purchase_fund_counted >= 0)",
		"ADD COLUMN purchase_fund_cash numeric(12,2) CHECK (purchase_fund_cash >= 0)",

		// The transition guard of 034, redefined whole: the only thing added to it is the
		// envelope in the comparison the branch decides against.
		"CREATE OR REPLACE FUNCTION admit_branch_closing_transition() RETURNS trigger LANGUAGE plpgsql AS $$",
		"IF OLD.status = 'proposed' AND NEW.status IN ('rejected','closed') THEN",
		"OR NEW.purchase_fund_counted IS DISTINCT FROM OLD.purchase_fund_counted",
		"OR NEW.purchase_fund_cash IS DISTINCT FROM OLD.purchase_fund_cash",
		"MESSAGE='The drawer of a proposed settlement is the offer the branch decides'",

		// The purchase rule: cash only, no balance needed by a counter-document, one lock
		// per branch, and the balance since the last closure (S2, S3, S4).
		"CREATE FUNCTION admit_purchase_against_fund() RETURNS trigger LANGUAGE plpgsql AS $$",
		"IF NEW.paid_transfer <> 0 THEN",
		"MESSAGE='A branch purchase is paid in cash from the purchase fund'",
		"IF NEW.reverses_purchase_id IS NOT NULL THEN",
		"PERFORM pg_advisory_xact_lock(340252, NEW.location_id::integer);",
		"SELECT settlement.purchase_fund_cash, settlement.closed_at INTO opening, since",
		"FROM branch_closings settlement",
		"AND settlement.status = 'closed'",
		"ORDER BY settlement.closed_at DESC LIMIT 1;",
		"IF NOT FOUND OR opening IS NULL THEN\n        RETURN NEW;",
		"SELECT coalesce(sum(purchase.paid_cash),0) INTO spent FROM purchases purchase",
		"AND purchase.created_at >= since;",
		"available := opening - spent;",
		"IF NEW.paid_cash > available THEN",
		"|| available || ' available'",
		"CREATE TRIGGER admit_purchase_against_fund BEFORE INSERT ON purchases",
		"FOR EACH ROW EXECUTE FUNCTION admit_purchase_against_fund();",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("044 must install %q", required)
		}
	}
	// The guard raises the purchase domain's own code, and it is the only purchase refusal it
	// adds: the envelope is paid in cash, and no document spends more than it holds. The codes
	// of the settlement belong to the guard of 034 this file replaces.
	if n := strings.Count(sql, "ERRCODE='LP006'"); n != 2 {
		t.Errorf("044 must raise LP006 for the refusals of the envelope, got %d", n)
	}
	for _, foreign := range []string{"LP001", "LP002", "LP003", "LP004", "LP005"} {
		if strings.Contains(sql, "ERRCODE='"+foreign+"'") {
			t.Errorf("044 must not mint the purchase code %s", foreign)
		}
	}
	// One function replaced (034's guard), one function created (the purchase rule) and
	// one trigger created: a second trigger on the same event would run the rule twice,
	// and the transition trigger of 034 keeps calling the function it already names.
	if got := strings.Count(sql, "CREATE OR REPLACE FUNCTION"); got != 1 {
		t.Errorf("044 must redefine exactly one function, got %d", got)
	}
	if got := strings.Count(sql, "CREATE FUNCTION"); got != 1 {
		t.Errorf("044 must create exactly one function, got %d", got)
	}
	if got := strings.Count(sql, "CREATE TRIGGER"); got != 1 {
		t.Errorf("044 must create exactly one trigger, got %d", got)
	}
	if got := strings.Count(sql, "ALTER TABLE"); got != 1 {
		t.Errorf("044 must touch one table, got %d", got)
	}
	for _, forbidden := range []string{
		"CREATE TABLE", "DROP", "UPDATE ", "INSERT INTO", "DELETE FROM", "TRUNCATE",
		"CREATE TRIGGER admit_branch_closing_transition",
		"ADD COLUMN purchase_fund_counted numeric(12,2) NOT NULL",
		"ADD COLUMN purchase_fund_cash numeric(12,2) NOT NULL",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("044 must not contain %q", forbidden)
		}
	}
	// The purchase rule runs after the rules of 032 and 035: PostgreSQL fires the BEFORE row
	// triggers of a table in name order, so the envelope is measured only on a document the
	// base rules already admitted, and none of their triggers is recreated here.
	trigger := "admit_purchase_against_fund"
	for _, earlier := range []string{"admit_frozen_branch_purchase", "admit_purchase"} {
		if earlier >= trigger {
			t.Errorf("the envelope rule must sort after %s so the base rules run first", earlier)
		}
		if strings.Contains(sql, "CREATE TRIGGER "+earlier+" ") {
			t.Errorf("044 must not recreate the trigger %s", earlier)
		}
	}
	// The file documents its own decisions, so the next reader does not have to derive
	// them from the guard.
	for _, documented := range []string{
		"S1", "S2", "S3", "S4", "S12",
		"034", "032", "LC005", "LP006", "checksum",
		"envelope", "counter-document", "nullable",
	} {
		if !strings.Contains(sql, documented) {
			t.Errorf("044 must document its own decision: %s", documented)
		}
	}
	// The columns are added before the guard that reads them.
	if first, second := strings.Index(sql, "ADD COLUMN purchase_fund_counted"),
		strings.Index(sql, "CREATE FUNCTION admit_purchase_against_fund"); first < 0 || second < 0 || first > second {
		t.Error("the envelope must exist before the purchase rule that reads it")
	}
}

// purchaseFundFixture is the settlement block applied through 044: the prefix catalogue,
// one account per location, the stock of branch 2, its price and its commission, exactly
// what closingFixture seeds at 035, plus the four versions the envelope needs.
func purchaseFundFixture(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	applyMigrationRange(t, ctx, p, 44)
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

// settlePurchaseFund closes one settlement of the branch with the envelope the warehouse
// counted and the amount it leaves for the next period, which is what the purchase rule
// reads from then on. The envelope is a draft while the settlement is open, so it is
// stated before the walk that proposes and closes it.
func settlePurchaseFund(t *testing.T, ctx context.Context, p *pgxpool.Pool, branch int, counted, fresh string) int64 {
	t.Helper()
	closing := openSettlement(t, ctx, p, branch)
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET purchase_fund_counted=$2::numeric,
 purchase_fund_cash=$3::numeric WHERE id=$1`, closing, counted, fresh); err != nil {
		t.Fatalf("the purchase fund must be a draft while the settlement is open: %v", err)
	}
	closeSettlement(t, ctx, p, closing, "200.00", "0.00", "60.00")
	return closing
}

// buy registers one original purchase of branch 2 paid in cash out of the purchase fund,
// with the single used line its document needs, and returns its id.
func buy(t *testing.T, ctx context.Context, p *pgxpool.Pool, key, amount string) int64 {
	t.Helper()
	tx, err := p.Begin(ctx)
	if err != nil {
		t.Fatal("the purchase transaction could not start")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var id int64
	if err := tx.QueryRow(ctx, `INSERT INTO purchases(operation_key,location_id,total,paid_cash,paid_transfer,created_by_account_id)
 VALUES($1,2,$2::numeric,$2::numeric,0.00,2) RETURNING id`, key, amount).Scan(&id); err != nil {
		t.Fatalf("the purchase %s must be admitted: %v", key, err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO purchase_used_lines(purchase_id,model,quantity,unit_price)
 VALUES($1,'NS60ZL',1,$2::numeric)`, id, amount); err != nil {
		t.Fatalf("the line of purchase %s must be admitted: %v", key, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("the purchase %s must commit: %v", key, err)
	}
	return id
}

// reverse registers the counter-document of one persisted purchase: the same used line
// negated, the same price, the negated amounts and its reason.
func reverse(t *testing.T, ctx context.Context, p *pgxpool.Pool, key string, original int64, amount string) int64 {
	t.Helper()
	tx, err := p.Begin(ctx)
	if err != nil {
		t.Fatal("the counter-document transaction could not start")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var id int64
	if err := tx.QueryRow(ctx, `INSERT INTO purchases(operation_key,location_id,total,paid_cash,paid_transfer,
 reverses_purchase_id,reason,created_by_account_id)
 VALUES($1,2,-($2::numeric),-($2::numeric),0.00,$3,'pesaje mal tipeado',2) RETURNING id`,
		key, amount, original).Scan(&id); err != nil {
		t.Fatalf("the counter-document %s must be admitted: %v", key, err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO purchase_used_lines(purchase_id,model,quantity,unit_price)
 VALUES($1,'NS60ZL',-1,$2::numeric)`, id, amount); err != nil {
		t.Fatalf("the mirrored line of %s must be admitted: %v", key, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("the counter-document %s must commit: %v", key, err)
	}
	return id
}

// purchasesState is every purchase document, its lines and every settlement as one value,
// so "the refusal wrote nothing" is one comparison: not a document, not a line and not a
// settlement field.
func purchasesState(t *testing.T, ctx context.Context, p *pgxpool.Pool) string {
	t.Helper()
	var state string
	if err := p.QueryRow(ctx, `SELECT (SELECT count(*) FROM purchases)::text||'|'||
         (SELECT count(*) FROM purchase_used_lines)::text||'|'||
         coalesce((SELECT string_agg(id||':'||status||':'||coalesce(purchase_fund_counted::text,'-')
         ||':'||coalesce(purchase_fund_cash::text,'-'),',' ORDER BY id) FROM branch_closings),'')`).Scan(&state); err != nil {
		t.Fatalf("the purchases and the settlements could not be read: %v", err)
	}
	return state
}

// TestPurchaseFundRefusesATransferPayment proves S2 on a live database: a branch purchase
// is paid in cash from the purchase fund, so a document that pays anything by transfer is
// refused with the purchase domain's own code and nothing of it is stored.
func TestPurchaseFundRefusesATransferPayment(t *testing.T) {
	ctx, p := purchaseFundFixture(t)
	settlePurchaseFund(t, ctx, p, 2, "100.00", "100.00")
	before := purchasesState(t, ctx, p)

	// The whole document is paid by transfer: the envelope is never charged, so the rule
	// that a branch purchase is cash only refuses it before the balance is read.
	_, err := p.Exec(ctx, `INSERT INTO purchases(operation_key,location_id,total,paid_cash,paid_transfer,created_by_account_id)
 VALUES('purchase-fund-transfer-01',2,100.00,0.00,100.00,2)`)
	execRefusalMessage(t, err, "LP006", "paid in cash from the purchase fund")
	// A mixed document is refused by the same rule: there is no part of a purchase that
	// is paid otherwise.
	_, err = p.Exec(ctx, `INSERT INTO purchases(operation_key,location_id,total,paid_cash,paid_transfer,created_by_account_id)
 VALUES('purchase-fund-transfer-02',2,100.00,60.00,40.00,2)`)
	execRefusalMessage(t, err, "LP006", "paid in cash from the purchase fund")
	if after := purchasesState(t, ctx, p); after != before {
		t.Fatalf("a refused purchase must write nothing, got %q before %q", before, after)
	}
	t.Logf("044: a purchase paid by transfer is refused with LP006")
}

// TestPurchaseFundRefusesMoreThanTheEnvelope proves S4 on a live database: a purchase that
// spends more than the fund holds is refused with the available amount in the message, and
// the refusal stores neither the document nor a settlement change.
func TestPurchaseFundRefusesMoreThanTheEnvelope(t *testing.T) {
	ctx, p := purchaseFundFixture(t)
	settlePurchaseFund(t, ctx, p, 2, "100.00", "100.00")
	before := purchasesState(t, ctx, p)

	_, err := p.Exec(ctx, `INSERT INTO purchases(operation_key,location_id,total,paid_cash,paid_transfer,created_by_account_id)
 VALUES('purchase-fund-over-01',2,150.00,150.00,0.00,2)`)
	execRefusalMessage(t, err, "LP006", "100.00 available")
	if after := purchasesState(t, ctx, p); after != before {
		t.Fatalf("a refused purchase must write nothing, got %q before %q", before, after)
	}
	// The envelope is the balance the warehouse left, not the drawer: the settlement still
	// reports the money it counted and the fund it left behind.
	var settlement string
	if err := p.QueryRow(ctx, `SELECT purchase_fund_counted||':'||purchase_fund_cash||':'
         ||counted_cash||':'||closing_cash FROM branch_closings WHERE branch_location_id=2`).Scan(&settlement); err != nil ||
		settlement != "100.00:100.00:200.00:60.00" {
		t.Fatalf("the refusal must not touch the settlement, got %q %v", settlement, err)
	}
	t.Logf("044: a purchase above the envelope is refused with LP006 and writes nothing")
}

// TestPurchaseFundAdmitsWhatFits proves S3 on a live database: a purchase inside the
// envelope is admitted, two purchases that fit together are admitted while the sum stays
// inside it, and the next one that does not fit is refused with what is left.
func TestPurchaseFundAdmitsWhatFits(t *testing.T) {
	ctx, p := purchaseFundFixture(t)
	settlePurchaseFund(t, ctx, p, 2, "100.00", "100.00")

	first := buy(t, ctx, p, "purchase-fund-fits-01", "40.00")
	second := buy(t, ctx, p, "purchase-fund-fits-02", "50.00")
	// The two documents are persisted with the lines their totals state.
	if documents := countRows(t, ctx, p, `SELECT count(*) FROM purchases WHERE location_id=2`); documents != 2 {
		t.Fatalf("two purchases that fit must be admitted, got %d", documents)
	}
	if lines := countRows(t, ctx, p, `SELECT count(*) FROM purchase_used_lines`); lines != 2 {
		t.Fatalf("each admitted purchase keeps its line, got %d", lines)
	}

	// The envelope is spent by documents, not by the drawer: 100 - 40 - 50 leaves 10.
	_, err := p.Exec(ctx, `INSERT INTO purchases(operation_key,location_id,total,paid_cash,paid_transfer,created_by_account_id)
 VALUES('purchase-fund-fits-03',2,20.00,20.00,0.00,2)`)
	execRefusalMessage(t, err, "LP006", "10.00 available")

	// Spending exactly what is left is inside the envelope, and the purchase that follows
	// finds it empty.
	third := buy(t, ctx, p, "purchase-fund-fits-04", "10.00")
	_, err = p.Exec(ctx, `INSERT INTO purchases(operation_key,location_id,total,paid_cash,paid_transfer,created_by_account_id)
 VALUES('purchase-fund-fits-05',2,1.00,1.00,0.00,2)`)
	execRefusalMessage(t, err, "LP006", "0.00 available")

	var spent string
	if err := p.QueryRow(ctx, `SELECT sum(paid_cash)::text FROM purchases
 WHERE location_id=2 AND id = ANY($1::bigint[])`, []int64{first, second, third}).Scan(&spent); err != nil || spent != "100.00" {
		t.Fatalf("the admitted purchases must charge the envelope with their cash: %q %v", spent, err)
	}
	t.Logf("044: 40 + 50 fit, 20 does not (10 left), 10 fits and leaves the envelope empty")
}

// TestPurchaseFundAcceptsACounterDocumentOnAnEmptyEnvelope proves the one document S11
// names: a counter-document returns money and needs no balance, so it is admitted with the
// envelope at zero, and the money it returns is available again.
func TestPurchaseFundAcceptsACounterDocumentOnAnEmptyEnvelope(t *testing.T) {
	ctx, p := purchaseFundFixture(t)
	settlePurchaseFund(t, ctx, p, 2, "100.00", "100.00")
	original := buy(t, ctx, p, "purchase-fund-empty-01", "100.00")

	// The envelope is empty now: no document can charge it.
	_, err := p.Exec(ctx, `INSERT INTO purchases(operation_key,location_id,total,paid_cash,paid_transfer,created_by_account_id)
 VALUES('purchase-fund-empty-02',2,1.00,1.00,0.00,2)`)
	execRefusalMessage(t, err, "LP006", "0.00 available")

	// The counter-document of the purchase that emptied it is admitted at zero, because it
	// returns money instead of spending it.
	reverse(t, ctx, p, "purchase-fund-empty-03", original, "100.00")
	var net string
	if err := p.QueryRow(ctx, `SELECT sum(paid_cash)::text FROM purchases WHERE location_id=2`).Scan(&net); err != nil || net != "0.00" {
		t.Fatalf("the counter-document must return what its original spent: %q %v", net, err)
	}
	// The reversal subtracts from what the envelope spent, so the money is available again.
	buy(t, ctx, p, "purchase-fund-empty-04", "100.00")
	t.Logf("044: a counter-document is admitted on an empty envelope and returns the money")
}

// TestPurchaseFundIsADraftUntilProposed proves the lifecycle half on a live database: the
// two columns are drafts while the settlement is open or rejected and are refused once it
// is proposed, with the same LC005 freeze the drawer's other fields have, and they are not
// yet a fact of the closure.
func TestPurchaseFundIsADraftUntilProposed(t *testing.T) {
	ctx, p := purchaseFundFixture(t)

	// The envelope is not required at the closure: a settlement still closes with both
	// columns unstated, because the screen that states them lands later.
	silent := openSettlement(t, ctx, p, 2)
	closeSettlement(t, ctx, p, silent, "200.00", "0.00", "60.00")
	var unstated bool
	if err := p.QueryRow(ctx, `SELECT status='closed' AND purchase_fund_counted IS NULL
         AND purchase_fund_cash IS NULL FROM branch_closings WHERE id=$1`, silent).Scan(&unstated); err != nil || !unstated {
		t.Fatalf("a settlement must still close with its envelope unstated: %v", err)
	}

	// "Guardar y salir": the envelope is a draft while the settlement is open, exactly
	// like the drawer it is counted next to.
	closing := openSettlement(t, ctx, p, 2)
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET purchase_fund_counted=120.00,
 purchase_fund_cash=100.00 WHERE id=$1`, closing); err != nil {
		t.Fatalf("the purchase fund must be a draft while the settlement is open: %v", err)
	}
	var drafted string
	if err := p.QueryRow(ctx, `SELECT purchase_fund_counted||':'||purchase_fund_cash
 FROM branch_closings WHERE id=$1`, closing).Scan(&drafted); err != nil || drafted != "120.00:100.00" {
		t.Fatalf("the draft must be persisted exactly as typed: %q %v", drafted, err)
	}

	// Once proposed, the envelope is no longer a draft: the branch is deciding an offer that
	// includes it, exactly like the drawer fields it is counted next to. A header-only draft is
	// refused with the same freeze the other drawer fields get...
	proposeRound(t, ctx, p, closing, `{"fund":"60.00"}`)
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='proposed',counted_cash=200.00,
 closing_cash=60.00 WHERE id=$1`, closing); err != nil {
		t.Fatalf("the settlement could not be proposed: %v", err)
	}
	for _, statement := range []string{
		`UPDATE branch_closings SET purchase_fund_counted=90.00 WHERE id=$1`,
		`UPDATE branch_closings SET purchase_fund_cash=90.00 WHERE id=$1`,
	} {
		_, err := p.Exec(ctx, statement, closing)
		execRefusalMessage(t, err, "LC005", "Only an open or a rejected settlement is drafted")
	}
	var frozen string
	if err := p.QueryRow(ctx, `SELECT purchase_fund_counted||':'||purchase_fund_cash
 FROM branch_closings WHERE id=$1`, closing).Scan(&frozen); err != nil || frozen != "120.00:100.00" {
		t.Fatalf("a refused draft must change nothing, got %q %v", frozen, err)
	}

	// A rejection hands the settlement back to the warehouse and the envelope is a draft
	// again, like every other drawer field.
	decideRound(t, ctx, p, closing, "rejected", "el fondo era otro")
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='rejected' WHERE id=$1`, closing); err != nil {
		t.Fatalf("the settlement could not return to the warehouse: %v", err)
	}
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET purchase_fund_counted=100.00,
 purchase_fund_cash=90.00 WHERE id=$1`, closing); err != nil {
		t.Fatalf("a rejected settlement must draft its envelope again: %v", err)
	}

	// ...and the closure applies exactly the envelope it was offered: a closure that rewrites
	// it is refused, and the envelope it keeps is the one the branch accepted.
	proposeRound(t, ctx, p, closing, `{"fund":"60.00"}`)
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='proposed' WHERE id=$1`, closing); err != nil {
		t.Fatalf("the second round could not be proposed: %v", err)
	}
	decideRound(t, ctx, p, closing, "accepted", "")
	_, err := p.Exec(ctx, `UPDATE branch_closings SET status='closed',purchase_fund_cash=60.00
 WHERE id=$1`, closing)
	execRefusalMessage(t, err, "LC005", "the offer the branch decides")
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='closed' WHERE id=$1`, closing); err != nil {
		t.Fatalf("the accepted round must close the settlement: %v", err)
	}
	var settled string
	if err := p.QueryRow(ctx, `SELECT status||':'||purchase_fund_counted||':'||purchase_fund_cash
 FROM branch_closings WHERE id=$1`, closing).Scan(&settled); err != nil || settled != "closed:100.00:90.00" {
		t.Fatalf("the closure must apply the envelope it was offered: %q %v", settled, err)
	}
	t.Logf("044: the envelope drafts while the settlement is live and freezes once proposed")
}

// TestPurchaseFundAdmitsTheCounterDocumentOfALegacyTransferPayment proves the correction path
// of the documents this version did not write: before 044 a purchase could be paid by transfer,
// and its counter-document mirrors that split. The cash rule belongs to originals only, so the
// mirror of such a purchase is admitted and the envelope never sees it.
func TestPurchaseFundAdmitsTheCounterDocumentOfALegacyTransferPayment(t *testing.T) {
	ctx, p := purchaseFundFixture(t)
	settlePurchaseFund(t, ctx, p, 2, "100.00", "100.00")

	// One document as a live database already stores it: the guard of this version is off for
	// this insert only, which is exactly the state of every row written before 044.
	// The trigger changes its own table, so each ALTER is its own transaction: PostgreSQL refuses
	// to touch a table with pending trigger events.
	if _, err := p.Exec(ctx, `ALTER TABLE purchases DISABLE TRIGGER admit_purchase_against_fund`); err != nil {
		t.Fatal("the guard of 044 could not be disabled for the setup")
	}
	tx, err := p.Begin(ctx)
	if err != nil {
		t.Fatal("the setup transaction could not start")
	}
	var legacy int64
	if err := tx.QueryRow(ctx, `INSERT INTO purchases(operation_key,location_id,total,paid_cash,paid_transfer,created_by_account_id)
 VALUES('purchase-fund-legacy-01',2,100.00,40.00,60.00,2) RETURNING id`).Scan(&legacy); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal("a purchase paid by transfer must be storable before this version")
	}
	if _, err := tx.Exec(ctx, `INSERT INTO purchase_used_lines(purchase_id,model,quantity,unit_price)
 VALUES($1,'NS60ZL',1,100.00)`, legacy); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal("the line of the legacy purchase must be admitted")
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal("the legacy purchase must commit")
	}
	if _, err := p.Exec(ctx, `ALTER TABLE purchases ENABLE TRIGGER admit_purchase_against_fund`); err != nil {
		t.Fatalf("the guard of 044 could not be enabled again: %v", err)
	}

	// Its mirror carries the same split negated, and the cash rule does not judge it.
	mirror, err := p.Begin(ctx)
	if err != nil {
		t.Fatal("the counter-document transaction could not start")
	}
	defer func() { _ = mirror.Rollback(context.Background()) }()
	var counter int64
	if err := mirror.QueryRow(ctx, `INSERT INTO purchases(operation_key,location_id,total,paid_cash,paid_transfer,
 reverses_purchase_id,reason,created_by_account_id)
 VALUES('purchase-fund-legacy-02',2,-100.00,-40.00,-60.00,$1,'se tipeó dos veces',2) RETURNING id`, legacy).Scan(&counter); err != nil {
		t.Fatalf("the counter-document of a transfer-paid purchase must be admitted: %v", err)
	}
	if _, err := mirror.Exec(ctx, `INSERT INTO purchase_used_lines(purchase_id,model,quantity,unit_price)
 VALUES($1,'NS60ZL',-1,100.00)`, counter); err != nil {
		t.Fatalf("the mirrored line must be admitted: %v", err)
	}
	if err := mirror.Commit(ctx); err != nil {
		t.Fatalf("the counter-document must commit: %v", err)
	}
	var net string
	if err := p.QueryRow(ctx, `SELECT sum(paid_cash)::text FROM purchases WHERE location_id=2`).Scan(&net); err != nil || net != "0.00" {
		t.Fatalf("the mirror must return what the legacy purchase paid in cash: %q %v", net, err)
	}
	t.Logf("044: a counter-document of a transfer-paid legacy purchase is admitted")
}
