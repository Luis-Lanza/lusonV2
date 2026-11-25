package migrations_test

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/testpg"
	"luson/api/migrations"
)

// The warranty case is the document of a battery that leaves service -- returned by a client under
// warranty or found failed in the branch's own stock -- and of its journey to the warehouse, to the
// factory and back (S1, S9). The migration owns the vocabulary of the vertical (S23), the per-branch
// numeration of the case (S20) and the shape that makes the impossible combinations impossible, and
// it adds no balance of used batteries anywhere (S18).
const warrantyCaseMigration = "065_warranty_cases.sql"

// The migrations of this vertical that may raise an `LW` SQLSTATE. The list is the one place that says
// which files own the prefix, so a new file of the family joins it by name and no other file may.
const usedModelMigration = "072_used_loan_requires_known_model.sql"

// The release of the unit that is bound for the branch's sellable stock (S31): the destination of the
// unit and the condition the factory returned it in are two facts, and only the pair says whether the
// branch may sell the battery.
const unitDestinedToStockMigration = "073_unit_destined_to_stock_is_released.sql"

// TestWarrantyCasesStructure reads the embedded version exactly as PostgreSQL receives it and
// asserts the shape it installs: the case with its two exclusive entry doors, the loans with no
// identity but a model and a quantity, and the append-only history of the journey.
func TestWarrantyCasesStructure(t *testing.T) {
	b, err := migrations.Files.ReadFile(warrantyCaseMigration)
	if err != nil {
		t.Fatal("the warranty case migration must be embedded", err)
	}
	// Comments may name the untouched contract; only executable statements prove what this
	// migration does.
	sql := statements(string(b))
	for _, required := range []string{
		// The case, owned by the branch that owes the client the answer (S19).
		"CREATE TABLE warranty_cases",
		"id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY",
		"branch_location_id smallint NOT NULL REFERENCES locations(id)",
		"branch_sequence bigint NOT NULL DEFAULT 0 CHECK (branch_sequence BETWEEN 1 AND 999999999)",
		"case_number text NOT NULL DEFAULT '' CHECK (case_number ~ '^C-[1-9][0-9]{0,4}-[0-9]{6,12}$')",
		"origin text NOT NULL CHECK (origin IN ('warranty_claim','stock_defect'))",
		"phase text NOT NULL DEFAULT 'received'",
		"CHECK (phase IN ('received','in_transit','at_warehouse','at_factory','resolved','closed'))",
		"verdict text CHECK (verdict IS NULL OR verdict IN",
		"'repaired','replaced','unrepairable','not_covered','lost','refused_at_warehouse'",
		// The three units of a case and where each one ends (S11).
		"reported_destination text CHECK (reported_destination IS NULL OR reported_destination IN",
		"loan_destination text CHECK (loan_destination IS NULL OR loan_destination IN",
		"stock_destination text CHECK (stock_destination IS NULL OR stock_destination IN",
		"'customer','stock','scrap','retained_by_factory'",
		"CHECK (stock_destination IS NULL OR origin = 'stock_defect')",
		// The claimed sale and the variant: a claim reads both from the serial (S2).
		"sale_id bigint REFERENCES sales(id)",
		"variant_id integer NOT NULL REFERENCES catalog_variants(id)",
		"serial_number text CHECK (serial_number IS NULL",
		"quantity bigint CHECK (quantity IS NULL OR quantity BETWEEN 1 AND 1000000)",
		"declared_failure text NOT NULL CHECK (char_length(btrim(declared_failure)) BETWEEN 1 AND 500)",
		"created_by_account_id integer NOT NULL REFERENCES auth_accounts(id)",
		"created_at timestamptz NOT NULL DEFAULT now()",
		// Two branches never share a numeration (S20).
		"UNIQUE (branch_location_id, branch_sequence)",
		"UNIQUE (case_number)",
		"FOREIGN KEY (sale_id, variant_id) REFERENCES sale_lines(sale_id, variant_id)",
		// The two doors are exclusive by constraint, not by convention (S1).
		"CHECK ((origin = 'warranty_claim'",
		"AND sale_id IS NOT NULL AND serial_number IS NOT NULL AND quantity IS NULL)",
		"OR (origin = 'stock_defect'",
		"AND sale_id IS NULL AND serial_number IS NULL AND quantity IS NOT NULL))",

		// The loan: a model, a quantity, a source and a fate. Never a serial as identity (S5).
		"CREATE TABLE warranty_case_loans",
		"case_id bigint NOT NULL REFERENCES warranty_cases(id)",
		"loan_ordinal integer NOT NULL DEFAULT 0 CHECK (loan_ordinal BETWEEN 1 AND 100)",
		"model text NOT NULL CHECK (model ~ '^[A-Z0-9][A-Z0-9 .,_/-]{0,39}$')",
		"quantity bigint NOT NULL CHECK (quantity BETWEEN 1 AND 10000)",
		"serial_number text NOT NULL DEFAULT '' CHECK (char_length(serial_number) <= 64)",
		"source_location_id smallint NOT NULL REFERENCES locations(id)",
		"given_at timestamptz NOT NULL DEFAULT now()",
		"fate text NOT NULL DEFAULT 'open'",
		"CHECK (fate IN ('open','returned','kept_by_customer','failed','lost'))",
		// The instant of the fate: an open loan carries no date and a decided one carries it, and
		// the date is the database's, so a returned battery can be put back in its own window (S17).
		"fate_decided_at timestamptz",
		"CHECK ((fate = 'open') = (fate_decided_at IS NULL))",
		"given_by_account_id integer NOT NULL REFERENCES auth_accounts(id)",
		"PRIMARY KEY (case_id, loan_ordinal)",

		// The journey: one append-only row per tramo, with actor, date, note and the factory file
		// number the warehouse transcribes by hand (S9).
		"CREATE TABLE warranty_case_events",
		"event_ordinal integer NOT NULL DEFAULT 0 CHECK (event_ordinal BETWEEN 1 AND 1000)",
		"factory_case_number text NOT NULL DEFAULT ''",
		"actor_account_id integer NOT NULL REFERENCES auth_accounts(id)",
		"recorded_at timestamptz NOT NULL DEFAULT now()",
		"note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500)",
		"PRIMARY KEY (case_id, event_ordinal)",

		// The reads of the vertical: the branch tray, the warehouse desk, the claimed serial, the
		// loans of a window and the history of one case.
		"CREATE INDEX warranty_cases_branch_history ON warranty_cases(branch_location_id, id DESC)",
		"CREATE INDEX warranty_cases_phase_queue ON warranty_cases(phase, id)",
		"CREATE INDEX warranty_cases_claimed_serial ON warranty_cases(upper(btrim(serial_number)))",
		"CREATE INDEX warranty_case_loans_by_given_at ON warranty_case_loans(given_at DESC)",
		"CREATE INDEX warranty_case_loans_by_return ON warranty_case_loans(source_location_id, fate_decided_at)",
		"CREATE INDEX warranty_case_events_by_case ON warranty_case_events(case_id, event_ordinal)",

		// Every rule of the vertical is the database's, in triggers of its own.
		"CREATE FUNCTION admit_warranty_case() RETURNS trigger LANGUAGE plpgsql AS $$",
		"CREATE TRIGGER admit_warranty_case BEFORE INSERT OR UPDATE ON warranty_cases",
		"CREATE FUNCTION admit_warranty_case_event() RETURNS trigger LANGUAGE plpgsql AS $$",
		"CREATE TRIGGER admit_warranty_case_event BEFORE INSERT ON warranty_case_events",
		"CREATE FUNCTION advance_warranty_case() RETURNS trigger LANGUAGE plpgsql AS $$",
		"CREATE TRIGGER advance_warranty_case AFTER INSERT ON warranty_case_events",
		"CREATE FUNCTION admit_warranty_case_loan() RETURNS trigger LANGUAGE plpgsql AS $$",
		"CREATE TRIGGER admit_warranty_case_loan BEFORE INSERT ON warranty_case_loans",
		"CREATE FUNCTION guard_warranty_case_loan() RETURNS trigger LANGUAGE plpgsql AS $$",
		"CREATE TRIGGER guard_warranty_case_loan BEFORE UPDATE ON warranty_case_loans",

		// Append-only, in the style the repository already uses, including TRUNCATE.
		"CREATE TRIGGER protect_warranty_case_events BEFORE UPDATE OR DELETE ON warranty_case_events",
		"CREATE TRIGGER protect_warranty_case_events_truncate BEFORE TRUNCATE ON warranty_case_events",
		"CREATE TRIGGER protect_warranty_cases BEFORE DELETE ON warranty_cases",
		"CREATE TRIGGER protect_warranty_cases_truncate BEFORE TRUNCATE ON warranty_cases",
		"CREATE TRIGGER protect_warranty_case_loans BEFORE DELETE ON warranty_case_loans",
		"CREATE TRIGGER protect_warranty_case_loans_truncate BEFORE TRUNCATE ON warranty_case_loans",
		"FOR EACH ROW EXECUTE FUNCTION protect_pending_request()",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("the warranty case migration is incomplete: missing %s", required)
		}
	}
	// The vertical adds exactly three tables and none of them is stock of used batteries (S18): no
	// balance, no count and no ledger of its own -- the pool is derived by flow (045, T3).
	if count := strings.Count(sql, "CREATE TABLE "); count != 3 {
		t.Fatalf("the vertical adds three tables and no stock of its own, got %d", count)
	}
	for _, forbidden := range []string{
		"ALTER TABLE", "CREATE OR REPLACE", "DROP ",
		"INSERT INTO inventory_balances", "UPDATE inventory_balances",
		"INSERT INTO stock_", "INSERT INTO transfer_", "INSERT INTO purchase_",
		"DELETE FROM",
		// A serial never identifies a loan: it is unique nowhere and keys nothing (S5).
		"CREATE UNIQUE INDEX warranty_case_loans",
		"UNIQUE (model", "PRIMARY KEY (model",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("the warranty case migration must not contain %s", forbidden)
		}
	}
	// Additive in both directions: no row of any existing table is rewritten and no applied
	// function is redefined, so this version only adds.
	if regexp.MustCompile(`(?m)^(UPDATE|INSERT INTO|DELETE FROM|TRUNCATE) `).MatchString(sql) {
		t.Error("the migration must not write any row of its own")
	}
}

