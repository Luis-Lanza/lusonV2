package migrations_test

import (
	"context"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/testpg"
	"luson/api/migrations"
)

// The notice the branch registers and the release the warehouse authorises are not phases (S14,
// S19, S23). They are two facts of the same append-only history, stated by a `kind` of their own
// beside the tramo that moves the case, so 065's six phases stay exactly as they were frozen and a
// notice never reads as a step of the journey.
const noticeReleaseMigration = "068_warranty_case_notice_and_release.sql"

// noticeSQL and releaseSQL state the two facts of S14 on the history of a case: the actor and the
// note are the caller's, and the phase is the phase the case already holds because neither of them
// moves the case.
const noticeSQL = `INSERT INTO warranty_case_events(case_id,kind,phase,factory_case_number,
 actor_account_id,note) VALUES($1,'notice',$2,'',$3,$4) RETURNING event_ordinal`

const releaseSQL = `INSERT INTO warranty_case_events(case_id,kind,phase,factory_case_number,
 actor_account_id,note) VALUES($1,'release',$2,'',$3,$4) RETURNING event_ordinal`

// closeCaseSQL is the tramo that closes the case: the branch delivers the exchange and the
// warehouse never does (S19).
const closeCaseSQL = `INSERT INTO warranty_case_events(case_id,kind,phase,factory_case_number,
 actor_account_id,note) VALUES($1,'phase','closed','',$2,$3) RETURNING event_ordinal`

