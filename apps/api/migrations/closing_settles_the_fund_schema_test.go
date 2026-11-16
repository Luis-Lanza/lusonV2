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

// migration051 is the closing settling the purchase fund through its book: the amount a settlement
// leaves becomes a `reposicion` of the fund's ledger of 048, written by the closure of the
// settlement and proved the way 046 proves the drawer's transfer, so the balance after the closure
// is the stated amount and the acta publishes the signed sum instead of a column that could drift
// from it (S5, S6, S9). A settlement that leaves less than the book holds states the difference with
// the sign of the money it sends back, and a statement below zero cannot even be stored, so no
// closure can drive the fund negative.
const closingSettlesTheFundMigration = "051_closing_settles_the_fund.sql"

// TestClosingSettlesTheFundMigrationShape reads the embedded migration exactly as PostgreSQL
// receives it and asserts the contract it installs: the signed amount of a `reposicion`, the trigger
// that writes the fund of a closure, the provenance and the restated admission of 048 with the two
// correction rules read on the magnitude and the sign. It also asserts what the migration must not
// do -- create a table or a view, rewrite a settlement, or mint a code of its own.
func TestClosingSettlesTheFundMigrationShape(t *testing.T) {
	b, err := migrations.Files.ReadFile(closingSettlesTheFundMigration)
	if err != nil {
		t.Fatal("the closing settles the fund migration must be embedded", err)
	}
	sql := string(b)
	for _, required := range []string{
		// The signed amount of a `reposicion`: the direction of a movement is still its kind's, and
		// the amount of the one kind a closure writes carries the sign of the difference it states.
		"ALTER TABLE branch_fund_movements DROP CONSTRAINT branch_fund_movements_amount_check",
		"ADD CONSTRAINT branch_fund_movements_amount_check CHECK (",
		"(kind = 'reposicion' AND amount <> 0) OR (kind <> 'reposicion' AND amount > 0)",

		// The closure writes the fund it leaves: the difference against the sum of the one view, read
		// under the lock of the branch, and written under the closure's marker.
		"CREATE FUNCTION record_branch_closing_fund() RETURNS trigger LANGUAGE plpgsql AS $$",
		"IF NEW.status <> 'closed' OR OLD.status = 'closed' THEN",
		"IF NEW.purchase_fund_cash IS NULL THEN",
		"PERFORM pg_advisory_xact_lock(340251, NEW.branch_location_id::integer);",
		"SELECT coalesce(sum(effective),0) INTO balance FROM purchase_fund_ledger",
		"IF NEW.purchase_fund_cash = balance THEN",
		"VALUES (NEW.branch_location_id, 'reposicion', NEW.purchase_fund_cash - balance,",
		"'Reposición de la rendición ' || NEW.id",
		"'Devolución del fondo de la rendición ' || NEW.id",
		"PERFORM set_config('luson.closing_fund', NEW.id::text, true);",
		"PERFORM set_config('luson.closing_fund', '', true);",
		"CREATE TRIGGER record_branch_closing_fund BEFORE UPDATE ON branch_closings",
		"FOR EACH ROW EXECUTE FUNCTION record_branch_closing_fund();",

		// The admission of 048, restated whole with the closing path: the marker, the depth only a
		// trigger writer reaches, the settlement of this branch that is being closed, and its own
		// opener as the actor of the movement.
		"CREATE OR REPLACE FUNCTION admit_branch_fund_movement() RETURNS trigger LANGUAGE plpgsql AS $$",
		"closing text := nullif(current_setting('luson.closing_fund', true), '');",
		"IF NEW.kind <> 'reposicion' OR NEW.corrects_id IS NOT NULL THEN",
		"funded.status <> 'proposed'",
		"MESSAGE='The closing states the fund of a settlement it is closing of its own branch'",
		"IF pg_trigger_depth() < 2 THEN",
		"MESSAGE='The fund of a settlement is written by its closure'",
		"IF NEW.created_by_account_id <> funded.opened_by_account_id THEN",
		"MESSAGE='The fund of a settlement is stated by the settlement''s own opener'",

		// Everything of 048 that is not about the sign is restated, not rewritten: the founding, the
		// backfill, the actor of a movement of the period, the freeze, the balance and its codes.
		"MESSAGE='The founding of a branch writes no movement of another branch'",
		"xmin = pg_current_xact_id()::xid",
		"current_setting('luson.fund_backfill', true) = 'on'",
		"MESSAGE='Only the branch records its own fund movements'",
		"PERFORM assert_branch_not_frozen(NEW.branch_location_id);",
		"MESSAGE='A correction names a movement of its own branch'",
		"MESSAGE='A correction is not corrected'",
		"IF balance + effect < 0 THEN",
		"MESSAGE='The purchase fund never goes negative: '",
		// The two rules of 048 that assume a positive amount, read on the magnitude and the sign.
		"IF used + NEW.amount > abs(corrected.amount) THEN",
		"THEN -sign(corrected.amount) * NEW.amount",
		"ELSE sign(corrected.amount) * NEW.amount END",

		// The backfill arm of 048 travels with the restatement: the live branch, its own opener and
		// the branch's last closed settlement are what the marker cannot forge, and a restatement
		// that drops one of them reopens the hole 048 closed.
		"JOIN locations branch ON branch.id = settlement.branch_location_id",
		"AND settlement.branch_location_id > 1",
		"AND branch.deleted_at IS NULL",
		"AND settlement.purchase_fund_cash IS NOT NULL",
		"AND settlement.purchase_fund_cash > 0",
		"AND settlement.opened_by_account_id = NEW.created_by_account_id",
		"AND settlement.closed_at = (",
		"SELECT max(later.closed_at) FROM branch_closings later",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("051 must state %q", required)
		}
	}
	// The version settles a fund and rewrites nothing else: no table, no view, no column of the
	// settlement, no row written or deleted here, and no dependency on the purchase version that a
	// database may or may not have applied.
	for _, forbidden := range []string{
		"CREATE TABLE", "CREATE VIEW", "DROP TABLE", "DROP VIEW", "ALTER TABLE branch_closings",
		"DROP FUNCTION", "UPDATE branch_closings", "DELETE FROM", "TRUNCATE",
		"INSERT INTO branch_closings", "INSERT INTO branch_cash_movements",
		"INSERT INTO closing_", "050_",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("051 must not use %q", forbidden)
		}
	}
	// The order of the file is the order of its readers: the constraint is relaxed before the
	// trigger that writes a signed movement, and the trigger that writes it before the admission
	// that admits it.
	relaxed := strings.Index(sql, "ALTER TABLE branch_fund_movements DROP CONSTRAINT")
	writer := strings.Index(sql, "FUNCTION record_branch_closing_fund()")
	admission := strings.Index(sql, "FUNCTION admit_branch_fund_movement()")
	if relaxed < 0 || writer < 0 || admission < 0 || relaxed > writer || writer > admission {
		t.Errorf("051 must relax the amount, write the movement and then admit it: %d %d %d",
			relaxed, writer, admission)
	}
	// No new code: the identity and the provenance of a movement are LF001, the tope of a correction
	// is LF002 and the balance that never goes negative is LF003, exactly as 048 minted them.
	for _, owned := range []string{"LF001", "LF002", "LF003"} {
		if !strings.Contains(sql, "ERRCODE='"+owned+"'") {
			t.Errorf("051 must restate %s", owned)
		}
	}
	for _, foreign := range []string{"LF004", "LF005", "LF006", "LF007", "LF008", "LF009"} {
		if strings.Contains(sql, "ERRCODE='"+foreign+"'") {
			t.Errorf("051 mints no code of its own, found %s", foreign)
		}
	}
	// The decisions a reader has to be able to check without deriving them from the triggers.
	for _, documented := range []string{
		"S5", "S6", "S7", "S9", "Why", "one arithmetic", "340251", "pg_trigger_depth",
		"purchase_fund_ledger", "reposicion", "closing_fund", "036", "LC022", "044", "048",
		// A restatement is where a rule is silently lost, so 051 says which one has to travel.
		"restated by later versions", "the backfill predicates must travel with it",
	} {
		if !strings.Contains(sql, documented) {
			t.Errorf("051 must document its own decision: %s", documented)
		}
	}
}

