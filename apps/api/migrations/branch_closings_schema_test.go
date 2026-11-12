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

// migration034 is the shape of the branch account settlement ("rendición de cuentas"):
// its tables, indexes, identity, state machine and immutability. The guards and the
// closure that read or write another table are 035, and this migration names no table
// of 001-033. Both are additive -- new tables, new guards and new indexes -- so they
// never rewrite the historical versions, whose checksums are already recorded in live
// databases.
const migration034 = "034_branch_closings.sql"

// settlementMigration is the other half of the same vertical: the freeze predicate, the
// stock snapshot, the offer, the cash ledger, the closure and the reconciliation guards.
// The database tests below install the pair, because a settlement is only meaningful
// when it can open, freeze, be decided and close.
const settlementMigration = "035_branch_guards.sql"

// The settlement migration owns six tables, the database-side rules of the whole
// vertical -- one live settlement per branch, a count that covers the stock, an
// append-only cash ledger, immutable rounds of proposal and correction -- and the
// state machine itself. statements is not used here because every required line below
// is a whole statement and the file is read exactly as PostgreSQL receives it.
func TestBranchClosingsSchemaStructure(t *testing.T) {
	b, err := migrations.Files.ReadFile(migration034)
	if err != nil {
		t.Fatal("the settlement migration must be embedded", err)
	}
	sql := string(b)
	for _, required := range []string{
		// The per-branch settings the warehouse owns: the commission rate is the only
		// one today and it is bounded to a percentage with two decimals.
		"CREATE TABLE branch_settings",
		"branch_location_id smallint PRIMARY KEY REFERENCES locations(id)",
		"commission_rate_percent numeric(5,2) NOT NULL",
		"CHECK (commission_rate_percent >= 0 AND commission_rate_percent <= 100)",
		"updated_by_account_id integer NOT NULL REFERENCES auth_accounts(id)",
		"updated_at timestamptz NOT NULL DEFAULT now()",
		"CREATE TRIGGER admit_branch_settings BEFORE INSERT OR UPDATE ON branch_settings",

		// The settlement itself: state, the database's own period, the commission frozen
		// at open and the money of the period.
		"CREATE TABLE branch_closings",
		"id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY",
		"status text NOT NULL DEFAULT 'open'",
		"CHECK (status IN ('open','proposed','rejected','closed'))",
		"period_start timestamptz NOT NULL",
		"cut_at timestamptz NOT NULL DEFAULT now()",
		"closed_at timestamptz",
		// The rate is a fact of the proposal (S6), so it is nullable on the settlement.
		"commission_rate_percent numeric(5,2)\n        CHECK (commission_rate_percent >= 0 AND commission_rate_percent <= 100)",
		"opening_cash numeric(12,2) NOT NULL DEFAULT 0 CHECK (opening_cash >= 0)",
		"cash_sales numeric(12,2) NOT NULL DEFAULT 0 CHECK (cash_sales >= 0)",
		"cash_expenses numeric(12,2) NOT NULL DEFAULT 0 CHECK (cash_expenses >= 0)",
		// The offer: the totals of the period and the commission they pay (R1-001).
		"sales_total numeric(12,2) NOT NULL DEFAULT 0 CHECK (sales_total >= 0)",
		"commission_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (commission_amount >= 0)",
		"card_total numeric(12,2) NOT NULL DEFAULT 0 CHECK (card_total >= 0)",
		"transfer_total numeric(12,2) NOT NULL DEFAULT 0 CHECK (transfer_total >= 0)",
		"qr_total numeric(12,2) NOT NULL DEFAULT 0 CHECK (qr_total >= 0)",
		"counted_cash numeric(12,2) CHECK (counted_cash >= 0)",
		// The admin's own contribution to the drawer (S10, L13).
		"contributed_cash numeric(12,2) NOT NULL DEFAULT 0 CHECK (contributed_cash >= 0)",
		"closing_cash numeric(12,2) CHECK (closing_cash >= 0)",
		"observation text NOT NULL DEFAULT '' CHECK (char_length(observation) <= 1000)",
		"opened_by_account_id integer NOT NULL REFERENCES auth_accounts(id)",
		"CHECK (period_start <= cut_at)",
		// A closure always states its money and never leaves more than it counted.
		"CHECK (status <> 'closed' OR (closed_at IS NOT NULL AND commission_rate_percent IS NOT NULL",
		"AND counted_cash IS NOT NULL AND closing_cash IS NOT NULL",
		"AND closing_cash <= counted_cash + contributed_cash))",
		// One live settlement per branch: open, proposed and rejected all freeze it.
		"CREATE UNIQUE INDEX branch_closings_one_live ON branch_closings(branch_location_id)",
		"WHERE status <> 'closed';",
		"CREATE INDEX branch_closings_by_branch ON branch_closings(branch_location_id, cut_at DESC)",

		// The count sheet: the expected quantity is the snapshot taken at open and the
		// counted quantity is the only thing the admin types.
		"CREATE TABLE closing_count_lines",
		"closing_id bigint NOT NULL REFERENCES branch_closings(id)",
		"variant_id integer NOT NULL REFERENCES catalog_variants(id)",
		"expected_quantity bigint NOT NULL CHECK (expected_quantity >= 0)",
		"counted_quantity bigint CHECK (counted_quantity >= 0 AND counted_quantity <= 1000000)",
		"PRIMARY KEY (closing_id, variant_id)",

		// The cash ledger: expenses recorded by the branch and the two directions of the
		// settlement transfer, appended and never edited.
		"CREATE TABLE branch_cash_movements",
		"closing_id bigint REFERENCES branch_closings(id)",
		"kind text NOT NULL CHECK (kind IN ('gasto','recaudacion','aporte'))",
		"amount numeric(12,2) NOT NULL CHECK (amount > 0)",
		"description text NOT NULL CHECK (char_length(btrim(description)) BETWEEN 1 AND 500)",
		"occurred_at timestamptz NOT NULL DEFAULT now()",
		"created_by_account_id integer NOT NULL REFERENCES auth_accounts(id)",
		"CREATE INDEX branch_cash_movements_by_branch ON branch_cash_movements(branch_location_id, occurred_at)",
		"CREATE UNIQUE INDEX branch_cash_movements_one_transfer ON branch_cash_movements(closing_id, kind)",

		// Every proposal round keeps what was offered, who decided and why it was
		// rejected, so the branch can always be shown exactly what it accepted.
		"CREATE TABLE closing_proposals",
		"round smallint NOT NULL CHECK (round >= 1)",
		"proposed_payload jsonb NOT NULL",
		"proposed_by_account_id integer NOT NULL REFERENCES auth_accounts(id)",
		"decided_by_account_id integer REFERENCES auth_accounts(id)",
		"decision text CHECK (decision IN ('accepted','rejected'))",
		"decision_reason text NOT NULL DEFAULT '' CHECK (char_length(decision_reason) <= 1000)",
		"UNIQUE (closing_id, round)",
		"CHECK (decision IS DISTINCT FROM 'rejected'",
		"CHECK ((decision IS NULL) = (decided_at IS NULL))",
		"CREATE UNIQUE INDEX closing_proposals_one_pending ON closing_proposals(closing_id)",
		"WHERE decision IS NULL;",

		// Corrections of a closed settlement: appended with a mandatory reason and the
		// branch's approval, one pending at a time.
		"CREATE TABLE closing_corrections",
		"status text NOT NULL DEFAULT 'proposed'",
		"CHECK (status IN ('proposed','accepted','rejected'))",
		"reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 1000)",
		"payload jsonb NOT NULL",
		"CHECK ((status = 'proposed') = (decided_at IS NULL))",
		"CREATE UNIQUE INDEX closing_corrections_one_pending ON closing_corrections(closing_id)",
		"WHERE status = 'proposed';",

		// Every guard is a named trigger, so the store never depends on an implicit side
		// effect of a table constraint. The settlement's own triggers are all here; the
		// ones that read another table are 035.
		"CREATE TRIGGER admit_branch_closing BEFORE INSERT ON branch_closings",
		"CREATE TRIGGER guard_closing_count_line BEFORE UPDATE ON closing_count_lines",
		"CREATE TRIGGER protect_closing_count_lines BEFORE DELETE ON closing_count_lines",
		"CREATE TRIGGER protect_closing_count_lines_truncate BEFORE TRUNCATE ON closing_count_lines",
		"CREATE TRIGGER admit_branch_closing_transition BEFORE UPDATE OR DELETE ON branch_closings",
		"CREATE TRIGGER protect_branch_closings_truncate BEFORE TRUNCATE ON branch_closings",
		"CREATE TRIGGER protect_branch_cash_movements BEFORE UPDATE OR DELETE ON branch_cash_movements",
		"CREATE TRIGGER protect_branch_cash_movements_truncate BEFORE TRUNCATE ON branch_cash_movements",
		"CREATE TRIGGER admit_closing_proposal_insert BEFORE INSERT ON closing_proposals",
		"CREATE TRIGGER guard_closing_proposal_decision BEFORE UPDATE OR DELETE ON closing_proposals",
		"CREATE TRIGGER protect_closing_proposals_truncate BEFORE TRUNCATE ON closing_proposals",
		"CREATE TRIGGER admit_closing_correction BEFORE INSERT ON closing_corrections",
		"CREATE TRIGGER guard_closing_correction_decision BEFORE UPDATE OR DELETE ON closing_corrections",
		"CREATE TRIGGER protect_closing_corrections_truncate BEFORE TRUNCATE ON closing_corrections",

		// The database, not the caller, freezes the period, the rate and the fund the
		// settlement inherits, and it takes the expected quantity from the balance.
		"NEW.status := 'open';",
		"NEW.cut_at := now();",
		// The rate is not read at open, and the draft starts without one.
		"NEW.commission_rate_percent := NULL;",
		// The rate is read and frozen when the warehouse proposes (S6).
		"NEW.commission_rate_percent := configured;",
		"NEW.period_start := coalesce(previous, NEW.cut_at);",
		"NEW.opening_cash := coalesce((",
		// The count sheet is writable while the settlement is open and again after a
		// rejection, and frozen while the branch decides and once closed (S14).
		"header.status NOT IN ('open','rejected') THEN",
		"MESSAGE='Only the counted quantity can change on a count line'",
		"NEW.closed_at := now();",
		// R1-001: the offer is recorded by the proposal and nothing rewrites it after.
		"MESSAGE='The offer of a settlement is recorded when it is proposed'",
		// R3-001: a settlement with a pending counted line cannot be offered at all.
		"MESSAGE='Variant ' || pending || ' has no counted quantity'",
		// R4-003: a header update cannot return a settlement the branch did not refuse.
		"MESSAGE='Proposal round ' || latest.round || ' is not rejected'",
		// The offer is a round: proposing opens one, so one always exists to reject.
		"MESSAGE='The settlement has no proposal round to offer'",
		// The opener and the closure take the same per-branch advisory lock the freeze
		// guards of 035 take (R4-001).
		"PERFORM pg_advisory_xact_lock(340251, NEW.branch_location_id::integer);",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("missing %s", required)
		}
	}
	// Every refusal raises its own SQLSTATE: the store maps that code and nothing else.
	for _, code := range []string{
		"LC002", "LC003", "LC004", "LC005", "LC006", "LC008", "LC009", "LC010",
		"LC012", "LC013", "LC014", "LC015", "LC016", "LC017", "LC019",
	} {
		if !strings.Contains(sql, "ERRCODE='"+code+"'") {
			t.Errorf("missing SQLSTATE %s", code)
		}
	}
	// The codes of the guards that read another table live in 035, with those guards.
	for _, code := range []string{"LC001", "LC007", "LC011", "LC018", "LC020"} {
		if strings.Contains(sql, "ERRCODE='"+code+"'") {
			t.Errorf("the refusal %s belongs to the guards of 035", code)
		}
	}
	// Additive only: no historical table, function or trigger is rewritten or dropped,
	// because 001-033 are already applied and checksummed.
	for _, forbidden := range []string{"ALTER TABLE", "CREATE OR REPLACE", "DROP "} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("the settlement migration must be additive: %s", forbidden)
		}
	}
	// The split the two migrations exist for: this file is the settlement's own shape,
	// so it names no table of 001-033 and it applies no stock and writes no ledger row.
	// The stock and the money of the drawer are 035.
	for _, forbidden := range []string{
		"inventory_balances", "sale_lines", "FROM sales",
		"INSERT INTO branch_cash_movements",
		"branch_closure_blocker", "assert_branch_not_frozen",
		"pg_trigger_depth", "set_config(",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("the settlement shape must not reach another table: %s", forbidden)
		}
	}
	// The stock difference cannot survive a closure, and the reservation is never the
	// database's to move: only `existing` is written, and 035 writes it.
	for _, forbidden := range []string{"reserved=", "reserved =", "reserved:="} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("a closure must never move the reserved stock: %s", forbidden)
		}
	}
	// The commission is reported and paid outside the system: it participates in no
	// cash identity, and the file says so where the money is defined.
	if strings.Contains(sql, "commission_amount -") || strings.Contains(sql, "- commission_amount") {
		t.Errorf("the commission must not participate in any cash identity")
	}
	// The tables must exist before the triggers that read them, and the settlement
	// before its count sheet.
	if first, second := strings.Index(sql, "CREATE TABLE branch_closings"),
		strings.Index(sql, "CREATE TABLE closing_count_lines"); first < 0 || second < 0 || first > second {
		t.Error("the settlement must exist before its count sheet does")
	}
	// The migration documents its own decisions, so the next reader does not have to
	// derive them from the guards.
	for _, documented := range []string{"rendición de cuentas", "One live settlement", "append only",
		"no limit of rounds", "Guardar y salir", "A retired branch is not settled",
		"is already decided", "is not rejected", "no proposal round to offer",
		"exceeds the cash counted plus the contribution", "The offer is the settlement"} {
		if !strings.Contains(sql, documented) {
			t.Errorf("the migration must document its own decision: %s", documented)
		}
	}
}