// TestNoticeReleaseShape reads the embedded version exactly as PostgreSQL receives it. It proves the
// file declares the kind of a tramo, narrows 065's LW006 instead of adding a phase, states the LW
// codes of its own and writes the balance in one statement, the mirror of the write-off of 067.
func TestNoticeReleaseShape(t *testing.T) {
	b, err := migrations.Files.ReadFile(noticeReleaseMigration)
	if err != nil {
		t.Fatal("the notice and release migration must be embedded", err)
	}
	// Comments may name the untouched contract; only executable statements prove what this
	// migration does.
	sql := statements(string(b))
	for _, required := range []string{
		// One history, and the kind is what tells a tramo from a fact that does not move the case
		// (S14, S23).
		"ALTER TABLE warranty_case_events",
		"ADD COLUMN kind text NOT NULL DEFAULT 'phase'",
		"CHECK (kind IN ('phase','notice','release'))",
		// A case registers its notice once and is released once (S14).
		"CREATE UNIQUE INDEX warranty_case_events_one_notice",
		"WHERE kind='notice';",
		"CREATE UNIQUE INDEX warranty_case_events_one_release",
		"WHERE kind='release';",
		// 065's guard is narrowed forward, never edited in place: the whole function is restated, so
		// the order of a tramo keeps one single authority.
		"CREATE OR REPLACE FUNCTION admit_warranty_case_event() RETURNS trigger LANGUAGE plpgsql AS $$",
		// A tramo of the journey still changes the phase, and a notice or a release never does
		// (LW006 keeps its number).
		"IF NEW.kind='phase' THEN",
		"IF NEW.phase <> header.phase THEN",
		// The factory file number still travels with the factory shipment and with nothing else.
		"IF (NEW.kind='phase' AND NEW.phase='at_factory')",
		// The two actors of S19 and S14: the notice is the branch's, the release the warehouse's.
		"SELECT location_id,enabled INTO actor_location,actor_enabled",
		"IF actor_location IS DISTINCT FROM header.branch_location_id THEN",
		"IF actor_location <> 1 THEN",
		// And what gates one with the other: a release requires a recorded notice, and neither is
		// stated before the factory answered.
		"NOT EXISTS (SELECT 1 FROM warranty_case_events notice_row",
		"IF header.phase NOT IN ('resolved','closed') THEN",
		// The branch owns the case and closes it; the warehouse only moves the battery (S19).
		"IF NEW.kind='phase' AND NEW.phase='closed' THEN",
		// The release is the exact mirror of 067's write-off: one balance update, of the case's own
		// branch and its own variant, inside the transaction of the event.
		"CREATE FUNCTION release_case_unit_to_stock() RETURNS trigger LANGUAGE plpgsql AS $$",
		"IF NEW.kind <> 'release' THEN",
		"IF header.origin = 'stock_defect' THEN",
		"UPDATE inventory_balances SET existing=existing+units",
		"WHERE location_id=header.branch_location_id AND variant_id=header.variant_id;",
		"CREATE TRIGGER release_case_unit_to_stock AFTER INSERT ON warranty_case_events",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("the notice and release migration is incomplete: missing %s", required)
		}
	}
	// The release is one statement of one function, exactly like the write-off it mirrors: it invents
	// no table, no document of the warehouse and no second stock write.
	if count := strings.Count(sql, "UPDATE inventory_balances"); count != 1 {
		t.Fatalf("the release is one balance update and no more, got %d", count)
	}
	for _, forbidden := range []string{
		"CREATE TABLE", "INSERT INTO stock_", "INSERT INTO transfer_",
		"INSERT INTO warranty_cases", "UPDATE stock_", "DELETE FROM", "DROP ",
		"ALTER TABLE inventory_balances", "ALTER TABLE warranty_cases",
		// No new phase: S23 froze six, and a notice is not one of them.
		"CHECK (phase IN (",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("the notice and release migration must not contain %s", forbidden)
		}
	}
	// The codes of this file are this vertical's and never a reused number (S23): 065 states LW001 to
	// LW015 and 067 states LW016 to LW018, so these are the next ones.
	used := map[string]bool{}
	for _, match := range regexp.MustCompile(`ERRCODE='(LW[0-9]{3})'`).FindAllStringSubmatch(sql, -1) {
		used[match[1]] = true
	}
	// The guard of 065 is restated whole, so it keeps its own LW006, LW007 and LW008 and states the
	// next numbers of the vertical for the facts it adds.
	declared := []string{"LW006", "LW007", "LW008",
		"LW019", "LW020", "LW021", "LW022", "LW023", "LW024", "LW025", "LW026"}
	got := make([]string, 0, len(used))
	for code := range used {
		got = append(got, code)
	}
	sort.Strings(got)
	if strings.Join(got, ",") != strings.Join(declared, ",") {
		t.Fatalf("the notice and release states 065's three codes and its own eight, got %v", got)
	}
	entries, err := migrations.Files.ReadDir(".")
	if err != nil {
		t.Fatal("embedded migrations are unreadable")
	}
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".sql") || entry.Name() == noticeReleaseMigration {
			continue
		}
		version, err := migrations.Files.ReadFile(entry.Name())
		if err != nil {
			t.Fatalf("embedded migration %s is unreadable", entry.Name())
		}
		// A later version narrows this guard forward by restating it whole, exactly as this file restated
		// 065's, so it states these same codes again on purpose. What is never reused is a number by a
		// version that adds a fact of its own.
		if strings.Contains(string(version),
			"CREATE OR REPLACE FUNCTION admit_warranty_case_event()") {
			continue
		}
		for code := range used {
			// 065 states LW006, LW007 and LW008 itself: narrowing its guard restates them, and the
			// other versions of this vertical never reuse the numbers this file adds.
			if code == "LW006" || code == "LW007" || code == "LW008" {
				continue
			}
			if strings.Contains(string(version), "ERRCODE='"+code+"'") {
				t.Fatalf("%s reuses the code %s of the notice and release", entry.Name(), code)
			}
		}
	}
	// The file documents the decision it takes, so the next reader does not reconstruct it.
	for _, documented := range []string{
		"S14", "S19", "S13", "S23", "065", "067", "LW006", "notice", "release", "custodia",
		"inventory_balances", "resolved",
	} {
		if !strings.Contains(string(b), documented) {
			t.Errorf("the notice and release must document its own decision: %s", documented)
		}
	}
}