// closingFundFixture is the prefix applied through 051: the catalogue, one account per historical
// location, the administrator of location 1, the initialization row the founding reads and the
// commission rate branch 2 needs to be settled. No stock and no balance is seeded: a branch without
// stock has an empty count sheet.
func closingFundFixture(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	return fundPrefixThrough(t, 51)
}

// settleFund walks one settlement of branch 2 to its closure with the fund it leaves, and returns
// its id: the whole state machine the guards allow (034, 044), with the purchase fund of the offer
// stated by the caller. An empty amount states no fund at all.
func settleFund(t *testing.T, ctx context.Context, p *pgxpool.Pool, purchaseFund string) int64 {
	t.Helper()
	closing := openSettlement(t, ctx, p, 2)
	proposeRound(t, ctx, p, closing, `{"fund":"100.00"}`)
	var envelope *string
	if purchaseFund != "" {
		envelope = &purchaseFund
	}
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='proposed',counted_cash=0.00,
 contributed_cash=100.00,closing_cash=100.00,purchase_fund_cash=$2::numeric WHERE id=$1`,
		closing, envelope); err != nil {
		t.Fatalf("the settlement could not be proposed: %v", err)
	}
	decideRound(t, ctx, p, closing, "accepted", "")
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='closed' WHERE id=$1`, closing); err != nil {
		t.Fatalf("the accepted round must close the settlement: %v", err)
	}
	return closing
}

