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

// migration036 is the application half of S16: 034 gives a correction its shape and its
// approval, and this migration is what an accepted correction actually does to a closed
// settlement -- the stock delta on the branch's balances, the journal of every delta it
// applied, and the fund delta the next period inherits as its opening cash.
const correctionMigration = "036_closing_corrections.sql"

// TestClosingCorrectionsSchemaStructure reads the embedded migration exactly as PostgreSQL
// receives it and asserts the contract it installs: the payload shape, the journal with its
// provenance, the application on acceptance, the fund marker the next opening reads, and no
// rewrite of the closed settlement, of the ledger or of anything of 001-035.
func TestClosingCorrectionsSchemaStructure(t *testing.T) {
	b, err := migrations.Files.ReadFile(correctionMigration)
	if err != nil {
		t.Fatal("the corrections migration must be embedded", err)
	}
	sql := string(b)
	for _, required := range []string{
		// The journal of applied deltas, with its unit split so an effect is never read as
		// the wrong quantity, and one row per delta so nothing is applied twice.
		"CREATE TABLE closing_correction_effects",
		"correction_id bigint NOT NULL REFERENCES closing_corrections(id)",
		"closing_id bigint NOT NULL REFERENCES branch_closings(id)",
		"kind text NOT NULL CHECK (kind IN ('stock','commission','fund'))",
		"variant_id integer REFERENCES catalog_variants(id)",
		"quantity_delta bigint CHECK (quantity_delta <> 0)",
		"amount_delta numeric(12,2) CHECK (amount_delta <> 0)",
		"CREATE UNIQUE INDEX closing_correction_effects_once",
		"ON closing_correction_effects(correction_id, kind, coalesce(variant_id, 0))",
		"CREATE INDEX closing_correction_effects_by_settlement",
		"ON closing_correction_effects(closing_id, kind)",

		// The provenance of the journal (R3-003 applied to the drawer): an effect is written
		// by the acceptance of its own correction, at the trigger depth only a trigger can
		// reach, and the journal is append only.
		"CREATE FUNCTION admit_closing_correction_effect() RETURNS trigger LANGUAGE plpgsql AS $$",
		"CREATE TRIGGER admit_closing_correction_effect BEFORE INSERT ON closing_correction_effects",
		"NEW.closing_id := correction.closing_id;",
		"current_setting('luson.closing_correction', true) IS DISTINCT FROM NEW.correction_id::text",
		"pg_trigger_depth() < 2",
		"MESSAGE='A correction effect is written when its correction is accepted'",
		"CREATE TRIGGER protect_closing_correction_effects BEFORE UPDATE OR DELETE ON closing_correction_effects",
		"CREATE TRIGGER protect_closing_correction_effects_truncate BEFORE TRUNCATE ON closing_correction_effects",

		// S20: one amount, one reader, canonical two decimals, and a JSON number refused
		// instead of being rounded on the way in.
		"CREATE FUNCTION closing_correction_amount(raw jsonb, field text) RETURNS numeric(12,2)",
		`'^[0-9]{1,10}\.[0-9]{2}$'`,
		"MESSAGE='The corrected ' || field || ' is a two-decimal amount, not a number'",

		// The payload shape, validated while the warehouse holds the correction: the known
		// fields only, at least one of them, whole quantities, and a variant the settlement
		// actually counted.
		"CREATE FUNCTION guard_closing_correction_payload() RETURNS trigger LANGUAGE plpgsql AS $$",
		"CREATE TRIGGER guard_closing_correction_payload BEFORE INSERT ON closing_corrections",
		"MESSAGE='A correction has no field ' || field",
		"MESSAGE='A correction states counted_quantities, commission_amount or closing_cash'",
		"MESSAGE='Variant ' || variant || ' is corrected once'",
		"MESSAGE='Variant ' || variant || ' is not on the count sheet of this settlement'",
		"MESSAGE='The corrected fund exceeds the cash counted plus the contribution by '",

		// The application: only an acceptance applies anything, it serialises with the
		// opener, it applies the stock delta in both directions and never under the
		// reservation, the commission goes to the journal only, and the fund delta is
		// recorded for the next opening or refused when that period already started.
		"CREATE FUNCTION apply_closing_correction() RETURNS trigger LANGUAGE plpgsql AS $$",
		"CREATE TRIGGER apply_closing_correction AFTER UPDATE ON closing_corrections",
		"IF OLD.status <> 'proposed' OR NEW.status <> 'accepted' THEN",
		"PERFORM pg_advisory_xact_lock(340251, header.branch_location_id::integer);",
		"PERFORM set_config('luson.closing_correction', NEW.id::text, true);",
		"delta_quantity := (entry.item->>'counted_quantity')::bigint",
		"MESSAGE='Variant ' || variant || ' would fall below the reserved stock'",
		"DO UPDATE SET existing = EXCLUDED.existing;",
		"VALUES (NEW.id, NEW.closing_id, 'commission', delta_amount);",
		"MESSAGE='The fund of a settlement is corrected before the next period starts'",
		"VALUES (NEW.id, NEW.closing_id, 'fund', delta_amount);",

		// The fund marker: the corrected fund is the opening cash of the next period, read
		// once, from the journal of the previous closed settlement.
		"CREATE FUNCTION apply_closing_correction_fund() RETURNS trigger LANGUAGE plpgsql AS $$",
		"CREATE TRIGGER apply_closing_correction_fund BEFORE INSERT ON branch_closings",
		"ORDER BY settlement.closed_at DESC LIMIT 1;",
		"WHERE effect.closing_id = previous AND effect.kind = 'fund';",
		"NEW.opening_cash := NEW.opening_cash + delta;",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("missing %s", required)
		}
	}
	// One table, five functions and six triggers: a missing one leaves a correction
	// unapplied or unguarded, and an extra one would be a second owner of the same fact.
	if got := strings.Count(sql, "CREATE TABLE"); got != 1 {
		t.Errorf("the corrections migration must add one table, got %d", got)
	}
	if got := strings.Count(sql, "CREATE FUNCTION"); got != 5 {
		t.Errorf("the corrections migration must install five functions, got %d", got)
	}
	if got := strings.Count(sql, "CREATE TRIGGER"); got != 6 {
		t.Errorf("the corrections migration must install six triggers, got %d", got)
	}
	// PostgreSQL fires the BEFORE ROW triggers of one table in name order: the payload guard
	// has to run after the admission of 034, and the fund marker after the opener of 034,
	// which is the trigger that wrote the opening cash it amends.
	for _, pair := range [][2]string{
		{"admit_closing_correction", "guard_closing_correction_payload"},
		{"admit_branch_closing", "apply_closing_correction_fund"},
	} {
		if !(pair[0] < pair[1]) {
			t.Errorf("%s must sort before %s to fire first", pair[0], pair[1])
		}
	}
	// Every refusal raises its own SQLSTATE and nothing else: the store maps the code. The
	// two that the closure already owns are reused for the same two facts.
	for _, code := range []string{"LC006", "LC007", "LC012", "LC021", "LC022", "LC023"} {
		if !strings.Contains(sql, "ERRCODE='"+code+"'") {
			t.Errorf("missing SQLSTATE %s", code)
		}
	}
	for _, code := range []string{
		"LC001", "LC002", "LC003", "LC004", "LC005", "LC008", "LC009", "LC010", "LC011",
		"LC013", "LC014", "LC015", "LC016", "LC017", "LC018", "LC019", "LC020",
	} {
		if strings.Contains(sql, "ERRCODE='"+code+"'") {
			t.Errorf("the refusal %s belongs to the shape and the guards of 034/035", code)
		}
	}
	// Additive only, and never a second owner of the closed settlement or of the ledger: no
	// settlement is rewritten or reopened, the cash ledger does not grow (one transfer of
	// each kind per settlement), and the reserved stock is never moved.
	for _, forbidden := range []string{
		"ALTER TABLE", "CREATE OR REPLACE", "DROP ", "DELETE FROM",
		"UPDATE branch_closings", "INSERT INTO branch_cash_movements",
		"SET reserved", "reserved :=",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("the corrections migration must not rewrite another fact: %s", forbidden)
		}
	}
	// Accepting a correction neither freezes nor unfreezes a branch: the freeze lives in 035
	// and this migration never consults it, it only reads the settlement's state.
	for _, forbidden := range []string{"assert_branch_not_frozen(", "branch_closure_blocker"} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("a correction must not touch the freeze: %s", forbidden)
		}
	}
	// The commission is reported and paid outside the system: it participates in no cash
	// identity here either.
	if strings.Contains(sql, "commission_amount -") || strings.Contains(sql, "- commission_amount") {
		t.Errorf("the commission must not participate in any cash identity")
	}
	// The table must exist before the trigger that guards it, and every function before the
	// trigger that executes it.
	for _, pair := range [][2]string{
		{"CREATE TABLE closing_correction_effects", "CREATE TRIGGER admit_closing_correction_effect"},
		{"CREATE FUNCTION closing_correction_amount", "CREATE FUNCTION guard_closing_correction_payload"},
		{"CREATE FUNCTION guard_closing_correction_payload", "CREATE TRIGGER guard_closing_correction_payload"},
		{"CREATE FUNCTION apply_closing_correction", "CREATE TRIGGER apply_closing_correction"},
		{"CREATE TABLE closing_correction_effects", "CREATE FUNCTION apply_closing_correction_fund"},
		{"CREATE FUNCTION apply_closing_correction_fund", "CREATE TRIGGER apply_closing_correction_fund"},
	} {
		first, second := strings.Index(sql, pair[0]), strings.Index(sql, pair[1])
		if first < 0 || second < 0 || first > second {
			t.Errorf("%s must be defined before %s", pair[0], pair[1])
		}
	}
	// The migration documents the payload it reads, the mechanism it chose for the fund and
	// why, so the next reader does not have to derive either from the triggers.
	for _, documented := range []string{
		"counted_quantities", "commission_amount", "closing_cash",
		"closing_correction_effects", "opening_cash(n+1) = closing_cash(n)",
		"never reopened", "append-only", "S5", "S9", "S10", "S16", "S20", "R3-003",
	} {
		if !strings.Contains(sql, documented) {
			t.Errorf("the migration must document its own decision: %s", documented)
		}
	}
}