// closingFixture is the established database fixture, not a new one: an isolated
// PostgreSQL database, every embedded migration applied in version order up to the last
// one of the settlement block, the prefix catalogue the settlement rules are written
// against, one account per location and the two variants branch 2 holds stock of. The
// pair is installed because a settlement is only complete when it can freeze, close and
// write its ledger; the split is asserted statically above.
func closingFixture(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	applyMigrationRange(t, ctx, p, 35)
	seedPrefixCatalog(t, ctx, p)
	if _, err := p.Exec(ctx, `INSERT INTO auth_accounts(location_id,username,password_hash)
 VALUES(1,'almacen','x'),(2,'sucursal_a','x'),(3,'sucursal_b','x')`); err != nil {
		t.Fatal("the accounts could not be provisioned")
	}
	if _, err := p.Exec(ctx, `INSERT INTO inventory_balances(location_id,variant_id,existing,reserved)
 VALUES(2,1,10,0),(2,2,4,0)`); err != nil {
		t.Fatal("the branch stock could not be provisioned")
	}
	// One price per branch and variant, so the offer test can sell what the branch holds.
	if _, err := p.Exec(ctx, `INSERT INTO branch_prices(branch_location_id,catalog_entry_id,min_price,suggested_price,updated_by_account_id)
 VALUES(2,1,0.01,2500.00,1),(3,1,0.01,2500.00,1)`); err != nil {
		t.Fatal("the branch prices could not be configured")
	}
	// The commission rate of branch 2: the only setting the settlement needs.
	if _, err := p.Exec(ctx, `INSERT INTO branch_settings(branch_location_id,commission_rate_percent,updated_by_account_id)
 VALUES(2,12.50,1)`); err != nil {
		t.Fatal("the branch commission could not be configured")
	}
	return ctx, p
}

