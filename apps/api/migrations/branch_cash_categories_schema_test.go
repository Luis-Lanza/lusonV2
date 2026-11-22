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

// migration061 is the closed list of motives of a branch expense (S2, S3, S5, S7, S8, S9): the
// seeded catalogue, the reference and the copy of the label on every expense, the optional note and
// the one refusal that states an expense without a motive (LC033). 001-060 are applied and
// checksummed, so this version is additive and rewrites no row.
const migration061 = "061_branch_cash_categories.sql"

// TestBranchCashCategoriesMigrationShape reads the embedded migration exactly as PostgreSQL
// receives it. It proves the file states the catalogue, the seed, the two columns, the optional note
// and the guard, and that it touches neither the historical rows nor the arithmetic of the drawer.
func TestBranchCashCategoriesMigrationShape(t *testing.T) {
	b, err := migrations.Files.ReadFile(migration061)
	if err != nil {
		t.Fatal("the motive migration must be embedded", err)
	}
	sql := string(b)
	for _, required := range []string{
		// The catalogue is one table of the database, global to every branch (S5): it has no branch
		// column, its label is offered exactly as it is stored and its place in the list is stated.
		"CREATE TABLE branch_cash_categories",
		"label text NOT NULL UNIQUE",
		"label = btrim(label)",
		"sort_order smallint NOT NULL UNIQUE",
		// An archived motive is never deleted and never offered again (S8).
		"retired_at timestamptz",
		"WHERE retired_at IS NULL",
		// The two facts of one expense: the reference and the copy of the label it had (S8).
		"ADD COLUMN category_id bigint REFERENCES branch_cash_categories(id)",
		"ADD COLUMN category_label text",
		"CHECK ((category_id IS NULL) = (category_label IS NULL))",
		// The note becomes optional exactly when the row names a motive (S3), and the constraint of
		// 034 is replaced under its own live name instead of guessed.
		"DROP CONSTRAINT IF EXISTS branch_cash_movements_description_check",
		"ADD CONSTRAINT branch_cash_movements_description_check",
		"char_length(btrim(description)) <= 500",
		// The one refusal, and the trigger named to fire after the three the table already carries.
		"CREATE FUNCTION admit_branch_expense_category()",
		"CREATE TRIGGER verify_branch_expense_category_before_insert BEFORE INSERT ON branch_cash_movements",
		"ERRCODE='LC033'",
		// The book publishes the motive and its copied label beside the same signed effect (S9).
		"CREATE OR REPLACE VIEW branch_cash_ledger AS",
		"movement.category_id",
		"movement.category_label",
		"branch_cash_effective(movement.kind, corrected.kind, movement.amount) AS effective",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("the motive migration must state %q", required)
		}
	}
	// Nothing is rewritten and the arithmetic of the drawer is not restated (S7, S9): the signed
	// effect, the expectation and the bound of 060 keep their bodies, and the three triggers that
	// already answer for the ledger are neither redefined nor dropped.
	for _, forbidden := range []string{
		"UPDATE branch_cash_movements",
		"DELETE FROM",
		"TRUNCATE",
		"DROP TABLE",
		"DROP COLUMN",
		"CREATE OR REPLACE FUNCTION branch_cash_effective",
		"CREATE OR REPLACE FUNCTION branch_drawer_expected",
		"CREATE OR REPLACE FUNCTION assert_branch_drawer_holds",
		"CREATE OR REPLACE FUNCTION admit_branch_cash_movement",
		"DROP TRIGGER",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("the motive migration must not %q: it is additive and the drawer is untouched", forbidden)
		}
	}
	// The eleven motives of the document, in the order the document states them (S2).
	for _, motive := range []string{
		"'Alquiler', 1", "'Internet', 2", "'Energía eléctrica', 3", "'Agua', 4", "'Limpieza', 5",
		"'Sueldos', 6", "'Transporte', 7", "'Insumos de tienda', 8", "'Mantenimiento', 9",
		"'Impuestos', 10", "'Otros gastos', 11",
	} {
		if !strings.Contains(sql, motive) {
			t.Errorf("the seed must state the motive %q", motive)
		}
	}
	for _, documented := range []string{"S2", "S3", "S5", "S7", "S8", "S9"} {
		if !strings.Contains(sql, documented) {
			t.Errorf("the motive migration must document %s", documented)
		}
	}
}

