package migrations_test

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/migrations"
)

// fundSignMigration is the fund's sign belonging to its kind: 052 corrects the three defects the
// review of 051 found -- a correction measured with a second, hand-made sign; a signed amount any
// account of the branch could write; and a closed acta recalculated from a book that was not the one
// it settled. It states one expression for the signed effect of a row, one kind for money out of the
// fund and one rule for reading a closed settlement's fund.
const fundSignMigration = "052_fund_sign_belongs_to_the_kind.sql"

// TestFundSignBelongsToTheKindMigrationShape reads the embedded migration exactly as PostgreSQL
// receives it and asserts the contract it installs, and what it must not do.
func TestFundSignBelongsToTheKindMigrationShape(t *testing.T) {
	b, err := migrations.Files.ReadFile(fundSignMigration)
	if err != nil {
		t.Fatal("the fund sign migration must be embedded", err)
	}
	sql := string(b)
	for _, required := range []string{
		// Finding 2: the closure's movement names its settlement, and the two directions of a closure
		// are two kinds with positive amounts.
		"ALTER TABLE branch_fund_movements ADD COLUMN closing_id bigint REFERENCES branch_closings(id)",
		"CREATE UNIQUE INDEX branch_fund_movements_by_closing",
		"ON branch_fund_movements(closing_id) WHERE closing_id IS NOT NULL",
		"ALTER TABLE branch_fund_movements DROP CONSTRAINT branch_fund_movements_kind_check",
		"CHECK (kind IN ('aporte','compra','reposicion','devolucion','correccion'))",
		"ADD CONSTRAINT branch_fund_movements_closing_shape CHECK (",
		"(kind <> 'devolucion' OR closing_id IS NOT NULL)",
		"ALTER TABLE branch_fund_movements DROP CONSTRAINT branch_fund_movements_amount_check",
		"CHECK (amount > 0) NOT VALID",
		"MESSAGE='Only the closing of a settlement takes money out of the fund'",
		"MESSAGE='A movement of the period belongs to no settlement'",
		"MESSAGE='The fund of a settlement names the settlement it is closing'",

		// Finding 1: one expression, published by the view and read by the admission.
		"CREATE FUNCTION branch_fund_effective(kind text, amount numeric, answered_kind text)",
		"WHEN kind <> 'correccion' AND kind IN ('aporte','reposicion') THEN amount",
		"WHEN answered_kind IN ('aporte','reposicion') THEN -amount",
		"CREATE OR REPLACE VIEW purchase_fund_ledger AS",
		"branch_fund_effective(movement.kind, movement.amount,",
		"effect := branch_fund_effective(NEW.kind, NEW.amount,",
		"IF balance + effect < 0 THEN",

		// Finding 3: a closed settlement is read from the book only when its own closure wrote the
		// movement, and the closure writes that movement naming the settlement.
		"CREATE FUNCTION settled_purchase_fund(branch smallint, closed_at timestamptz)",
		"WHERE movement.closing_id = settled.id",
		"ELSE settled.purchase_fund_cash END",
		"INSERT INTO branch_fund_movements(",
		"NEW.opened_by_account_id, NEW.id)",

		// Everything of 048 and 051 that is not about the sign travels with the restatement, so a
		// later reader of this file sees the rules it must not lose.
		"MESSAGE='The founding of a branch writes no movement of another branch'",
		"xmin = pg_current_xact_id()::xid",
		"current_setting('luson.fund_backfill', true) = 'on'",
		"MESSAGE='Only the branch records its own fund movements'",
		"PERFORM assert_branch_not_frozen(NEW.branch_location_id);",
		"MESSAGE='A correction names a movement of its own branch'",
		"MESSAGE='A correction is not corrected'",
		"MESSAGE='A correction never exceeds the movement it corrects'",
		"MESSAGE='The purchase fund never goes negative: '",
		"PERFORM pg_advisory_xact_lock(340251, NEW.branch_location_id::integer);",
		"restated by later versions", "the backfill predicates must travel with it",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("052 must state %q", required)
		}
	}
	// The version corrects the fund and nothing else: no purchase, no metric, no settlement, no row
	// written here, and 051 itself is left alone because its checksum is recorded.
	for _, forbidden := range []string{
		"CREATE TABLE", "DROP TABLE", "DROP VIEW", "ALTER TABLE branch_closings",
		"ALTER TABLE purchases", "ALTER TABLE sale", "DROP FUNCTION", "DELETE FROM", "TRUNCATE",
		"UPDATE branch_closings", "INSERT INTO branch_closings", "INSERT INTO purchases",
		"INSERT INTO branch_cash_movements", "INSERT INTO closing_", "050_",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("052 must not use %q", forbidden)
		}
	}
	// The order of the file is the order of its readers: the column and the kinds before the function
	// that reads them, the function before the view that publishes it, and the view before the two
	// functions that read it.
	column := strings.Index(sql, "ADD COLUMN closing_id")
	sign := strings.Index(sql, "FUNCTION branch_fund_effective(")
	view := strings.Index(sql, "CREATE OR REPLACE VIEW purchase_fund_ledger")
	settled := strings.Index(sql, "FUNCTION settled_purchase_fund(")
	writer := strings.Index(sql, "FUNCTION record_branch_closing_fund()")
	admission := strings.Index(sql, "FUNCTION admit_branch_fund_movement()")
	if column < 0 || sign < 0 || view < 0 || settled < 0 || writer < 0 || admission < 0 ||
		column > sign || sign > view || view > settled || settled > writer || writer > admission {
		t.Errorf("052 must state the column, the sign, the view and then its readers: %d %d %d %d %d %d",
			column, sign, view, settled, writer, admission)
	}
	// No new code: the identity, the provenance and the shape are LF001, the tope of a correction is
	// LF002 and the balance that never goes negative is LF003, exactly as 048 minted them.
	for _, owned := range []string{"LF001", "LF002", "LF003"} {
		if !strings.Contains(sql, "ERRCODE='"+owned+"'") {
			t.Errorf("052 must restate %s", owned)
		}
	}
	for _, foreign := range []string{"LF004", "LF005", "LF006", "LF007", "LF008", "LF009"} {
		if strings.Contains(sql, "ERRCODE='"+foreign+"'") {
			t.Errorf("052 mints no code of its own, found %s", foreign)
		}
	}
	// The decisions a reader has to be able to check without deriving them from the triggers.
	for _, documented := range []string{
		"S5", "S6", "S7", "S9", "Why", "the sign belongs to the kind",
		"one expression", "devolucion", "closing_id", "settled_purchase_fund",
		"never recalculated", "NOT VALID", "append only", "340251", "051",
	} {
		if !strings.Contains(sql, documented) {
			t.Errorf("052 must document its own decision: %s", documented)
		}
	}
}