// openSettlement opens the next settlement of one branch for the warehouse and returns
// its id. The declared period start and rate are deliberately wrong: the database owns
// both and overwrites whatever the caller promised.
func openSettlement(t *testing.T, ctx context.Context, p *pgxpool.Pool, branch int) int64 {
	t.Helper()
	var id int64
	err := p.QueryRow(ctx, `INSERT INTO branch_closings(branch_location_id,period_start,commission_rate_percent,opened_by_account_id)
 VALUES($1,now(),0,1) RETURNING id`, branch).Scan(&id)
	if err != nil {
		t.Fatalf("the settlement of branch %d could not be opened: %v", branch, err)
	}
	return id
}

// countAll counts every seeded line of the settlement with the asked quantities, so a
// test only states the lines it is interested in.
func countAll(t *testing.T, ctx context.Context, p *pgxpool.Pool, closing int64, counted map[int]int) {
	t.Helper()
	for variant, quantity := range counted {
		if _, err := p.Exec(ctx, `UPDATE closing_count_lines SET counted_quantity=$3
 WHERE closing_id=$1 AND variant_id=$2`, closing, variant, quantity); err != nil {
			t.Fatalf("variant %d could not be counted: %v", variant, err)
		}
	}
}

// branchAccount is the enabled account of the branch that owns the settlement: any of
// them may decide a round, and the schema derives it instead of naming it.
const branchAccount = `(SELECT a.id FROM auth_accounts a
     JOIN branch_closings c ON c.branch_location_id=a.location_id WHERE c.id=$1)`

// proposeRound records one round of the warehouse's offer while the settlement is still
// open or rejected, which is the only window a round can be created in.
func proposeRound(t *testing.T, ctx context.Context, p *pgxpool.Pool, closing int64, payload string) {
	t.Helper()
	if _, err := p.Exec(ctx, `INSERT INTO closing_proposals(closing_id,round,proposed_payload,proposed_by_account_id)
 VALUES($1,1,$2::jsonb,1)`, closing, payload); err != nil {
		t.Fatalf("the proposal round could not be recorded: %v", err)
	}
}

// decideRound records the branch's answer to the pending round of the settlement.
func decideRound(t *testing.T, ctx context.Context, p *pgxpool.Pool, closing int64, decision, reason string) {
	t.Helper()
	query := `UPDATE closing_proposals SET decision=$2,decision_reason=$3,
 decided_by_account_id=` + branchAccount + ` WHERE closing_id=$1 AND decision IS NULL`
	if _, err := p.Exec(ctx, query, closing, decision, reason); err != nil {
		t.Fatalf("the branch could not decide the round: %v", err)
	}
}

// closeSettlement walks the whole state machine over one settlement: the warehouse
// proposes a round, moves it to 'proposed' with the money it counted, the branch accepts
// it, and the closure applies. It is the only shape the guards allow.
func closeSettlement(t *testing.T, ctx context.Context, p *pgxpool.Pool, closing int64, counted, contributed, fund string) {
	t.Helper()
	proposeRound(t, ctx, p, closing, `{"fund":"`+fund+`"}`)
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='proposed',counted_cash=$2::numeric,
 contributed_cash=$3::numeric,closing_cash=$4::numeric
 WHERE id=$1 AND status IN ('open','rejected')`, closing, counted, contributed, fund); err != nil {
		t.Fatalf("the settlement could not be proposed: %v", err)
	}
	decideRound(t, ctx, p, closing, "accepted", "")
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='closed' WHERE id=$1`, closing); err != nil {
		t.Fatalf("the accepted round must close the settlement: %v", err)
	}
}

// settlementState is the money and the state of one settlement as one value, so a test
// proves a refusal wrote nothing by comparing it before and after.
func settlementState(t *testing.T, ctx context.Context, p *pgxpool.Pool, closing int64) string {
	t.Helper()
	var state string
	if err := p.QueryRow(ctx, `SELECT status||':'||coalesce(commission_rate_percent::text,'-')||':'
         ||sales_total||':'||cash_sales||':'||card_total||':'||transfer_total||':'||qr_total||':'
         ||commission_amount||':'||coalesce(commission_rate_percent::text,'-') FROM branch_closings WHERE id=$1`,
		closing).Scan(&state); err != nil {
		t.Fatalf("the settlement state could not be read: %v", err)
	}
	return state
}