// correctionFixture is the settlement block applied through 036 -- the migrations of the
// vertical and everything they read -- with the catalogue, one account per location, the
// stock of branch 2 and its commission rate. It duplicates closingFixture because that one
// stops at 035: the correction rules only exist once 036 is applied.
func correctionFixture(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	applyMigrationRange(t, ctx, p, 36)
	seedPrefixCatalog(t, ctx, p)
	if _, err := p.Exec(ctx, `INSERT INTO auth_accounts(location_id,username,password_hash)
 VALUES(1,'almacen','x'),(2,'sucursal_a','x'),(3,'sucursal_b','x')`); err != nil {
		t.Fatal("the accounts could not be provisioned")
	}
	// The branch that gets settled holds two variants, so its count sheet has two lines.
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

// settledBranch opens and closes one settlement of branch 2 over the stock the fixture
// provisioned: 8 counted of variant 1 and 4 of variant 2, an empty commission (there are no
// sales in the period), a drawer of 100 counted and a fund of 40, so the closure takes 60
// out of the till. It is the shape every correction test corrects.
func settledBranch(t *testing.T, ctx context.Context, p *pgxpool.Pool) int64 {
	t.Helper()
	closing := openSettlement(t, ctx, p, 2)
	countAll(t, ctx, p, closing, map[int]int{1: 8, 2: 4})
	closeSettlement(t, ctx, p, closing, "100.00", "0.00", "40.00")
	if stock := stocks(t, ctx, p); stock != "2:1:8:0,2:2:4:0" {
		t.Fatalf("the fixture must start from the closed stock, got %s", stock)
	}
	return closing
}

// proposeCorrection records the warehouse's correction of a closed settlement and returns
// the row it created. The payload is passed as written, so a test can propose the shapes
// the migration must refuse.
func proposeCorrection(t *testing.T, ctx context.Context, p *pgxpool.Pool,
	closing int64, reason, payload string) int64 {
	t.Helper()
	var id int64
	if err := p.QueryRow(ctx, `INSERT INTO closing_corrections(closing_id,reason,payload,proposed_by_account_id)
 VALUES($1,$2,$3::jsonb,1) RETURNING id`, closing, reason, payload).Scan(&id); err != nil {
		t.Fatalf("the correction %q could not be proposed: %v", reason, err)
	}
	return id
}

// correctionBranchAccount is the enabled account of the branch that owns the correction:
// clause $1 is the correction id and the branch is derived from it.
const correctionBranchAccount = `(SELECT account.id FROM auth_accounts account
     JOIN closing_corrections correction ON correction.id=$1
     JOIN branch_closings header ON header.id=correction.closing_id
     WHERE header.branch_location_id=account.location_id AND account.enabled)`

// acceptCorrection is the branch's approval. It returns the error instead of asserting, so
// the same call proves what is applied and what is refused.
func acceptCorrection(ctx context.Context, p *pgxpool.Pool, correction int64) error {
	_, err := p.Exec(ctx, `UPDATE closing_corrections SET status='accepted',
 decided_by_account_id=`+correctionBranchAccount+` WHERE id=$1`, correction)
	return err
}

// rejectCorrection is the branch's refusal, with the reason a rejection always states.
func rejectCorrection(ctx context.Context, p *pgxpool.Pool, correction int64, reason string) error {
	_, err := p.Exec(ctx, `UPDATE closing_corrections SET status='rejected',decision_reason=$2,
 decided_by_account_id=`+correctionBranchAccount+` WHERE id=$1`, correction, reason)
	return err
}

// correctionEffects is the journal of one settlement as one value, so a test can state
// exactly which deltas an accepted correction applied and prove that a refused one applied
// none.
func correctionEffects(t *testing.T, ctx context.Context, p *pgxpool.Pool, closing int64) string {
	t.Helper()
	var journal string
	if err := p.QueryRow(ctx, `SELECT coalesce(string_agg(kind||':'||coalesce(variant_id::text,'-')
         ||':'||coalesce(quantity_delta::text,amount_delta::text),',' ORDER BY id),'')
 FROM closing_correction_effects WHERE closing_id=$1`, closing).Scan(&journal); err != nil {
		t.Fatalf("the correction journal could not be read: %v", err)
	}
	return journal
}

// closedSettlement is the closed settlement as bytes: its row, its count sheet and its cash
// ledger, hashed. "The closed settlement is unchanged" then is one comparison instead of a
// promise about three tables, and it covers the columns a correction must never touch.
func closedSettlement(t *testing.T, ctx context.Context, p *pgxpool.Pool, closing int64) string {
	t.Helper()
	var digest string
	if err := p.QueryRow(ctx, `SELECT md5(header::text)||'/'
         ||md5(coalesce((SELECT string_agg(line::text,'|' ORDER BY line.variant_id)
             FROM closing_count_lines line WHERE line.closing_id=header.id),''))||'/'
         ||md5(coalesce((SELECT string_agg(movement::text,'|' ORDER BY movement.id)
             FROM branch_cash_movements movement WHERE movement.closing_id=header.id),''))
 FROM branch_closings header WHERE header.id=$1`, closing).Scan(&digest); err != nil {
		t.Fatalf("the closed settlement could not be read: %v", err)
	}
	return digest
}

// TestClosingCorrectionsPayloadShape proves the payload contract at the door: the migration
// accepts the three documented fields and refuses everything else while the warehouse still
// holds the correction -- an unknown field, an empty payload, a variant the settlement did
// not count, a duplicated variant, a quantity that is not a whole number, an amount that is
// a JSON number instead of a canonical two-decimal string, and a fund bigger than the drawer
// the branch counted. Every refusal writes nothing.
func TestClosingCorrectionsPayloadShape(t *testing.T) {
	ctx, p := correctionFixture(t)
	closing := settledBranch(t, ctx, p)
	digest := closedSettlement(t, ctx, p, closing)

	for _, refused := range []struct {
		payload, code, message string
	}{
		{`[]`, "LC021", "payload is an object"},
		{`{"fund":"10.00"}`, "LC021", "no field fund"},
		{`{}`, "LC021", "states counted_quantities"},
		{`{"counted_quantities":{}}`, "LC021", "array of counted quantities"},
		{`{"counted_quantities":[3]}`, "LC021", "states variant_id and counted_quantity"},
		{`{"counted_quantities":[{"variant_id":1}]}`, "LC021", "whole quantity"},
		{`{"counted_quantities":[{"variant_id":1,"counted_quantity":-1}]}`, "LC021", "whole quantity"},
		{`{"counted_quantities":[{"variant_id":1,"counted_quantity":2.5}]}`, "LC021", "whole quantity"},
		{`{"counted_quantities":[{"variant_id":1,"counted_quantity":9,"note":"x"}]}`, "LC021", "nothing else"},
		{`{"counted_quantities":[{"variant_id":0,"counted_quantity":1}]}`, "LC021", "by id"},
		// Variant 3 exists in the catalogue but this settlement never counted it: there is
		// no recorded quantity to take a difference against.
		{`{"counted_quantities":[{"variant_id":3,"counted_quantity":1}]}`, "LC021", "not on the count sheet"},
		{`{"counted_quantities":[{"variant_id":1,"counted_quantity":9},
  {"variant_id":1,"counted_quantity":10}]}`, "LC021", "Variant 1 is corrected once"},
		{`{"commission_amount":250.5}`, "LC021", "not a number"},
		{`{"commission_amount":"250.5"}`, "LC021", "two-decimal amount"},
		{`{"commission_amount":"-1.00"}`, "LC021", "two-decimal amount"},
		// The fund never exceeds what the drawer held: 100 counted and nothing contributed.
		{`{"closing_cash":"100.01"}`, "LC006", "exceeds the cash counted plus the contribution"},
	} {
		_, err := p.Exec(ctx, `INSERT INTO closing_corrections(closing_id,reason,payload,proposed_by_account_id)
 VALUES($1,'error de cierre',$2::jsonb,1)`, closing, refused.payload)
		if err == nil {
			t.Fatalf("the payload %s must be refused", refused.payload)
		}
		execRefusalMessage(t, err, refused.code, refused.message)
	}
	var corrections int
	if err := p.QueryRow(ctx, `SELECT count(*) FROM closing_corrections`).Scan(&corrections); err != nil || corrections != 0 {
		t.Fatalf("a refused payload must write nothing, got %d %v", corrections, err)
	}
	if after := closedSettlement(t, ctx, p, closing); after != digest {
		t.Fatalf("a refused payload must leave the settlement untouched, got %s before %s", after, digest)
	}

	// The documented shape is the one admitted: a corrected count, a commission and a fund
	// in one correction, which is the round the branch decides as a whole (S14).
	proposeCorrection(t, ctx, p, closing, "el conteo estaba mal",
		`{"counted_quantities":[{"variant_id":1,"counted_quantity":9}],
  "commission_amount":"12.50","closing_cash":"50.00"}`)
	t.Logf("036: the payload shape is admitted only as documented and refused before a row exists")
}

// TestClosingCorrectionsStockAppliesBothDirections proves S5 through a correction: an
// accepted stock correction moves the branch balance to the corrected quantity in both
// directions, in the same correction and across corrections, and a variant the payload does
// not name keeps the stock it had.
func TestClosingCorrectionsStockAppliesBothDirections(t *testing.T) {
	ctx, p := correctionFixture(t)
	closing := settledBranch(t, ctx, p)
	digest := closedSettlement(t, ctx, p, closing)

	// Upwards, and only for the variant the payload names.
	up := proposeCorrection(t, ctx, p, closing, "conté diez, no ocho",
		`{"counted_quantities":[{"variant_id":1,"counted_quantity":10}]}`)
	if err := acceptCorrection(ctx, p, up); err != nil {
		t.Fatalf("the branch must be able to accept a stock correction: %v", err)
	}
	if stock := stocks(t, ctx, p); stock != "2:1:10:0,2:2:4:0" {
		t.Fatalf("the correction must raise the counted variant only, got %s", stock)
	}

	// Downwards, for both variants at once. The second correction of variant 1 states 10
	// less one, so the delta is taken against the sheet as the accepted correction amended
	// it: the balance ends at the corrected quantity, not at the sheet's 8 minus the
	// corrected quantity.
	down := proposeCorrection(t, ctx, p, closing, "las dos estaban infladas",
		`{"counted_quantities":[{"variant_id":2,"counted_quantity":2},
  {"variant_id":1,"counted_quantity":9}]}`)
	if err := acceptCorrection(ctx, p, down); err != nil {
		t.Fatalf("the branch must be able to accept a downward correction: %v", err)
	}
	if stock := stocks(t, ctx, p); stock != "2:1:9:0,2:2:2:0" {
		t.Fatalf("the correction must lower both counted variants, got %s", stock)
	}
	if journal := correctionEffects(t, ctx, p, closing); journal != "stock:1:2,stock:2:-2,stock:1:-1" {
		t.Fatalf("every applied delta must be journalled once, got %s", journal)
	}

	// A correction that states what is already there applies no delta: the base is the
	// amended count, so re-stating it cannot double the difference.
	again := proposeCorrection(t, ctx, p, closing, "el nueve estaba bien",
		`{"counted_quantities":[{"variant_id":1,"counted_quantity":9}]}`)
	if err := acceptCorrection(ctx, p, again); err != nil {
		t.Fatalf("the branch must be able to accept a correction that changes nothing: %v", err)
	}
	if stock := stocks(t, ctx, p); stock != "2:1:9:0,2:2:2:0" {
		t.Fatalf("a correction with no delta must not move the stock, got %s", stock)
	}
	if journal := correctionEffects(t, ctx, p, closing); journal != "stock:1:2,stock:2:-2,stock:1:-1" {
		t.Fatalf("a correction with no delta must not write a journal row, got %s", journal)
	}

	// The closed settlement is byte-identical: no count line, no total, no fund, no ledger
	// row was rewritten, and the branch is not frozen by an approval.
	if after := closedSettlement(t, ctx, p, closing); after != digest {
		t.Fatalf("a correction must never rewrite the closed settlement, got %s before %s", after, digest)
	}
	var state string
	if err := p.QueryRow(ctx, `SELECT status||':'||counted_cash||':'||closing_cash||':'
         ||(closed_at IS NOT NULL)::text FROM branch_closings WHERE id=$1`, closing).Scan(&state); err != nil ||
		state != "closed:100.00:40.00:true" {
		t.Fatalf("the settlement must stay closed with the numbers it was signed with: %q %v", state, err)
	}
	var blocker bool
	if err := p.QueryRow(ctx, `SELECT branch_closure_blocker(2::smallint)`).Scan(&blocker); err != nil || blocker {
		t.Fatalf("accepting a correction must not freeze the branch: %v %v", blocker, err)
	}
	t.Logf("036: an accepted stock correction moves the balance both ways and rewrites nothing")
}

// TestClosingCorrectionsRefusesStockBelowReserved proves the other half of S5: an accepted
// stock correction is refused, naming the variant, when the balance it would leave is under
// the stock the branch already reserved -- and the refusal applies nothing at all.
func TestClosingCorrectionsRefusesStockBelowReserved(t *testing.T) {
	ctx, p := correctionFixture(t)
	closing := settledBranch(t, ctx, p)
	// The branch promised three units of variant 2 while it operates.
	if _, err := p.Exec(ctx, `UPDATE inventory_balances SET reserved=3
 WHERE location_id=2 AND variant_id=2`); err != nil {
		t.Fatal("the reservation could not be provisioned")
	}
	before, digest := stocks(t, ctx, p), closedSettlement(t, ctx, p, closing)

	correction := proposeCorrection(t, ctx, p, closing, "solo había una",
		`{"counted_quantities":[{"variant_id":2,"counted_quantity":1}]}`)
	err := acceptCorrection(ctx, p, correction)
	execRefusalMessage(t, err, "LC007", "Variant 2")
	if after := stocks(t, ctx, p); after != before {
		t.Fatalf("a refused correction must not move the stock, got %s before %s", before, after)
	}
	if journal := correctionEffects(t, ctx, p, closing); journal != "" {
		t.Fatalf("a refused correction must apply no delta, got %s", journal)
	}
	var status string
	if err := p.QueryRow(ctx, `SELECT status FROM closing_corrections WHERE id=$1`, correction).Scan(&status); err != nil ||
		status != "proposed" {
		t.Fatalf("a refused acceptance must leave the correction pending: %q %v", status, err)
	}
	if after := closedSettlement(t, ctx, p, closing); after != digest {
		t.Fatalf("a refused correction must leave the settlement untouched, got %s before %s", after, digest)
	}

	// The branch rejects the correction it cannot accept, and a correction that only lowers
	// the stock down to the reservation is what it can accept: it is the reservation, not the
	// sign of the delta, that refused the first one.
	if err := rejectCorrection(ctx, p, correction, "revisar"); err != nil {
		t.Fatalf("the branch must be able to reject a correction it cannot accept: %v", err)
	}
	allowed := proposeCorrection(t, ctx, p, closing, "quedaron tres",
		`{"counted_quantities":[{"variant_id":2,"counted_quantity":3}]}`)
	if err := acceptCorrection(ctx, p, allowed); err != nil {
		t.Fatalf("a correction over the reservation must be accepted: %v", err)
	}
	if stock := stocks(t, ctx, p); stock != "2:1:8:0,2:2:3:3" {
		t.Fatalf("the accepted correction must leave exactly the reservation, got %s", stock)
	}
	t.Logf("036: a correction under the reservation is refused and names the variant")
}

// TestClosingCorrectionsRejectionAppliesNothing proves S16's other half: a rejected
// correction changes nothing, keeps the settlement closed and the branch operating, and
// leaves room for the next round -- one pending correction at a time.
func TestClosingCorrectionsRejectionAppliesNothing(t *testing.T) {
	ctx, p := correctionFixture(t)
	closing := settledBranch(t, ctx, p)
	before, digest := stocks(t, ctx, p), closedSettlement(t, ctx, p, closing)

	// One single proposal contains the count, the cash and the commission (S14).
	correction := proposeCorrection(t, ctx, p, closing, "todo estaba mal",
		`{"counted_quantities":[{"variant_id":1,"counted_quantity":10}],
  "commission_amount":"30.00","closing_cash":"20.00"}`)
	// One pending at a time: the warehouse waits for the branch.
	_, err := p.Exec(ctx, `INSERT INTO closing_corrections(closing_id,reason,payload,proposed_by_account_id)
 VALUES($1,'otra','{"commission_amount":"10.00"}'::jsonb,1)`, closing)
	execRefusal(t, err, "23505")

	if err := rejectCorrection(ctx, p, correction, "no corresponde"); err != nil {
		t.Fatalf("the branch must be able to reject a correction: %v", err)
	}
	if after := stocks(t, ctx, p); after != before {
		t.Fatalf("a rejected correction must not move the stock, got %s before %s", before, after)
	}
	if journal := correctionEffects(t, ctx, p, closing); journal != "" {
		t.Fatalf("a rejected correction must apply no delta, got %s", journal)
	}
	if after := closedSettlement(t, ctx, p, closing); after != digest {
		t.Fatalf("a rejected correction must leave the settlement untouched, got %s before %s", after, digest)
	}
	var state string
	if err := p.QueryRow(ctx, `SELECT correction.status||':'||(correction.decided_at IS NOT NULL)::text
         ||':'||header.status||':'||(header.closed_at IS NOT NULL)::text
 FROM closing_corrections correction, branch_closings header
 WHERE correction.id=$1 AND header.id=correction.closing_id`, correction).Scan(&state); err != nil ||
		state != "rejected:true:closed:true" {
		t.Fatalf("a rejection must keep the settlement closed: %q %v", state, err)
	}
	var blocker bool
	if err := p.QueryRow(ctx, `SELECT branch_closure_blocker(2::smallint)`).Scan(&blocker); err != nil || blocker {
		t.Fatalf("a correction must never freeze the branch: %v %v", blocker, err)
	}

	// No limit of rounds: the next correction of the same settlement is applied normally.
	next := proposeCorrection(t, ctx, p, closing, "el conteo seguía mal",
		`{"counted_quantities":[{"variant_id":1,"counted_quantity":10}]}`)
	if err := acceptCorrection(ctx, p, next); err != nil {
		t.Fatalf("a correction after a rejection must be accepted: %v", err)
	}
	if stock := stocks(t, ctx, p); stock != "2:1:10:0,2:2:4:0" {
		t.Fatalf("the accepted correction must apply, got %s", stock)
	}
	t.Logf("036: a rejected correction applies nothing and the branch can accept the next one")
}

// TestClosingCorrectionsCommissionIsInformational proves S9 through a correction: a
// corrected commission is recorded and auditable, and it moves no till, no ledger row and no
// balance, because the commission is money settled outside the system.
func TestClosingCorrectionsCommissionIsInformational(t *testing.T) {
	ctx, p := correctionFixture(t)
	closing := settledBranch(t, ctx, p)
	before, digest := stocks(t, ctx, p), closedSettlement(t, ctx, p, closing)

	correction := proposeCorrection(t, ctx, p, closing, "la comisión era otra",
		`{"commission_amount":"250.50"}`)
	if err := acceptCorrection(ctx, p, correction); err != nil {
		t.Fatalf("the branch must be able to accept a commission correction: %v", err)
	}
	if journal := correctionEffects(t, ctx, p, closing); journal != "commission:-:250.50" {
		t.Fatalf("the corrected commission must be journalled, got %s", journal)
	}
	// Visible: the journal row is attributable to the reason the branch accepted.
	var audited string
	if err := p.QueryRow(ctx, `SELECT effect.kind||':'||effect.amount_delta||':'||correction.reason
 FROM closing_correction_effects effect JOIN closing_corrections correction
 ON correction.id=effect.correction_id WHERE effect.closing_id=$1`, closing).Scan(&audited); err != nil ||
		audited != "commission:250.50:la comisión era otra" {
		t.Fatalf("the commission delta must be auditable with its reason: %q %v", audited, err)
	}
	// The correction of a commission states the difference against the settled amount, so a
	// second one is a delta on the first.
	second := proposeCorrection(t, ctx, p, closing, "eran doscientos",
		`{"commission_amount":"200.00"}`)
	if err := acceptCorrection(ctx, p, second); err != nil {
		t.Fatalf("the branch must be able to accept a second commission correction: %v", err)
	}
	if journal := correctionEffects(t, ctx, p, closing); journal != "commission:-:250.50,commission:-:-50.50" {
		t.Fatalf("each commission correction must be a delta on the settled amount, got %s", journal)
	}
	var effective string
	if err := p.QueryRow(ctx, `SELECT commission_amount+coalesce((SELECT sum(amount_delta)
 FROM closing_correction_effects WHERE closing_id=$1 AND kind='commission'),0) FROM branch_closings
 WHERE id=$1`, closing).Scan(&effective); err != nil || effective != "200.00" {
		t.Fatalf("the effective commission must be the settled amount plus the deltas: %q %v", effective, err)
	}
	// The till and the stock are untouched: the closed settlement still states the commission
	// it settled, its ledger still has its one collection row, and no balance moved.
	if after := closedSettlement(t, ctx, p, closing); after != digest {
		t.Fatalf("a commission correction must not rewrite the settlement, got %s before %s", after, digest)
	}
	if after := stocks(t, ctx, p); after != before {
		t.Fatalf("a commission correction must not move stock, got %s before %s", before, after)
	}
	var unchanged bool
	if err := p.QueryRow(ctx, `SELECT commission_amount=0 FROM branch_closings WHERE id=$1`, closing).Scan(&unchanged); err != nil || !unchanged {
		t.Fatalf("the closed settlement keeps the commission it settled: %v %v", unchanged, err)
	}
	var movements int
	if err := p.QueryRow(ctx, `SELECT count(*) FROM branch_cash_movements WHERE closing_id=$1`,
		closing).Scan(&movements); err != nil || movements != 1 {
		t.Fatalf("a commission must never move the till, got %d %v", movements, err)
	}
	t.Logf("036: a corrected commission is journalled and moves no till")
}

// TestClosingCorrectionsFundMovesTheNextOpening proves the mechanism chosen for the fund
// delta: the corrected fund is the opening cash of the next period, so the delta is recorded
// in the journal and folded into the next opening exactly once -- the closed settlement is
// never rewritten and its ledger never grows.
func TestClosingCorrectionsFundMovesTheNextOpening(t *testing.T) {
	ctx, p := correctionFixture(t)
	closing := settledBranch(t, ctx, p)
	digest := closedSettlement(t, ctx, p, closing)
	ledger := documents(t, ctx, p)

	correction := proposeCorrection(t, ctx, p, closing, "quedaron sesenta, no cuarenta",
		`{"closing_cash":"60.00"}`)
	if err := acceptCorrection(ctx, p, correction); err != nil {
		t.Fatalf("the branch must be able to accept a fund correction: %v", err)
	}
	if journal := correctionEffects(t, ctx, p, closing); journal != "fund:-:20.00" {
		t.Fatalf("the fund delta must be journalled, got %s", journal)
	}
	if after := closedSettlement(t, ctx, p, closing); after != digest {
		t.Fatalf("a fund correction must not rewrite the settlement, got %s before %s", after, digest)
	}
	if after := documents(t, ctx, p); after != ledger {
		t.Fatalf("a fund correction must not append a ledger row, got %s before %s", ledger, after)
	}

	// The next period inherits the corrected fund: the drawer chain stays
	// opening_cash(n+1) = closing_cash(n) + the deltas the branch accepted.
	next := openSettlement(t, ctx, p, 2)
	var opening string
	if err := p.QueryRow(ctx, `SELECT current.opening_cash||':'||(current.period_start=previous.closed_at)::text
 FROM branch_closings current, branch_closings previous WHERE current.id=$1 AND previous.id=$2`,
		next, closing).Scan(&opening); err != nil || opening != "60.00:true" {
		t.Fatalf("the next period must open with the corrected fund: %q %v", opening, err)
	}

	// Exactly once: the following period inherits the fund the next settlement declares, not
	// the delta of its predecessor again.
	countAll(t, ctx, p, next, map[int]int{1: 9, 2: 2})
	closeSettlement(t, ctx, p, next, "50.00", "0.00", "10.00")
	third := openSettlement(t, ctx, p, 2)
	var inherited string
	if err := p.QueryRow(ctx, `SELECT opening_cash FROM branch_closings WHERE id=$1`, third).Scan(&inherited); err != nil ||
		inherited != "10.00" {
		t.Fatalf("the fund delta must be applied once, got %q %v", inherited, err)
	}
	t.Logf("036: the accepted fund delta becomes the opening cash of the next period, once")
}

// TestClosingCorrectionsRefusesFundAfterTheNextPeriodStarts proves the refusal that keeps the
// drawer chain coherent: once a later settlement exists, the fund of the closed one cannot be
// applied anywhere without rewriting a period that already started, so it is refused with its
// own code and applies nothing.
func TestClosingCorrectionsFundRefusesWhenTheNextPeriodStarted(t *testing.T) {
	ctx, p := correctionFixture(t)
	closing := settledBranch(t, ctx, p)
	next := openSettlement(t, ctx, p, 2)
	before := stocks(t, ctx, p)
	digest := closedSettlement(t, ctx, p, closing)

	correction := proposeCorrection(t, ctx, p, closing, "quedaron sesenta, no cuarenta",
		`{"closing_cash":"60.00"}`)
	err := acceptCorrection(ctx, p, correction)
	execRefusalMessage(t, err, "LC022", "before the next period starts")
	if journal := correctionEffects(t, ctx, p, closing); journal != "" {
		t.Fatalf("a refused fund correction must apply no delta, got %s", journal)
	}
	if after := closedSettlement(t, ctx, p, closing); after != digest {
		t.Fatalf("a refused fund correction must leave the settlement untouched, got %s before %s", after, digest)
	}
	if after := stocks(t, ctx, p); after != before {
		t.Fatalf("a refused fund correction must not move stock, got %s before %s", before, after)
	}
	// The period that already started keeps the fund it inherited: the refusal is what stops
	// the drawer from silently disagreeing with its own opening cash.
	var opening string
	if err := p.QueryRow(ctx, `SELECT opening_cash FROM branch_closings WHERE id=$1`, next).Scan(&opening); err != nil ||
		opening != "40.00" {
		t.Fatalf("the started period must keep its opening cash, got %q %v", opening, err)
	}
	var status string
	if err := p.QueryRow(ctx, `SELECT status FROM closing_corrections WHERE id=$1`, correction).Scan(&status); err != nil ||
		status != "proposed" {
		t.Fatalf("the refused correction stays pending for the branch to reject: %q %v", status, err)
	}
	t.Logf("036: a fund correction is refused once the next period started")
}

// TestClosingCorrectionsAcceptanceIsFinal proves a correction is decided once: accepting it
// twice is impossible, its payload is the warehouse's version, its journal is append only,
// and a second pending correction is refused.
func TestClosingCorrectionsAcceptanceIsFinal(t *testing.T) {
	ctx, p := correctionFixture(t)
	closing := settledBranch(t, ctx, p)
	correction := proposeCorrection(t, ctx, p, closing, "conté diez",
		`{"counted_quantities":[{"variant_id":1,"counted_quantity":10}]}`)
	if err := acceptCorrection(ctx, p, correction); err != nil {
		t.Fatalf("the branch must be able to accept the correction: %v", err)
	}
	before, journal := stocks(t, ctx, p), correctionEffects(t, ctx, p, closing)

	// A decided correction is final: it is not accepted again, not rewritten and not removed.
	_, err := p.Exec(ctx, `UPDATE closing_corrections SET status='accepted',
 decided_by_account_id=2 WHERE id=$1`, correction)
	execRefusalMessage(t, err, "LC013", "final")
	_, err = p.Exec(ctx, `UPDATE closing_corrections SET payload='{"commission_amount":"1.00"}'::jsonb
 WHERE id=$1`, correction)
	execRefusal(t, err, "LC013")
	_, err = p.Exec(ctx, `DELETE FROM closing_corrections WHERE id=$1`, correction)
	execRefusal(t, err, "LC013")
	// The journal is append only too: an applied delta is a fact of the drawer and the stock.
	for _, statement := range []string{
		`UPDATE closing_correction_effects SET quantity_delta=1`,
		`DELETE FROM closing_correction_effects`,
		`TRUNCATE closing_correction_effects`,
	} {
		_, journalErr := p.Exec(ctx, statement)
		refusal(t, journalErr)
	}
	// A hand written effect is refused: it would move the next opening's cash or the journal
	// of a settlement nobody accepted a delta for.
	_, err = p.Exec(ctx, `INSERT INTO closing_correction_effects(correction_id,closing_id,kind,amount_delta)
 VALUES($1,$2,'fund',100.00)`, correction, closing)
	execRefusal(t, err, "LC023")
	if after := stocks(t, ctx, p); after != before {
		t.Fatalf("the refused attempts must not move stock, got %s before %s", before, after)
	}
	if after := correctionEffects(t, ctx, p, closing); after != journal {
		t.Fatalf("the refused attempts must not touch the journal, got %s before %s", journal, after)
	}
	var decided string
	if err := p.QueryRow(ctx, `SELECT status||':'||(decided_at IS NOT NULL)::text
 FROM closing_corrections WHERE id=$1`, correction).Scan(&decided); err != nil ||
		decided != "accepted:true" {
		t.Fatalf("the correction must keep one decision: %q %v", decided, err)
	}
	t.Logf("036: a correction is decided once and its journal is append only")
}