// fundSignFixture is the prefix applied through 052: the same catalogue, accounts and commission the
// fund suite seeds, so what is tested here is the version and nothing else.
func fundSignFixture(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	return fundPrefixThrough(t, 52)
}

// fundMovement is one movement of the fund's book as the database states it: the kind that carries
// its direction, the positive amount, the description, the instant it carries, the settlement whose
// closure wrote it (nil for a movement of the period) and the account that signed it.
type fundMovement struct {
	id          int64
	kind        string
	amount      string
	description string
	occurredAt  time.Time
	closingID   *int64
	actor       int
}

// fundClosingMovement reads the one movement a settlement's closure wrote, or fails: a closure that
// changes the fund states it once and through a row of the branch's book.
func fundClosingMovement(t *testing.T, ctx context.Context, p *pgxpool.Pool,
	closing int64) fundMovement {
	t.Helper()
	var movement fundMovement
	if err := p.QueryRow(ctx, `SELECT id,kind,amount::text,description,occurred_at,closing_id,
 created_by_account_id FROM branch_fund_movements WHERE closing_id=$1`, closing).
		Scan(&movement.id, &movement.kind, &movement.amount, &movement.description,
			&movement.occurredAt, &movement.closingID, &movement.actor); err != nil {
		t.Fatalf("the closure of settlement %d must write the fund it leaves: %v", closing, err)
	}
	return movement
}

// tryFundMovementNamingSettlement writes one movement of the period that names a settlement, which is
// the shape a client would use to describe an acta of its own, and returns the error instead of
// asserting.
func tryFundMovementNamingSettlement(ctx context.Context, p *pgxpool.Pool, branch, account int,
	kind, amount, description string, closing int64) error {
	_, err := p.Exec(ctx, `INSERT INTO branch_fund_movements(branch_location_id,kind,amount,
 description,created_by_account_id,closing_id)
 VALUES($1::smallint,$2,$3::numeric,$4,$5::integer,$6)`, branch, kind, amount, description,
		account, closing)
	return err
}