// TestBranchClosingsGuards proves the settlement rules on a live database: opening
// freezes the period and the snapshot and leaves the rate for the proposal; the money of
// the period is a draft while the settlement is live; the rate is read and frozen when
// the warehouse proposes; only an accepted round closes; and the closure applies exactly
// what was counted while recording the drawer's money.
//
// The count sheet is writable only while the settlement is open, and a refused closure
// leaves the settlement proposed, so the terminal refusals run at the end of the branch
// they belong to.
func TestBranchClosingsGuards(t *testing.T) {
	ctx, p := closingFixture(t)

	// Only the warehouse opens, only for a branch, and it never configures a commission
	// for itself. Opening does not read the rate: that is a fact of the proposal (S6).
	_, err := p.Exec(ctx, `INSERT INTO branch_closings(branch_location_id,period_start,commission_rate_percent,opened_by_account_id)
 VALUES(3,now(),0,3)`)
	execRefusal(t, err, "LC002")
	_, err = p.Exec(ctx, `INSERT INTO branch_closings(branch_location_id,period_start,commission_rate_percent,opened_by_account_id)
 VALUES(1,now(),0,1)`)
	execRefusal(t, err, "LC002")
	_, err = p.Exec(ctx, `INSERT INTO branch_settings(branch_location_id,commission_rate_percent,updated_by_account_id)
 VALUES(3,10.00,3)`)
	execRefusal(t, err, "LC015")
	_, err = p.Exec(ctx, `INSERT INTO branch_settings(branch_location_id,commission_rate_percent,updated_by_account_id)
 VALUES(1,10.00,1)`)
	execRefusal(t, err, "LC015")
	var refusals int
	if err := p.QueryRow(ctx, `SELECT (SELECT count(*) FROM branch_closings)
         + (SELECT count(*) FROM branch_settings)`).Scan(&refusals); err != nil || refusals != 1 {
		t.Fatalf("a refused settlement must write nothing: %d %v", refusals, err)
	}

	// The open freezes the database's period and the snapshot, and leaves the rate open:
	// the settlement is a draft of the branch's money until it is proposed.
	closing := openSettlement(t, ctx, p, 2)
	var frozen bool
	if err := p.QueryRow(ctx, `SELECT status='open' AND commission_rate_percent IS NULL
         AND opening_cash=0 AND contributed_cash=0 AND period_start=cut_at AND closed_at IS NULL
         FROM branch_closings WHERE id=$1`, closing).Scan(&frozen); err != nil || !frozen {
		t.Fatalf("the open must freeze period and fund and leave the rate for the proposal: %v", err)
	}
	var snapshot string
	if err := p.QueryRow(ctx, `SELECT string_agg(variant_id||':'||expected_quantity||':'
         ||coalesce(counted_quantity::text,'-'),',' ORDER BY variant_id)
         FROM closing_count_lines WHERE closing_id=$1`, closing).Scan(&snapshot); err != nil ||
		snapshot != "1:10:-,2:4:-" {
		t.Fatalf("the expected snapshot of the cut instant is wrong: %q %v", snapshot, err)
	}

	// The expected quantity is a fact of the cut instant, and a count line is never
	// removed: dropping it would let a whole variant escape the count.
	_, err = p.Exec(ctx, `UPDATE closing_count_lines SET expected_quantity=1 WHERE closing_id=$1`, closing)
	execRefusal(t, err, "LC004")
	_, err = p.Exec(ctx, `DELETE FROM closing_count_lines WHERE closing_id=$1`, closing)
	execRefusal(t, err, "LC004")
	_, err = p.Exec(ctx, `TRUNCATE closing_count_lines`)
	execRefusal(t, err, "LC004")
	var blocker bool
	if err := p.QueryRow(ctx, `SELECT branch_closure_blocker(2::smallint)`).Scan(&blocker); err != nil || !blocker {
		t.Fatalf("a live settlement must freeze its branch: %v %v", blocker, err)
	}

	// "Guardar y salir" (S10, L13): the money and observation fields are a draft while
	// the settlement is open, and nothing else is.
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET cash_sales=120.00,cash_expenses=20.00,
 counted_cash=100.00,contributed_cash=10.00,closing_cash=30.00,observation='borrador' WHERE id=$1`, closing); err != nil {
		t.Fatalf("the admin must be able to save a draft and leave: %v", err)
	}
	var draft string
	if err := p.QueryRow(ctx, `SELECT cash_sales||':'||cash_expenses||':'||counted_cash||':'
         ||contributed_cash||':'||closing_cash||':'||observation FROM branch_closings WHERE id=$1`, closing).Scan(&draft); err != nil ||
		draft != "120.00:20.00:100.00:10.00:30.00:borrador" {
		t.Fatalf("the draft must be persisted exactly as typed: %q %v", draft, err)
	}
	for _, statement := range []string{
		`UPDATE branch_closings SET sales_total=1.00 WHERE id=$1`,
		`UPDATE branch_closings SET commission_amount=1.00 WHERE id=$1`,
		`UPDATE branch_closings SET card_total=1.00 WHERE id=$1`,
		`UPDATE branch_closings SET transfer_total=1.00 WHERE id=$1`,
		`UPDATE branch_closings SET qr_total=1.00 WHERE id=$1`,
		`UPDATE branch_closings SET commission_rate_percent=1.00 WHERE id=$1`,
		`UPDATE branch_closings SET opening_cash=1.00 WHERE id=$1`,
		`UPDATE branch_closings SET cut_at=now() WHERE id=$1`,
		`UPDATE branch_closings SET closed_at=now() WHERE id=$1`,
	} {
		_, draftErr := p.Exec(ctx, statement, closing)
		execRefusal(t, draftErr, "LC005")
	}
	// The settlement's own identity column is never rewritten either.
	_, err = p.Exec(ctx, `UPDATE branch_closings SET id=99 WHERE id=$1`, closing)
	refusal(t, err)

	// The count sheet is writable while the settlement is open: the only thing that
	// refuses a second line of the same variant here is the key.
	_, err = p.Exec(ctx, `INSERT INTO closing_count_lines(closing_id,variant_id,expected_quantity)
 VALUES($1,1,10)`, closing)
	execRefusal(t, err, "23505")
	countAll(t, ctx, p, closing, map[int]int{1: 7, 2: 6})

	// A second live settlement of the same branch is impossible.
	_, err = p.Exec(ctx, `INSERT INTO branch_closings(branch_location_id,period_start,commission_rate_percent,opened_by_account_id)
 VALUES(2,now(),0,1)`)
	execRefusal(t, err, "23505")

	// The proposal freezes the configured rate, which is read now and not at open.
	proposeRound(t, ctx, p, closing, `{"fund":"40.00"}`)
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='proposed',counted_cash=100.00,
 contributed_cash=0.00,closing_cash=40.00 WHERE id=$1`, closing); err != nil {
		t.Fatalf("the settlement could not be proposed: %v", err)
	}
	var rate string
	if err := p.QueryRow(ctx, `SELECT commission_rate_percent::text FROM branch_closings WHERE id=$1`, closing).Scan(&rate); err != nil || rate != "12.50" {
		t.Fatalf("the proposal must freeze the configured rate: %q %v", rate, err)
	}
	// A proposed settlement is not a draft: the branch is deciding that very offer.
	_, err = p.Exec(ctx, `UPDATE branch_closings SET observation='tarde' WHERE id=$1`, closing)
	execRefusal(t, err, "LC005")

	// While the branch is deciding, the count is frozen: the offer it reads cannot move.
	_, err = p.Exec(ctx, `UPDATE closing_count_lines SET counted_quantity=8 WHERE closing_id=$1`, closing)
	execRefusal(t, err, "LC004")
	_, err = p.Exec(ctx, `INSERT INTO closing_count_lines(closing_id,variant_id,expected_quantity)
 VALUES($1,3,0)`, closing)
	execRefusal(t, err, "LC004")

	// Only an accepted round closes (S14): neither a pending one nor a rejection.
	_, err = p.Exec(ctx, `UPDATE branch_closings SET status='closed' WHERE id=$1`, closing)
	execRefusalMessage(t, err, "LC016", "still undecided")
	decideRound(t, ctx, p, closing, "rejected", "el fondo era otro")
	_, err = p.Exec(ctx, `UPDATE branch_closings SET status='closed' WHERE id=$1`, closing)
	execRefusalMessage(t, err, "LC016", "rejected, not accepted")
	// The rejection returns the settlement to the warehouse as a draft it can correct,
	// and it can only be corrected once it is back in the warehouse's hands.
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='rejected' WHERE id=$1`, closing); err != nil {
		t.Fatalf("the settlement could not return to the warehouse: %v", err)
	}
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET cash_expenses=30.00,observation='fondo corregido'
 WHERE id=$1`, closing); err != nil {
		t.Fatalf("a rejected settlement must be editable again: %v", err)
	}
	// A rejection hands the settlement back for correction (S14), so the count it
	// rejected can be fixed and a missed variant added: the expected quantity is still
	// the database's snapshot, and it still cannot be rewritten.
	if _, err := p.Exec(ctx, `UPDATE closing_count_lines SET counted_quantity=4
 WHERE closing_id=$1 AND variant_id=1`, closing); err != nil {
		t.Fatalf("a rejected settlement must accept a corrected count: %v", err)
	}
	var expected int64
	if err := p.QueryRow(ctx, `INSERT INTO closing_count_lines(closing_id,variant_id,expected_quantity,counted_quantity)
 VALUES($1,3,999,5) RETURNING expected_quantity`, closing).Scan(&expected); err != nil || expected != 0 {
		t.Fatalf("a missed variant must be admissible with the database's snapshot: %d %v", expected, err)
	}
	_, err = p.Exec(ctx, `UPDATE closing_count_lines SET expected_quantity=1 WHERE closing_id=$1`, closing)
	execRefusal(t, err, "LC004")
	var corrected string
	if err := p.QueryRow(ctx, `SELECT cash_expenses||':'||observation FROM branch_closings WHERE id=$1`, closing).Scan(&corrected); err != nil ||
		corrected != "30.00:fondo corregido" {
		t.Fatalf("a rejected settlement keeps the corrected draft: %q %v", corrected, err)
	}
	proposeRound(t, ctx, p, closing, `{"fund":"40.00"}`)
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='proposed' WHERE id=$1`, closing); err != nil {
		t.Fatalf("the second round could not be proposed: %v", err)
	}
	decideRound(t, ctx, p, closing, "accepted", "")
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='closed' WHERE id=$1`, closing); err != nil {
		t.Fatalf("an accepted round must close the settlement: %v", err)
	}

	// The closure applies exactly what was counted, in both directions, and records the
	// settlement transfer as one ledger row with its own sign.
	var stock string
	if err := p.QueryRow(ctx, `SELECT string_agg(variant_id||':'||existing||':'||reserved,',' ORDER BY variant_id)
 FROM inventory_balances WHERE location_id=2`).Scan(&stock); err != nil || stock != "1:4:0,2:6:0,3:5:0" {
		t.Fatalf("the closure must apply the corrected counted quantities: %q %v", stock, err)
	}
	var ledger, state string
	if err := p.QueryRow(ctx, `SELECT string_agg(kind||':'||amount||':'||description,',' ORDER BY id)
 FROM branch_cash_movements WHERE closing_id=$1`, closing).Scan(&ledger); err != nil ||
		ledger != "recaudacion:60.00:Recaudación de la rendición" {
		t.Fatalf("the settlement transfer must be one recorded ledger row: %q %v", ledger, err)
	}
	if err := p.QueryRow(ctx, `SELECT status||':'||(closed_at IS NOT NULL)::text FROM branch_closings
 WHERE id=$1`, closing).Scan(&state); err != nil || state != "closed:true" {
		t.Fatalf("the closure must state its own instant: %q %v", state, err)
	}
	var unfrozen bool
	if err := p.QueryRow(ctx, `SELECT branch_closure_blocker(2::smallint)`).Scan(&unfrozen); err != nil || unfrozen {
		t.Fatalf("a closed settlement must unfreeze its branch: %v %v", unfrozen, err)
	}

	// Changing the configured rate afterwards never alters a closed settlement (S6).
	if _, err := p.Exec(ctx, `UPDATE branch_settings SET commission_rate_percent=99.00
 WHERE branch_location_id=2`); err != nil {
		t.Fatalf("the configured rate could not be changed: %v", err)
	}
	if err := p.QueryRow(ctx, `SELECT commission_rate_percent=12.50 FROM branch_closings WHERE id=$1`, closing).Scan(&frozen); err != nil || !frozen {
		t.Fatalf("a closed settlement keeps the rate it settled: %v", err)
	}

	// A closed settlement is never edited, reopened, deleted or truncated, and its
	// count sheet stays exactly as it was closed.
	_, err = p.Exec(ctx, `UPDATE branch_closings SET observation='otra' WHERE id=$1`, closing)
	execRefusal(t, err, "LC005")
	_, err = p.Exec(ctx, `UPDATE branch_closings SET status='open' WHERE id=$1`, closing)
	execRefusal(t, err, "LC005")
	_, err = p.Exec(ctx, `DELETE FROM branch_closings WHERE id=$1`, closing)
	execRefusal(t, err, "LC005")
	_, err = p.Exec(ctx, `UPDATE closing_count_lines SET counted_quantity=1 WHERE closing_id=$1`, closing)
	execRefusal(t, err, "LC004")
	_, err = p.Exec(ctx, `TRUNCATE branch_closings CASCADE`)
	refusal(t, err)

	// The next period opens where the previous closure left it: the fund it declared
	// is the inherited cash, and the period starts at the closure instant.
	next := openSettlement(t, ctx, p, 2)
	var inherited bool
	if err := p.QueryRow(ctx, `SELECT n.opening_cash=40.00 AND n.period_start=p.closed_at
 FROM branch_closings n, branch_closings p WHERE n.id=$1 AND p.id=$2`, next, closing).Scan(&inherited); err != nil || !inherited {
		t.Fatalf("the next period must inherit the declared fund: %v", err)
	}

	// While a settlement is live the branch records no expense; the warehouse's money
	// always belongs to a settlement of its own branch, and an expense to no settlement.
	_, err = p.Exec(ctx, `INSERT INTO branch_cash_movements(branch_location_id,kind,amount,description,created_by_account_id)
 VALUES(2,'gasto',15.00,'Flete',2)`)
	execRefusal(t, err, "LC001")
	_, err = p.Exec(ctx, `INSERT INTO branch_cash_movements(branch_location_id,kind,amount,description,created_by_account_id)
 VALUES(3,'gasto',15.00,'Flete',2)`)
	execRefusal(t, err, "LC011")
	if _, err := p.Exec(ctx, `INSERT INTO branch_cash_movements(branch_location_id,kind,amount,description,created_by_account_id)
 VALUES(3,'gasto',15.00,'Flete',3)`); err != nil {
		t.Fatalf("an operating branch must record its own expense: %v", err)
	}
	var expense string
	if err := p.QueryRow(ctx, `SELECT kind||':'||amount||':'||(closing_id IS NULL)::text
 FROM branch_cash_movements WHERE branch_location_id=3`).Scan(&expense); err != nil ||
		expense != "gasto:15.00:true" {
		t.Fatalf("a branch expense belongs to no settlement: %q %v", expense, err)
	}
	_, err = p.Exec(ctx, `INSERT INTO branch_cash_movements(branch_location_id,kind,amount,description,created_by_account_id)
 VALUES(2,'recaudacion',10.00,'Sin rendición',1)`)
	execRefusal(t, err, "LC011")
	_, err = p.Exec(ctx, `INSERT INTO branch_cash_movements(branch_location_id,closing_id,kind,amount,description,created_by_account_id)
 VALUES(3,$1,'recaudacion',10.00,'De otra sucursal',1)`, next)
	execRefusal(t, err, "LC011")
	// The money of a settlement is the warehouse's, never the branch's.
	_, err = p.Exec(ctx, `INSERT INTO branch_cash_movements(branch_location_id,closing_id,kind,amount,description,created_by_account_id)
 VALUES(2,$1,'recaudacion',10.00,'Cobro propio',2)`, next)
	execRefusal(t, err, "LC011")
	// The ledger is append only: a wrong movement is fixed by its opposite.
	for _, statement := range []string{
		`UPDATE branch_cash_movements SET amount=1.00`,
		`DELETE FROM branch_cash_movements`,
		`TRUNCATE branch_cash_movements`,
	} {
		_, ledgerErr := p.Exec(ctx, statement)
		refusal(t, ledgerErr)
	}

	// A branch without a configured rate opens anyway and cannot be proposed (S6).
	if _, err := p.Exec(ctx, `INSERT INTO inventory_balances(location_id,variant_id,existing,reserved)
 VALUES(3,1,3,0),(3,2,5,4)`); err != nil {
		t.Fatal("the third branch stock could not be provisioned")
	}
	reserved := openSettlement(t, ctx, p, 3)
	countAll(t, ctx, p, reserved, map[int]int{1: 2, 2: 2})
	proposeRound(t, ctx, p, reserved, `{}`)
	_, err = p.Exec(ctx, `UPDATE branch_closings SET status='proposed',counted_cash=10.00,closing_cash=0.00
 WHERE id=$1`, reserved)
	execRefusal(t, err, "LC003")
	if _, err := p.Exec(ctx, `INSERT INTO branch_settings(branch_location_id,commission_rate_percent,updated_by_account_id)
 VALUES(3,8.75,1)`); err != nil {
		t.Fatalf("the third branch commission could not be configured: %v", err)
	}
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='proposed',counted_cash=10.00,closing_cash=0.00
 WHERE id=$1`, reserved); err != nil {
		t.Fatalf("the third branch settlement could not be proposed: %v", err)
	}
	if err := p.QueryRow(ctx, `SELECT commission_rate_percent=8.75 FROM branch_closings WHERE id=$1`, reserved).Scan(&frozen); err != nil || !frozen {
		t.Fatalf("each branch freezes the rate it was configured with: %v", err)
	}
	decideRound(t, ctx, p, reserved, "accepted", "")
	// Any open reservation blocks the closure, naming the variant, even when the counted
	// quantity covers it (R3-002, R4-004).
	_, err = p.Exec(ctx, `UPDATE branch_closings SET status='closed' WHERE id=$1`, reserved)
	execRefusalMessage(t, err, "LC007", "Variant 2")
	if err := p.QueryRow(ctx, `SELECT string_agg(variant_id||':'||existing,',' ORDER BY variant_id)
 FROM inventory_balances WHERE location_id=3`).Scan(&stock); err != nil || stock != "1:3,2:5" {
		t.Fatalf("a refused closure must leave the stock untouched: %q %v", stock, err)
	}

	// The money and the count refusals, on a settlement whose round is already accepted so
	// that the decision is not what stops them.
	countAll(t, ctx, p, next, map[int]int{1: 8, 2: 6, 3: 5})
	// The drawer is a draft while the settlement is live, and the bound is checked on
	// every write so the admin sees the domain code, not a constraint violation.
	_, err = p.Exec(ctx, `UPDATE branch_closings SET counted_cash=50.00,closing_cash=60.00
 WHERE id=$1`, next)
	execRefusalMessage(t, err, "LC006", "exceeds the cash counted plus the contribution by 10.00")
	// The contribution raises the bound.
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET counted_cash=50.00,
 contributed_cash=10.00,closing_cash=60.00 WHERE id=$1`, next); err != nil {
		t.Fatalf("the drawer draft must be accepted: %v", err)
	}
	proposeRound(t, ctx, p, next, `{}`)
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='proposed' WHERE id=$1`, next); err != nil {
		t.Fatalf("the second settlement could not be proposed: %v", err)
	}
	decideRound(t, ctx, p, next, "accepted", "")
	// Once proposed, the drawer is the offer the branch accepted: closing cannot rewrite it.
	_, err = p.Exec(ctx, `UPDATE branch_closings SET status='closed',counted_cash=99.00 WHERE id=$1`, next)
	execRefusalMessage(t, err, "LC005", "the offer the branch decides")
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='closed' WHERE id=$1`, next); err != nil {
		t.Fatalf("an accepted round must close the second settlement: %v", err)
	}
	t.Logf("034: opened, drafted, proposed, accepted, closed and refused settlements behave as the contract says")
}