// TestWarrantyCasesGuards proves the rules the database owns and the codes it refuses them with:
// the claim against the sale (S2), the two doors (S1), the loan that is never an identity (S5) and
// the journey that moves only through its own append-only history (S9).
func TestWarrantyCasesGuards(t *testing.T) {
	b, err := migrations.Files.ReadFile(warrantyCaseMigration)
	if err != nil {
		t.Fatal("the warranty case migration must be embedded", err)
	}
	sql := statements(string(b))
	for _, required := range []string{
		// The branch and the account of that branch own the case, and the branch row stays locked
		// while its correlative is allocated, exactly like a sale (025).
		"IF NEW.branch_location_id <= 1 THEN",
		"SELECT deleted_at IS NULL INTO active FROM locations",
		"WHERE id=NEW.branch_location_id FOR UPDATE;",
		"OR owner_location IS DISTINCT FROM NEW.branch_location_id THEN",
		"SELECT coalesce(max(case_row.branch_sequence),0)+1 INTO next_sequence",
		"NEW.case_number := 'C-' || NEW.branch_location_id::text || '-' || lpad(next_sequence::text,6,'0');",
		// A case is born received at its branch, whatever the caller promised (S1, S9).
		"NEW.phase := 'received';",
		// The claim is read from the serial and judged against the sale (S2): a serial nobody sold,
		// a unit sold without a term, and a term that has already run out are three refusals.
		"WHERE upper(btrim(unit.serial_number))=upper(btrim(NEW.serial_number));",
		"IF claimed.warranty_months IS NULL THEN",
		"IF sold_at + claimed.warranty_months * interval '1 month' <= now() THEN",
		"NEW.sale_id := claimed.sale_id;",
		"NEW.variant_id := claimed.variant_id;",
		// What a case is about is frozen, and its phase is a copy of its last event.
		"RAISE EXCEPTION USING ERRCODE='LW010'",
		"current_setting('luson.warranty_case_event', true) IS DISTINCT FROM NEW.id::text",
		"OR pg_trigger_depth() < 2) THEN",
		"PERFORM set_config('luson.warranty_case_event', NEW.case_id::text, true);",
		"UPDATE warranty_cases SET phase=NEW.phase WHERE id=NEW.case_id;",
		// The history and the loans are numbered under the lock of their own case.
		"SELECT * INTO header FROM warranty_cases WHERE id=NEW.case_id FOR UPDATE;",
		"SELECT coalesce(max(event.event_ordinal),0)+1 INTO next_ordinal",
		"FROM warranty_case_events event WHERE event.case_id=NEW.case_id;",
		"IF NEW.phase = header.phase THEN",
		// The factory file number travels with the factory shipment and with nothing else (S9,
		// S10): a refusal at the warehouse can never register one.
		"IF (NEW.phase = 'at_factory') <> (btrim(NEW.factory_case_number) <> '') THEN",
		// A loan is frozen except for its fate, and a decided fate is final (S7).
		"RAISE EXCEPTION USING ERRCODE='LW011'",
		"IF OLD.fate <> 'open' AND NEW.fate IS DISTINCT FROM OLD.fate THEN",
		// The instant of the fate is nobody's statement but the database's, in both directions: a
		// loan that keeps its fate cannot move the date, and a fate that leaves open cannot arrive
		// with one (S17).
		"IF NEW.fate IS DISTINCT FROM OLD.fate THEN",
		"IF NEW.fate_decided_at IS NOT NULL THEN",
		"NEW.fate_decided_at := now();",
		"ELSIF NEW.fate_decided_at IS DISTINCT FROM OLD.fate_decided_at THEN",
		"RAISE EXCEPTION USING ERRCODE='LW015'",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("the warranty case guard is incomplete: missing %s", required)
		}
	}
	// The codes of this vertical use the `LW` prefix, which this repository does not use anywhere
	// else, and no number is reused (S23). The set is stated once here so a new refusal cannot
	// borrow a code silently.
	used := map[string]bool{}
	for _, match := range regexp.MustCompile(`ERRCODE='(LW[0-9]{3})'`).FindAllStringSubmatch(sql, -1) {
		used[match[1]] = true
	}
	declared := []string{
		"LW001", "LW002", "LW003", "LW004", "LW005", "LW006", "LW007",
		"LW008", "LW009", "LW010", "LW011", "LW012", "LW013", "LW014", "LW015",
	}
	got := make([]string, 0, len(used))
	for code := range used {
		got = append(got, code)
	}
	sort.Strings(got)
	if strings.Join(got, ",") != strings.Join(declared, ",") {
		t.Fatalf("the vertical states exactly its own LW codes, got %v", got)
	}
	// The prefix is this vertical's and nobody else's: the other versions of the same vertical are the
	// write-off of S16 (067), the notice and release of S14 (068), the resolution of a finding (069)
	// and the stock and the loan refusal of S24 and S25 (071), which state their own next numbers and
	// nothing of 065's.
	all, err := migrations.Files.ReadDir(".")
	if err != nil {
		t.Fatal("embedded migrations are unreadable")
	}
	for _, entry := range all {
		if !strings.HasSuffix(entry.Name(), ".sql") || entry.Name() == warrantyCaseMigration ||
			entry.Name() == writeOffMigration || entry.Name() == noticeReleaseMigration ||
			entry.Name() == stockResolutionMigration || entry.Name() == usedStockMigration ||
			entry.Name() == usedModelMigration || entry.Name() == unitDestinedToStockMigration {
			continue
		}
		version, err := migrations.Files.ReadFile(entry.Name())
		if err != nil {
			t.Fatalf("embedded migration %s is unreadable", entry.Name())
		}
		if strings.Contains(string(version), "ERRCODE='LW") {
			t.Fatalf("the LW prefix belongs to the warranty case: %s already uses it", entry.Name())
		}
	}
}

