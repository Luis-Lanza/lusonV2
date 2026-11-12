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

// countedCashMigration is the fourth value of S16: 036 applies the deltas of a correction --
// stock, commission and fund -- and this migration adds the one it left out, the cash the
// branch counted, without touching any rule 036 owns.
const countedCashMigration = "040_closing_correction_counted_cash.sql"

// TestClosingCorrectionCountedCashSchemaStructure reads the embedded migration exactly as
// PostgreSQL receives it and asserts the contract it installs: the fourth kind of a journalled
// delta, the payload guard that admits it, and the application that writes it and nothing else
// -- no ledger row, no rewrite of the closed settlement, no second owner of the three rules of
// 036.
func TestClosingCorrectionCountedCashSchemaStructure(t *testing.T) {
	b, err := migrations.Files.ReadFile(countedCashMigration)
	if err != nil {
		t.Fatal("the counted-cash correction migration must be embedded", err)
	}
	sql := string(b)
	for _, required := range []string{
		// The journal of 036 admits one more unit, and it is money: the widened kind CHECK plus
		// the unit split that already refuses a variant and a quantity for every non-stock kind.
		"ALTER TABLE closing_correction_effects",
		"DROP CONSTRAINT closing_correction_effects_kind_check;",
		"ADD CONSTRAINT closing_correction_effects_kind_check",
		"CHECK (kind IN ('stock','commission','fund','counted_cash'));",

		// The payload guard is restated with the fourth field: the shape of a correction is
		// judged when the warehouse proposes it, so only the guard itself can admit it.
		"CREATE OR REPLACE FUNCTION guard_closing_correction_payload() RETURNS trigger LANGUAGE plpgsql AS $$",
		"IF field NOT IN ('counted_quantities','counted_cash','commission_amount','closing_cash') THEN",
		"MESSAGE='A correction states counted_quantities, counted_cash, commission_amount or closing_cash'",
		"PERFORM closing_correction_amount(NEW.payload->'counted_cash', 'counted cash');",
		// The rules of 036 that this restatement carries unchanged: the closed settlement's
		// count sheet, the unknown field, the one canonical amount and the fund bound.
		"MESSAGE='A correction has no field ' || field",
		"MESSAGE='Variant ' || variant || ' is not on the count sheet of this settlement'",
		"PERFORM closing_correction_amount(NEW.payload->'commission_amount', 'commission');",
		"MESSAGE='The corrected fund exceeds the cash counted plus the contribution by '",

		// The application: a delta against the signed drawer plus the deltas already accepted,
		// written from inside the acceptance with the provenance marker of 036's journal.
		"CREATE FUNCTION apply_closing_correction_counted_cash() RETURNS trigger LANGUAGE plpgsql AS $$",
		"CREATE TRIGGER apply_closing_correction_counted_cash AFTER UPDATE ON closing_corrections",
		"IF OLD.status <> 'proposed' OR NEW.status <> 'accepted' THEN",
		"PERFORM set_config('luson.closing_correction', NEW.id::text, true);",
		"WHERE effect.closing_id = NEW.closing_id AND effect.kind = 'counted_cash';",
		"delta_amount := closing_correction_amount(NEW.payload->'counted_cash', 'counted cash')",
		"VALUES (NEW.id, NEW.closing_id, 'counted_cash', delta_amount);",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("missing %s", required)
		}
	}
	// One table is altered and no other is created: the journal of 036 is widened and nothing
	// is added beside it.
	if got := strings.Count(sql, "CREATE TABLE"); got != 0 {
		t.Errorf("the counted-cash correction adds no table, got %d", got)
	}
	if got := strings.Count(sql, "ALTER TABLE"); got != 2 {
		t.Errorf("the migration widens one CHECK with two statements, got %d", got)
	}
	for _, statement := range strings.Split(sql, "ALTER TABLE")[1:] {
		line, _, _ := strings.Cut(statement, "\n")
		if !strings.Contains(line, "closing_correction_effects") {
			t.Errorf("no other table may be altered, got ALTER TABLE%s", line)
		}
	}
	// One function is restated and one is new, with its own trigger. The three kinds of 036 keep
	// the single owner they had: neither of its functions is restated.
	if got := strings.Count(sql, "CREATE OR REPLACE FUNCTION"); got != 1 {
		t.Errorf("only the payload guard is restated, got %d functions", got)
	}
	if !strings.Contains(sql, "CREATE OR REPLACE FUNCTION guard_closing_correction_payload") {
		t.Error("the restated function must be the payload guard")
	}
	if got := strings.Count(sql, "CREATE FUNCTION"); got != 1 {
		t.Errorf("the migration installs one new function, got %d", got)
	}
	if got := strings.Count(sql, "CREATE TRIGGER"); got != 1 {
		t.Errorf("the migration installs one trigger, got %d", got)
	}
	if strings.Contains(sql, "apply_closing_correction_fund") ||
		strings.Contains(sql, "CREATE OR REPLACE FUNCTION apply_closing_correction()") {
		t.Error("the fund mechanism and the three applied kinds of 036 must stay untouched")
	}
	// PostgreSQL fires the AFTER ROW triggers of one table in name order: the counted-cash
	// application has to run after the acceptance of 036 decided it, never before.
	trigger := ""
	if _, rest, found := strings.Cut(sql, "CREATE TRIGGER "); found {
		trigger, _, _ = strings.Cut(rest, " ")
	}
	if trigger == "" {
		t.Fatal("the migration must install its trigger")
	}
	if !strings.HasPrefix(trigger, "apply_closing_correction") || !("apply_closing_correction" < trigger) {
		t.Errorf("the counted-cash application (%s) must fire after apply_closing_correction", trigger)
	}
	// Every refusal names its own fact, and the migration raises nothing of its own: the codes it
	// documents are the ones 034, 036 and its own trigger reuse.
	for _, code := range []string{"LC012", "LC013", "LC014", "LC021", "LC022", "LC023"} {
		if !strings.Contains(sql, code) {
			t.Errorf("the migration must document %s", code)
		}
	}
	// The restated guard is the only thing here that raises, and it raises exactly the two codes 036
	// owns for the shape of a correction and for the fund bound: this migration invents no code of
	// its own, so the store maps the same six facts it already maps for the closed settlement.
	for _, raised := range []string{"ERRCODE='LC021'", "ERRCODE='LC006'"} {
		if !strings.Contains(sql, raised) {
			t.Errorf("the restated guard must keep %s", raised)
		}
	}
	for _, silent := range []string{"ERRCODE='LC012'", "ERRCODE='LC013'", "ERRCODE='LC014'",
		"ERRCODE='LC022'", "ERRCODE='LC023'", "ERRCODE='LC007'"} {
		if strings.Contains(sql, silent) {
			t.Errorf("the refusal %s belongs to the helpers and triggers this migration reuses", silent)
		}
	}
	// Additive and never a second owner of the closed settlement: no settlement is rewritten or
	// reopened, the cash ledger does not grow, and the reserved stock is never moved.
	for _, forbidden := range []string{
		"UPDATE branch_closings", "INSERT INTO branch_cash_movements", "DELETE FROM",
		"SET reserved", "reserved :=", "DROP TABLE", "DROP FUNCTION", "DROP TRIGGER",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("a counted-cash correction must not rewrite another fact: %s", forbidden)
		}
	}
	// The commission keeps taking no part in any cash identity, and the drawer is not compared
	// with the fund: a difference is free to be any number (S8, S9).
	if strings.Contains(sql, "commission_amount -") || strings.Contains(sql, "- commission_amount") {
		t.Error("the commission must not participate in any cash identity")
	}
	// The mechanism is documented where the next reader looks for it, not derived from a trigger.
	for _, documented := range []string{
		"counted_cash", "closing_correction_effects", "'counted_cash'", "no ledger row",
		"S8", "S9", "S16", "S20", "LC021", "LC012", "LC022", "LC023",
	} {
		if !strings.Contains(sql, documented) {
			t.Errorf("the migration must document its own decision: %s", documented)
		}
	}
	// The ALTER comes before the function that depends on the widened kind, and the function
	// before the trigger that executes it.
	for _, pair := range [][2]string{
		{"ALTER TABLE closing_correction_effects", "CREATE OR REPLACE FUNCTION guard_closing_correction_payload"},
		{"CREATE OR REPLACE FUNCTION guard_closing_correction_payload", "CREATE FUNCTION apply_closing_correction_counted_cash"},
		{"CREATE FUNCTION apply_closing_correction_counted_cash", "CREATE TRIGGER apply_closing_correction_counted_cash"},
	} {
		first, second := strings.Index(sql, pair[0]), strings.Index(sql, pair[1])
		if first < 0 || second < 0 || first > second {
			t.Errorf("%s must be defined before %s", pair[0], pair[1])
		}
	}
}