// TestBranchClosingsFirstSettlement proves S11 with the resolved S10 of L13: the very
// first settlement of a branch has an empty till, the admin declares the fund it leaves,
// and that money is one aporte in the ledger — never an invented count, never a
// recaudación.
func TestBranchClosingsFirstSettlement(t *testing.T) {
	ctx, p := closingFixture(t)
	closing := openSettlement(t, ctx, p, 2)
	countAll(t, ctx, p, closing, map[int]int{1: 10, 2: 4})

	// The offer is a round (S14, S15): a settlement cannot even be proposed without the
	// version that states what the branch is being offered, because a rejection would
	// then have nothing to refuse.
	before := settlementState(t, ctx, p, closing)
	_, err := p.Exec(ctx, `UPDATE branch_closings SET status='proposed',
 counted_cash=0.00,contributed_cash=500.00,closing_cash=500.00 WHERE id=$1`, closing)
	execRefusalMessage(t, err, "LC016", "no proposal round to offer")
	if after := settlementState(t, ctx, p, closing); after != before {
		t.Fatalf("a refused proposal must change nothing, got %s before %s", before, after)
	}

	// The warehouse offers the fund it will leave, the branch accepts it, and the closure
	// records the declared money as a single contribution.
	proposeRound(t, ctx, p, closing, `{"fund":"500.00"}`)
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='proposed',
 counted_cash=0.00,contributed_cash=500.00,closing_cash=500.00 WHERE id=$1`, closing); err != nil {
		t.Fatalf("the first settlement could not be proposed: %v", err)
	}
	decideRound(t, ctx, p, closing, "accepted", "")
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='closed' WHERE id=$1`, closing); err != nil {
		t.Fatalf("the accepted round must close the first settlement: %v", err)
	}
	var ledger string
	if err := p.QueryRow(ctx, `SELECT string_agg(kind||':'||amount||':'||description,',' ORDER BY id)
 FROM branch_cash_movements WHERE closing_id=$1`, closing).Scan(&ledger); err != nil ||
		ledger != "aporte:500.00:Aporte de fondo de la rendición" {
		t.Fatalf("the declared fund must be one aporte: %q %v", ledger, err)
	}
	var state string
	if err := p.QueryRow(ctx, `SELECT opening_cash||':'||counted_cash||':'||contributed_cash||':'
         ||closing_cash||':'||commission_amount||':'||commission_rate_percent
         FROM branch_closings WHERE id=$1`, closing).Scan(&state); err != nil ||
		state != "0.00:0.00:500.00:500.00:0.00:12.50" {
		t.Fatalf("the first settlement must record an empty till and the declared fund: %q %v", state, err)
	}
	// The stock is left exactly as counted, and the fund is the inherited cash of the
	// period that starts.
	var stock string
	if err := p.QueryRow(ctx, `SELECT string_agg(variant_id||':'||existing,',' ORDER BY variant_id)
 FROM inventory_balances WHERE location_id=2`).Scan(&stock); err != nil || stock != "1:10,2:4" {
		t.Fatalf("the first closure must leave the stock as counted: %q %v", stock, err)
	}
	next := openSettlement(t, ctx, p, 2)
	var inherited bool
	if err := p.QueryRow(ctx, `SELECT opening_cash=500.00 FROM branch_closings WHERE id=$1`, next).Scan(&inherited); err != nil || !inherited {
		t.Fatalf("the next period must inherit the fund the admin left: %v", err)
	}
	t.Logf("034: the first settlement of a branch starts from an empty till with a declared fund")
}