// countNegativeInstants counts the running balances of one branch's book that read below zero, which
// is the rule S6 states and the admission of the ledger enforces.
func countNegativeInstants(t *testing.T, ctx context.Context, p *pgxpool.Pool, branch int) int64 {
	t.Helper()
	var negative int64
	if err := p.QueryRow(ctx, `SELECT count(*) FROM (SELECT sum(effective) OVER (ORDER BY id)
   AS running FROM purchase_fund_ledger WHERE branch_location_id=$1) history
 WHERE running < 0`, branch).Scan(&negative); err != nil {
		t.Fatalf("the history of the fund could not be read: %v", err)
	}
	return negative
}

// TestFundCorrectionIsMeasuredByTheSignTheViewPublishes proves finding 1 and S6 on a live database:
// the guard measures the signed effect of a correction with the very expression the book publishes,
// so the balance it refuses with is the balance the view holds and a correction it admits lands the
// fund where the guard said it would.
func TestFundCorrectionIsMeasuredByTheSignTheViewPublishes(t *testing.T) {
	ctx, p := fundSignFixture(t)
	// The warehouse loads the fund the branch operates with, and the branch buys with it: the book is
	// the only money of the fund (S5, S7).
	load := recordFundMovement(t, ctx, p, 2, 2, "aporte", "500.00", "Carga de fondo del período")
	if err := tryFundMovement(ctx, p, 2, 2, "compra", "400.00", "Baterías usadas"); err != nil {
		t.Fatalf("a purchase the fund holds must be admitted: %v", err)
	}
	if balance := fundBalance(t, ctx, p, 2); balance != "100.00" {
		t.Fatalf("the book must hold what the load left, got %s", balance)
	}
	// A correction that would take the fund below zero is refused, and the balance it names is the one
	// the view publishes: the guard read no second arithmetic of its own.
	before := fundLedger(t, ctx, p)
	err := tryFundCorrection(ctx, p, 2, 2, load, "500.00", "Carga anulada")
	execRefusalMessage(t, err, "LF003", "100.00 in it, 500.00 requested")
	if after := fundLedger(t, ctx, p); after != before {
		t.Fatalf("a refused correction must write nothing, got %s before %s", after, before)
	}
	// The same movement corrected by what the book holds fits, and the fund lands exactly where the
	// guard measured it: 100.00 in, 100.00 answered, nothing left.
	if err := tryFundCorrection(ctx, p, 2, 2, load, "100.00", "Carga anulada en parte"); err != nil {
		t.Fatalf("a correction the balance fits must be admitted: %v", err)
	}
	if balance := fundBalance(t, ctx, p, 2); balance != "0.00" {
		t.Fatalf("the book must follow the correction the guard admitted, got %s", balance)
	}
	// A closure states the fund it leaves, and the fund it loads is money in as a `reposicion`
	// (finding 2). Answering it is money out, and the sign the guard measured is the sign the view
	// publishes for that very row: the opposite of the direction it carries.
	closing := settleFund(t, ctx, p, "600.00")
	moved := fundClosingMovement(t, ctx, p, closing)
	if moved.kind != "reposicion" || moved.amount != "600.00" {
		t.Fatalf("a closure that loads the fund states it as a reposicion, got %s %s",
			moved.kind, moved.amount)
	}
	if err := tryFundCorrection(ctx, p, 2, 2, moved.id, "200.00", "Carga de más"); err != nil {
		t.Fatalf("a correction of the fund a closure states must be admitted: %v", err)
	}
	if book := fundBalance(t, ctx, p, 2); book != "400.00" {
		t.Fatalf("answering money in must take it out, got %s", book)
	}
	var effect, effectKind string
	if err := p.QueryRow(ctx, `SELECT effective::text,effect_kind FROM purchase_fund_ledger
         WHERE corrects_id=$1`, moved.id).Scan(&effect, &effectKind); err != nil {
		t.Fatalf("the correction must be a row of the book: %v", err)
	}
	// The effect the guard measured is the effect the view publishes, for the very row it admitted.
	if effectKind != "reposicion" || effect != "-200.00" {
		t.Fatalf("the view must publish the direction of the corrected kind, got %s %s",
			effectKind, effect)
	}
	// No instant of the book is negative: the guard and the view measured the same money.
	if negative := countNegativeInstants(t, ctx, p, 2); negative != 0 {
		t.Fatalf("the fund of the branch must never read negative, got %d instants", negative)
	}
	t.Logf("052: the guard measures the sign the view publishes")
}