// countedCashFixture is the settlement block applied through 040 -- the migrations of the
// vertical and the one migration this test is about -- with the catalogue, one account per
// location, the stock of branch 2 and its commission rate. It duplicates correctionFixture
// because that one stops at 036: the fourth field only exists once 040 is applied.
func countedCashFixture(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	applyMigrationRange(t, ctx, p, 40)
	seedPrefixCatalog(t, ctx, p)
	if _, err := p.Exec(ctx, `INSERT INTO auth_accounts(location_id,username,password_hash)
 VALUES(1,'almacen','x'),(2,'sucursal_a','x'),(3,'sucursal_b','x')`); err != nil {
		t.Fatal("the accounts could not be provisioned")
	}
	if _, err := p.Exec(ctx, `INSERT INTO inventory_balances(location_id,variant_id,existing,reserved)
 VALUES(2,1,10,0),(2,2,4,0)`); err != nil {
		t.Fatal("the branch stock could not be provisioned")
	}
	if _, err := p.Exec(ctx, `INSERT INTO branch_settings(branch_location_id,commission_rate_percent,updated_by_account_id)
 VALUES(2,12.50,1)`); err != nil {
		t.Fatal("the branch commission could not be configured")
	}
	return ctx, p
}

// countedCashOf is the closed settlement's own counted cash plus the deltas the branch accepted
// for the drawer: the number a reader derives, which is the whole contract of this migration.
func countedCashOf(t *testing.T, ctx context.Context, p *pgxpool.Pool, closing int64) string {
	t.Helper()
	var effective string
	if err := p.QueryRow(ctx, `SELECT (header.counted_cash+coalesce(sum(effect.amount_delta),0))::numeric(12,2)
 FROM branch_closings header
 LEFT JOIN closing_correction_effects effect
   ON effect.closing_id=header.id AND effect.kind='counted_cash'
 WHERE header.id=$1 GROUP BY header.id`, closing).Scan(&effective); err != nil {
		t.Fatalf("the effective counted cash could not be read: %v", err)
	}
	return effective
}

