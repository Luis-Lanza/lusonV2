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

// migration046 is the ledger the branch writes for itself: a fourth kind that answers a wrong
// movement, the single reference it carries, the shape both facts are read as, the one signed
// reading of every row, and the two guards restated whole. 035 and 042 are applied and their
// checksums recorded, so nothing of them is edited: the admission and the stamp are replaced by
// name, exactly as 044 restates the transition guard of 034.
const branchCashCorrectionsMigration = "046_branch_cash_corrections.sql"

// TestBranchCashCorrectionsSchemaStructure reads the embedded migration exactly as PostgreSQL
// receives it and asserts the contract it installs: four kinds, one reference, the shape that
// ties the two, the signed view, and the two functions replaced whole. It also asserts what the
// migration must not do -- add a table, write a row, or rewrite the settlement it reads.
func TestBranchCashCorrectionsSchemaStructure(t *testing.T) {
	b, err := migrations.Files.ReadFile(branchCashCorrectionsMigration)
	if err != nil {
		t.Fatal("the cash corrections migration must be embedded", err)
	}
	sql := string(b)
	for _, required := range []string{
		// The fourth kind, and the drop by name of the inline CHECK of 034 that precedes it:
		// the column is not retyped, the constraint around it is restated.
		"DROP CONSTRAINT IF EXISTS branch_cash_movements_kind_check",
		"ADD CONSTRAINT branch_cash_movements_kind_check",
		"CHECK (kind IN ('gasto','recaudacion','aporte','correccion'))",

		// The single reference, its foreign key to the same ledger, and the shape: exactly one
		// of the two readings, so a correction always names what it answers and nothing else
		// ever names another row.
		"ADD COLUMN corrects_id bigint REFERENCES branch_cash_movements(id)",
		"ADD CONSTRAINT branch_cash_movements_correction_shape",
		"CHECK ((kind = 'correccion') = (corrects_id IS NOT NULL))",

		// The lookup that answers "what has already been corrected against this row", which is
		// the total the tope of LC031 is read against.
		"CREATE INDEX branch_cash_movements_corrects ON branch_cash_movements(corrects_id)",

		// One signed reading of every row (S13): the direction is the target's for a correction
		// and the row's own for every other kind, and the money is that direction applied.
		"CREATE VIEW branch_cash_ledger AS",
		"CASE WHEN movement.kind = 'correccion' THEN corrected.kind ELSE movement.kind END",
		"AS effect_kind",
		"THEN movement.amount ELSE -movement.amount END AS effective",
		"<> (movement.kind = 'correccion')",
		"LEFT JOIN branch_cash_movements corrected ON corrected.id = movement.corrects_id",

		// The admission, restated whole: the two paths of the ledger (a transfer of a settlement
		// and a movement of the period) and the two codes the correction adds.
		"CREATE OR REPLACE FUNCTION admit_branch_cash_movement() RETURNS trigger LANGUAGE plpgsql AS $$",
		"IF NEW.closing_id IS NOT NULL THEN",
		"IF actor.location_id <> NEW.branch_location_id THEN",
		"MESSAGE='Only the branch records its own cash movements'",
		"PERFORM assert_branch_not_frozen(NEW.branch_location_id);",
		"IF NEW.kind <> 'correccion' THEN",
		"SELECT * INTO corrected FROM branch_cash_movements WHERE id=NEW.corrects_id FOR UPDATE;",
		"ERRCODE='LC030'",
		"MESSAGE='A correction names a movement of the ledger'",
		"MESSAGE='A correction names a movement of its own branch'",
		"MESSAGE='A correction is not corrected'",
		"MESSAGE='The transfer of a settlement is corrected in the settlement'",
		"MESSAGE='A movement of a settled period is corrected in the settlement'",
		"AND closing.status = 'closed'",
		"AND corrected.occurred_at >= closing.period_start",
		"AND corrected.occurred_at < closing.cut_at",
		"ERRCODE='LC031'",
		"IF used + NEW.amount > corrected.amount THEN",
		"MESSAGE='A correction never exceeds the movement it corrects'",

		// The stamp, restated for every movement of the period instead of the expense alone.
		"CREATE OR REPLACE FUNCTION stamp_branch_expense() RETURNS trigger LANGUAGE plpgsql AS $$",
		"IF NEW.closing_id IS NULL THEN",
		"NEW.occurred_at := now();",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("the cash corrections migration must state %q", required)
		}
	}

	// Two functions and nothing else is restated: a third would mean this version rewrote a
	// guard it does not own, and a trigger of its own would mean the ledger gained a second
	// owner -- the wiring of 035 and 042 keeps calling the functions by name.
	if got := strings.Count(sql, "CREATE OR REPLACE FUNCTION"); got != 2 {
		t.Errorf("046 replaces the admission and the stamp, got %d functions", got)
	}
	if got := strings.Count(sql, "CREATE FUNCTION"); got != 0 {
		t.Errorf("046 must not install a new function, got %d", got)
	}
	if got := strings.Count(sql, "CREATE TRIGGER"); got != 0 {
		t.Errorf("046 must not install a trigger, got %d", got)
	}

	// A column, an index, a view and a constraint: this version reshapes the ledger around the
	// movement it already has, so it adds no table and never rewrites one it does not own.
	if strings.Contains(sql, "CREATE TABLE") {
		t.Error("the ledger is reshaped, not replaced: 046 must add no table")
	}
	// The settlement is read by the guard that answers S7 -- a movement inside a closed window
	// is signed in an acta -- and written by nothing here. A settlement is never recalculated
	// from the branch, so this migration must not state a single fact about one.
	for _, forbidden := range []string{
		"ALTER TABLE branch_closings", "INSERT INTO branch_closings",
		"UPDATE branch_closings", "DELETE FROM branch_closings",
		"DROP TABLE", "DELETE FROM", "TRUNCATE ", "UPDATE branch_cash_movements",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("046 writes no row and rewrites no settlement: it must not use %q", forbidden)
		}
	}

	// The column exists before the two things that read it, and the view exists before the guard
	// that is documented as the reader of the same arithmetic.
	column := strings.Index(sql, "ADD COLUMN corrects_id")
	shape := strings.Index(sql, "branch_cash_movements_correction_shape")
	view := strings.Index(sql, "CREATE VIEW branch_cash_ledger AS")
	admission := strings.Index(sql, "FUNCTION admit_branch_cash_movement()")
	if column < 0 || shape < 0 || view < 0 || admission < 0 || column > shape || column > view ||
		view > admission {
		t.Errorf("the reference comes first, then its shape, the view and the guard: %d %d %d %d",
			column, shape, view, admission)
	}
	// The codes this version adds are its own: the ledger's shape is answered by LC030 and its
	// tope by LC031, and no code of 034-045 is restated as if it were new.
	for _, owned := range []string{"LC030", "LC031"} {
		if !strings.Contains(sql, "ERRCODE='"+owned+"'") {
			t.Errorf("046 must raise %s", owned)
		}
	}
	// The two decisions a reader has to be able to check without deriving them from the trigger.
	for _, documented := range []string{
		"S2", "S5", "S6", "S7", "S13", "Why", "correccion", "effect_kind",
		"branch_cash_ledger", "035", "042", "closed",
	} {
		if !strings.Contains(sql, documented) {
			t.Errorf("046 must document its own decision: %s", documented)
		}
	}
}