// claimCaseSQL opens a case of the first door: the serial is what the client brings, and the sale
// and the variant are the database's reading of it (S1, S2).
const claimCaseSQL = `INSERT INTO warranty_cases(branch_location_id,origin,serial_number,
 declared_failure,created_by_account_id)
 VALUES($1,'warranty_claim',$2,'No arranca el motor',$3) RETURNING id`

// defectCaseSQL opens a case of the second door: the variant and the quantity the branch found
// failed in its own shelf (S1).
const defectCaseSQL = `INSERT INTO warranty_cases(branch_location_id,origin,variant_id,quantity,
 declared_failure,created_by_account_id)
 VALUES($1,'stock_defect',$2,$3,'No retiene carga',$4) RETURNING id`

// lendSQL hands one used battery to the client of a case, from wherever that battery is (S5, S6).
const lendSQL = `INSERT INTO warranty_case_loans(case_id,model,quantity,serial_number,
 source_location_id,given_by_account_id)
 VALUES($1,$2,$3,$4,$5,$6) RETURNING loan_ordinal`

// journeySQL records one tramo of the journey with its actor and, when it is the factory shipment,
// the file number the warehouse transcribes by hand (S9).
const journeySQL = `INSERT INTO warranty_case_events(case_id,phase,factory_case_number,
 actor_account_id,note)
 VALUES($1,$2,$3,$4,$5) RETURNING event_ordinal`

// TestWarrantyCasesEntryDoorsOnALiveDatabase proves the two doors on the admitted fixture: a claim
// is judged against the sale and each refusal writes nothing while keeping its own code (S1, S2),
// and the case number is the branch's own and never the warranty numbering (S20).
func TestWarrantyCasesEntryDoorsOnALiveDatabase(t *testing.T) {
	ctx, p, productVariant := warrantyFixture(t)

	// The sales of branch 2 the claims below are judged against: one covered for twelve months, one
	// sold without a term -- a decision 031 records, not missing data -- and one whose year has run.
	covered := sellWarrantyUnit(t, ctx, p, 2, 1, "100.00", "CUB-1/1", term(12), time.Now())
	sellWarrantyUnit(t, ctx, p, 2, 1, "100.00", "SIN-GARANTIA/1", nil, time.Now())
	sellWarrantyUnit(t, ctx, p, 2, 1, "100.00", "VENCIDA/1", term(12), time.Now().AddDate(-1, -2, 0))

	// Every refusal of this door writes no case at all (S1, S2).
	empty := warrantyCaseCount(t, ctx, p)
	_, err := p.Exec(ctx, claimCaseSQL, 2, "NO-EXISTE/1", 2)
	execRefusalMessage(t, err, "LW002", "was never sold")
	_, err = p.Exec(ctx, claimCaseSQL, 2, "SIN-GARANTIA/1", 2)
	execRefusalMessage(t, err, "LW003", "without a warranty term")
	_, err = p.Exec(ctx, claimCaseSQL, 2, "VENCIDA/1", 2)
	execRefusalMessage(t, err, "LW004", "has expired")
	// The warehouse never owns a case, and no branch opens one on another branch's account.
	_, err = p.Exec(ctx, claimCaseSQL, 1, "CUB-1/1", 1)
	execRefusalMessage(t, err, "LW001", "belongs to a branch")
	_, err = p.Exec(ctx, claimCaseSQL, 2, "CUB-1/1", 3)
	execRefusalMessage(t, err, "LW001", "account of its own branch")
	// A product is counted, never serialized, so it never comes back under warranty.
	_, err = p.Exec(ctx, defectCaseSQL, 2, productVariant, 1, 2)
	execRefusalMessage(t, err, "LW005", "names a battery")
	// The shape of the row is the last authority: a claim is one battery and states no quantity, a
	// stock defect carries no serial, and a quantity is a positive whole battery (S1, S23).
	_, err = p.Exec(ctx, `INSERT INTO warranty_cases(branch_location_id,origin,serial_number,
 quantity,declared_failure,created_by_account_id)
 VALUES(2,'warranty_claim','CUB-1/1',2,'No arranca el motor',2)`)
	requireRowViolation(t, err)
	_, err = p.Exec(ctx, `INSERT INTO warranty_cases(branch_location_id,origin,variant_id,quantity,
 serial_number,declared_failure,created_by_account_id)
 VALUES(2,'stock_defect',1,2,'CUB-1/1','No retiene carga',2)`)
	requireRowViolation(t, err)
	_, err = p.Exec(ctx, defectCaseSQL, 2, 1, 0, 2)
	requireRowViolation(t, err)
	if written := warrantyCaseCount(t, ctx, p); written != empty {
		t.Fatalf("a refused entry writes no case: %d before, %d after", empty, written)
	}

	// The covered claim is admitted, and the serial is what the client brings: "cub-1/1 " is the
	// battery 031 stored as "CUB-1/1", and the sale and the variant are the database's reading.
	var claim int64
	if err := p.QueryRow(ctx, claimCaseSQL, 2, "cub-1/1 ", 2).Scan(&claim); err != nil {
		t.Fatalf("a covered claim must be admitted: %v", err)
	}
	var (
		sequence int64
		number   string
		sale     int64
		variant  int
		quantity *int64
		phase    string
		verdict  *string
	)
	if err := p.QueryRow(ctx, `SELECT branch_sequence,case_number,sale_id,variant_id,quantity,
 phase,verdict FROM warranty_cases WHERE id=$1`, claim).
		Scan(&sequence, &number, &sale, &variant, &quantity, &phase, &verdict); err != nil {
		t.Fatalf("the admitted case could not be read: %v", err)
	}
	if sale != covered || variant != 1 {
		t.Fatalf("the claim is the sale of its serial, got sale=%d variant=%d", sale, variant)
	}
	if quantity != nil {
		t.Fatalf("a claim is one battery and states no quantity, got %v", *quantity)
	}
	if sequence != 1 || number != "C-2-000001" {
		t.Fatalf("the first case of branch 2 is C-2-000001, got %d:%s", sequence, number)
	}
	if phase != "received" || verdict != nil {
		t.Fatalf("a case is born received without a verdict, got %s:%v", phase, verdict)
	}

	// The case number is its own numeration and never the warranty one (S20): the first sale of
	// branch 2 is warranty 2-000001 while its claim is case C-2-000001.
	var warrantyNumber string
	if err := p.QueryRow(ctx, `SELECT warranty_number FROM sales WHERE id=$1`, covered).
		Scan(&warrantyNumber); err != nil {
		t.Fatalf("the warranty number of the sale could not be read: %v", err)
	}
	if warrantyNumber != "2-000001" {
		t.Fatalf("the sale fixture states its own warranty number, got %s", warrantyNumber)
	}

	// Two branches never share a numeration: each counts its own cases from one, and the number
	// printed on the receipt carries the branch so both are unique in the whole installation.
	secondOfBranch2 := warrantyDefect(t, ctx, p, 2, 1, 2, 2)
	firstOfBranch3 := warrantyDefect(t, ctx, p, 3, 1, 3, 3)
	secondOfBranch3 := warrantyDefect(t, ctx, p, 3, 1, 1, 3)
	for _, expected := range []struct {
		id       int64
		sequence int64
		number   string
	}{
		{secondOfBranch2, 2, "C-2-000002"},
		{firstOfBranch3, 1, "C-3-000001"},
		{secondOfBranch3, 2, "C-3-000002"},
	} {
		var gotSequence int64
		var gotNumber string
		if err := p.QueryRow(ctx, `SELECT branch_sequence,case_number FROM warranty_cases
 WHERE id=$1`, expected.id).Scan(&gotSequence, &gotNumber); err != nil {
			t.Fatalf("the case of %s could not be read: %v", expected.number, err)
		}
		if gotSequence != expected.sequence || gotNumber != expected.number {
			t.Fatalf("a branch counts its own cases: wanted %d:%s, got %d:%s",
				expected.sequence, expected.number, gotSequence, gotNumber)
		}
	}
	if total, distinct := warrantyCaseNumbers(t, ctx, p); total != distinct {
		t.Fatalf("no two cases share a number: %d cases, %d numbers", total, distinct)
	}
}