// TestClosingCorrectionCountedCashCorrectsTheDrawer proves the rule of this migration on a live
// database: an accepted correction of the counted cash journals its delta, the closed settlement
// keeps the drawer it was signed with -- row, count sheet and ledger byte-identical -- and no
// ledger row is written, because the drawer holds what it holds. The difference the settlement
// recorded is the corrected one as soon as it is derived from the journal.
func TestClosingCorrectionCountedCashCorrectsTheDrawer(t *testing.T) {
	ctx, p := countedCashFixture(t)
	closing := settledBranch(t, ctx, p)
	digest, stock := closedSettlement(t, ctx, p, closing), stocks(t, ctx, p)
	ledger := documents(t, ctx, p)

	// The settlement was signed with a drawer of 100 and a fund of 40, so it took 60 and its
	// difference against the expected 0 is a surplus of 100.
	if effective := countedCashOf(t, ctx, p, closing); effective != "100.00" {
		t.Fatalf("the fixture must start from the signed drawer, got %s", effective)
	}
	correction := proposeCorrection(t, ctx, p, closing, "el conteo de la caja estaba mal",
		`{"counted_cash":"120.00"}`)
	if journal := correctionEffects(t, ctx, p, closing); journal != "" {
		t.Fatalf("a proposed correction applies nothing, got %s", journal)
	}
	if err := acceptCorrection(ctx, p, correction); err != nil {
		t.Fatalf("the branch must be able to accept a counted-cash correction: %v", err)
	}
	if journal := correctionEffects(t, ctx, p, closing); journal != "counted_cash:-:20.00" {
		t.Fatalf("the drawer delta must be journalled once, got %s", journal)
	}
	// Nothing moved but the journal: the drawer holds what it holds, so no ledger row, no stock
	// and not one byte of the closed settlement changed.
	if after := documents(t, ctx, p); after != ledger {
		t.Fatalf("a counted-cash correction must not write a ledger row, got %s before %s", after, ledger)
	}
	if after := stocks(t, ctx, p); after != stock {
		t.Fatalf("a counted-cash correction must not move stock, got %s before %s", after, stock)
	}
	if after := closedSettlement(t, ctx, p, closing); after != digest {
		t.Fatalf("a counted-cash correction must not rewrite the settlement, got %s before %s", after, digest)
	}
	// The row keeps saying what the branch signed, and the derived number is the corrected one.
	var signed string
	if err := p.QueryRow(ctx, `SELECT counted_cash||':'||closing_cash||':'||status
 FROM branch_closings WHERE id=$1`, closing).Scan(&signed); err != nil ||
		signed != "100.00:40.00:closed" {
		t.Fatalf("the closed settlement must keep its signed drawer: %q %v", signed, err)
	}
	if effective := countedCashOf(t, ctx, p, closing); effective != "120.00" {
		t.Fatalf("the corrected drawer must be the signed one plus the delta, got %s", effective)
	}
	// The journal is auditable with the reason the branch accepted, and the branch is not frozen
	// by an approval.
	var audited string
	if err := p.QueryRow(ctx, `SELECT effect.kind||':'||effect.amount_delta||':'||correction.reason
 FROM closing_correction_effects effect JOIN closing_corrections correction
 ON correction.id=effect.correction_id WHERE effect.closing_id=$1`, closing).Scan(&audited); err != nil ||
		audited != "counted_cash:20.00:el conteo de la caja estaba mal" {
		t.Fatalf("the drawer delta must be auditable with its reason: %q %v", audited, err)
	}
	var blocker bool
	if err := p.QueryRow(ctx, `SELECT branch_closure_blocker(2::smallint)`).Scan(&blocker); err != nil || blocker {
		t.Fatalf("accepting a correction must not freeze the branch: %v %v", blocker, err)
	}
	t.Logf("040: an accepted counted-cash correction is journalled and rewrites nothing")
}