// categoryDB applies the whole settlement chain through 061 and provisions the three known
// locations with one account each. Nothing is closed, so the drawer of a branch inherits nothing and
// the bound of 060 is what the tests below decide with a contribution.
func categoryDB(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	applyMigrationRange(t, ctx, p, 61)
	seedPrefixCatalog(t, ctx, p)
	if _, err := p.Exec(ctx, `INSERT INTO auth_accounts(location_id,username,password_hash)
 VALUES(1,'almacen','x'),(2,'sucursal_a','x'),(3,'sucursal_b','x')`); err != nil {
		t.Fatal("the accounts could not be provisioned")
	}
	return ctx, p
}

// applyCategoryMigration applies the file of this delivery alone, so a test can write the rows of
// the previous schema and then upgrade them.
func applyCategoryMigration(t *testing.T, ctx context.Context, p *pgxpool.Pool) {
	t.Helper()
	b, err := migrations.Files.ReadFile(migration061)
	if err != nil {
		t.Fatal("the motive migration must be embedded", err)
	}
	if _, err := p.Exec(ctx, string(b)); err != nil {
		t.Fatalf("the motive migration must apply on the schema of 060: %v", err)
	}
}

// tryCategoryMovement writes one movement as a caller would -- the branch it names, its kind, amount,
// description and the motive it states, nil when it states none -- and returns the error instead of
// asserting, so the same call is used where the row must be admitted and where it must be refused.
func tryCategoryMovement(ctx context.Context, p *pgxpool.Pool, branch, account int,
	kind, amount, description string, motive *int64) error {
	_, err := p.Exec(ctx, `INSERT INTO branch_cash_movements(branch_location_id,kind,amount,
 description,category_id,created_by_account_id) VALUES($1::smallint,$2,$3::numeric,$4,$5,$6::integer)`,
		branch, kind, amount, description, motive, account)
	return err
}

// motiveOf reads the id of one motive by its label, so a test names the list the way the screen does
// and never guesses an identity value.
func motiveOf(t *testing.T, ctx context.Context, p *pgxpool.Pool, label string) int64 {
	t.Helper()
	var id int64
	if err := p.QueryRow(ctx, `SELECT id FROM branch_cash_categories WHERE label=$1`, label).Scan(&id); err != nil {
		t.Fatalf("the motive %q must be seeded: %v", label, err)
	}
	return id
}

// categoryRows reads how many movements the ledger holds, so "writes nothing" is one number.
func categoryRows(t *testing.T, ctx context.Context, p *pgxpool.Pool) string {
	t.Helper()
	var rows string
	if err := p.QueryRow(ctx, `SELECT coalesce(jsonb_agg(to_jsonb(movement) ORDER BY movement.id),
  '[]'::jsonb)::text FROM branch_cash_movements movement`).Scan(&rows); err != nil {
		t.Fatal("the ledger could not be read")
	}
	return rows
}