// TestWarrantyCasesLoansAndJourneyOnALiveDatabase proves the rest of the vertical: the loan is a
// model and a quantity from wherever the battery is and moves no stock (S5, S6), several loans live
// in one case with their own fate and never open a second one (S7), the journey is an append-only
// history that owns the phase of the case (S9), and the resolution states the verdict and the
// destination of each unit inside the frozen vocabularies (S11, S23).
func TestWarrantyCasesLoansAndJourneyOnALiveDatabase(t *testing.T) {
	ctx, p, _ := warrantyFixture(t)
	sale := sellWarrantyUnit(t, ctx, p, 2, 1, "100.00", "CUB-9/1", term(12), time.Now())
	var claim int64
	if err := p.QueryRow(ctx, claimCaseSQL, 2, "CUB-9/1", 2).Scan(&claim); err != nil {
		t.Fatalf("the claim of this case must be admitted: %v", err)
	}
	defect := warrantyDefect(t, ctx, p, 3, 1, 2, 3)

	// The loan records where the used battery came from and moves nothing: a used battery is not
	// stock anywhere in this repository, so no balance and no transfer is written (S6, S18).
	balances := warrantyBalances(t, ctx, p)
	// Same model and same quantity twice, one from the warehouse and one from another branch, and
	// the same free serial text on both: two independent loans, because a serial is never identity
	// and never a key (S5).
	if ordinal := warrantyLend(t, ctx, p, claim, "YUASA NP7-12", 2, "", 2, 2); ordinal != 1 {
		t.Fatalf("the first loan of a case is 1, got %d", ordinal)
	}
	if ordinal := warrantyLend(t, ctx, p, claim, "YUASA NP7-12", 2, "USADA-1", 1, 2); ordinal != 2 {
		t.Fatalf("a second loan of the same model and quantity is its own row, got %d", ordinal)
	}
	if ordinal := warrantyLend(t, ctx, p, claim, "YUASA NP7-12", 2, "USADA-1", 3, 2); ordinal != 3 {
		t.Fatalf("a third loan from another branch is admitted, got %d", ordinal)
	}
	// The loans of one case are numbered inside that case only.
	if ordinal := warrantyLend(t, ctx, p, defect, "BOSCH S4 005", 1, "", 3, 3); ordinal != 1 {
		t.Fatalf("another case starts its own loans at 1, got %d", ordinal)
	}
	// A loan without a model is refused, and so is a quantity that is not a positive battery.
	_, err := p.Exec(ctx, lendSQL, claim, "", 1, "", 2, 2)
	requireRowViolation(t, err)
	_, err = p.Exec(ctx, lendSQL, claim, "YUASA NP7-12", 0, "", 2, 2)
	requireRowViolation(t, err)
	if got := warrantyBalances(t, ctx, p); got != balances {
		t.Fatalf("a loan moves no stock: %s became %s", balances, got)
	}
	for _, table := range []string{"transfer_requests", "transfer_request_items",
		"transfer_receipt_lines"} {
		if moved := warrantyRowCount(t, ctx, p, table); moved != 0 {
			t.Fatalf("a loan writes no transfer: %s holds %d rows", table, moved)
		}
	}

	// A failed loan is marked and replaced by another loan of the same case, never by a new case
	// (S7): its fate is decided once and the loan itself is frozen.
	if _, err := p.Exec(ctx, `UPDATE warranty_case_loans SET fate='failed'
 WHERE case_id=$1 AND loan_ordinal=1`, claim); err != nil {
		t.Fatalf("a failed loan must be markable: %v", err)
	}
	_, err = p.Exec(ctx, `UPDATE warranty_case_loans SET fate='returned'
 WHERE case_id=$1 AND loan_ordinal=1`, claim)
	execRefusalMessage(t, err, "LW012", "decided loan fate is final")
	_, err = p.Exec(ctx, `UPDATE warranty_case_loans SET model='OTRO MODELO'
 WHERE case_id=$1 AND loan_ordinal=2`, claim)
	execRefusalMessage(t, err, "LW011", "only its fate is decided")
	if ordinal := warrantyLend(t, ctx, p, claim, "YUASA NP7-12", 2, "", 2, 2); ordinal != 4 {
		t.Fatalf("the replacement is the next loan of the same case, got %d", ordinal)
	}
	var claimsOfTheSale int
	if err := p.QueryRow(ctx, `SELECT count(*) FROM warranty_cases WHERE sale_id=$1`, sale).
		Scan(&claimsOfTheSale); err != nil {
		t.Fatalf("the claim of this sale could not be counted: %v", err)
	}
	if claimsOfTheSale != 1 {
		t.Fatalf("one claim is one case: got %d", claimsOfTheSale)
	}

	// The journey: every tramo is a row with its actor and its date, and it owns the phase (S9).
	if ordinal := warrantyMove(t, ctx, p, claim, "in_transit", "", 2, "Enviada al Almacén"); ordinal != 1 {
		t.Fatalf("the first tramo of a case is 1, got %d", ordinal)
	}
	var phase, note string
	var actor int
	var recordedAt time.Time
	if err := p.QueryRow(ctx, `SELECT phase,actor_account_id,note,recorded_at FROM warranty_case_events
 WHERE case_id=$1 AND event_ordinal=1`, claim).Scan(&phase, &actor, &note, &recordedAt); err != nil {
		t.Fatalf("the tramo could not be read: %v", err)
	}
	if note != "Enviada al Almacén" || actor != 2 || recordedAt.IsZero() {
		t.Fatalf("a tramo carries its actor, its date and its note, got %s:%d:%s", note, actor, recordedAt)
	}
	if stored := warrantyPhase(t, ctx, p, claim); stored != "in_transit" {
		t.Fatalf("the phase of the case is the phase of its last tramo, got %s", stored)
	}
	// A tramo that enters the phase the case already holds is not a tramo, and it writes nothing.
	_, err = p.Exec(ctx, journeySQL, claim, "in_transit", "", 2, "otra vez")
	execRefusalMessage(t, err, "LW006", "already in")
	if moved := warrantyRowCount(t, ctx, p, "warranty_case_events"); moved != 1 {
		t.Fatalf("a refused tramo writes nothing, got %d rows", moved)
	}
	// The stored phase is a copy and never a second authority: it moves only with its own event.
	_, err = p.Exec(ctx, `UPDATE warranty_cases SET phase='at_factory' WHERE id=$1`, claim)
	execRefusalMessage(t, err, "LW009", "only with its own event")
	// What the case is about is frozen forever.
	_, err = p.Exec(ctx, `UPDATE warranty_cases SET origin='stock_defect' WHERE id=$1`, claim)
	execRefusalMessage(t, err, "LW010", "is frozen")
	// The factory file number travels with the factory shipment and with nothing else (S9, S10).
	warrantyMove(t, ctx, p, claim, "at_warehouse", "", 1, "Recibida y revisada")
	_, err = p.Exec(ctx, journeySQL, claim, "at_factory", "", 1, "Enviada a fábrica")
	execRefusalMessage(t, err, "LW007", "carries its file number")
	if ordinal := warrantyMove(t, ctx, p, claim, "at_factory", "LEGAJO-77", 1, "Enviada a fábrica"); ordinal != 3 {
		t.Fatalf("the factory shipment is the third tramo, got %d", ordinal)
	}
	_, err = p.Exec(ctx, journeySQL, claim, "resolved", "LEGAJO-77", 2, "")
	execRefusalMessage(t, err, "LW007", "and only it")
	// An event of a case that does not exist is refused before the foreign key sees it.
	_, err = p.Exec(ctx, journeySQL, 999999, "closed", "", 2, "")
	execRefusalMessage(t, err, "LW008", "persisted case")
	// The history is append-only: a tramo is written once, never corrected and never removed, and
	// neither is the case it belongs to nor the loans it lent (S9).
	for _, statement := range []string{
		`UPDATE warranty_case_events SET note='corregido' WHERE case_id=$1`,
		`DELETE FROM warranty_case_events WHERE case_id=$1`,
		`DELETE FROM warranty_cases WHERE id=$1`,
		`DELETE FROM warranty_case_loans WHERE case_id=$1`,
	} {
		if _, err := p.Exec(ctx, statement, claim); err == nil {
			t.Fatalf("a case document is never rewritten nor removed: %s", statement)
		}
	}
	if _, err := p.Exec(ctx, `TRUNCATE warranty_case_events`); err == nil {
		t.Fatal("the history of a case is never truncated, not even whole")
	}

	// The resolution states the verdict and the destination of each unit, and both come from the
	// vocabularies frozen for the whole vertical (S11, S23): a value outside the list is refused by
	// the database and not only by the application.
	_, err = p.Exec(ctx, `UPDATE warranty_cases SET verdict='refunded' WHERE id=$1`, claim)
	requireRowViolation(t, err)
	_, err = p.Exec(ctx, journeySQL, claim, "shipped", "", 2, "")
	requireRowViolation(t, err)
	// A fate outside the frozen list is refused by the row of a loan still open.
	_, err = p.Exec(ctx, `UPDATE warranty_case_loans SET fate='abandoned'
 WHERE case_id=$1 AND loan_ordinal=3`, claim)
	requireRowViolation(t, err)
	_, err = p.Exec(ctx, `INSERT INTO warranty_cases(branch_location_id,origin,variant_id,quantity,
 declared_failure,created_by_account_id)
 VALUES(2,'return',1,1,'No retiene carga',2)`)
	requireRowViolation(t, err)
	_, err = p.Exec(ctx, `UPDATE warranty_cases SET reported_destination='warehouse' WHERE id=$1`,
		claim)
	requireRowViolation(t, err)
	// A claim never had branch stock in play, so it states no destination for a shelf (S11).
	_, err = p.Exec(ctx, `UPDATE warranty_cases SET stock_destination='stock' WHERE id=$1`, claim)
	requireRowViolation(t, err)
	// The decision the factory reached lands on the case, and the release of the lent battery writes
	// its tramo with the actor and the motive of whoever authorised it (S14).
	if _, err := p.Exec(ctx, `UPDATE warranty_cases SET verdict='not_covered',
 reported_destination='scrap',loan_destination='customer' WHERE id=$1`, claim); err != nil {
		t.Fatalf("the resolution of the case must be storable: %v", err)
	}
	if _, err := p.Exec(ctx, `UPDATE warranty_case_loans SET fate='kept_by_customer'
 WHERE case_id=$1 AND loan_ordinal=2`, claim); err != nil {
		t.Fatalf("the lent battery may stay with the client: %v", err)
	}
	warrantyMove(t, ctx, p, claim, "resolved", "", 2, "Liberada a stock la reportada")
	if stored := warrantyPhase(t, ctx, p, claim); stored != "resolved" {
		t.Fatalf("the case is resolved, got %s", stored)
	}
	// The stock defect does state the destination of the shelf it left.
	if _, err := p.Exec(ctx, `UPDATE warranty_cases SET verdict='replaced',
 stock_destination='stock' WHERE id=$1`, defect); err != nil {
		t.Fatalf("a replaced stock defect states the shelf it returns to: %v", err)
	}
	// Nothing of this vertical ever became stock of used batteries (S18): the balance matrix of the
	// fixture is exactly the one it started with, after four loans and seven tramos.
	if got := warrantyBalances(t, ctx, p); got != balances {
		t.Fatalf("the vertical creates no balance of used batteries: %s became %s", balances, got)
	}
	if used := warrantyRowCount(t, ctx, p, "purchase_used_lines"); used != 0 {
		t.Fatalf("the vertical buys no used battery of its own, got %d lines", used)
	}
}