// correctionsFixture is the settlement block applied through 046: the prefix catalogue, one
// account per location and the commission rate the settlement of branch 2 needs to be proposed.
// No stock, price or balance is seeded: none of the rules below reads them, and the count sheet
// of a branch without stock is empty instead of pending.
func correctionsFixture(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	applyMigrationRange(t, ctx, p, 46)
	seedPrefixCatalog(t, ctx, p)
	if _, err := p.Exec(ctx, `INSERT INTO auth_accounts(location_id,username,password_hash)
 VALUES(1,'almacen','x'),(2,'sucursal_a','x'),(3,'sucursal_b','x')`); err != nil {
		t.Fatal("the accounts could not be provisioned")
	}
	if _, err := p.Exec(ctx, `INSERT INTO branch_settings(branch_location_id,
 commission_rate_percent,updated_by_account_id) VALUES(2,12.50,1)`); err != nil {
		t.Fatal("the branch commission could not be configured")
	}
	return ctx, p
}

// recordMovement writes one movement of the period as a caller would -- the branch the row
// names, its kind, amount, description and the account that records it -- and returns the id the
// corrections of the tests below name. It fails instead of returning the error: every call of it
// is a row the domain must admit.
func recordMovement(t *testing.T, ctx context.Context, p *pgxpool.Pool, branch, account int,
	kind, amount, description string) int64 {
	t.Helper()
	var id int64
	if err := p.QueryRow(ctx, `INSERT INTO branch_cash_movements(branch_location_id,kind,amount,
 description,created_by_account_id) VALUES($1::smallint,$2,$3::numeric,$4,$5::integer)
 RETURNING id`, branch, kind, amount, description, account).Scan(&id); err != nil {
		t.Fatalf("the %s of branch %d must be admitted: %v", kind, branch, err)
	}
	return id
}

