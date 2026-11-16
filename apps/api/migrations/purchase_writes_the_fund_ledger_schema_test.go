package migrations_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/migrations"
)

// migration050 is the purchase writing its own movement of the fund: the two rules of 044 --
// a branch purchase is paid in cash, and the fund pays only what it holds -- become one rule of
// the database. A cash purchase appends its `compra` to the fund's ledger of 048 in the same
// transaction, a counter-document appends the `correccion` that answers it, and the balance that
// decides is the signed sum of that ledger and nothing else -- which is why a branch whose fund
// was never stated now has zero instead of an unstated exception (S6, S7, S8).
const purchaseWritesTheFundLedgerMigration = "050_purchase_writes_the_fund_ledger.sql"

// TestPurchaseWritesTheFundLedgerMigrationShape reads the embedded migration exactly as
// PostgreSQL receives it and asserts the contract it installs: the link between a document and
// the movement it wrote, the two triggers of the write, the replacement of the envelope rule, and
// -- the point of the version -- that it computes no balance of its own.
func TestPurchaseWritesTheFundLedgerMigrationShape(t *testing.T) {
	b, err := migrations.Files.ReadFile(purchaseWritesTheFundLedgerMigration)
	if err != nil {
		t.Fatal("the purchase writes the fund ledger migration must be embedded", err)
	}
	sql := string(b)
	for _, required := range []string{
		// The link between the document and the movement it wrote: one movement per document,
		// sealed like the two books it joins.
		"CREATE TABLE purchase_fund_writes (",
		"purchase_id bigint PRIMARY KEY REFERENCES purchases(id)",
		"movement_id bigint NOT NULL UNIQUE REFERENCES branch_fund_movements(id)",
		"CREATE TRIGGER protect_purchase_fund_writes BEFORE UPDATE OR DELETE ON purchase_fund_writes",
		"CREATE TRIGGER protect_purchase_fund_writes_truncate BEFORE TRUNCATE ON purchase_fund_writes",
		// 044's envelope rule, replaced: cash only, and no arithmetic of its own.
		"CREATE OR REPLACE FUNCTION admit_purchase_against_fund() RETURNS trigger LANGUAGE plpgsql AS $$",
		"MESSAGE='A branch purchase is paid in cash from the purchase fund'",
		"ERRCODE='LP006'",
		// The write: the `compra` of the cash the purchase paid, and the `correccion` that
		// answers the `compra` of the document it reverses.
		"CREATE FUNCTION write_purchase_fund_movement() RETURNS trigger LANGUAGE plpgsql AS $$",
		"VALUES(NEW.location_id,'compra',NEW.paid_cash,",
		"VALUES(NEW.location_id,'correccion',original.amount,",
		"corrects_id)",
		"FROM purchase_fund_writes writes",
		"AND movement.kind = 'compra'",
		"RETURNING id INTO movement_id",
		"INSERT INTO purchase_fund_writes(purchase_id,movement_id)",
		// The description names the document and the material it bought, and it is bounded.
		"'Compra ' || NEW.id",
		"'Corrección ' || NEW.id",
		"ORDER BY item",
		"left(description,500)",
		// The write is deferred to the commit of the document: the material of a purchase is
		// known once its lines are written, and the ledger of a document states the document.
		"CREATE CONSTRAINT TRIGGER purchase_writes_the_fund_ledger AFTER INSERT ON purchases",
		"DEFERRABLE INITIALLY DEFERRED",
		"FOR EACH ROW EXECUTE FUNCTION write_purchase_fund_movement()",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("050 must install %q", required)
		}
	}

	// One table, two immutability guards, one replaced function, one function and the deferred
	// trigger of the write. Nothing else: this version adds no column, no view and no ledger
	// guard of its own.
	if got := strings.Count(sql, "CREATE TABLE"); got != 1 {
		t.Errorf("050 adds one table, got %d", got)
	}
	if got := strings.Count(sql, "CREATE TRIGGER"); got != 2 {
		t.Errorf("050 seals the link table with two guards, got %d", got)
	}
	if got := strings.Count(sql, "CREATE OR REPLACE FUNCTION"); got != 1 {
		t.Errorf("050 replaces the envelope rule and nothing else, got %d", got)
	}
	if got := strings.Count(sql, "CREATE FUNCTION"); got != 1 {
		t.Errorf("050 installs the write and nothing else, got %d", got)
	}
	if got := strings.Count(sql, "CREATE CONSTRAINT TRIGGER"); got != 1 {
		t.Errorf("050 installs one deferred trigger, got %d", got)
	}
	// There is exactly one place that computes the fund's balance -- the view of 048 -- so this
	// version contains no arithmetic over the fund at all: it names the view and no query reads
	// it, it subtracts nothing and it reads no column of a settlement.
	for _, forbidden := range []string{
		"sum(effective) INTO", "coalesce(sum", "SUM(", "INTO balance",
		"ALTER TABLE branch_fund_movements", "CREATE VIEW",
		"CREATE OR REPLACE FUNCTION admit_branch_fund_movement",
		"CREATE OR REPLACE FUNCTION create_branch_funded",
		"purchase_fund_cash", "purchase_fund_counted", "paid_cash - ", "available",
		"DROP ", "UPDATE branch_fund_movements", "DELETE FROM branch_fund_movements",
		"TRUNCATE branch_fund_movements", "UPDATE purchases", "DELETE FROM purchases",
		"INSERT INTO branch_closings", "UPDATE branch_closings",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("050 must not contain %q", forbidden)
		}
	}
	// The refusals this version publishes are the ones it inherits: the cash rule keeps its own
	// code and the tope is raised by the ledger's admission (LF003), never restated here.
	if strings.Contains(sql, "ERRCODE='LF003'") {
		t.Error("050 must not raise the tope: the admission of 048 decides it")
	}
	if strings.Contains(sql, "ERRCODE='LF001'") {
		t.Error("050 must not mint the ledger's identity code")
	}

	// The link table exists before the guard that writes it, and the write is installed after
	// the rule that admits the document.
	table := strings.Index(sql, "CREATE TABLE purchase_fund_writes")
	rule := strings.Index(sql, "CREATE OR REPLACE FUNCTION admit_purchase_against_fund()")
	write := strings.Index(sql, "CREATE FUNCTION write_purchase_fund_movement()")
	trigger := strings.Index(sql, "CREATE CONSTRAINT TRIGGER purchase_writes_the_fund_ledger")
	if table < 0 || rule < 0 || write < 0 || trigger < 0 || table > write || rule > trigger || write > trigger {
		t.Errorf("the order of 050 is the order of its readers: %d %d %d %d", table, rule, write, trigger)
	}

	// The decisions a reader has to be able to check without deriving them from the triggers.
	for _, documented := range []string{
		"S6", "S7", "S8", "Why", "purchase_fund_ledger", "340251", "LF003",
		"unstated", "compra", "correccion", "deferred",
	} {
		if !strings.Contains(sql, documented) {
			t.Errorf("050 must document its own decision: %s", documented)
		}
	}
}