// TestWarrantyCasesLoanFateIsDated proves the fact the used pool reads (S17): a loan is open and
// undated, and the instant its fate leaves open the database records when, so a battery that came
// back can be put back in the window it came back in. The instant is the database's in both
// directions -- an open loan cannot state one and a decided loan cannot be undated -- and a refused
// statement writes nothing.
func TestWarrantyCasesLoanFateIsDated(t *testing.T) {
	ctx, p, _ := warrantyFixture(t)
	claim := warrantyDefect(t, ctx, p, 2, 1, 1, 2)
	// A loan is what the counter handed over, so it is born open and undated whatever the caller
	// states: what became of it is decided afterwards, and by then the date is the database's.
	var (
		ordinal   int
		fate      string
		decidedAt *time.Time
	)
	if err := p.QueryRow(ctx, `INSERT INTO warranty_case_loans(case_id,model,quantity,fate,
 fate_decided_at,source_location_id,given_by_account_id)
 VALUES($1,'NS60ZL',1,'kept_by_customer',now(),2,2) RETURNING loan_ordinal,fate,fate_decided_at`,
		claim).Scan(&ordinal, &fate, &decidedAt); err != nil {
		t.Fatalf("the loan must be admitted: %v", err)
	}
	if fate != "open" || decidedAt != nil {
		t.Fatalf("a loan is born open and undated, got %s:%v", fate, decidedAt)
	}
	var givenAt time.Time
	if err := p.QueryRow(ctx, `SELECT given_at FROM warranty_case_loans
 WHERE case_id=$1 AND loan_ordinal=$2`, claim, ordinal).Scan(&givenAt); err != nil {
		t.Fatalf("the loan could not be read: %v", err)
	}
	// The instant the fate leaves open, the row states when: one statement from the counter, and no
	// date in it.
	if _, err := p.Exec(ctx, `UPDATE warranty_case_loans SET fate='returned'
 WHERE case_id=$1 AND loan_ordinal=$2`, claim, ordinal); err != nil {
		t.Fatalf("a returned loan must be markable: %v", err)
	}
	if err := p.QueryRow(ctx, `SELECT fate,fate_decided_at FROM warranty_case_loans
 WHERE case_id=$1 AND loan_ordinal=$2`, claim, ordinal).Scan(&fate, &decidedAt); err != nil {
		t.Fatalf("the decided loan could not be read: %v", err)
	}
	if fate != "returned" || decidedAt == nil || decidedAt.Before(givenAt) {
		t.Fatalf("a decided loan states when it was decided, got %s:%v", fate, decidedAt)
	}
	decided := *decidedAt
	// The date is never the caller's, in either direction: it cannot arrive with the fate that
	// leaves open, it cannot be stated on a loan that is still open, and it cannot be moved on a
	// loan whose fate is already decided.
	other := warrantyLend(t, ctx, p, claim, "NS60ZL", 1, "", 2, 2)
	_, err := p.Exec(ctx, `UPDATE warranty_case_loans SET fate='kept_by_customer',
 fate_decided_at=now() - interval '1 day' WHERE case_id=$1 AND loan_ordinal=$2`, claim, other)
	execRefusalMessage(t, err, "LW015", "never the instant")
	_, err = p.Exec(ctx, `UPDATE warranty_case_loans SET fate_decided_at=now()
 WHERE case_id=$1 AND loan_ordinal=$2`, claim, other)
	execRefusalMessage(t, err, "LW015", "never the instant")
	_, err = p.Exec(ctx, `UPDATE warranty_case_loans SET fate_decided_at=now()
 WHERE case_id=$1 AND loan_ordinal=$2`, claim, ordinal)
	execRefusalMessage(t, err, "LW015", "never the instant")
	// Nothing of the three refusals was written: the open loan is still open and undated, and the
	// decided one still states the instant of its own decision.
	if err := p.QueryRow(ctx, `SELECT fate,fate_decided_at FROM warranty_case_loans
 WHERE case_id=$1 AND loan_ordinal=$2`, claim, other).Scan(&fate, &decidedAt); err != nil {
		t.Fatalf("the open loan could not be read: %v", err)
	}
	if fate != "open" || decidedAt != nil {
		t.Fatalf("a refused statement leaves the loan open and undated, got %s:%v", fate, decidedAt)
	}
	if err := p.QueryRow(ctx, `SELECT fate_decided_at FROM warranty_case_loans
 WHERE case_id=$1 AND loan_ordinal=$2`, claim, ordinal).Scan(&decidedAt); err != nil {
		t.Fatalf("the decided loan could not be read: %v", err)
	}
	if decidedAt == nil || !decidedAt.Equal(decided) {
		t.Fatalf("the instant of a decision is never rewritten, got %v want %v", decidedAt, decided)
	}
	t.Logf("065: a loan is dated by the database the instant its fate leaves open")
}