// TestBranchClosingsRetiredBranch proves a retired branch is never settled: like every
// other branch flow, the settlement refuses a location the warehouse retired.
func TestBranchClosingsRetiredBranch(t *testing.T) {
	ctx, p := closingFixture(t)
	// The admin service retires the branch account first and the location after it.
	if _, err := p.Exec(ctx, `UPDATE auth_accounts SET enabled=false,deleted_at=now() WHERE id=3`); err != nil {
		t.Fatal("the branch account could not be retired")
	}
	if _, err := p.Exec(ctx, `UPDATE locations SET deleted_at=now() WHERE id=3`); err != nil {
		t.Fatal("the branch could not be retired")
	}
	_, err := p.Exec(ctx, `INSERT INTO branch_closings(branch_location_id,period_start,commission_rate_percent,opened_by_account_id)
 VALUES(3,now(),0,1)`)
	execRefusal(t, err, "LC017")
	var settlements int
	if err := p.QueryRow(ctx, `SELECT count(*) FROM branch_closings`).Scan(&settlements); err != nil || settlements != 0 {
		t.Fatalf("a retired branch must not be settled: %d %v", settlements, err)
	}
	// The branches that still operate settle normally.
	openSettlement(t, ctx, p, 2)
	t.Logf("034: a retired branch is refused and an operating one still settles")
}