// TestFundSignUpgradesADatabaseThatApplied051 proves the version can be applied to a database that
// already ran 051 and holds the rows it admitted. The signed `reposicion` of that version is history,
// and this book is append only (048): no row is rewritten to satisfy a rule stated later, so the
// amount rule of 052 binds the rows written from it on and the old ones are read by the kind they
// carry, exactly as the view always read them.
func TestFundSignUpgradesADatabaseThatApplied051(t *testing.T) {
	ctx, p := fundPrefixThrough(t, 51)
	recordFundMovement(t, ctx, p, 2, 2, "aporte", "500.00", "Carga de fondo del período")
	// The past the upgrade has to carry: a signed reposicion, which 051 admitted and 052 withdraws.
	if err := tryFundMovement(ctx, p, 2, 2, "reposicion", "-400.00", "Carga en negativo de 051"); err != nil {
		t.Fatalf("051 admitted the signed reposicion this probe states: %v", err)
	}
	if balance := fundBalance(t, ctx, p, 2); balance != "100.00" {
		t.Fatalf("the book of 051 holds what it held, got %s", balance)
	}

	applyMigrationFrom(t, ctx, p, 52, 52)

	// The row of the past still reads as the money it moved, and the version completed on it.
	if balance := fundBalance(t, ctx, p, 2); balance != "100.00" {
		t.Fatalf("the upgrade must not rewrite the book it finds, got %s", balance)
	}
	// The rule binds every row written from this version on.
	err := tryFundMovement(ctx, p, 2, 2, "reposicion", "-1.00", "Otra carga negativa")
	execRefusalMessage(t, err, "23514", "branch_fund_movements_amount_check")
	// And the closure of a settlement writes the direction it states as a kind that names it, on the
	// upgraded database as on a new one.
	closing := settleFund(t, ctx, p, "40.00")
	moved := fundClosingMovement(t, ctx, p, closing)
	if moved.kind != "devolucion" || moved.amount != "60.00" || moved.closingID == nil ||
		*moved.closingID != closing {
		t.Fatalf("the closure of an upgraded database states the surplus as a devolucion, got %s %s %v",
			moved.kind, moved.amount, moved.closingID)
	}
	if balance := fundBalance(t, ctx, p, 2); balance != "40.00" {
		t.Fatalf("the fund after the closure must be the amount it leaves, got %s", balance)
	}
	t.Logf("052: a database that applied 051 upgrades without rewriting its book")
}