// TestUnitDestinedToStockShape reads the embedded version exactly as PostgreSQL receives it: it proves
// the file restates the two functions of the vertical forward instead of adding a phase or a trigger,
// names the pair `destination + verdict` once, and states the one code of its own (S23, S31).
func TestUnitDestinedToStockShape(t *testing.T) {
	b, err := migrations.Files.ReadFile(unitDestinedToStockMigration)
	if err != nil {
		t.Fatal("the unit destined to stock migration must be embedded", err)
	}
	sql := statements(string(b))
	for _, required := range []string{
		// The pair is named once and read by the guard and by the release.
		"CREATE FUNCTION warranty_case_unit_bound_for_stock(case_row warranty_cases) RETURNS boolean",
		"SELECT case_row.origin = 'warranty_claim'",
		"AND case_row.reported_destination = 'stock'",
		"AND case_row.verdict IN ('repaired','replaced')",
		// The two facts 068 and 069 own are narrowed forward by restating them whole, so each keeps
		// exactly one authority.
		"CREATE OR REPLACE FUNCTION admit_warranty_case_event() RETURNS trigger LANGUAGE plpgsql AS $$",
		"CREATE OR REPLACE FUNCTION release_case_unit_to_stock() RETURNS trigger LANGUAGE plpgsql AS $$",
		// The close of the case bound for stock is the release's, in both directions.
		"IF NEW.kind='phase' AND NEW.phase='closed' AND warranty_case_unit_bound_for_stock(header) THEN",
		"ELSIF NEW.kind='release' AND warranty_case_unit_bound_for_stock(header) THEN",
		"UPDATE inventory_balances SET existing=existing+1",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("the unit destined to stock is released: missing %s", required)
		}
	}
	// It restates what it narrows and states one new number, which is the vertical's next one (S23).
	used := map[string]bool{}
	for _, match := range regexp.MustCompile(`ERRCODE='(LW[0-9]{3})'`).FindAllStringSubmatch(sql, -1) {
		used[match[1]] = true
	}
	declared := []string{"LW006", "LW007", "LW008", "LW019", "LW020", "LW021", "LW022",
		"LW023", "LW024", "LW025", "LW026", "LW030", "LW031", "LW035"}
	got := make([]string, 0, len(used))
	for code := range used {
		got = append(got, code)
	}
	sort.Strings(got)
	if strings.Join(got, ",") != strings.Join(declared, ",") {
		t.Fatalf("the release restates the codes it narrows and states its own, got %v", got)
	}
	// Additive in the shape it adds: two functions restated, one declared, no table, no column, no
	// trigger of its own and no row of any document rewritten.
	for _, forbidden := range []string{
		"CREATE TABLE", "ALTER TABLE", "CREATE TRIGGER", "DROP ",
		"INSERT INTO inventory_balances", "INSERT INTO stock_", "INSERT INTO transfer_",
		"DELETE FROM",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("the release of the unit bound for stock must not contain %s", forbidden)
		}
	}
	if regexp.MustCompile(`(?m)^(UPDATE|INSERT INTO|DELETE FROM|TRUNCATE) `).MatchString(sql) {
		t.Error("the migration must not write any row of its own")
	}
	// The file documents the decision it takes, so the next reader does not reconstruct it.
	for _, documented := range []string{
		"S31", "S14", "S23", "068", "069", "071", "LW035", "verdict", "stock",
		"inventory_balances", "closed", "pool de usadas",
	} {
		if !strings.Contains(string(b), documented) {
			t.Errorf("073 must document its own decision: %s", documented)
		}
	}
}