// fundReposicion reads the one `reposicion` of a branch's fund and asserts there is exactly one.
func fundReposicion(t *testing.T, ctx context.Context, p *pgxpool.Pool, branch int) (int64, string,
	string, time.Time) {
	t.Helper()
	var id int64
	var amount, description string
	var at time.Time
	if err := p.QueryRow(ctx, `SELECT id,amount::text,description,occurred_at
 FROM branch_fund_movements WHERE branch_location_id=$1 AND kind='reposicion'`, branch).
		Scan(&id, &amount, &description, &at); err != nil {
		t.Fatalf("the closure must write the fund it leaves: %v", err)
	}
	return id, amount, description, at
}

// TestClosingWritesTheFundItLeaves proves S9 on a live database: the amount the settlement leaves is
// one `reposicion` of the fund's book -- the difference against what the book held, signed by the
// settlement's own opener, stamped with the instant the settlement closed -- and the balance of the
// fund after the closure is exactly that amount. A settlement that states nothing writes nothing,
// because an unstated fund is the book's own sum (S7).
func TestClosingWritesTheFundItLeaves(t *testing.T) {
	ctx, p := closingFundFixture(t)
	// The warehouse loads the fund the branch operates with: the book is the only money of the fund.
	recordFundMovement(t, ctx, p, 2, 2, "aporte", "500.00", "Carga de fondo del período")
	closing := settleFund(t, ctx, p, "300.00")
	_, amount, description, at := fundReposicion(t, ctx, p, 2)
	// The movement is the difference, not the stated amount: 300.00 stated against 500.00 held, and
	// the fund it takes back is the sign and the description of the same fact.
	if amount != "-200.00" {
		t.Fatalf("the reposicion must state the difference against the book, got %s", amount)
	}
	if !strings.Contains(description, "rendición "+fmt.Sprint(closing)) {
		t.Fatalf("the reposicion must name the settlement it comes from, got %q", description)
	}
	var closedAt time.Time
	var opener int
	if err := p.QueryRow(ctx, `SELECT closed_at,opened_by_account_id FROM branch_closings
 WHERE id=$1`, closing).Scan(&closedAt, &opener); err != nil {
		t.Fatal("the closure of the settlement could not be read")
	}
	// One instant, one transaction: the movement of the fund is a fact of the closure, so it carries
	// the instant the settlement closed and the actor that closed it.
	if !at.Equal(closedAt) {
		t.Fatalf("the fund of a closure must share its instant, got %s and %s", at, closedAt)
	}
	if opener != 1 {
		t.Fatalf("the settlement of a branch is the warehouse's, got opener %d", opener)
	}
	// The balance after the closure is the amount the settlement left, and it is read where the fund
	// is computed: the sum of the view.
	if balance := fundBalance(t, ctx, p, 2); balance != "300.00" {
		t.Fatalf("the fund after the closure must be the amount it leaves, got %s", balance)
	}
	// A settlement that states no fund states the book's own sum and writes no movement (S7).
	before := fundLedger(t, ctx, p)
	if second := settleFund(t, ctx, p, ""); second <= closing {
		t.Fatalf("the second settlement must be a new document, got %d", second)
	}
	if after := fundLedger(t, ctx, p); after != before {
		t.Fatalf("a settlement that states no fund writes no movement, got %s before %s", after, before)
	}
	t.Logf("051: the closure states the fund as the difference and the book is the amount")
}