// recordCorrection writes one correction like recordMovement, returning its id.
func recordCorrection(t *testing.T, ctx context.Context, p *pgxpool.Pool, branch, account int,
	target int64, amount, description string) int64 {
	t.Helper()
	var id int64
	if err := p.QueryRow(ctx, `INSERT INTO branch_cash_movements(branch_location_id,kind,amount,
 description,created_by_account_id,corrects_id)
 VALUES($1::smallint,'correccion',$2::numeric,$3,$4::integer,$5) RETURNING id`,
		branch, amount, description, account, target).Scan(&id); err != nil {
		t.Fatalf("the correction of movement %d must be admitted: %v", target, err)
	}
	return id
}

// tryCorrection writes a correction and returns the error instead of asserting, so the same call
// is used where the row must be admitted and where it must be refused.
func tryCorrection(ctx context.Context, p *pgxpool.Pool, branch, account int, target int64,
	amount, description string) error {
	_, err := p.Exec(ctx, `INSERT INTO branch_cash_movements(branch_location_id,kind,amount,
 description,created_by_account_id,corrects_id)
 VALUES($1::smallint,'correccion',$2::numeric,$3,$4::integer,$5)`,
		branch, amount, description, account, target)
	return err
}

// TestBranchCashCorrectionsBranchWritesAporteAndRecaudacion proves S2 on a live database: the
// branch states the two facts a settlement also states -- the money the owner leaves for change
// and the money the warehouse collects -- as movements of the period, and a `closing_id` is what
// keeps them apart from the transfers of an acta (S5). The boundary of the admission is the
// actor: only an account of that branch writes its till.
func TestBranchCashCorrectionsBranchWritesAporteAndRecaudacion(t *testing.T) {
	ctx, p := correctionsFixture(t)

	// The branch records both as they happen, with no settlement of its own: the settlement that
	// covers them is the one whose window contains their instant.
	if err := tryExpense(ctx, p, 2, 2, "aporte", "50.00", "Aporte del dueño"); err != nil {
		t.Fatalf("a branch must record its own contribution (S2): %v", err)
	}
	if err := tryExpense(ctx, p, 2, 2, "recaudacion", "30.00", "Recaudación del almacén"); err != nil {
		t.Fatalf("a branch must record its own collection (S2): %v", err)
	}
	var rows string
	if err := p.QueryRow(ctx, `SELECT string_agg(kind||':'||amount||':'||description||':'
         ||(closing_id IS NULL)::text||':'||created_by_account_id,',' ORDER BY id)
         FROM branch_cash_movements WHERE branch_location_id=2`).Scan(&rows); err != nil ||
		rows != "aporte:50.00:Aporte del dueño:true:2,recaudacion:30.00:Recaudación del almacén:true:2" {
		t.Fatalf("the two movements of the period belong to no settlement: %q %v", rows, err)
	}
	before := cashLedger(t, ctx, p)

	// The boundary of the new path is the actor, and it is the same refusal 038 gave an expense:
	// another branch and the warehouse state no fact about this till.
	for _, refused := range []struct {
		name   string
		branch int
		actor  int
	}{
		{"another branch", 2, 3},
		{"the warehouse", 2, 1},
	} {
		err := tryExpense(ctx, p, refused.branch, refused.actor, "aporte", "10.00", "Ajeno")
		execRefusalMessage(t, err, "LC011", "Only the branch records its own cash movements")
		err = tryExpense(ctx, p, refused.branch, refused.actor, "recaudacion", "10.00", "Ajena")
		execRefusalMessage(t, err, "LC011", "Only the branch records its own cash movements")
		if after := cashLedger(t, ctx, p); after != before {
			t.Fatalf("%s must write nothing, got %s before %s", refused.name, after, before)
		}
	}
	// The kind of a movement of the period is one of the four: a fifth is still refused by the
	// ledger's own CHECK before any guard reads it.
	if err := tryExpense(ctx, p, 2, 2, "devolucion", "10.00", "Inventado"); err == nil {
		t.Fatal("the ledger states four kinds")
	}
	if after := cashLedger(t, ctx, p); after != before {
		t.Fatalf("an unknown kind must write nothing, got %s before %s", after, before)
	}
	t.Logf("046: the branch records its own contributions and collections of the period")
}