// TestUnitDestinedToStockIsReleasedOnALiveDatabase proves S31 on the admitted fixture. The rule is the
// pair of two facts: a claim resolved `repaired` or `replaced` with its unit destined to the branch's
// shelf is sellable stock the release sells once and the act that closes the case; the same destination
// on any other verdict is the damaged battery of the used pool (071), which is still refused with
// LW025 and writes nothing. The customer path keeps closing with its delivery tramo.
func TestUnitDestinedToStockIsReleasedOnALiveDatabase(t *testing.T) {
	ctx, p := unitDestinedToStockFixture(t)
	claim := coveredClaim(t, ctx, p)
	reachedResolved(t, ctx, p, claim)
	if _, err := p.Exec(ctx, `UPDATE warranty_cases SET verdict='repaired',
 reported_destination='stock',loan_destination='customer' WHERE id=$1`, claim); err != nil {
		t.Fatalf("the resolution of the claim could not be stated: %v", err)
	}
	before := writeOffBalances(t, ctx, p)
	// The usable unit of this case never leaves with the client: the tramo that closes the case is
	// refused, because closing it is asserting a handover that did not happen (S31).
	_, err := p.Exec(ctx, closeCaseSQL, claim, 2, "Entregada al cliente")
	execRefusalMessage(t, err, "LW035", "release closes it")
	if phase := warrantyPhase(t, ctx, p, claim); phase != "resolved" {
		t.Fatalf("a refused close never moves the case, got %s", phase)
	}
	if got := writeOffBalances(t, ctx, p); got != before {
		t.Fatalf("a refused close writes no stock, got %s", got)
	}
	// The release requires the notice, and the release of this case is the act that closes it: a
	// release that states the phase the case already holds would leave the case with no act left.
	if _, err := p.Exec(ctx, releaseSQL, claim, "resolved", 1, "El cliente no la retira"); err == nil {
		t.Fatal("the release of a case bound for stock requires its notice")
	}
	if _, err := p.Exec(ctx, noticeSQL, claim, "resolved", 2, "Avisado el cliente"); err != nil {
		t.Fatalf("the branch registers the notice of its own case: %v", err)
	}
	_, err = p.Exec(ctx, releaseSQL, claim, "resolved", 1, "El cliente no la retira")
	execRefusalMessage(t, err, "LW035", "bound for stock")
	if phase := warrantyPhase(t, ctx, p, claim); phase != "resolved" {
		t.Fatalf("a refused release never moves the case, got %s", phase)
	}
	if _, err := p.Exec(ctx, releaseSQL, claim, "closed", 1, "El cliente no la retira"); err != nil {
		t.Fatalf("the warehouse releases the unit of a notified case: %v", err)
	}
	if phase := warrantyPhase(t, ctx, p, claim); phase != "closed" {
		t.Fatalf("the release closes the case bound for stock, got %s", phase)
	}
	// The unit crosses from custody to the branch's sellable stock once, and nowhere else.
	released := writeOffBalances(t, ctx, p)
	if released == before {
		t.Fatalf("the release sells the unit of the case, %s became %s", before, released)
	}
	_, err = p.Exec(ctx, releaseSQL, claim, "closed", 1, "La libero otra vez")
	execRefusalMessage(t, err, "LW019", "release")
	if got := writeOffBalances(t, ctx, p); got != released {
		t.Fatalf("a refused second release moves no balance, got %s", got)
	}

	// The other side of the pair: the same destination on a verdict that did not give a usable battery
	// back is the damaged unit of the used pool, and the branch never sells it (S11, S31, 071).
	damaged := coveredClaim(t, ctx, p)
	reachedResolved(t, ctx, p, damaged)
	if _, err := p.Exec(ctx, `UPDATE warranty_cases SET verdict='not_covered',
 reported_destination='stock',loan_destination='customer' WHERE id=$1`, damaged); err != nil {
		t.Fatalf("the refusal of the factory could not be stated: %v", err)
	}
	if _, err := p.Exec(ctx, noticeSQL, damaged, "resolved", 2, "Avisado el cliente"); err != nil {
		t.Fatalf("the branch registers the notice of the second case: %v", err)
	}
	// The sale of the second claim moved the shelf, so the refused release is compared against the
	// matrix it found and not against the one of the first case.
	poolShelf := writeOffBalances(t, ctx, p)
	_, err = p.Exec(ctx, releaseSQL, damaged, "resolved", 1, "La dañada al pool")
	execRefusalMessage(t, err, "LW025", "no unit")
	if got := writeOffBalances(t, ctx, p); got != poolShelf {
		t.Fatalf("a refused release writes no stock, got %s", got)
	}
	// The damaged unit never enters sellable stock, so its case keeps the closing act it always had:
	// the branch closes it with the tramo of its journey, exactly as before this version.
	if _, err := p.Exec(ctx, closeCaseSQL, damaged, 2, "Las dañadas al pool de usadas"); err != nil {
		t.Fatalf("the used-pool case keeps closing with its tramo: %v", err)
	}
	if phase := warrantyPhase(t, ctx, p, damaged); phase != "closed" {
		t.Fatalf("the used-pool case is closed, got %s", phase)
	}
	t.Logf("073: the pair destination + verdict decides whether the branch may sell the unit")
}

// unitDestinedToStockFixture is the whole prefix of this vertical, the accounts, the branch stock and
// the price the claim of S31 needs, applied up to this version so the guard it tests is the one 073
// installs.
func unitDestinedToStockFixture(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	applyMigrationRange(t, ctx, p, 73)
	seedPrefixCatalog(t, ctx, p)
	if _, err := p.Exec(ctx, `INSERT INTO auth_accounts(location_id,username,password_hash)
 VALUES(1,'almacen','x'),(2,'sucursal_a','x'),(3,'sucursal_b','x')`); err != nil {
		t.Fatal("the accounts could not be provisioned")
	}
	if _, err := p.Exec(ctx, `INSERT INTO inventory_balances(location_id,variant_id,existing,reserved)
 VALUES(2,1,10,0),(3,1,10,0)`); err != nil {
		t.Fatal("the branch stock could not be provisioned")
	}
	if _, err := p.Exec(ctx, `INSERT INTO branch_prices(branch_location_id,catalog_entry_id,min_price,
 suggested_price,updated_by_account_id) VALUES(2,1,0.01,100.00,1)`); err != nil {
		t.Fatal("the branch prices could not be configured")
	}
	return ctx, p
}