// TestBranchClosingsProposalNeedsCompleteCount pins R3-001: a settlement is never
// offered to a branch while any line of its count sheet is still pending, and the
// refusal names the variant. Otherwise the branch would accept a proposal whose count is
// incomplete, the closure would then refuse the missing line with the count already
// frozen, and the settlement would be stuck in 'proposed' with the branch frozen.
func TestBranchClosingsProposalNeedsCompleteCount(t *testing.T) {
	ctx, p := closingFixture(t)
	closing := openSettlement(t, ctx, p, 2)
	// Variant 2 is left pending on purpose; variant 1 is counted.
	countAll(t, ctx, p, closing, map[int]int{1: 10})
	proposeRound(t, ctx, p, closing, `{"fund":"0.00"}`)

	before := settlementState(t, ctx, p, closing)
	_, err := p.Exec(ctx, `UPDATE branch_closings SET status='proposed',counted_cash=0.00,
 closing_cash=0.00 WHERE id=$1`, closing)
	execRefusalMessage(t, err, "LC019", "Variant 2")
	// The refusal wrote nothing: still open, still no rate, still no offer.
	if after := settlementState(t, ctx, p, closing); after != before {
		t.Fatalf("a refused proposal must change nothing, got %s before %s", before, after)
	}
	if state := settlementState(t, ctx, p, closing); !strings.HasPrefix(state, "open:") {
		t.Fatalf("the settlement must stay open, got %s", state)
	}

	// Counting the pending variant is the only thing that unblocks the same proposal,
	// and the round the warehouse already recorded is still the one being offered.
	countAll(t, ctx, p, closing, map[int]int{2: 4})
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='proposed',counted_cash=0.00,
 closing_cash=0.00 WHERE id=$1`, closing); err != nil {
		t.Fatalf("a complete count must be proposable: %v", err)
	}
	if state := settlementState(t, ctx, p, closing); !strings.HasPrefix(state, "proposed:12.50:") {
		t.Fatalf("the proposal must freeze the rate and record the offer, got %s", state)
	}
	t.Logf("034: a proposal with a pending count line is refused and names the variant")
}

// TestBranchClosingsRejectionNeedsRejectedRound pins R4-003: proposed -> rejected is the
// branch's answer to a round, so the latest round must itself be rejected. A header-only
// update can never return a settlement to the warehouse after the branch accepted it, and
// it can never bypass an accepted round.
func TestBranchClosingsRejectionNeedsRejectedRound(t *testing.T) {
	ctx, p := closingFixture(t)
	closing := openSettlement(t, ctx, p, 2)
	countAll(t, ctx, p, closing, map[int]int{1: 10, 2: 4})
	proposeRound(t, ctx, p, closing, `{"fund":"0.00"}`)
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='proposed',counted_cash=10.00,
 closing_cash=0.00 WHERE id=$1`, closing); err != nil {
		t.Fatalf("the settlement could not be proposed: %v", err)
	}

	// The branch accepted the round: the header cannot then be moved to rejected.
	decideRound(t, ctx, p, closing, "accepted", "")
	before := settlementState(t, ctx, p, closing)
	_, err := p.Exec(ctx, `UPDATE branch_closings SET status='rejected' WHERE id=$1`, closing)
	execRefusalMessage(t, err, "LC016", "is not rejected")
	if after := settlementState(t, ctx, p, closing); after != before {
		t.Fatalf("a refused rejection must change nothing, got %s before %s", before, after)
	}
	// The accepted settlement cannot be proposed again either: it is no longer a draft.
	_, err = p.Exec(ctx, `INSERT INTO closing_proposals(closing_id,round,proposed_payload,proposed_by_account_id)
 VALUES($1,1,'{}'::jsonb,1)`, closing)
	execRefusal(t, err, "LC008")
	// The only way on is the closure the branch accepted.
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='closed' WHERE id=$1`, closing); err != nil {
		t.Fatalf("the accepted round must close the settlement: %v", err)
	}

	// On a second settlement the rejection works exactly as S14 states: the round is
	// rejected first, and only then does the header return to the warehouse.
	second := openSettlement(t, ctx, p, 2)
	countAll(t, ctx, p, second, map[int]int{1: 10, 2: 4})
	proposeRound(t, ctx, p, second, `{"fund":"0.00"}`)
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='proposed',counted_cash=10.00,
 closing_cash=0.00 WHERE id=$1`, second); err != nil {
		t.Fatalf("the second settlement could not be proposed: %v", err)
	}
	decideRound(t, ctx, p, second, "rejected", "el fondo era otro")
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='rejected' WHERE id=$1`, second); err != nil {
		t.Fatalf("a rejected round must return the settlement to the warehouse: %v", err)
	}
	t.Logf("034: a header-only rejection cannot bypass the round the branch decided")
}

// TestBranchClosingsProposalRounds proves the round contract of S14/S15 on a live
// database: one pending proposal per settlement, a rejection that returns it to the
// warehouse with its reason, no limit of rounds, and rounds that are immutable once
// decided.
func TestBranchClosingsProposalRounds(t *testing.T) {
	ctx, p := closingFixture(t)
	closing := openSettlement(t, ctx, p, 2)
	countAll(t, ctx, p, closing, map[int]int{1: 10, 2: 4})

	// Only the warehouse proposes, and only over a live settlement.
	_, err := p.Exec(ctx, `INSERT INTO closing_proposals(closing_id,round,proposed_payload,proposed_by_account_id)
 VALUES($1,99,'{}'::jsonb,2)`, closing)
	execRefusal(t, err, "LC008")
	var first int64
	if err := p.QueryRow(ctx, `INSERT INTO closing_proposals(closing_id,round,proposed_payload,proposed_by_account_id)
 VALUES($1,99,'{"fund":"10.00"}'::jsonb,1) RETURNING id`, closing).Scan(&first); err != nil {
		t.Fatalf("the first proposal round could not be recorded: %v", err)
	}
	var round int
	if err := p.QueryRow(ctx, `SELECT round FROM closing_proposals WHERE id=$1`, first).Scan(&round); err != nil || round != 1 {
		t.Fatalf("the round must be numbered by the database: %d %v", round, err)
	}
	_, err = p.Exec(ctx, `INSERT INTO closing_proposals(closing_id,round,proposed_payload,proposed_by_account_id)
 VALUES($1,1,'{}'::jsonb,1)`, closing)
	execRefusal(t, err, "23505")

	// Only an enabled account of the branch decides, and a rejection states why.
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='proposed' WHERE id=$1`, closing); err != nil {
		t.Fatalf("the settlement could not be proposed: %v", err)
	}
	_, err = p.Exec(ctx, `UPDATE closing_proposals SET decision='rejected',decision_reason='falta plata'
 WHERE id=$1`, first)
	execRefusal(t, err, "LC010")
	_, err = p.Exec(ctx, `UPDATE closing_proposals SET decision='rejected',decision_reason='falta plata',
 decided_by_account_id=3 WHERE id=$1`, first)
	execRefusal(t, err, "LC010")
	_, err = p.Exec(ctx, `UPDATE closing_proposals SET decision='rejected',decided_by_account_id=2
 WHERE id=$1`, first)
	execRefusal(t, err, "23514")
	if _, err := p.Exec(ctx, `UPDATE closing_proposals SET decision='rejected',decision_reason='faltó plata',
 decided_by_account_id=2 WHERE id=$1`, first); err != nil {
		t.Fatalf("the branch must be able to reject with its reason: %v", err)
	}
	var decided string
	if err := p.QueryRow(ctx, `SELECT decision||':'||decision_reason||':'||(decided_at IS NOT NULL)::text
 FROM closing_proposals WHERE id=$1`, first).Scan(&decided); err != nil ||
		decided != "rejected:faltó plata:true" {
		t.Fatalf("the rejection must be a version with author, date and reason: %q %v", decided, err)
	}

	// The rejection applies nothing, unfreezes nothing and returns the settlement to
	// the warehouse: the next round is proposed over it, with no limit of rounds.
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='rejected' WHERE id=$1`, closing); err != nil {
		t.Fatalf("the settlement could not return to the warehouse: %v", err)
	}
	var live bool
	if err := p.QueryRow(ctx, `SELECT status='rejected' AND closed_at IS NULL FROM branch_closings
 WHERE id=$1`, closing).Scan(&live); err != nil || !live {
		t.Fatalf("a rejection must not close anything: %v", err)
	}
	var second int64
	if err := p.QueryRow(ctx, `INSERT INTO closing_proposals(closing_id,round,proposed_payload,proposed_by_account_id)
 VALUES($1,1,'{"fund":"20.00"}'::jsonb,1) RETURNING id`, closing).Scan(&second); err != nil {
		t.Fatalf("a second round must be proposable after a rejection: %v", err)
	}
	if err := p.QueryRow(ctx, `SELECT round FROM closing_proposals WHERE id=$1`, second).Scan(&round); err != nil || round != 2 {
		t.Fatalf("the second round must be numbered 2: %d %v", round, err)
	}
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='proposed',counted_cash=50.00,closing_cash=20.00
 WHERE id=$1`, closing); err != nil {
		t.Fatalf("the second round could not be proposed: %v", err)
	}
	if _, err := p.Exec(ctx, `UPDATE closing_proposals SET decision='accepted',decided_by_account_id=2
 WHERE id=$1`, second); err != nil {
		t.Fatalf("the branch must be able to accept: %v", err)
	}
	if _, err := p.Exec(ctx, `UPDATE branch_closings SET status='closed' WHERE id=$1`, closing); err != nil {
		t.Fatalf("the accepted round must close the settlement: %v", err)
	}

	// Both rounds stay visible and immutable after the closure.
	var history string
	if err := p.QueryRow(ctx, `SELECT string_agg(round||':'||coalesce(decision,'-'),',' ORDER BY round)
 FROM closing_proposals WHERE closing_id=$1`, closing).Scan(&history); err != nil ||
		history != "1:rejected,2:accepted" {
		t.Fatalf("the settlement must keep its whole round history: %q %v", history, err)
	}
	_, err = p.Exec(ctx, `UPDATE closing_proposals SET proposed_payload='{}'::jsonb WHERE id=$1`, first)
	execRefusal(t, err, "LC009")
	_, err = p.Exec(ctx, `DELETE FROM closing_proposals WHERE id=$1`, first)
	execRefusal(t, err, "LC009")
	_, err = p.Exec(ctx, `TRUNCATE closing_proposals`)
	refusal(t, err)
	_, err = p.Exec(ctx, `INSERT INTO closing_proposals(closing_id,round,proposed_payload,proposed_by_account_id)
 VALUES($1,3,'{}'::jsonb,1)`, closing)
	execRefusal(t, err, "LC008")
	t.Logf("034: proposals round, reject with a reason and stay immutable")
}