// TestClosingCorrectionCountedCashPayload trims the fourth field to its own shape: one canonical
// two-decimal amount written as a JSON string, never a number and never a float, a field a
// correction does not carry is refused by name, and a correction that states a drawer equal to
// the signed one applies no delta instead of applying the same difference twice.
func TestClosingCorrectionCountedCashPayload(t *testing.T) {
	ctx, p := countedCashFixture(t)
	closing := settledBranch(t, ctx, p)
	digest := closedSettlement(t, ctx, p, closing)

	for _, refused := range []struct{ payload, code, message string }{
		// A JSON number would be rounded by PostgreSQL on the way in, and the value the branch
		// accepted has to be the value that was applied, digit for digit (S20).
		{`{"counted_cash":120}`, "LC021", "not a number"},
		{`{"counted_cash":120.5}`, "LC021", "not a number"},
		{`{"counted_cash":"120.5"}`, "LC021", "two-decimal amount"},
		{`{"counted_cash":"-1.00"}`, "LC021", "two-decimal amount"},
		{`{"counted_cash":"1.234"}`, "LC021", "two-decimal amount"},
		{`{"counted_cash":"120.00","drawer":"x"}`, "LC021", "no field drawer"},
		// The count sheet, the commission and the fund keep the shape and the bound of 036.
		{`{"counted_cash":"120.00","closing_cash":"100.01"}`, "LC006", "exceeds the cash counted plus the contribution"},
	} {
		_, err := p.Exec(ctx, `INSERT INTO closing_corrections(closing_id,reason,payload,proposed_by_account_id)
 VALUES($1,'error de cierre',$2::jsonb,1)`, closing, refused.payload)
		if err == nil {
			t.Fatalf("the payload %s must be refused", refused.payload)
		}
		execRefusalMessage(t, err, refused.code, refused.message)
	}
	if after := closedSettlement(t, ctx, p, closing); after != digest {
		t.Fatalf("a refused payload must leave the settlement untouched, got %s before %s", after, digest)
	}

	// The fourth field is admitted beside the three of 036, in one correction.
	proposeCorrection(t, ctx, p, closing, "todo el cierre estaba mal",
		`{"counted_quantities":[{"variant_id":1,"counted_quantity":9}],
  "counted_cash":"120.00","commission_amount":"12.50","closing_cash":"60.00"}`)

	// Re-stating the drawer the settlement was signed with applies no delta: the base is the
	// amended count, so a correction cannot apply the same difference twice.
	var correction int64
	if err := p.QueryRow(ctx, `SELECT id FROM closing_corrections WHERE closing_id=$1`, closing).Scan(&correction); err != nil {
		t.Fatalf("the pending correction could not be read: %v", err)
	}
	if err := rejectCorrection(ctx, p, correction, "no corresponde"); err != nil {
		t.Fatalf("the branch must be able to reject it: %v", err)
	}
	repeated := proposeCorrection(t, ctx, p, closing, "la caja era la que firmé",
		`{"counted_cash":"100.00"}`)
	if err := acceptCorrection(ctx, p, repeated); err != nil {
		t.Fatalf("a correction that changes nothing must be accepted: %v", err)
	}
	if journal := correctionEffects(t, ctx, p, closing); journal != "" {
		t.Fatalf("a correction with no delta must not write a journal row, got %s", journal)
	}
	t.Logf("040: the fourth field is one canonical amount and a refused payload writes nothing")
}