// TestClosingFundMovementCannotBeForged proves the provenance rule on a live database: a client that
// sets the marker itself cannot write the fund of a settlement. The insert runs at trigger depth 1,
// which is the depth only a caller reaches, and the settlement the marker names must be one that is
// being closed right now by an account of no branch.
func TestClosingFundMovementCannotBeForged(t *testing.T) {
	ctx, p := closingFundFixture(t)
	recordFundMovement(t, ctx, p, 2, 2, "aporte", "500.00", "Carga de fondo del período")
	closing := settleFund(t, ctx, p, "300.00")
	before := fundLedger(t, ctx, p)
	// A client sets the marker of the settlement it has just closed and writes the fund it would
	// rather have left: the settlement no longer reads as proposed, so the shape is refused first.
	if _, err := p.Exec(ctx, `SELECT set_config('luson.closing_fund',$1::text,false)`,
		fmt.Sprint(closing)); err != nil {
		t.Fatalf("the marker could not be set: %v", err)
	}
	err := tryFundMovement(ctx, p, 2, 1, "reposicion", "900.00", "Fondo inventado")
	execRefusalMessage(t, err, "LF001",
		"The closing states the fund of a settlement it is closing of its own branch")
	// The marker of a live settlement of another branch is refused the same way: the fund of a
	// settlement is written where that settlement is, and nowhere else.
	live := openSettlement(t, ctx, p, 3)
	if _, err := p.Exec(ctx, `SELECT set_config('luson.closing_fund',$1::text,false)`,
		fmt.Sprint(live)); err != nil {
		t.Fatalf("the marker could not be set: %v", err)
	}
	err = tryFundMovement(ctx, p, 2, 2, "reposicion", "100.00", "Fondo de la sucursal vecina")
	execRefusalMessage(t, err, "LF001",
		"The closing states the fund of a settlement it is closing of its own branch")
	// A proposed settlement of the branch, written by a client statement: the depth is what refuses
	// it, because a caller's insert runs at depth 1 and only the closure of that settlement reaches 2.
	// The row states every fact the marker could name -- the branch, the proposal, the opener -- so
	// what refuses it is the provenance and nothing else.
	own := openSettlement(t, ctx, p, 2)
	proposeRound(t, ctx, p, own, `{"fund":"100.00"}`)
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='proposed',counted_cash=0.00,
 contributed_cash=100.00,closing_cash=100.00,purchase_fund_cash=300.00 WHERE id=$1`, own); err != nil {
		t.Fatalf("the settlement could not be proposed: %v", err)
	}
	if _, err := p.Exec(ctx, `SELECT set_config('luson.closing_fund',$1::text,false)`,
		fmt.Sprint(own)); err != nil {
		t.Fatalf("the marker could not be set: %v", err)
	}
	err = tryFundMovement(ctx, p, 2, 1, "reposicion", "900.00", "Fondo inventado")
	execRefusalMessage(t, err, "LF001", "The fund of a settlement is written by its closure")
	// And nothing of the fund moved through the three attempts.
	if after := fundLedger(t, ctx, p); after != before {
		t.Fatalf("a forged fund movement must write nothing, got %s before %s", after, before)
	}
	if balance := fundBalance(t, ctx, p, 2); balance != "300.00" {
		t.Fatalf("the fund must be the one the closure settled, got %s", balance)
	}
	t.Logf("051: the fund of a settlement is written by its closure and by nothing else")
}

// TestFundCorrectionAfterTheClosureAppendsItsMovement proves the append-only half of S9 on a live
// database: the fund a settlement settled is never rewritten. A correction of the `reposicion`
// appends its own row -- of a movement whose amount took money out, so the correction gives it back
// -- and the balance follows the sum while the closure's row stays exactly as it was written.
func TestFundCorrectionAfterTheClosureAppendsItsMovement(t *testing.T) {
	ctx, p := closingFundFixture(t)
	recordFundMovement(t, ctx, p, 2, 2, "aporte", "500.00", "Carga de fondo del período")
	settleFund(t, ctx, p, "300.00")
	reposicion, amount, _, _ := fundReposicion(t, ctx, p, 2)
	if amount != "-200.00" {
		t.Fatalf("the closure writes the difference against the book, got %s", amount)
	}
	before := fundLedger(t, ctx, p)
	// The surplus the warehouse took was 250.00 and not 200.00, so the fund holds 50.00 less than the
	// settlement stated: the branch appends the correction of the movement that took it.
	if err := tryFundCorrection(ctx, p, 2, 2, reposicion, "50.00",
		"Corrección del fondo devuelto en la rendición"); err != nil {
		t.Fatalf("a correction of a reposicion that took money out must be admitted: %v", err)
	}
	if balance := fundBalance(t, ctx, p, 2); balance != "250.00" {
		t.Fatalf("the balance must follow the correction, got %s", balance)
	}
	if after := fundLedger(t, ctx, p); !strings.HasPrefix(after, before) || after == before {
		t.Fatalf("a correction appends its movement and rewrites none: %q after %q", after, before)
	}
	// A correction still never exceeds the magnitude of the movement it answers, whatever its sign.
	err := tryFundCorrection(ctx, p, 2, 2, reposicion, "150.01", "De más")
	execRefusalMessage(t, err, "LF002", "A correction never exceeds the movement it corrects")
	// And the movement of the closure is still the row it was: the same amount, the same description.
	var stored string
	if err := p.QueryRow(ctx, `SELECT amount::text||':'||description FROM branch_fund_movements
 WHERE id=$1`, reposicion).Scan(&stored); err != nil {
		t.Fatal("the movement of the closure could not be read")
	}
	if !strings.HasPrefix(stored, "-200.00:Devolución del fondo de la rendición ") {
		t.Fatalf("the closure's movement must stay as it was written, got %q", stored)
	}
	t.Logf("051: a fund correction appends its movement and the balance follows")
}

// TestClosingKeepsTheBackfillRulesOf048 proves the backfill rules of 048 survive the restatement of
// 051 on a database migrated through 51: 051 replaces the fund's admission whole, so the marker of
// S12 must still open the numbers of a live branch's last closed settlement signed by that
// settlement's own opener, and nothing else. The same forged openings the 048 suite runs at the 048
// level run here against the function 051 installs, so a later restatement that drops one of these
// predicates fails this test instead of silently reopening the hole.
func TestClosingKeepsTheBackfillRulesOf048(t *testing.T) {
	ctx, p := fundPrefixThrough(t, 47)

	// Branch 2 leaves 2.000,00 in its fund and then closes again leaving nothing: its last closed
	// settlement states no fund, so the backfill must skip the branch instead of walking back to the
	// earlier settlement, whose instant the admission refuses.
	earlier, last := closeFund(t, ctx, p, 2, "2000.00"), closeFund(t, ctx, p, 2, "0.00")
	if !last.After(earlier) {
		t.Fatalf("the second closure is the branch's last one: %s after %s", last, earlier)
	}
	// A branch that is retired before 048 runs. 034 refuses a settlement of a retired branch (LC017)
	// and of the warehouse (LC002), so the numbers a forged opening for them needs are fabricated the
	// way the 048 suite fabricates them, after the versions below are applied.
	var retired int
	if err := p.QueryRow(ctx, `SELECT create_branch('Sucursal F')`).Scan(&retired); err != nil {
		t.Fatalf("the branch could not be created: %v", err)
	}
	if _, err := p.Exec(ctx, `UPDATE locations SET deleted_at=now() WHERE id=$1`, retired); err != nil {
		t.Fatalf("branch %d could not be retired: %v", retired, err)
	}

	applyMigrationFrom(t, ctx, p, 48, 51)

	// The version completed, which it could not do while walking back to the earlier settlement of
	// branch 2: the last-settlement rule reached the backfill of 048, and that branch got no opening.
	var rows int
	if err := p.QueryRow(ctx, `SELECT count(*) FROM branch_fund_movements
         WHERE branch_location_id=2`).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("a branch whose last settlement left nothing gets no opening, got %d %v", rows, err)
	}
	// The fabricated settlements are written with their triggers off, so 051's closure writes no
	// `reposicion` for them and the numbers a forged opening states are the settlement's own.
	retiredAt := fabricatedSettlement(t, ctx, p, retired)
	warehouseAt := fabricatedSettlement(t, ctx, p, 1)
	liveAt := fabricatedSettlement(t, ctx, p, 3)
	before := fundLedger(t, ctx, p)

	for _, forged := range []struct {
		name, message, amount string
		branch, account       int
		occurred              time.Time
	}{
		// The two holes the review found in 048, closed here against the function 051 installs: a
		// retired branch and the warehouse state no fund, so the marker cannot open one for them.
		{"a retired branch", backfillNotLast, "700.00", retired, 1, retiredAt},
		{"the warehouse", backfillNotLast, "700.00", 1, 1, warehouseAt},
		// An opening is signed by the account that opened the settlement it comes from: another
		// branch's account cannot write this one's history, even with the right numbers.
		{"another branch's account", backfillNotLast, "700.00", 3, 2, liveAt},
		// The last closed settlement is the only one the backfill reads, and the instant is how it
		// is read: the earlier settlement of branch 2 states 2.000,00 that its last closure voided.
		{"an earlier settlement", backfillNotLast, "2000.00", 2, 1, earlier},
	} {
		err := tryBackfillAs(ctx, p, forged.branch, forged.amount, forged.occurred, forged.account)
		execRefusalMessage(t, err, "LF001", forged.message)
		if after := fundLedger(t, ctx, p); after != before {
			t.Fatalf("%s must write nothing, got %s before %s", forged.name, after, before)
		}
	}
	// And the four branches the marker cannot open a fund for hold no fund at all: the refusals left
	// no row behind, which is what "writes nothing" means at the level of a book.
	for _, branch := range []int{1, 2, 3, retired} {
		if balance := fundBalance(t, ctx, p, branch); balance != "0.00" {
			t.Fatalf("branch %d states no fund it was not given, got %s", branch, balance)
		}
	}
	t.Logf("051: the backfill predicates of 048 travel with the restated admission")
}