// purchaseLedgerFixture is the prefix applied through 050: the catalogue, the accounts of the
// historical locations, the initialization row and the commission of branch 2, exactly what the
// fund's ledger of 048 needs. The branch that buys is founded with its fund by the test.
func purchaseLedgerFixture(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	return fundPrefixThrough(t, 50)
}

// purchaseKey builds one operation key of the contract: at least sixteen admitted characters,
// unique per document.
func purchaseKey(name string) string {
	return fmt.Sprintf("purchase-fund-ledger-%s", name)
}

// buyPurchaseTx starts one original purchase of a branch paid whole in cash out of the fund, with
// the single weighed line of copper its document needs, and leaves the transaction to the caller
// so an immediate and a deferred refusal are both observed where they happen.
func buyPurchaseTx(t *testing.T, ctx context.Context, p *pgxpool.Pool, key string, branch,
	account int, cash string) (pgx.Tx, int64) {
	t.Helper()
	tx, err := p.Begin(ctx)
	if err != nil {
		t.Fatal("the purchase transaction could not start")
	}
	t.Cleanup(func() { _ = tx.Rollback(context.WithoutCancel(ctx)) })
	var id int64
	if err := tx.QueryRow(ctx, `INSERT INTO purchases(operation_key,location_id,total,paid_cash,
 paid_transfer,created_by_account_id) VALUES($1,$2,$3::numeric,$3::numeric,0.00,$4)
 RETURNING id`, key, branch, cash, account).Scan(&id); err != nil {
		t.Fatalf("the purchase %q must be admitted: %v", key, err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO purchase_scrap_lines(purchase_id,material_id,kg,
 price_per_kg) VALUES($1,1,1.000,$2::numeric)`, id, cash); err != nil {
		t.Fatalf("the line of purchase %q must be admitted: %v", key, err)
	}
	return tx, id
}

// buyPurchase commits one original purchase paid whole in cash and returns the identifier of the
// document the database persisted.
func buyPurchase(t *testing.T, ctx context.Context, p *pgxpool.Pool, key string, branch,
	account int, cash string) int64 {
	t.Helper()
	tx, id := buyPurchaseTx(t, ctx, p, key, branch, account, cash)
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("the purchase %q must be admitted when it commits: %v", key, err)
	}
	return id
}

// counterDocument commits the counter-document of one persisted purchase: the same weighed line
// negated, the same price, the negated amounts and its reason, exactly as the mirror rule states.
func counterDocument(t *testing.T, ctx context.Context, p *pgxpool.Pool, key string, branch,
	account int, original int64, cash string) int64 {
	t.Helper()
	tx, err := p.Begin(ctx)
	if err != nil {
		t.Fatal("the counter-document transaction could not start")
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	var id int64
	if err := tx.QueryRow(ctx, `INSERT INTO purchases(operation_key,location_id,total,paid_cash,
 paid_transfer,reverses_purchase_id,reason,created_by_account_id)
 VALUES($1,$2,-($3::numeric),-($3::numeric),0.00,$4,'pesaje mal tipeado',$5) RETURNING id`,
		key, branch, cash, original, account).Scan(&id); err != nil {
		t.Fatalf("the counter-document %q must be admitted: %v", key, err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO purchase_scrap_lines(purchase_id,material_id,kg,
 price_per_kg) VALUES($1,1,-1.000,$2::numeric)`, id, cash); err != nil {
		t.Fatalf("the mirrored line of %q must be admitted: %v", key, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("the counter-document %q must commit: %v", key, err)
	}
	return id
}

// commitRefusalMessage asserts the deferred guard fired at commit with its own SQLSTATE and named
// the fact it had to name: the two numbers of the fund are only useful if they reach the caller.
func commitRefusalMessage(t *testing.T, ctx context.Context, tx pgx.Tx, code, contains string) {
	t.Helper()
	err := tx.Commit(ctx)
	var pg *pgconn.PgError
	if !errors.As(err, &pg) || pg.Code != code {
		t.Fatalf("expected SQLSTATE %s at commit, got %v", code, err)
	}
	if !strings.Contains(pg.Message, contains) {
		t.Fatalf("the refusal must name %q, got %q", contains, pg.Message)
	}
}

// purchaseFundLedgerState is every row of the fund's ledger, its signed reading and the link of
// every document as one value, so "writes nothing" is one comparison instead of a promise about
// a row.
func purchaseFundLedgerState(t *testing.T, ctx context.Context, p *pgxpool.Pool) string {
	t.Helper()
	var state string
	if err := p.QueryRow(ctx, `SELECT (SELECT coalesce(string_agg(branch_location_id||':'||kind
    ||':'||amount||':'||description||':'||created_by_account_id||':'
    ||coalesce(corrects_id::text,'-'),',' ORDER BY id),'') FROM branch_fund_movements)||'|'||
  (SELECT coalesce(string_agg(purchase_id||':'||movement_id,',' ORDER BY purchase_id),'')
     FROM purchase_fund_writes)||'|'||(SELECT count(*) FROM purchases)::text`).Scan(&state); err != nil {
		t.Fatalf("the fund ledger could not be read: %v", err)
	}
	return state
}

// spareBranchFounding creates a branch with a fund of the stated amount and returns the branch and
// the account of that branch: the two facts a movement of the fund is signed with.
func spareBranchFounding(t *testing.T, ctx context.Context, p *pgxpool.Pool, name,
	fund string) (int, int) {
	t.Helper()
	branch := founding(t, ctx, p, name, "0.00", fund, 1)
	return branch, branchActor(t, ctx, p, branch)
}

// TestPurchaseWritesItsCompraInTheFundLedger proves S5, S6 and S8 on a live database: a purchase
// paid in cash appends exactly one `compra` of that cash to the ledger of its branch, signed by
// the purchase's own account, described with the document and the material it bought, and the
// balance of the fund is the fund minus what the document paid.
func TestPurchaseWritesItsCompraInTheFundLedger(t *testing.T) {
	ctx, p := purchaseLedgerFixture(t)
	branch, actor := spareBranchFounding(t, ctx, p, "Sucursal C", "300.00")
	document := buyPurchase(t, ctx, p, purchaseKey("compra"), branch, actor, "120.00")

	var kind, amount, description string
	var signed int
	var corrects *int64
	if err := p.QueryRow(ctx, `SELECT kind,amount::text,description,created_by_account_id,corrects_id
 FROM branch_fund_movements WHERE branch_location_id=$1 AND kind='compra'`,
		branch).Scan(&kind, &amount, &description, &signed, &corrects); err != nil {
		t.Fatalf("the cash purchase must write its compra: %v", err)
	}
	if amount != "120.00" || signed != actor || corrects != nil {
		t.Fatalf("the compra states the cash paid, the purchase's account and no target, got %s %d %v",
			amount, signed, corrects)
	}
	// The description names the document and the material it bought: the ledger of a fund is
	// read as history, and a row that says nothing about its document is a row nobody can audit.
	if !strings.Contains(description, "Compra "+fmt.Sprint(document)) ||
		!strings.Contains(description, "Cobre") {
		t.Fatalf("the compra must name its document and the material, got %q", description)
	}
	// The document and the movement are one fact: the link is a row of its own and the balance is
	// the fund minus what the document paid.
	var linked int64
	if err := p.QueryRow(ctx, `SELECT movement_id FROM purchase_fund_writes WHERE purchase_id=$1`,
		document).Scan(&linked); err != nil {
		t.Fatalf("the purchase must link the movement it wrote: %v", err)
	}
	if balance := fundBalance(t, ctx, p, branch); balance != "180.00" {
		t.Fatalf("the fund after a purchase of 120.00 of 300.00 is 180.00, got %s", balance)
	}
	t.Logf("050: a cash purchase writes its own compra and the fund is the difference")
}

// TestPurchasePaidByTransferWritesNothing proves the reaching half of the fund rule on a live
// database: a document paid by transfer is refused with the fund's own code before anything is
// written, and the ledger of the fund stays exactly as it was -- a purchase that does not pay
// cash from the fund writes no movement at all.
func TestPurchasePaidByTransferWritesNothing(t *testing.T) {
	ctx, p := purchaseLedgerFixture(t)
	branch, actor := spareBranchFounding(t, ctx, p, "Sucursal C", "300.00")
	before := purchaseFundLedgerState(t, ctx, p)

	for name, paid := range map[string]string{"whole": "0.00", "part": "1.00"} {
		transfer := "120.00"
		if paid == "1.00" {
			transfer = "119.00"
		}
		_, err := p.Exec(ctx, `INSERT INTO purchases(operation_key,location_id,total,paid_cash,
 paid_transfer,created_by_account_id) VALUES($1,$2,120.00,$3::numeric,$4::numeric,$5)`,
			purchaseKey("transfer-"+name), branch, paid, transfer, actor)
		execRefusalMessage(t, err, "LP006", "paid in cash from the purchase fund")
	}
	if after := purchaseFundLedgerState(t, ctx, p); after != before {
		t.Fatalf("a purchase that pays no cash from the fund writes nothing, got %s before %s",
			after, before)
	}
	// And the same document paid in cash does write its movement: what the rule refuses is the
	// payment, not the purchase.
	buyPurchase(t, ctx, p, purchaseKey("transfer-cash"), branch, actor, "120.00")
	if balance := fundBalance(t, ctx, p, branch); balance != "180.00" {
		t.Fatalf("the cash document must charge the fund, got %s", balance)
	}
	t.Logf("050: a transfer-paid purchase writes nothing")
}

// TestCounterDocumentReturnsTheMoneyToTheFund proves the correction of S5 on a live database: the
// counter-document appends a `correccion` that answers the original `compra` for the same amount,
// so the money comes back, the corrected document keeps its own row, and the balance returns to
// where it was before the purchase.
func TestCounterDocumentReturnsTheMoneyToTheFund(t *testing.T) {
	ctx, p := purchaseLedgerFixture(t)
	branch, actor := spareBranchFounding(t, ctx, p, "Sucursal C", "300.00")
	document := buyPurchase(t, ctx, p, purchaseKey("return"), branch, actor, "120.00")
	if balance := fundBalance(t, ctx, p, branch); balance != "180.00" {
		t.Fatalf("the purchase must charge the fund, got %s", balance)
	}
	var originalID int64
	if err := p.QueryRow(ctx, `SELECT id FROM branch_fund_movements
 WHERE branch_location_id=$1 AND kind='compra'`, branch).Scan(&originalID); err != nil {
		t.Fatalf("the compra of the purchase could not be read: %v", err)
	}

	counter := counterDocument(t, ctx, p, purchaseKey("return-counter"), branch, actor, document,
		"120.00")
	var kind, amount, effectKind, effective string
	var target int64
	var signed int
	var description string
	if err := p.QueryRow(ctx, `SELECT ledger.kind,movement.amount::text,ledger.effect_kind,
  ledger.effective::text,movement.corrects_id,movement.created_by_account_id,
  movement.description
 FROM purchase_fund_ledger ledger
 JOIN branch_fund_movements movement ON movement.id=ledger.id
 WHERE movement.id=(SELECT movement_id FROM purchase_fund_writes WHERE purchase_id=$1)`,
		counter).Scan(&kind, &amount, &effectKind, &effective, &target, &signed,
		&description); err != nil {
		t.Fatalf("the counter-document must write its correccion: %v", err)
	}
	if kind != "correccion" || amount != "120.00" || target != originalID || signed != actor {
		t.Fatalf("the correction answers the compra of its original for its amount, got %s %s %d %d",
			kind, amount, target, signed)
	}
	// The signed reading of the ledger is what makes the money come back: the correction carries
	// the direction of the compra it answers, inverted, and never its own.
	if effectKind != "compra" || effective != "120.00" {
		t.Fatalf("a correction of a compra returns its money, got %s:%s", effectKind, effective)
	}
	if !strings.Contains(description, "Corrección") ||
		!strings.Contains(description, fmt.Sprint(document)) {
		t.Fatalf("the correccion must name the document it answers, got %q", description)
	}
	if balance := fundBalance(t, ctx, p, branch); balance != "300.00" {
		t.Fatalf("the corrected purchase must give the fund back, got %s", balance)
	}
	// One compra and one correccion on top of the opening aporte: the original keeps its row and
	// the answer is its own.
	var movements string
	if err := p.QueryRow(ctx, `SELECT string_agg(kind, ',' ORDER BY id) FROM branch_fund_movements
 WHERE branch_location_id=$1`, branch).Scan(&movements); err != nil ||
		movements != "aporte,compra,correccion" {
		t.Fatalf("a corrected purchase leaves its opening, its compra and its correccion, got %q %v",
			movements, err)
	}
	t.Logf("050: a counter-document returns the money of its compra")
}

// TestPurchaseAboveTheFundIsRefusedAtCommit proves S6 and S8 on a live database: a purchase that
// asks the fund for more than it holds is refused by the ledger's admission of 048 -- the one
// place that decides -- with the balance and the requested amount in the message, and it writes
// neither the document nor a movement.
func TestPurchaseAboveTheFundIsRefusedAtCommit(t *testing.T) {
	ctx, p := purchaseLedgerFixture(t)
	branch, actor := spareBranchFounding(t, ctx, p, "Sucursal C", "300.00")
	before := purchaseFundLedgerState(t, ctx, p)

	tx, _ := buyPurchaseTx(t, ctx, p, purchaseKey("over"), branch, actor, "500.00")
	commitRefusalMessage(t, ctx, tx, "LF003", "300.00 in it, 500.00 requested")
	if after := purchaseFundLedgerState(t, ctx, p); after != before {
		t.Fatalf("a refused purchase writes nothing, got %s before %s", after, before)
	}
	// Spending exactly what the fund holds is admitted, and the next document finds it empty.
	buyPurchase(t, ctx, p, purchaseKey("over-fits"), branch, actor, "300.00")
	if balance := fundBalance(t, ctx, p, branch); balance != "0.00" {
		t.Fatalf("spending the whole fund leaves zero, got %s", balance)
	}
	tx, _ = buyPurchaseTx(t, ctx, p, purchaseKey("over-empty"), branch, actor, "0.01")
	commitRefusalMessage(t, ctx, tx, "LF003", "0.00 in it, 0.01 requested")
	t.Logf("050: the fund pays what it holds and refuses the rest with both numbers")
}

// TestPurchaseWithoutAStatedFundIsRefused proves S7 on a live database: a branch whose fund was
// never stated has zero, not an unknown, so its purchase is refused instead of admitted. The
// exception of 044 -- "an unstated envelope is not zero" -- no longer exists, and this is the row
// that would have passed through it.
func TestPurchaseWithoutAStatedFundIsRefused(t *testing.T) {
	ctx, p := purchaseLedgerFixture(t)
	// Branch 2 is one of the branches that already exist: 048 gave it no movement because it never
	// closed a settlement, so its book is empty and its balance is the empty sum.
	var closed int
	if err := p.QueryRow(ctx, `SELECT count(*) FROM branch_closings
 WHERE branch_location_id=2`).Scan(&closed); err != nil || closed != 0 {
		t.Fatalf("the unstated branch is one that never closed a settlement: %d %v", closed, err)
	}
	before := purchaseFundLedgerState(t, ctx, p)
	tx, _ := buyPurchaseTx(t, ctx, p, purchaseKey("unstated"), 2, 2, "1.00")
	commitRefusalMessage(t, ctx, tx, "LF003", "0.00 in it, 1.00 requested")
	if after := purchaseFundLedgerState(t, ctx, p); after != before {
		t.Fatalf("a refused purchase writes nothing, got %s before %s", after, before)
	}
	t.Logf("050: an unstated fund is zero and its purchase is refused")
}

// TestPurchaseWithALiveSettlementIsRefused proves the freeze on a live database: a purchase of a
// branch that is being settled is still refused before its movement is written, so the ledger of
// the fund cannot be charged by a document the branch may not register.
func TestPurchaseWithALiveSettlementIsRefused(t *testing.T) {
	ctx, p := purchaseLedgerFixture(t)
	branch, actor := spareBranchFounding(t, ctx, p, "Sucursal C", "300.00")
	if _, err := p.Exec(ctx, `INSERT INTO branch_settings(branch_location_id,
 commission_rate_percent,updated_by_account_id) VALUES($1,12.50,1)`, branch); err != nil {
		t.Fatalf("the branch commission could not be configured: %v", err)
	}
	before := purchaseFundLedgerState(t, ctx, p)
	openSettlement(t, ctx, p, branch)
	_, err := p.Exec(ctx, `INSERT INTO purchases(operation_key,location_id,total,paid_cash,
 paid_transfer,created_by_account_id) VALUES($1,$2,10.00,10.00,0.00,$3)`,
		purchaseKey("frozen"), branch, actor)
	execRefusalMessage(t, err, "LC001", "open account settlement")
	if after := purchaseFundLedgerState(t, ctx, p); after != before {
		t.Fatalf("a frozen branch writes no movement of its fund, got %s before %s", after, before)
	}
	t.Logf("050: a purchase with a live settlement is refused and writes nothing")
}

// TestPurchaseFundWritesAreAppendOnly proves the link between a document and its movement cannot
// be rewritten: a purchase has one movement and a movement has one purchase, and the rows that say
// so are sealed exactly like the books they join.
func TestPurchaseFundWritesAreAppendOnly(t *testing.T) {
	ctx, p := purchaseLedgerFixture(t)
	branch, actor := spareBranchFounding(t, ctx, p, "Sucursal C", "300.00")
	buyPurchase(t, ctx, p, purchaseKey("sealed"), branch, actor, "120.00")
	before := purchaseFundLedgerState(t, ctx, p)

	for _, statement := range []string{
		`UPDATE purchase_fund_writes SET movement_id=movement_id`,
		`DELETE FROM purchase_fund_writes`,
		`TRUNCATE purchase_fund_writes`,
	} {
		if _, err := p.Exec(ctx, statement); err == nil {
			t.Fatalf("the link of a purchase is append only: %s", statement)
		}
	}
	if after := purchaseFundLedgerState(t, ctx, p); after != before {
		t.Fatalf("a refused write leaves the link untouched, got %s before %s", after, before)
	}
	t.Logf("050: the link between a document and its movement is append only")
}