// TestClosingCorrectionCountedCashKeepsTheDrawerChain proves that the two money deltas of one
// correction stay two facts: the counted cash is the drawer the branch read and the fund is the
// money the next period starts with, so a correction that states both journals both and the next
// opening inherits the fund delta alone -- never the drawer delta on top of it.
func TestClosingCorrectionCountedCashKeepsTheDrawerChain(t *testing.T) {
	ctx, p := countedCashFixture(t)
	closing := settledBranch(t, ctx, p)
	digest := closedSettlement(t, ctx, p, closing)

	correction := proposeCorrection(t, ctx, p, closing, "quedaron 120 en caja y 60 de fondo",
		`{"counted_cash":"120.00","closing_cash":"60.00"}`)
	if err := acceptCorrection(ctx, p, correction); err != nil {
		t.Fatalf("the branch must be able to accept both deltas at once: %v", err)
	}
	// The application of 036 runs first (its trigger sorts before the new one), so the fund delta is
	// journalled before the drawer delta: the two are the same decision applied to two facts, and
	// the journal states each one once.
	if journal := correctionEffects(t, ctx, p, closing); journal != "fund:-:20.00,counted_cash:-:20.00" {
		t.Fatalf("each delta must be journalled as its own fact, got %s", journal)
	}
	if after := closedSettlement(t, ctx, p, closing); after != digest {
		t.Fatalf("a correction must never rewrite the settlement, got %s before %s", after, digest)
	}
	// The drawer chain stays opening_cash(n+1) = closing_cash(n) + the fund deltas of n: the
	// counted cash is a fact of this drawer and never money of the next period.
	next := openSettlement(t, ctx, p, 2)
	var opening string
	if err := p.QueryRow(ctx, `SELECT opening_cash||':'||(period_start=(
     SELECT closed_at FROM branch_closings WHERE id=$2))::text
 FROM branch_closings WHERE id=$1`, next, closing).Scan(&opening); err != nil ||
		opening != "60.00:true" {
		t.Fatalf("the next period must inherit the corrected fund alone: %q %v", opening, err)
	}
	// Once that period started, the fund of the closed settlement is not correctable any more
	// (036, LC022) -- while the counted cash of the same settlement still is, because it moves no
	// money of the next period.
	if err := rejectCorrection(ctx, p, correction, "ya está"); err == nil {
		t.Fatal("a decided correction cannot be decided again")
	}
	late := proposeCorrection(t, ctx, p, closing, "la caja decía 130",
		`{"counted_cash":"130.00"}`)
	if err := acceptCorrection(ctx, p, late); err != nil {
		t.Fatalf("the drawer is still correctable after the next period started: %v", err)
	}
	if journal := correctionEffects(t, ctx, p, closing); journal != "fund:-:20.00,counted_cash:-:20.00,counted_cash:-:10.00" {
		t.Fatalf("the drawer delta is a difference against the corrected count, got %s", journal)
	}
	if effective := countedCashOf(t, ctx, p, closing); effective != "130.00" {
		t.Fatalf("successive drawer corrections must converge, got %s", effective)
	}
	funder := proposeCorrection(t, ctx, p, closing, "el fondo era 80",
		`{"closing_cash":"80.00"}`)
	before := correctionEffects(t, ctx, p, closing)
	err := acceptCorrection(ctx, p, funder)
	execRefusalMessage(t, err, "LC022", "before the next period starts")
	if after := correctionEffects(t, ctx, p, closing); after != before {
		t.Fatalf("a refused fund correction must apply no delta, got %s before %s", after, before)
	}
	t.Logf("040: the drawer delta never leaks into the opening cash of the next period")
}