// warrantyFixture is the established database fixture of this vertical: an isolated PostgreSQL
// database with every embedded migration applied, the prefix catalogue, one account per location,
// the branch stock and the price a battery sale needs, and one product of the other kind, so the
// case's own "batteries only" rule has something to refuse.
func warrantyFixture(t *testing.T) (context.Context, *pgxpool.Pool, int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	applyMigrationRange(t, ctx, p, 65)
	seedPrefixCatalog(t, ctx, p)
	if _, err := p.Exec(ctx, `INSERT INTO auth_accounts(location_id,username,password_hash)
 VALUES(1,'almacen','x'),(2,'sucursal_a','x'),(3,'sucursal_b','x')`); err != nil {
		t.Fatal("the accounts could not be provisioned")
	}
	var product int64
	if err := p.QueryRow(ctx, `INSERT INTO catalog_entries(kind,name) VALUES('other','Agua acidulada')
 RETURNING id`).Scan(&product); err != nil {
		t.Fatalf("the product fixture failed: %v", err)
	}
	var productVariant int
	if err := p.QueryRow(ctx, `INSERT INTO catalog_variants(catalog_entry_id) VALUES($1) RETURNING id`,
		product).Scan(&productVariant); err != nil {
		t.Fatalf("the product variant fixture failed: %v", err)
	}
	if _, err := p.Exec(ctx, `INSERT INTO inventory_balances(location_id,variant_id,existing,reserved)
 VALUES(2,1,10,0),(3,1,10,0)`); err != nil {
		t.Fatalf("the branch stock could not be provisioned: %v", err)
	}
	if _, err := p.Exec(ctx, `INSERT INTO branch_prices(branch_location_id,catalog_entry_id,min_price,
 suggested_price,updated_by_account_id) VALUES(2,1,0.01,100.00,1)`); err != nil {
		t.Fatalf("the branch prices could not be configured: %v", err)
	}
	return ctx, p, productVariant
}

// term is the warranty the seller states on a sold unit, or nil for a battery sold without one.
func term(months int) *int {
	return &months
}

// warrantySale records one battery sale of one branch with the term the seller stated and the date
// it was registered: exactly the two facts a claim is judged against (S2).
func sellWarrantyUnit(t *testing.T, ctx context.Context, p *pgxpool.Pool, branch, variant int,
	price, serial string, months *int, soldAt time.Time) int64 {
	t.Helper()
	tx, err := p.Begin(ctx)
	if err != nil {
		t.Fatalf("the sale transaction could not start: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var id int64
	if err := tx.QueryRow(ctx, `INSERT INTO sales(branch_location_id,cash_amount,customer_name,
 customer_phone,customer_document,total,created_by_account_id,created_at)
 VALUES($1,$2::numeric,'Cliente de garantía','700-00000','CI-123456',$2::numeric,
   (SELECT id FROM auth_accounts WHERE location_id=$1),$3) RETURNING id`,
		branch, price, soldAt).Scan(&id); err != nil {
		t.Fatalf("the sale header could not be stored: %v", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO sale_lines(sale_id,variant_id,quantity,unit_price)
 VALUES($1,$2,1,$3::numeric)`, id, variant, price); err != nil {
		t.Fatalf("the sale line could not be stored: %v", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO sale_units(sale_id,variant_id,unit_ordinal,serial_number,
 warranty_months) VALUES($1,$2,1,$3,$4)`, id, variant, serial, months); err != nil {
		t.Fatalf("the sold unit could not be stored: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("the sale must commit: %v", err)
	}
	return id
}

// warrantyDefect opens a stock defect of one branch and returns its id, so a test only states the
// case it is interested in.
func warrantyDefect(t *testing.T, ctx context.Context, p *pgxpool.Pool, branch, variant int,
	quantity int64, account int) int64 {
	t.Helper()
	var id int64
	if err := p.QueryRow(ctx, defectCaseSQL, branch, variant, quantity, account).Scan(&id); err != nil {
		t.Fatalf("the stock defect of branch %d must be admitted: %v", branch, err)
	}
	return id
}

// warrantyLend hands one used battery to the client of a case and states the ordinal the database
// allocated for it.
func warrantyLend(t *testing.T, ctx context.Context, p *pgxpool.Pool, claim int64, model string,
	quantity int64, serial string, source int, account int) int {
	t.Helper()
	var ordinal int
	if err := p.QueryRow(ctx, lendSQL, claim, model, quantity, serial, source, account).
		Scan(&ordinal); err != nil {
		t.Fatalf("the loan of %s must be admitted: %v", model, err)
	}
	return ordinal
}

// warrantyMove records one tramo of the journey and returns the ordinal the database allocated.
func warrantyMove(t *testing.T, ctx context.Context, p *pgxpool.Pool, claim int64, phase,
	factoryCaseNumber string, actor int, note string) int {
	t.Helper()
	var ordinal int
	err := p.QueryRow(ctx, journeySQL, claim, phase, factoryCaseNumber, actor, note).Scan(&ordinal)
	if err != nil {
		t.Fatalf("the tramo %s must be admitted: %v", phase, err)
	}
	return ordinal
}

// warrantyPhase reads the phase the case stores, which is the phase of its last tramo.
func warrantyPhase(t *testing.T, ctx context.Context, p *pgxpool.Pool, claim int64) string {
	t.Helper()
	var phase string
	if err := p.QueryRow(ctx, `SELECT phase FROM warranty_cases WHERE id=$1`, claim).
		Scan(&phase); err != nil {
		t.Fatalf("the phase of the case could not be read: %v", err)
	}
	return phase
}

// warrantyCaseCount is the size of the whole case table, which is what "writes no case" means.
func warrantyCaseCount(t *testing.T, ctx context.Context, p *pgxpool.Pool) int {
	t.Helper()
	return warrantyRowCount(t, ctx, p, "warranty_cases")
}

// warrantyCaseNumbers reads how many cases exist and how many distinct numbers they state: the two
// are equal exactly when no two branches share a numeration (S20).
func warrantyCaseNumbers(t *testing.T, ctx context.Context, p *pgxpool.Pool) (int, int) {
	t.Helper()
	var total, distinct int
	if err := p.QueryRow(ctx, `SELECT count(*),count(DISTINCT case_number) FROM warranty_cases`).
		Scan(&total, &distinct); err != nil {
		t.Fatalf("the case numbers could not be counted: %v", err)
	}
	return total, distinct
}

// warrantyRowCount counts the rows of one table of the fixture.
func warrantyRowCount(t *testing.T, ctx context.Context, p *pgxpool.Pool, table string) int {
	t.Helper()
	var rows int
	if err := p.QueryRow(ctx, `SELECT count(*) FROM `+table).Scan(&rows); err != nil {
		t.Fatalf("the rows of %s could not be counted: %v", table, err)
	}
	return rows
}

// warrantyBalances is the whole stock matrix of the fixture, in one comparable string.
func warrantyBalances(t *testing.T, ctx context.Context, p *pgxpool.Pool) string {
	t.Helper()
	rows, err := p.Query(ctx, `SELECT location_id,variant_id,existing,reserved
 FROM inventory_balances ORDER BY location_id,variant_id`)
	if err != nil {
		t.Fatalf("the stock matrix could not be read: %v", err)
	}
	defer rows.Close()
	matrix := make([]string, 0, 8)
	for rows.Next() {
		var location, variant int
		var existing, reserved int64
		if err := rows.Scan(&location, &variant, &existing, &reserved); err != nil {
			t.Fatalf("a balance row could not be read: %v", err)
		}
		matrix = append(matrix, fmt.Sprintf("%d:%d=%d/%d", location, variant, existing, reserved))
	}
	if rows.Err() != nil {
		t.Fatalf("the stock matrix could not be read: %v", rows.Err())
	}
	return strings.Join(matrix, ",")
}

// requireRowViolation asserts the row itself refused the statement: the shape of a case, of a loan
// and of the frozen vocabularies is carried by constraints and not only by triggers (S1, S5, S23).
func requireRowViolation(t *testing.T, err error) {
	t.Helper()
	var violation *pgconn.PgError
	if !errors.As(err, &violation) || violation.Code != "23514" {
		t.Fatalf("the shape of the row must refuse this statement, got %v", err)
	}
}