// TestNoticeAndReleaseOnALiveDatabase proves the split of S14 and S19 on the admitted fixture: the
// branch registers the notice and the warehouse authorises the release, the release requires a
// recorded notice, neither is stated before the factory answered, the case is released once, and the
// tramo that closes the case is the branch's.
func TestNoticeAndReleaseOnALiveDatabase(t *testing.T) {
	ctx, p := noticeReleaseFixture(t)
	claim := coveredClaim(t, ctx, p)
	// The factory answered the claim and the repaired battery waits for the client at the branch
	// (S13): the reported unit is destined to the customer, so it is the unit in custody.
	reachedResolved(t, ctx, p, claim)
	if _, err := p.Exec(ctx, `UPDATE warranty_cases SET verdict='repaired',
 reported_destination='customer',loan_destination='stock' WHERE id=$1`, claim); err != nil {
		t.Fatalf("the resolution of the claim could not be stated: %v", err)
	}
	// The notice is the branch's, and the warehouse never registers one (S19).
	_, err := p.Exec(ctx, noticeSQL, claim, "resolved", 1, "Avisado el cliente")
	execRefusalMessage(t, err, "LW022", "branch that owns it")
	// Neither the notice nor the release exists before the factory answered: a case still in its
	// journey has no unit back to notify about and none to release (S14).
	pending := coveredClaim(t, ctx, p)
	_, err = p.Exec(ctx, noticeSQL, pending, "received", 2, "Avisado el cliente")
	execRefusalMessage(t, err, "LW021", "factory")
	_, err = p.Exec(ctx, releaseSQL, pending, "received", 1, "Liberada a stock")
	execRefusalMessage(t, err, "LW021", "factory")
	// A release without a recorded notice is refused, not silently ignored (S14).
	reachedResolved(t, ctx, p, pending)
	if _, err := p.Exec(ctx, `UPDATE warranty_cases SET verdict='repaired',
 reported_destination='customer',loan_destination='stock' WHERE id=$1`, pending); err != nil {
		t.Fatalf("the resolution of the second claim could not be stated: %v", err)
	}
	_, err = p.Exec(ctx, releaseSQL, pending, "resolved", 1, "Custodia vencida")
	execRefusalMessage(t, err, "LW020", "recorded notice")

	// The notice of the branch is one fact of the history: it enters no phase, it is never repeated,
	// and the case keeps the phase it had.
	if _, err := p.Exec(ctx, noticeSQL, claim, "resolved", 2, "Avisado el cliente"); err != nil {
		t.Fatalf("the branch registers the notice of its own case: %v", err)
	}
	if phase := warrantyPhase(t, ctx, p, claim); phase != "resolved" {
		t.Fatalf("a notice never moves the case, got %s", phase)
	}
	_, err = p.Exec(ctx, noticeSQL, claim, "resolved", 2, "Avisado otra vez")
	execRefusalMessage(t, err, "LW019", "notice")
	// The release is the warehouse's: a branch account never authorises one (S19).
	_, err = p.Exec(ctx, releaseSQL, claim, "resolved", 2, "La sucursal libera")
	execRefusalMessage(t, err, "LW023", "warehouse")
	// With the notice registered the warehouse authorises the release, and the unit crosses back from
	// custody to sellable stock exactly once: the mirror of the write-off of 067. The shelf of the
	// branch is read right before the release, so the assertion states the one unit it returns.
	before := writeOffBalances(t, ctx, p)
	if _, err := p.Exec(ctx, releaseSQL, claim, "resolved", 1, "El cliente no volvió"); err != nil {
		t.Fatalf("the warehouse authorises the release of a notified case: %v", err)
	}
	if phase := warrantyPhase(t, ctx, p, claim); phase != "resolved" {
		t.Fatalf("a release never moves the case either, got %s", phase)
	}
	if got := writeOffBalances(t, ctx, p); got == before {
		t.Fatalf("a release returns the unit of the case to sellable stock, %s became %s", before, got)
	}
	released := writeOffBalances(t, ctx, p)
	_, err = p.Exec(ctx, releaseSQL, claim, "resolved", 1, "La libero otra vez")
	execRefusalMessage(t, err, "LW019", "release")
	if got := writeOffBalances(t, ctx, p); got != released {
		t.Fatalf("a refused second release moves no balance, got %s", got)
	}
	// The warehouse moves the battery and never closes the case (S19): the tramo that closes it is
	// the branch's own.
	_, err = p.Exec(ctx, closeCaseSQL, claim, 1, "Cerrado por el Almacén")
	execRefusalMessage(t, err, "LW026", "branch that owns it")
	if phase := warrantyPhase(t, ctx, p, claim); phase != "resolved" {
		t.Fatalf("a refused close never moves the case, got %s", phase)
	}
	if _, err := p.Exec(ctx, closeCaseSQL, claim, 2, "Entregado al cliente"); err != nil {
		t.Fatalf("the branch closes its own case: %v", err)
	}
	if phase := warrantyPhase(t, ctx, p, claim); phase != "closed" {
		t.Fatalf("the closed tramo closes the case, got %s", phase)
	}

	// The narrowed LW006 keeps both halves of the fact: a tramo of the journey that enters the phase
	// the case already holds is refused, and a notice or a release that states another phase is
	// refused too, because neither of them moves the case.
	_, err = p.Exec(ctx, journeySQL, pending, "resolved", "", 2, "Se resolvió otra vez")
	execRefusalMessage(t, err, "LW006", "not already in")
	_, err = p.Exec(ctx, noticeSQL, pending, "received", 2, "Avisado el cliente")
	execRefusalMessage(t, err, "LW006", "phase")
	// The factory file number still belongs to the factory shipment and to nothing else.
	_, err = p.Exec(ctx, `INSERT INTO warranty_case_events(case_id,kind,phase,factory_case_number,
 actor_account_id,note) VALUES($1,'notice','resolved','LEG-1',2,'Avisado el cliente')`, pending)
	execRefusalMessage(t, err, "LW007", "file number")
	// A claim whose reported battery never came back to the branch holds nothing to release: the used
	// pool is not the branch's sellable stock (S11, S13).
	if _, err := p.Exec(ctx, noticeSQL, pending, "resolved", 2, "Avisado el cliente"); err != nil {
		t.Fatalf("the second claim registers its notice: %v", err)
	}
	if _, err := p.Exec(ctx, `UPDATE warranty_cases SET reported_destination='stock' WHERE id=$1`,
		pending); err != nil {
		t.Fatalf("the destination of the second claim could not be stated: %v", err)
	}
	_, err = p.Exec(ctx, releaseSQL, pending, "resolved", 1, "Sin unidad en custodia")
	execRefusalMessage(t, err, "LW025", "no unit")
	if got := writeOffBalances(t, ctx, p); got != released {
		t.Fatalf("a refused release writes no stock, got %s", got)
	}
	t.Logf("068: notice of the branch, release of the warehouse, once each")
}