// TestClosingCorrectionCountedCashNeedsAClosedSettlement proves the door of S16: only a closed
// settlement is corrected, and a rejected correction of the drawer changes nothing at all.
func TestClosingCorrectionCountedCashNeedsAClosedSettlement(t *testing.T) {
	ctx, p := countedCashFixture(t)
	live := openSettlement(t, ctx, p, 2)
	countAll(t, ctx, p, live, map[int]int{1: 8, 2: 4})
	digest, stock := closedSettlement(t, ctx, p, live), stocks(t, ctx, p)
	for _, payload := range []string{`{"counted_cash":"120.00"}`, `{"closing_cash":"10.00"}`} {
		_, err := p.Exec(ctx, `INSERT INTO closing_corrections(closing_id,reason,payload,proposed_by_account_id)
 VALUES($1,'todavía no cerró',$2::jsonb,1)`, live, payload)
		execRefusalMessage(t, err, "LC012", "Only a closed settlement is corrected")
	}
	if after := closedSettlement(t, ctx, p, live); after != digest {
		t.Fatalf("a refused correction must leave the settlement untouched, got %s before %s", after, digest)
	}
	if after := stocks(t, ctx, p); after != stock {
		t.Fatalf("a refused correction must not move stock, got %s before %s", after, stock)
	}

	// A rejected correction of the drawer applies nothing, keeps the settlement closed and leaves
	// room for the next round.
	closeSettlement(t, ctx, p, live, "100.00", "0.00", "40.00")
	closed := closedSettlement(t, ctx, p, live)
	ledger := documents(t, ctx, p)
	correction := proposeCorrection(t, ctx, p, live, "me equivoqué",
		`{"counted_cash":"999.00"}`)
	if err := rejectCorrection(ctx, p, correction, "la caja estaba bien"); err != nil {
		t.Fatalf("the branch must be able to reject a drawer correction: %v", err)
	}
	if journal := correctionEffects(t, ctx, p, live); journal != "" {
		t.Fatalf("a rejected correction must apply no delta, got %s", journal)
	}
	if effective := countedCashOf(t, ctx, p, live); effective != "100.00" {
		t.Fatalf("a rejected correction must not correct the drawer, got %s", effective)
	}
	if after := closedSettlement(t, ctx, p, live); after != closed {
		t.Fatalf("a rejected correction must leave the settlement untouched: %s %s", after, closed)
	}
	if after := documents(t, ctx, p); after != ledger {
		t.Fatalf("a rejected correction must write no ledger row: %s %s", after, ledger)
	}
	var state string
	if err := p.QueryRow(ctx, `SELECT status||':'||decision_reason FROM closing_corrections
 WHERE id=$1`, correction).Scan(&state); err != nil || state != "rejected:la caja estaba bien" {
		t.Fatalf("the rejection must be recorded with its reason: %q %v", state, err)
	}
	t.Logf("040: the drawer is corrected only on a closed settlement, and a rejection applies nothing")
}