// TestBranchCashCategoriesAreTheSeededList proves S2 and S5 on a live database: the list is seeded
// with exactly the eleven motives of the document, in their order, all of them offered and global to
// every branch -- the table states no branch at all.
func TestBranchCashCategoriesAreTheSeededList(t *testing.T) {
	ctx, p := categoryDB(t)

	type row struct {
		label string
		order int
	}
	want := []row{
		{"Alquiler", 1}, {"Internet", 2}, {"Energía eléctrica", 3}, {"Agua", 4}, {"Limpieza", 5},
		{"Sueldos", 6}, {"Transporte", 7}, {"Insumos de tienda", 8}, {"Mantenimiento", 9},
		{"Impuestos", 10}, {"Otros gastos", 11},
	}
	rows, err := p.Query(ctx, `SELECT label,sort_order FROM branch_cash_categories
 ORDER BY sort_order,label`)
	if err != nil {
		t.Fatal("the seeded motives could not be read")
	}
	defer rows.Close()
	got := make([]row, 0, len(want))
	for rows.Next() {
		var value row
		if rows.Scan(&value.label, &value.order) != nil {
			t.Fatal("a seeded motive could not be read")
		}
		got = append(got, value)
	}
	if rows.Err() != nil {
		t.Fatal("the seeded motives could not be read")
	}
	if len(got) != len(want) {
		t.Fatalf("the seed states %d motives, want %d: %+v", len(got), len(want), got)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("the seed must be the document's list in order: got %+v want %+v", got, want)
		}
	}
	// Every seeded motive is offered (S2) and the catalogue belongs to no branch (S5).
	var retired, branchColumns int64
	if err := p.QueryRow(ctx, `SELECT count(*) FROM branch_cash_categories
 WHERE retired_at IS NOT NULL`).Scan(&retired); err != nil {
		t.Fatal("the catalogue could not be read")
	}
	if err := p.QueryRow(ctx, `SELECT count(*) FROM information_schema.columns
 WHERE table_name='branch_cash_categories' AND column_name LIKE 'branch%'`).Scan(&branchColumns); err != nil {
		t.Fatal("the shape of the catalogue could not be read")
	}
	if retired != 0 {
		t.Fatalf("every seeded motive must be offered, %d are archived", retired)
	}
	if branchColumns != 0 {
		t.Fatalf("the catalogue is global and states no branch, %d branch columns found", branchColumns)
	}
	// The read of the screen is the active motives in the order of the list, and "Otros gastos" is
	// the last of them: it is the escape valve and it goes last (S2).
	var last string
	if err := p.QueryRow(ctx, `SELECT label FROM branch_cash_categories
 WHERE retired_at IS NULL ORDER BY sort_order DESC,label DESC LIMIT 1`).Scan(&last); err != nil || last != "Otros gastos" {
		t.Fatalf("the escape valve must be the last motive, got %q (%v)", last, err)
	}
}

// TestExpenseRequiresAnOfferedMotive proves S3 and S5 on a live database: an expense states a motive
// of the list, the motive exists and is still offered, and no other kind states one. Every refusal is
// LC033 and writes nothing.
func TestExpenseRequiresAnOfferedMotive(t *testing.T) {
	ctx, p := categoryDB(t)

	// The till holds what one contribution put in it, so the bound of 060 is never what answers the
	// rows below: the motive is the only fact under test.
	if err := tryCategoryMovement(ctx, p, 2, 2, "aporte", "100.00", "Fondo de la caja", nil); err != nil {
		t.Fatalf("a contribution states no motive and must be admitted (S3): %v", err)
	}
	before := categoryRows(t, ctx, p)
	alquiler := motiveOf(t, ctx, p, "Alquiler")
	unknown := int64(999999)

	// An expense without a motive is not recorded (S3).
	err := tryCategoryMovement(ctx, p, 2, 2, "gasto", "10.00", "Flete", nil)
	execRefusalMessage(t, err, "LC033", "An expense states a motive of the drawer")
	// A motive the list does not offer is not an option of the screen, and neither is one archived:
	// both answers name the same fact, because neither can be picked.
	err = tryCategoryMovement(ctx, p, 2, 2, "gasto", "10.00", "Flete", &unknown)
	execRefusalMessage(t, err, "LC033", "The motive of this expense is unknown or archived")
	if _, err := p.Exec(ctx, `UPDATE branch_cash_categories SET retired_at=now() WHERE id=$1`,
		alquiler); err != nil {
		t.Fatalf("a motive must be archivable: %v", err)
	}
	err = tryCategoryMovement(ctx, p, 2, 2, "gasto", "10.00", "Flete", &alquiler)
	execRefusalMessage(t, err, "LC033", "The motive of this expense is unknown or archived")
	// Only an expense states a motive (S3): a contribution, a collection and a correction of a
	// movement name none, and neither do the transfers a settlement writes.
	internet := motiveOf(t, ctx, p, "Internet")
	for _, kind := range []string{"aporte", "recaudacion"} {
		err := tryCategoryMovement(ctx, p, 2, 2, kind, "1.00", "Movimiento con motivo", &internet)
		execRefusalMessage(t, err, "LC033", "Only an expense states a motive of the drawer")
	}
	if after := categoryRows(t, ctx, p); after != before {
		t.Fatalf("a refused expense writes nothing (S3): %s before %s", before, after)
	}
	// An offered motive is admitted and the row is the one the caller stated.
	if err := tryCategoryMovement(ctx, p, 2, 2, "gasto", "10.00", "Flete", &internet); err != nil {
		t.Fatalf("an expense with an offered motive must be admitted (S3): %v", err)
	}
	if after := categoryRows(t, ctx, p); after == before {
		t.Fatal("the admitted expense is a row of the ledger")
	}
}