// TestBranchCashCorrectionsAreCappedAtTheAmountTheyCorrect proves the tope of S6: the corrections
// of one movement may be written in parts, and what refuses the excess is the total already
// written against it plus the one being written now (LC031).
func TestBranchCashCorrectionsAreCappedAtTheAmountTheyCorrect(t *testing.T) {
	ctx, p := correctionsFixture(t)
	expense := recordMovement(t, ctx, p, 2, 2, "gasto", "100.00", "Detergente")

	// The movement is corrected in two parts that add up to exactly what it stated.
	recordCorrection(t, ctx, p, 2, 2, expense, "60.00", "Detergente mal cargado")
	recordCorrection(t, ctx, p, 2, 2, expense, "40.00", "El resto")
	var corrections string
	if err := p.QueryRow(ctx, `SELECT string_agg(kind||':'||amount||':'||(corrects_id=$1)::text,','
         ORDER BY id) FROM branch_cash_movements WHERE corrects_id=$1`, expense).
		Scan(&corrections); err != nil ||
		corrections != "correccion:60.00:true,correccion:40.00:true" {
		t.Fatalf("the two corrections must both be admitted: %q %v", corrections, err)
	}
	before := cashLedger(t, ctx, p)

	// One cent more does not fit under the amount the movement stated. The refusal writes
	// nothing, and the corrected row keeps its own amount: the book is immutable.
	err := tryCorrection(ctx, p, 2, 2, expense, "0.01", "De más")
	execRefusalMessage(t, err, "LC031", "A correction never exceeds the movement it corrects")
	if after := cashLedger(t, ctx, p); after != before {
		t.Fatalf("a refused correction must write nothing, got %s before %s", after, before)
	}
	var amount string
	if err := p.QueryRow(ctx, `SELECT amount FROM branch_cash_movements WHERE id=$1`, expense).
		Scan(&amount); err != nil || amount != "100.00" {
		t.Fatalf("a correction never edits the movement it answers: %q %v", amount, err)
	}
	t.Logf("046: the corrections of one movement are capped at the amount it stated")
}

// TestBranchCashCorrectionsNameAMovementOfTheirOwnKindAndBranch proves the three refusals of
// LC030 that are answered by the target alone (S6): a correction names a movement of its own
// branch, a movement that is not a correction, and one that exists.
func TestBranchCashCorrectionsNameAMovementOfTheirOwnKindAndBranch(t *testing.T) {
	ctx, p := correctionsFixture(t)
	foreign := recordMovement(t, ctx, p, 3, 3, "gasto", "20.00", "Flete de la otra sucursal")
	expense := recordMovement(t, ctx, p, 2, 2, "gasto", "20.00", "Flete")
	correction := recordCorrection(t, ctx, p, 2, 2, expense, "5.00", "Flete mal cargado")
	before := cashLedger(t, ctx, p)

	for _, refused := range []struct {
		name    string
		target  int64
		message string
	}{
		{"a movement of another branch", foreign, "A correction names a movement of its own branch"},
		{"a correction", correction, "A correction is not corrected"},
		{"an unknown movement", 999999, "A correction names a movement of the ledger"},
	} {
		err := tryCorrection(ctx, p, 2, 2, refused.target, "1.00", "Compensación")
		execRefusalMessage(t, err, "LC030", refused.message)
		if after := cashLedger(t, ctx, p); after != before {
			t.Fatalf("%s must not be correctable, got %s before %s", refused.name, after, before)
		}
	}
	// The corrections that were admitted are still there and still name what they answer: a
	// refusal never retracts a row of somebody else's branch.
	var kept int
	if err := p.QueryRow(ctx, `SELECT count(*) FROM branch_cash_movements
         WHERE kind='correccion'`).Scan(&kept); err != nil || kept != 1 {
		t.Fatalf("a refused correction must leave the ledger as it was, got %d %v", kept, err)
	}
	t.Logf("046: a correction names a movement of its own branch that is not a correction")
}