// TestFundMoneyOutIsAKindOnlyAClosureWrites proves finding 2 and S9 on a live database: the sign of a
// movement is its kind's and never its amount's, so no amount of any kind is negative, and the money
// that leaves the fund is a `devolucion` -- a kind the admission attributes to the closure of a
// settlement alone.
func TestFundMoneyOutIsAKindOnlyAClosureWrites(t *testing.T) {
	ctx, p := fundSignFixture(t)
	recordFundMovement(t, ctx, p, 2, 2, "aporte", "500.00", "Carga de fondo del período")
	before := fundLedger(t, ctx, p)

	// A branch account states no money out of its own fund: the closure of a settlement does, with the
	// provenance the settlement gives it, so a branch that could write the kind itself could drain the
	// fund with no acta behind it.
	err := tryFundMovement(ctx, p, 2, 2, "devolucion", "400.00", "Devolución sin rendición")
	execRefusalMessage(t, err, "LF001",
		"Only the closing of a settlement takes money out of the fund")
	// And no amount of any kind is negative: the direction of a movement is written in its kind, so a
	// reposición of minus four hundred is not a way to take money out of the fund.
	err = tryFundMovement(ctx, p, 2, 2, "reposicion", "-400.00", "Fondo negativo")
	execRefusalMessage(t, err, "23514", "branch_fund_movements_amount_check")
	err = tryFundMovement(ctx, p, 2, 2, "aporte", "-1.00", "Carga negativa")
	execRefusalMessage(t, err, "23514", "branch_fund_movements_amount_check")
	if after := fundLedger(t, ctx, p); after != before {
		t.Fatalf("a refused movement of money out must write nothing, got %s before %s", after, before)
	}
	// A positive reposición is still the branch's own load of the period (048): money in needs no
	// settlement, because it can never take the fund below zero.
	recordFundMovement(t, ctx, p, 2, 2, "reposicion", "100.00", "Carga del período")
	if balance := fundBalance(t, ctx, p, 2); balance != "600.00" {
		t.Fatalf("a load of the period must enter the book, got %s", balance)
	}
	// A movement of the period belongs to no settlement: naming one would describe an acta the closure
	// of that settlement did not write, and the acta would then read a book it never stated. It is
	// refused by its shape and before the freeze of the settlement it names is read.
	loadedBook := fundLedger(t, ctx, p)
	own := openSettlement(t, ctx, p, 2)
	err = tryFundMovementNamingSettlement(ctx, p, 2, 2, "reposicion", "10.00", "Acto ajeno", own)
	execRefusalMessage(t, err, "LF001", "A movement of the period belongs to no settlement")
	if after := fundLedger(t, ctx, p); after != loadedBook {
		t.Fatalf("a movement that names a settlement must write nothing, got %s before %s", after,
			loadedBook)
	}

	// The closure states the surplus it takes back as a `devolucion`, with its provenance: the
	// settlement's own opener, the instant the settlement closed, the settlement named by the row and
	// the description that names it.
	proposeRound(t, ctx, p, own, `{"fund":"100.00"}`)
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='proposed',counted_cash=0.00,
 contributed_cash=100.00,closing_cash=100.00,purchase_fund_cash=100.00 WHERE id=$1`, own); err != nil {
		t.Fatalf("the settlement could not be proposed: %v", err)
	}
	decideRound(t, ctx, p, own, "accepted", "")
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='closed' WHERE id=$1`, own); err != nil {
		t.Fatalf("the accepted round must close the settlement: %v", err)
	}
	moved := fundClosingMovement(t, ctx, p, own)
	if moved.kind != "devolucion" || moved.amount != "500.00" || moved.actor != 1 {
		t.Fatalf("the surplus of a closure is a devolucion signed by its opener, got %s %s %d",
			moved.kind, moved.amount, moved.actor)
	}
	if moved.closingID == nil || *moved.closingID != own {
		t.Fatalf("the movement of a closure must name its settlement, got %v", moved.closingID)
	}
	if !strings.Contains(moved.description, "rendición "+fmt.Sprint(own)) {
		t.Fatalf("the movement must name the settlement it states, got %q", moved.description)
	}
	var closedAt time.Time
	if err := p.QueryRow(ctx, `SELECT closed_at FROM branch_closings WHERE id=$1`, own).
		Scan(&closedAt); err != nil {
		t.Fatal("the closure instant could not be read")
	}
	if !moved.occurredAt.Equal(closedAt) {
		t.Fatalf("the statement of a closure shares its instant, got %s and %s",
			moved.occurredAt, closedAt)
	}
	if balance := fundBalance(t, ctx, p, 2); balance != "100.00" {
		t.Fatalf("the fund after the closure must be the amount it leaves, got %s", balance)
	}
	// The other direction exists as its own kind: a settlement that leaves more than the book holds
	// loads the fund with a `reposicion`, and the amount is positive in both directions.
	loading := settleFund(t, ctx, p, "400.00")
	loaded := fundClosingMovement(t, ctx, p, loading)
	if loaded.kind != "reposicion" || loaded.amount != "300.00" {
		t.Fatalf("the fund a closure loads is a reposicion of the difference, got %s %s",
			loaded.kind, loaded.amount)
	}
	if balance := fundBalance(t, ctx, p, 2); balance != "400.00" {
		t.Fatalf("the book must hold the fund the closure leaves, got %s", balance)
	}
	// The marker of a closure is no way in for a client, and another branch states nothing here.
	err = tryFundMovement(ctx, p, 3, 3, "devolucion", "1.00", "Devolución inventada")
	execRefusalMessage(t, err, "LF001",
		"Only the closing of a settlement takes money out of the fund")
	if negative := countNegativeInstants(t, ctx, p, 2); negative != 0 {
		t.Fatalf("the fund of the branch must never read negative, got %d instants", negative)
	}
	t.Logf("052: money out of the fund is a kind only a closure writes")
}