// TestExpenseKeepsTheLabelItWasRecordedWith proves S8 on a live database: the row keeps a copy of the
// label the motive had when it was written, so renaming the motive never rewrites the past, and the
// book publishes the copy beside the reference. Archiving a motive stops it from being offered and
// from being admissible again, and the rows that already name it stay exactly as they are.
func TestExpenseKeepsTheLabelItWasRecordedWith(t *testing.T) {
	ctx, p := categoryDB(t)

	if err := tryCategoryMovement(ctx, p, 2, 2, "aporte", "100.00", "Fondo de la caja", nil); err != nil {
		t.Fatalf("the contribution must be admitted: %v", err)
	}
	limpieza := motiveOf(t, ctx, p, "Limpieza")
	var id int64
	if err := p.QueryRow(ctx, `INSERT INTO branch_cash_movements(branch_location_id,kind,amount,
 description,category_id,created_by_account_id) VALUES(2,'gasto',25.00,'Detergente y escobas',$1,2)
 RETURNING id`, limpieza).Scan(&id); err != nil {
		t.Fatalf("the expense must be admitted: %v", err)
	}
	var motive, label string
	if err := p.QueryRow(ctx, `SELECT category_id::text,category_label FROM branch_cash_ledger
 WHERE id=$1`, id).Scan(&motive, &label); err != nil {
		t.Fatalf("the book must publish the motive of the row: %v", err)
	}
	if label != "Limpieza" {
		t.Fatalf("the book must publish the label of the motive, got %q", label)
	}
	// The copy is the database's and never a caller value: a row that states its own label gets the
	// motive's one, because the guard writes it and nothing else does.
	var stated string
	if err := p.QueryRow(ctx, `INSERT INTO branch_cash_movements(branch_location_id,kind,amount,
 description,category_id,category_label,created_by_account_id)
 VALUES(2,'gasto',1.00,'Flete',$1,'Un motivo inventado',2) RETURNING category_label`,
		limpieza).Scan(&stated); err != nil {
		t.Fatalf("the expense must be admitted: %v", err)
	}
	if stated != "Limpieza" {
		t.Fatalf("the copy of the label is the motive's own, got %q", stated)
	}
	// Renaming the motive (the vertical of the administrator) never rewrites the rows already
	// recorded: the book keeps telling the same story (S8).
	if _, err := p.Exec(ctx, `UPDATE branch_cash_categories SET label='Limpieza y aseo' WHERE id=$1`,
		limpieza); err != nil {
		t.Fatalf("a motive must be renameable: %v", err)
	}
	var recorded string
	if err := p.QueryRow(ctx, `SELECT category_label FROM branch_cash_ledger WHERE id=$1`,
		id).Scan(&recorded); err != nil || recorded != "Limpieza" {
		t.Fatalf("the recorded expense keeps the label it was recorded with, got %q (%v)", recorded, err)
	}
	// Archiving it stops the screen from offering it and stops it from being admissible again, and
	// the expense that already names it is untouched (S7).
	if _, err := p.Exec(ctx, `UPDATE branch_cash_categories SET retired_at=now() WHERE id=$1`,
		limpieza); err != nil {
		t.Fatalf("a motive must be archivable: %v", err)
	}
	var offered int64
	if err := p.QueryRow(ctx, `SELECT count(*) FROM branch_cash_categories
 WHERE retired_at IS NULL AND id=$1`, limpieza).Scan(&offered); err != nil || offered != 0 {
		t.Fatalf("an archived motive is no longer offered, got %d (%v)", offered, err)
	}
	err := tryCategoryMovement(ctx, p, 2, 2, "gasto", "1.00", "Otro flete", &limpieza)
	execRefusalMessage(t, err, "LC033", "The motive of this expense is unknown or archived")
	if err := p.QueryRow(ctx, `SELECT category_label FROM branch_cash_ledger WHERE id=$1`,
		id).Scan(&recorded); err != nil || recorded != "Limpieza" {
		t.Fatalf("archiving a motive never rewrites the expense that names it, got %q (%v)", recorded, err)
	}
}