// TestBranchCashCorrectionsLedgerSignsEveryRow proves the single signed reading of S13 on a live
// database: the view carries the direction of the row and the direction of the movement a
// correction answers, so the drawer of the period is one sum and cannot be computed twice.
func TestBranchCashCorrectionsLedgerSignsEveryRow(t *testing.T) {
	ctx, p := correctionsFixture(t)
	recordMovement(t, ctx, p, 2, 2, "gasto", "100.00", "Detergente")
	recordMovement(t, ctx, p, 2, 2, "aporte", "100.00", "Aporte del dueño")
	recordMovement(t, ctx, p, 2, 2, "recaudacion", "60.00", "Recaudación")
	expense := recordMovement(t, ctx, p, 2, 2, "gasto", "40.00", "Escobas")
	recordCorrection(t, ctx, p, 2, 2, expense, "40.00", "Escobas devueltas")

	// A `gasto` and a `recaudacion` leave the drawer, an `aporte` enters it, and a correction of a
	// `gasto` enters it: the row carries its own direction unless it answers another one.
	var signed string
	if err := p.QueryRow(ctx, `SELECT string_agg(kind||':'||effect_kind||':'||effective::text,','
         ORDER BY id) FROM branch_cash_ledger WHERE branch_location_id=2`).Scan(&signed); err != nil ||
		signed != "gasto:gasto:-100.00,aporte:aporte:100.00,recaudacion:recaudacion:-60.00,"+
			"gasto:gasto:-40.00,correccion:gasto:40.00" {
		t.Fatalf("the view must sign every row as money: %q %v", signed, err)
	}
	// And the drawer of the period is that one sum, not a second arithmetic: -100 + 100 - 60 - 40
	// + 40. A correction is not a row some readers see and others do not.
	var drawer string
	if err := p.QueryRow(ctx, `SELECT sum(effective)::text FROM branch_cash_ledger
         WHERE branch_location_id=2 AND closing_id IS NULL`).Scan(&drawer); err != nil ||
		drawer != "-60.00" {
		t.Fatalf("the drawer of the period must be one signed sum: %q %v", drawer, err)
	}
	t.Logf("046: the ledger reads every row as signed money")
}

// TestBranchCashCorrectionsShapeIsTheTablesOwnRule proves the shape of the reference at the table
// itself: a movement that is not a correction names no target, so the row that names one is
// refused by the CHECK and not by the guard.
//
// The other half of the shape -- a correction without a target -- reaches the admission before the
// CHECK is evaluated, because a row-level BEFORE trigger runs first, so it is refused with LC030
// instead of 23514. The row is refused either way and this test pins both facts: the refusal the
// caller observes and the validated CHECK that answers the same shape behind it.
func TestBranchCashCorrectionsShapeIsTheTablesOwnRule(t *testing.T) {
	ctx, p := correctionsFixture(t)
	expense := recordMovement(t, ctx, p, 2, 2, "gasto", "20.00", "Flete")
	before := cashLedger(t, ctx, p)

	// A target on a movement that is not a correction describes a cancelation nothing reads.
	err := tryCorrectionKind(ctx, p, "gasto", expense)
	execRefusalMessage(t, err, "23514", "branch_cash_movements_correction_shape")
	if after := cashLedger(t, ctx, p); after != before {
		t.Fatalf("a refused shape must write nothing, got %s before %s", after, before)
	}
	// A correction that names nothing would be money out of nowhere: the admission answers it
	// before the CHECK, with its own code.
	err = tryCorrectionKind(ctx, p, "correccion", 0)
	execRefusalMessage(t, err, "LC030", "A correction names a movement of the ledger")
	if after := cashLedger(t, ctx, p); after != before {
		t.Fatalf("a refused shape must write nothing, got %s before %s", after, before)
	}

	// The CHECK is present and validated with exactly the shape both refusals read, so a path that
	// ever reached the table without the trigger would still be refused.
	var constraint string
	if err := p.QueryRow(ctx, `SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
         JOIN pg_class t ON t.oid=c.conrelid
         WHERE t.relname='branch_cash_movements' AND c.conname='branch_cash_movements_correction_shape'
           AND c.contype='c' AND c.convalidated`).Scan(&constraint); err != nil {
		t.Fatal("the shape of the reference must be a validated CHECK of the ledger")
	}
	if !strings.Contains(constraint, "kind = 'correccion'::text") ||
		!strings.Contains(constraint, "corrects_id IS NOT NULL") {
		t.Fatalf("the shape CHECK must state both readings, got %s", constraint)
	}
	t.Logf("046: the shape of a correction is the table's own rule")
}