// TestBranchClosingsCorrections proves S16 at the schema level on a live database: a
// closed settlement is corrected by an appended correction that states a reason and
// needs the branch's approval, one pending at a time, and nothing is reopened.
func TestBranchClosingsCorrections(t *testing.T) {
	ctx, p := closingFixture(t)
	closing := openSettlement(t, ctx, p, 2)
	countAll(t, ctx, p, closing, map[int]int{1: 10, 2: 4})

	// Only a closed settlement is corrected, and only the warehouse proposes it.
	_, err := p.Exec(ctx, `INSERT INTO closing_corrections(closing_id,reason,payload,proposed_by_account_id)
 VALUES($1,'error de conteo','{}'::jsonb,1)`, closing)
	execRefusal(t, err, "LC012")
	closeSettlement(t, ctx, p, closing, "30.00", "0.00", "0.00")
	_, err = p.Exec(ctx, `INSERT INTO closing_corrections(closing_id,reason,payload,proposed_by_account_id)
 VALUES($1,'error de conteo','{}'::jsonb,2)`, closing)
	execRefusal(t, err, "LC012")
	_, err = p.Exec(ctx, `INSERT INTO closing_corrections(closing_id,reason,payload,proposed_by_account_id)
 VALUES($1,'','{}'::jsonb,1)`, closing)
	execRefusal(t, err, "23514")
	var correction int64
	if err := p.QueryRow(ctx, `INSERT INTO closing_corrections(closing_id,reason,payload,proposed_by_account_id)
 VALUES($1,'el fondo era 10','{"fund":"10.00"}'::jsonb,1) RETURNING id`, closing).Scan(&correction); err != nil {
		t.Fatalf("the correction could not be proposed: %v", err)
	}
	_, err = p.Exec(ctx, `INSERT INTO closing_corrections(closing_id,reason,payload,proposed_by_account_id)
 VALUES($1,'otra','{}'::jsonb,1)`, closing)
	execRefusal(t, err, "23505")

	// The branch decides it: another branch's account cannot, and a rejection states
	// why while the settlement stays closed and the branch stays unfrozen.
	_, err = p.Exec(ctx, `UPDATE closing_corrections SET status='accepted',decided_by_account_id=3
 WHERE id=$1`, correction)
	execRefusal(t, err, "LC014")
	_, err = p.Exec(ctx, `UPDATE closing_corrections SET status='rejected',decided_by_account_id=2
 WHERE id=$1`, correction)
	execRefusal(t, err, "23514")
	if _, err := p.Exec(ctx, `UPDATE closing_corrections SET status='rejected',decision_reason='no corresponde',
 decided_by_account_id=2 WHERE id=$1`, correction); err != nil {
		t.Fatalf("the branch must be able to reject a correction: %v", err)
	}
	var state string
	if err := p.QueryRow(ctx, `SELECT c.status||':'||(c.decided_at IS NOT NULL)::text||':'
         ||x.status||':'||(x.closed_at IS NOT NULL)::text
         FROM closing_corrections c, branch_closings x WHERE c.id=$1 AND x.id=c.closing_id`, correction).Scan(&state); err != nil ||
		state != "rejected:true:closed:true" {
		t.Fatalf("a rejected correction must leave the closure untouched: %q %v", state, err)
	}
	var blocker bool
	if err := p.QueryRow(ctx, `SELECT branch_closure_blocker(2::smallint)`).Scan(&blocker); err != nil || blocker {
		t.Fatalf("a correction must never freeze the branch: %v %v", blocker, err)
	}
	// A decided correction is a version: it is never edited, deleted or truncated, and
	// a rejected round leaves room for the next one.
	var again int64
	if err := p.QueryRow(ctx, `INSERT INTO closing_corrections(closing_id,reason,payload,proposed_by_account_id)
 VALUES($1,'el fondo era 10','{"fund":"10.00"}'::jsonb,1) RETURNING id`, closing).Scan(&again); err != nil {
		t.Fatalf("a second correction round must be proposable: %v", err)
	}
	if _, err := p.Exec(ctx, `UPDATE closing_corrections SET status='accepted',decided_by_account_id=2
 WHERE id=$1`, again); err != nil {
		t.Fatalf("the branch must be able to accept a correction: %v", err)
	}
	_, err = p.Exec(ctx, `UPDATE closing_corrections SET payload='{}'::jsonb WHERE id=$1`, correction)
	execRefusal(t, err, "LC013")
	_, err = p.Exec(ctx, `UPDATE closing_corrections SET status='accepted' WHERE id=$1`, correction)
	execRefusal(t, err, "LC013")
	_, err = p.Exec(ctx, `DELETE FROM closing_corrections WHERE id=$1`, correction)
	execRefusal(t, err, "LC013")
	_, err = p.Exec(ctx, `TRUNCATE closing_corrections`)
	refusal(t, err)
	t.Logf("034: a closed settlement is corrected by an approved, immutable correction")
}

// refusal asserts a statement was refused, whatever SQLSTATE the guard raised: the
// guards that reuse the house immutability function raise a plain error.
func refusal(t *testing.T, err error) {
	t.Helper()
	if err == nil {
		t.Fatal("the statement must be refused")
	}
}

// execRefusalMessage asserts a refusal carries both its own SQLSTATE and the fact it
// has to name, so the surface can say which variant blocks the closure.
func execRefusalMessage(t *testing.T, err error, code, contains string) {
	t.Helper()
	var pg *pgconn.PgError
	if !errors.As(err, &pg) || pg.Code != code {
		t.Fatalf("expected SQLSTATE %s, got %v", code, err)
	}
	if !strings.Contains(pg.Message, contains) {
		t.Fatalf("the refusal must name %q, got %q", contains, pg.Message)
	}
}