// TestExpenseNoteIsOptionalOnlyWithAMotive proves S3 on the note: an expense may state no note at all
// when it names a motive, and the note keeps the bound it always had. A kind that is not an expense
// still says what it is for, because a row that names no motive has nothing else to say.
func TestExpenseNoteIsOptionalOnlyWithAMotive(t *testing.T) {
	ctx, p := categoryDB(t)

	if err := tryCategoryMovement(ctx, p, 2, 2, "aporte", "100.00", "Fondo de la caja", nil); err != nil {
		t.Fatalf("the contribution must be admitted: %v", err)
	}
	agua := motiveOf(t, ctx, p, "Agua")
	// The note of an expense is optional and the empty one is stored exactly as it is stated.
	var note string
	if err := p.QueryRow(ctx, `INSERT INTO branch_cash_movements(branch_location_id,kind,amount,
 description,category_id,created_by_account_id) VALUES(2,'gasto',10.00,'',$1,2)
 RETURNING description`, agua).Scan(&note); err != nil {
		t.Fatalf("an expense without a note must be admitted when it names a motive (S3): %v", err)
	}
	if note != "" {
		t.Fatalf("the note of the row is empty, got %q", note)
	}
	// The note keeps its bound: 500 characters are admitted and 501 are not, exactly as before.
	if err := tryCategoryMovement(ctx, p, 2, 2, "gasto", "1.00", strings.Repeat("ñ", 500), &agua); err != nil {
		t.Fatalf("a note of 500 characters must be admitted: %v", err)
	}
	err := tryCategoryMovement(ctx, p, 2, 2, "gasto", "1.00", strings.Repeat("ñ", 501), &agua)
	execRefusal(t, err, "23514")
	// A kind that is not an expense still says what it is for: the empty text is only admissible
	// where a motive states the fact (S3).
	err = tryCategoryMovement(ctx, p, 2, 2, "aporte", "1.00", "", nil)
	execRefusal(t, err, "23514")
	err = tryCategoryMovement(ctx, p, 2, 2, "recaudacion", "1.00", "   ", nil)
	execRefusal(t, err, "23514")
}

// TestExpenseOnAFrozenPeriodRefusesTheFreeze proves the precedence of the guard: it is the last of the
// four BEFORE INSERT triggers of the table, so an empty drawer answers LC032 and a frozen branch
// answers LC001 before the motive is ever read -- a refusal of this delivery never masks the reason
// an older rule already stated (060 S5, this delivery S3).
func TestExpenseOnAFrozenPeriodRefusesTheFreeze(t *testing.T) {
	ctx, p := categoryDB(t)
	internet := motiveOf(t, ctx, p, "Internet")

	// An empty drawer refuses the expense before the motive is read (LC032, 060).
	err := tryCategoryMovement(ctx, p, 2, 2, "gasto", "10.00", "Flete", &internet)
	execRefusalMessage(t, err, "LC032", "The drawer does not hold the cash of this movement")
	// Funded, the expense would be admitted; frozen, the freeze answers first (LC001) with or without
	// a motive.
	if err := tryCategoryMovement(ctx, p, 2, 2, "aporte", "100.00", "Fondo de la caja", nil); err != nil {
		t.Fatalf("the contribution must be admitted: %v", err)
	}
	openSettlement(t, ctx, p, 2)
	err = tryCategoryMovement(ctx, p, 2, 2, "gasto", "10.00", "Flete", &internet)
	execRefusalMessage(t, err, "LC001", "The branch has an open account settlement and cannot operate")
	err = tryCategoryMovement(ctx, p, 2, 2, "gasto", "10.00", "Flete", nil)
	execRefusalMessage(t, err, "LC001", "The branch has an open account settlement and cannot operate")
}