// tryCorrectionKind inserts one movement of the asked kind with a target, or with no target at all
// when target is 0, so a test can reach the shape of the row instead of the rules around it.
func tryCorrectionKind(ctx context.Context, p *pgxpool.Pool, kind string, target int64) error {
	var corrects any
	if target != 0 {
		corrects = target
	}
	_, err := p.Exec(ctx, `INSERT INTO branch_cash_movements(branch_location_id,kind,amount,
 description,created_by_account_id,corrects_id)
 VALUES(2,$1::text,10.00,'Forma',$2::integer,$3)`, kind, 2, corrects)
	return err
}

// TestBranchCashCorrectionsStampEveryMovementOfThePeriod proves the stamp of 042 restated for the
// whole ledger: every movement of the period carries the database's instant, so a caller cannot
// date an `aporte` or a `recaudacion` into a window that is already settled (S7), and a `gasto`
// keeps being stamped as it was before this version.
func TestBranchCashCorrectionsStampEveryMovementOfThePeriod(t *testing.T) {
	ctx, p := correctionsFixture(t)

	for _, kind := range []string{"aporte", "recaudacion", "gasto"} {
		var written time.Time
		if err := p.QueryRow(ctx, `INSERT INTO branch_cash_movements(branch_location_id,kind,amount,
 description,occurred_at,created_by_account_id)
 VALUES(2,$1::text,25.00,'Fechado a mano','2020-01-01T00:00:00Z',2) RETURNING occurred_at`,
			kind).Scan(&written); err != nil {
			t.Fatalf("the %s could not be recorded: %v", kind, err)
		}
		past := time.Date(2020, time.January, 1, 0, 0, 0, 0, time.UTC)
		if !written.After(past) {
			t.Fatalf("a %s is stamped with the instant it is written, got %s", kind, written)
		}
		if age := time.Since(written); age < 0 || age > time.Minute {
			t.Fatalf("the %s must carry the instant of its writing, got %s", kind, written)
		}
	}
	t.Logf("046: every movement of the period is stamped by the database")
}

// TestBranchCashCorrectionsRefuseAMovementOfASettledPeriod proves S7 on a live database: the
// windows of a branch's closed settlements tile its timeline, so a movement whose instant falls
// inside one of them is already signed in an acta and is corrected in the settlement, never with
// a new row of the branch's ledger (LC030).
func TestBranchCashCorrectionsRefuseAMovementOfASettledPeriod(t *testing.T) {
	ctx, p := correctionsFixture(t)
	expense := recordMovement(t, ctx, p, 2, 2, "gasto", "80.00", "Flete")
	var recorded time.Time
	if err := p.QueryRow(ctx, `SELECT occurred_at FROM branch_cash_movements WHERE id=$1`, expense).
		Scan(&recorded); err != nil {
		t.Fatal("the instant of the expense could not be read")
	}

	// The settlement of the branch is opened after the expense and closed over it, so the window
	// [period_start, cut_at) contains the instant the expense carries.
	closing := openSettlement(t, ctx, p, 2)
	closeSettlement(t, ctx, p, closing, "100.00", "20.00", "30.00")
	var start, cut time.Time
	var status string
	if err := p.QueryRow(ctx, `SELECT period_start,cut_at,status FROM branch_closings WHERE id=$1`,
		closing).Scan(&start, &cut, &status); err != nil {
		t.Fatal("the window of the settlement could not be read")
	}
	if status != "closed" || recorded.Before(start) || !recorded.Before(cut) {
		t.Fatalf("the fixture must settle the instant of the expense (%s in [%s,%s), %s)",
			recorded, start, cut, status)
	}
	before := cashLedger(t, ctx, p)

	// The branch is operating again -- the settlement is closed and no longer freezes it -- so the
	// refusal that answers is the settled window and not the freeze.
	err := tryCorrection(ctx, p, 2, 2, expense, "10.00", "Flete mal cargado")
	execRefusalMessage(t, err, "LC030", "A movement of a settled period is corrected in the settlement")
	if after := cashLedger(t, ctx, p); after != before {
		t.Fatalf("a settled period is never corrected from the branch, got %s before %s", after, before)
	}

	// A movement written after the closure is in the new period and is corrected like any other:
	// the refusal is the window, not the branch.
	next := recordMovement(t, ctx, p, 2, 2, "gasto", "25.00", "Escobas")
	recordCorrection(t, ctx, p, 2, 2, next, "25.00", "Escobas devueltas")
	t.Logf("046: a movement of a settled period is corrected in the settlement, never in the ledger")
}