// noticeReleaseFixture is the whole prefix of this vertical plus the stock, the accounts and one
// covered sale the two doors need.
func noticeReleaseFixture(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	applyMigrationRange(t, ctx, p, 68)
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

// coveredClaim opens a claim of a covered sold unit, which is the door the release of S14 is about.
func coveredClaim(t *testing.T, ctx context.Context, p *pgxpool.Pool) int64 {
	t.Helper()
	serial := "CUB-" + testpg.Random(t)[:8]
	sellWarrantyUnit(t, ctx, p, 2, 1, "100.00", serial, term(12), time.Now())
	var claim int64
	if err := p.QueryRow(ctx, claimCaseSQL, 2, serial, 2).Scan(&claim); err != nil {
		t.Fatalf("the covered claim must be admitted: %v", err)
	}
	return claim
}

// reachedResolved walks one case to the phase the factory answers in, which is where the notice and
// the release live (S14).
func reachedResolved(t *testing.T, ctx context.Context, p *pgxpool.Pool, claim int64) {
	t.Helper()
	for _, tramo := range []struct {
		phase   string
		factory string
	}{
		{"in_transit", ""},
		{"at_warehouse", ""},
		{"at_factory", "LEG-1"},
		{"resolved", ""},
	} {
		if _, err := p.Exec(ctx, journeySQL, claim, tramo.phase, tramo.factory, 1,
			"Tramo del fixture"); err != nil {
			t.Fatalf("the case reaches %s: %v", tramo.phase, err)
		}
	}
}