// TestDrawerArithmeticIgnoresTheMotive proves S9 on a live database: the signed effect of a row is the
// direction of its kind and never the motive it names, so two expenses of the same amount under
// different motives move the drawer by the same money, and the motive neither signs nor bounds.
func TestDrawerArithmeticIgnoresTheMotive(t *testing.T) {
	ctx, p := categoryDB(t)

	if err := tryCategoryMovement(ctx, p, 2, 2, "aporte", "100.00", "Fondo de la caja", nil); err != nil {
		t.Fatalf("the contribution must be admitted: %v", err)
	}
	alquiler, transporte := motiveOf(t, ctx, p, "Alquiler"), motiveOf(t, ctx, p, "Transporte")
	for _, motive := range []int64{alquiler, transporte} {
		if err := tryCategoryMovement(ctx, p, 2, 2, "gasto", "20.00", "Gasto de la tienda", &motive); err != nil {
			t.Fatalf("the expense must be admitted: %v", err)
		}
	}
	var effects string
	if err := p.QueryRow(ctx, `SELECT string_agg(effective::text,',' ORDER BY id)
 FROM branch_cash_ledger WHERE kind='gasto'`).Scan(&effects); err != nil {
		t.Fatal("the signed effect of the expenses could not be read")
	}
	if effects != "-20.00,-20.00" {
		t.Fatalf("the motive signs nothing: each expense moves -20.00, got %q", effects)
	}
	// The expectation is the three terms 060 states, and the motive is not a fourth (S9).
	var expected string
	if err := p.QueryRow(ctx, `SELECT branch_drawer_expected(2::smallint)::text`).Scan(&expected); err != nil {
		t.Fatalf("the drawer could not be read: %v", err)
	}
	if expected != "60.00" {
		t.Fatalf("100.00 in and two expenses of 20.00 out is 60.00, got %q", expected)
	}
	// The bound of 060 still counts every pay-out of the drawer whatever motive it names.
	err := tryCategoryMovement(ctx, p, 2, 2, "gasto", "60.01", "Gasto sin respaldo", &alquiler)
	execRefusalMessage(t, err, "LC032", "The drawer does not hold the cash of this movement")
}

// TestHistoricalExpensesSurviveTheMigration proves S7 on a live database: the rows recorded before
// this delivery keep their free text and their instant, the migration rewrites none of them, they
// read with no motive and no copied label, the signed effect of each one is unchanged (S9), and the
// immutability guard of the ledger still refuses to update or delete them.
func TestHistoricalExpensesSurviveTheMigration(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	applyMigrationRange(t, ctx, p, 60)
	seedPrefixCatalog(t, ctx, p)
	if _, err := p.Exec(ctx, `INSERT INTO auth_accounts(location_id,username,password_hash)
 VALUES(1,'almacen','x'),(2,'sucursal_a','x'),(3,'sucursal_b','x')`); err != nil {
		t.Fatal("the accounts could not be provisioned")
	}
	// Two rows of the schema of 060: the free text of an expense and a contribution, recorded before
	// any motive existed.
	for _, movement := range []struct{ kind, amount, description string }{
		{"aporte", "100.00", "Fondo de la caja"},
		{"gasto", "45.50", "Flete del mes"},
	} {
		if err := tryExpense(ctx, p, 2, 2, movement.kind, movement.amount, movement.description); err != nil {
			t.Fatalf("the row of the previous schema must be admitted: %v", err)
		}
	}
	before := cashLedger(t, ctx, p)

	applyCategoryMigration(t, ctx, p)

	// The migration rewrites nothing: the ledger of the branch is the same value it was.
	if after := cashLedger(t, ctx, p); after != before {
		t.Fatalf("the motive migration must not rewrite a row (S7): %q before, %q after", before, after)
	}
	// Every row recorded before this delivery still reads with no motive and no copied label, and its
	// signed effect is the direction of its kind, exactly as 060 stated it (S9).
	rows, err := p.Query(ctx, `SELECT kind,description,category_id,category_label,effective::text
 FROM branch_cash_ledger WHERE branch_location_id=2 ORDER BY id`)
	if err != nil {
		t.Fatal("the book of the branch could not be read")
	}
	defer rows.Close()
	type entry struct{ kind, description, effective string }
	book := make([]entry, 0, 2)
	for rows.Next() {
		var kind, description, effective string
		var motive, label *string
		if rows.Scan(&kind, &description, &motive, &label, &effective) != nil {
			t.Fatal("a row of the book could not be read")
		}
		if motive != nil || label != nil {
			t.Fatalf("a historical row names no motive, got %v %v", motive, label)
		}
		book = append(book, entry{kind, description, effective})
	}
	if rows.Err() != nil {
		t.Fatal("the book of the branch could not be read")
	}
	want := []entry{{"aporte", "Fondo de la caja", "100.00"}, {"gasto", "Flete del mes", "-45.50"}}
	if len(book) != len(want) || book[0] != want[0] || book[1] != want[1] {
		t.Fatalf("the historical book must read exactly as it did: got %+v want %+v", book, want)
	}
	// The immutability guard of the ledger is untouched (S7): a row is still never edited and never
	// deleted, and the two new columns are no hole in it.
	var id int64
	if err := p.QueryRow(ctx, `SELECT id FROM branch_cash_movements ORDER BY id DESC LIMIT 1`).Scan(&id); err != nil {
		t.Fatal("the last movement could not be read")
	}
	for _, statement := range []string{
		`UPDATE branch_cash_movements SET description='Otra cosa' WHERE id=$1`,
		`UPDATE branch_cash_movements SET category_id=1 WHERE id=$1`,
		`DELETE FROM branch_cash_movements WHERE id=$1`,
	} {
		_, err := p.Exec(ctx, statement, id)
		execRefusal(t, err, "P0001")
	}
	// The new rule governs what is written from now on, over the same history: an expense of the new
	// schema states a motive, and the historical one keeps saying what it said.
	err = tryCategoryMovement(ctx, p, 2, 2, "gasto", "4.50", "Flete de hoy", nil)
	execRefusalMessage(t, err, "LC033", "An expense states a motive of the drawer")
	if after := cashLedger(t, ctx, p); after != before {
		t.Fatalf("a refused expense writes nothing: %q before, %q after", before, after)
	}
}

// TestCategoryCatalogueShape proves the constraints of the catalogue itself: the label is offered
// exactly as it is stored and says something, the place of a motive in the list is stated and
// unique, and a reference never travels without the copy of the label it had.
func TestCategoryCatalogueShape(t *testing.T) {
	ctx, p := categoryDB(t)

	// A blank label and a padded one are not options of the screen: what the catalogue stores is
	// what the branch reads.
	for _, label := range []string{"", "   ", " Alquiler"} {
		_, err := p.Exec(ctx, `INSERT INTO branch_cash_categories(label,sort_order) VALUES($1,99)`, label)
		execRefusal(t, err, "23514")
	}
	// Two motives of the list never share a label nor a place.
	if _, err := p.Exec(ctx, `INSERT INTO branch_cash_categories(label,sort_order)
 VALUES('Alquiler',98)`); err == nil {
		t.Fatal("two motives must not share a label")
	}
	if _, err := p.Exec(ctx, `INSERT INTO branch_cash_categories(label,sort_order)
 VALUES('Fletes',1)`); err == nil {
		t.Fatal("two motives must not share a place in the list")
	}
	// An expense names the motive and the guard writes the copy of its label: the pair always travels
	// together, so a reader of the book never sees a motive without the name it had.
	if err := tryCategoryMovement(ctx, p, 2, 2, "aporte", "10.00", "Fondo", nil); err != nil {
		t.Fatalf("the contribution must be admitted: %v", err)
	}
	agua := motiveOf(t, ctx, p, "Agua")
	if err := tryCategoryMovement(ctx, p, 2, 2, "gasto", "1.00", "Flete", &agua); err != nil {
		t.Fatalf("the expense must be admitted: %v", err)
	}
	var rows int64
	if err := p.QueryRow(ctx, `SELECT count(*) FROM branch_cash_movements
 WHERE (category_id IS NULL) <> (category_label IS NULL)`).Scan(&rows); err != nil {
		t.Fatal("the shape of the pair could not be read")
	}
	if rows != 0 {
		t.Fatalf("a reference and its label travel together, %d rows state only one", rows)
	}
}
