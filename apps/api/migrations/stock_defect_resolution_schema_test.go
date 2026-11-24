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

// The stock door resolves its own shelf (S11). 067 takes the units of a finding off the branch's own
// balance in the transaction that admits the case; this version states the other half of the boundary:
// the verdict the factory or the warehouse reached returns those units to that same shelf, or leaves
// the write-off standing because the damaged units stay in the used pool. A finding has no client, so
// it registers no notice and authorises no release: 068's two facts stay the claim's.
const stockResolutionMigration = "069_stock_defect_returns_its_units.sql"

// resolvedCaseSQL states the verdict of a case and then the tramo that resolves it, in the order the
// store writes them: the verdict is what the shelf trigger of the resolution reads.
const resolvedCaseSQL = `UPDATE warranty_cases SET stock_destination=$2,reported_destination=$3,
 verdict=$4 WHERE id=$1`

// TestStockResolutionShape reads the embedded version exactly as PostgreSQL receives it: one balance
// update and no more, the mirror of 067 and of 068, and the two facts 068 states narrowed so that a
// finding can never reach them.
func TestStockResolutionShape(t *testing.T) {
	b, err := migrations.Files.ReadFile(stockResolutionMigration)
	if err != nil {
		t.Fatal("the stock resolution migration must be embedded", err)
	}
	sql := statements(string(b))
	for _, required := range []string{
		// 068's guard is narrowed forward, never edited in place: the whole function is restated so the
		// history keeps one single authority.
		"CREATE OR REPLACE FUNCTION admit_warranty_case_event() RETURNS trigger LANGUAGE plpgsql AS $$",
		// A finding registers no notice: there is no client to call (S19).
		"IF header.origin = 'stock_defect' THEN",
		// And no release: its units never waited in custody, they are the branch's own (S13, S14).
		"CREATE OR REPLACE FUNCTION release_case_unit_to_stock() RETURNS trigger LANGUAGE plpgsql AS $$",
		"IF header.reported_destination IS DISTINCT FROM 'customer' THEN",
		// The resolution of a finding returns its units, once, in the transaction of the tramo that
		// resolves the case (S11).
		"CREATE FUNCTION restock_stock_defect_resolution() RETURNS trigger LANGUAGE plpgsql AS $$",
		"IF NEW.kind <> 'phase' OR NEW.phase <> 'resolved' THEN",
		"IF header.origin <> 'stock_defect' THEN",
		"IF header.verdict IS NULL THEN",
		"IF header.verdict IN ('repaired','replaced') THEN",
		// The shelf destination and the movement are one fact: a verdict that returns the units states its
		// shelf as stock, and one that does not states no shelf destination at all.
		"IF header.stock_destination IS DISTINCT FROM 'stock' THEN",
		"IF header.stock_destination IS NOT NULL THEN",
		// The same lock and the same signed arithmetic as 067 and 068: the case's own branch and its own
		// variant, locked, computed in numeric and written in one statement.
		"SELECT * INTO balance FROM inventory_balances",
		"WHERE location_id=header.branch_location_id AND variant_id=header.variant_id FOR UPDATE;",
		"total := balance.existing::numeric + header.quantity::numeric;",
		"UPDATE inventory_balances SET existing=total::bigint",
		"CREATE TRIGGER restock_stock_defect_resolution AFTER INSERT ON warranty_case_events",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("the stock resolution migration is incomplete: missing %s", required)
		}
	}
	// Two statements and no more: the release of 068 restated forward -- the claim's single unit, which is
	// the one it keeps -- and the resolution this file adds, which returns the case's own quantity. Neither
	// of them is a document of the warehouse.
	if count := strings.Count(sql, "UPDATE inventory_balances"); count != 2 {
		t.Fatalf("the file restates one balance update and adds one, got %d", count)
	}
	if !strings.Contains(sql, "UPDATE inventory_balances SET existing=existing+1") {
		t.Fatal("the restated release still returns the single unit of a claim")
	}
	for _, forbidden := range []string{
		"CREATE TABLE", "INSERT INTO stock_", "INSERT INTO transfer_", "UPDATE stock_",
		"INSERT INTO warranty_cases", "DELETE FROM", "DROP ", "ALTER TABLE inventory_balances",
		"ALTER TABLE warranty_cases", "ALTER TABLE warranty_case_events",
		// No new phase and no new vocabulary: S23 froze both.
		"CHECK (phase IN (", "CHECK (verdict IN (",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("the stock resolution migration must not contain %s", forbidden)
		}
	}
	// The codes of this file are this vertical's and never a reused number (S23): 065 states LW001 to
	// LW015, 067 states LW016 to LW018 and 068 states LW019 to LW026.
	used := map[string]bool{}
	for _, match := range regexp.MustCompile(`ERRCODE='(LW[0-9]{3})'`).FindAllStringSubmatch(sql, -1) {
		used[match[1]] = true
	}
	declared := []string{"LW006", "LW007", "LW008", "LW019", "LW020", "LW021", "LW022", "LW023",
		"LW024", "LW025", "LW026", "LW027", "LW028", "LW029", "LW030", "LW031", "LW032"}
	got := make([]string, 0, len(used))
	for code := range used {
		got = append(got, code)
	}
	sort.Strings(got)
	if strings.Join(got, ",") != strings.Join(declared, ",") {
		t.Fatalf("the resolution restates the codes it narrows and states its own six, got %v", got)
	}
	entries, err := migrations.Files.ReadDir(".")
	if err != nil {
		t.Fatal("embedded migrations are unreadable")
	}
	stated := map[string]bool{"LW006": true, "LW007": true, "LW008": true,
		"LW019": true, "LW020": true, "LW021": true, "LW022": true, "LW023": true,
		"LW024": true, "LW025": true, "LW026": true}
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".sql") || entry.Name() == stockResolutionMigration {
			continue
		}
		version, err := migrations.Files.ReadFile(entry.Name())
		if err != nil {
			t.Fatalf("embedded migration %s is unreadable", entry.Name())
		}
		for code := range used {
			// The codes the restated guards already own are stated by 065 and 068 themselves; the six
			// this file adds are never reused by another version of the vertical.
			if stated[code] {
				continue
			}
			if strings.Contains(string(version), "ERRCODE='"+code+"'") {
				t.Fatalf("%s reuses the code %s of the stock resolution", entry.Name(), code)
			}
		}
	}
	// The file documents the decision it takes, so the next reader does not reconstruct it.
	for _, documented := range []string{"S11", "S13", "S14", "S19", "S23", "067", "068",
		"inventory_balances", "repaired", "replaced", "not_covered", "pool de usadas", "resolved"} {
		if !strings.Contains(string(b), documented) {
			t.Errorf("the stock resolution must document its own decision: %s", documented)
		}
	}
}

// TestStockDefectReturnsItsUnitsAtItsResolution proves the matrix of S11 on a live database: a finding
// resolved `repaired` or `replaced` brings its units back to its own branch's shelf in the transaction
// of the tramo that resolves the case, `not_covered` leaves the write-off standing, a case that
// resolves without a verdict or with a shelf destination the verdict does not state is refused, and
// the branch -- never the warehouse -- closes it.
func TestStockDefectReturnsItsUnitsAtItsResolution(t *testing.T) {
	ctx, p := stockResolutionFixture(t)
	if before := writeOffBalances(t, ctx, p); before != "2:1=10/0,3:1=10/0" {
		t.Fatalf("the fixture states its own stock, got %s", before)
	}
	// The admission of the finding takes its units off the branch's shelf (067).
	var repaired int64
	if err := p.QueryRow(ctx, writeOffCaseSQL, 2, 1, 3, "Probada en mostrador: no arranca", 2).
		Scan(&repaired); err != nil {
		t.Fatalf("the finding on the shelf must be admitted: %v", err)
	}
	if got := writeOffBalances(t, ctx, p); got != "2:1=7/0,3:1=10/0" {
		t.Fatalf("067 takes the three units off the shelf, got %s", got)
	}
	stockReachedFactory(t, ctx, p, repaired)
	// The verdict is stated before the tramo that resolves the case, exactly as the store writes both.
	if _, err := p.Exec(ctx, resolvedCaseSQL, repaired, "stock", "stock", "repaired"); err != nil {
		t.Fatalf("the resolution of the finding could not be stated: %v", err)
	}
	if _, err := p.Exec(ctx, journeySQL, repaired, "resolved", "", 1, "Reparadas por fábrica"); err != nil {
		t.Fatalf("the resolution tramo must be admitted: %v", err)
	}
	if got := writeOffBalances(t, ctx, p); got != "2:1=10/0,3:1=10/0" {
		t.Fatalf("the units of the finding return to its own shelf, got %s", got)
	}
	// The movement happens once: a case enters `resolved` once, and a second tramo is refused before it
	// is written (LW006 of 065).
	_, err := p.Exec(ctx, journeySQL, repaired, "resolved", "", 1, "Otra vez")
	execRefusalMessage(t, err, "LW006", "not already in")
	if got := writeOffBalances(t, ctx, p); got != "2:1=10/0,3:1=10/0" {
		t.Fatalf("a refused second resolution moves no balance, got %s", got)
	}
	// The branch owns the case and closes it; the warehouse moves the battery and never closes it (S19).
	_, err = p.Exec(ctx, closeCaseSQL, repaired, 1, "Cerrado por el Almacén")
	execRefusalMessage(t, err, "LW026", "branch that owns it")
	if _, err := p.Exec(ctx, closeCaseSQL, repaired, 2, "Vuelven a la góndola"); err != nil {
		t.Fatalf("the branch closes its own finding: %v", err)
	}
	if phase := warrantyPhase(t, ctx, p, repaired); phase != "closed" {
		t.Fatalf("the closed tramo closes the finding, got %s", phase)
	}

	// A replacement returns the units in their place, and nothing of another branch moves.
	var replaced int64
	if err := p.QueryRow(ctx, writeOffCaseSQL, 2, 1, 2, "Falla de góndola", 2).
		Scan(&replaced); err != nil {
		t.Fatalf("the second finding must be admitted: %v", err)
	}
	stockReachedFactory(t, ctx, p, replaced)
	if _, err := p.Exec(ctx, resolvedCaseSQL, replaced, "stock", "stock", "replaced"); err != nil {
		t.Fatalf("the replacement could not be stated: %v", err)
	}
	if _, err := p.Exec(ctx, journeySQL, replaced, "resolved", "", 1, "Fábrica repuso"); err != nil {
		t.Fatalf("the replacement tramo must be admitted: %v", err)
	}
	if got := writeOffBalances(t, ctx, p); got != "2:1=10/0,3:1=10/0" {
		t.Fatalf("a replacement returns the units too, got %s", got)
	}

	// `not_covered` leaves the write-off standing: the damaged units stay in the used pool and the
	// branch's sellable stock is not credited with them (S11).
	var uncovered int64
	if err := p.QueryRow(ctx, writeOffCaseSQL, 2, 1, 2, "Sin cobertura", 2).Scan(&uncovered); err != nil {
		t.Fatalf("the third finding must be admitted: %v", err)
	}
	stockReachedFactory(t, ctx, p, uncovered)
	if _, err := p.Exec(ctx, resolvedCaseSQL, uncovered, nil, "stock", "not_covered"); err != nil {
		t.Fatalf("the refusal of the factory could not be stated: %v", err)
	}
	if _, err := p.Exec(ctx, journeySQL, uncovered, "resolved", "", 1, "No cubre"); err != nil {
		t.Fatalf("the refusal tramo must be admitted: %v", err)
	}
	if got := writeOffBalances(t, ctx, p); got != "2:1=8/0,3:1=10/0" {
		t.Fatalf("not_covered writes no stock back, got %s", got)
	}
	t.Logf("069: 10 - 3 + 3 repaired, + 2 replaced, and 8 after the factory refused two")
}

// TestStockResolutionGuardRefusesWhatTheMatrixDoesNotState proves the guards of the resolution: a
// finding does not enter `resolved` without a verdict, a shelf destination that disagrees with the
// verdict is refused, and a finding registers no notice and authorises no release (S14, S19).
func TestStockResolutionGuardRefusesWhatTheMatrixDoesNotState(t *testing.T) {
	ctx, p := stockResolutionFixture(t)
	// A finding that reaches `resolved` with no verdict has no shelf outcome to apply.
	var bare int64
	if err := p.QueryRow(ctx, writeOffCaseSQL, 2, 1, 1, "Falla de góndola", 2).Scan(&bare); err != nil {
		t.Fatalf("the finding must be admitted: %v", err)
	}
	stockReachedFactory(t, ctx, p, bare)
	_, err := p.Exec(ctx, journeySQL, bare, "resolved", "", 1, "Resuelta sin veredicto")
	execRefusalMessage(t, err, "LW027", "verdict")
	if phase := warrantyPhase(t, ctx, p, bare); phase != "at_factory" {
		t.Fatalf("a refused resolution moves no phase, got %s", phase)
	}
	if got := writeOffBalances(t, ctx, p); got != "2:1=9/0,3:1=10/0" {
		t.Fatalf("a refused resolution writes no stock, got %s", got)
	}
	// The shelf destination is the verdict's own reading: a repair that states none, and a refusal that
	// states stock, are both refused (LW028).
	if _, err := p.Exec(ctx, resolvedCaseSQL, bare, nil, "stock", "repaired"); err != nil {
		t.Fatalf("the verdict could not be stated: %v", err)
	}
	_, err = p.Exec(ctx, journeySQL, bare, "resolved", "", 1, "Resuelta sin destino")
	execRefusalMessage(t, err, "LW028", "shelf")
	if _, err := p.Exec(ctx, resolvedCaseSQL, bare, "stock", "stock", "not_covered"); err != nil {
		t.Fatalf("the second verdict could not be stated: %v", err)
	}
	_, err = p.Exec(ctx, journeySQL, bare, "resolved", "", 1, "Resuelta con destino")
	execRefusalMessage(t, err, "LW028", "shelf")
	if got := writeOffBalances(t, ctx, p); got != "2:1=9/0,3:1=10/0" {
		t.Fatalf("the refused resolutions wrote stock, got %s", got)
	}

	// The finding is resolved the way its matrix states, and the shelf comes back.
	var resolved int64
	if err := p.QueryRow(ctx, writeOffCaseSQL, 2, 1, 1, "Falla de góndola", 2).Scan(&resolved); err != nil {
		t.Fatalf("the second finding must be admitted: %v", err)
	}
	stockReachedFactory(t, ctx, p, resolved)
	if _, err := p.Exec(ctx, resolvedCaseSQL, resolved, "stock", "stock", "repaired"); err != nil {
		t.Fatalf("the resolution could not be stated: %v", err)
	}
	if _, err := p.Exec(ctx, journeySQL, resolved, "resolved", "", 1, "Reparada"); err != nil {
		t.Fatalf("the resolution tramo must be admitted: %v", err)
	}
	if got := writeOffBalances(t, ctx, p); got != "2:1=9/0,3:1=10/0" {
		t.Fatalf("the resolution returns the unit, got %s", got)
	}
	// A finding has no client to notify and no unit in custody: 068's two facts are the claim's (S14,
	// S19), and both are refused instead of moving stock a second time.
	_, err = p.Exec(ctx, noticeSQL, resolved, "resolved", 2, "Avisada la sucursal")
	execRefusalMessage(t, err, "LW030", "no client")
	_, err = p.Exec(ctx, releaseSQL, resolved, "resolved", 1, "Vuelven a la góndola")
	execRefusalMessage(t, err, "LW031", "custody")
	if got := writeOffBalances(t, ctx, p); got != "2:1=9/0,3:1=10/0" {
		t.Fatalf("a refused notice and a refused release write no stock, got %s", got)
	}

	// A claim keeps both facts: its notice is the branch's, its release is the warehouse's and it returns
	// the single repaired unit to the branch (S13, S14). The claim door is untouched by this version.
	claim := coveredClaim(t, ctx, p)
	reachedResolved(t, ctx, p, claim)
	if _, err := p.Exec(ctx, `UPDATE warranty_cases SET verdict='repaired',
 reported_destination='customer',loan_destination='stock' WHERE id=$1`, claim); err != nil {
		t.Fatalf("the resolution of the claim could not be stated: %v", err)
	}
	if _, err := p.Exec(ctx, noticeSQL, claim, "resolved", 2, "Avisado el cliente"); err != nil {
		t.Fatalf("the branch registers the notice of its claim: %v", err)
	}
	shelf := writeOffExisting(t, ctx, p, 2, 1)
	if _, err := p.Exec(ctx, releaseSQL, claim, "resolved", 1, "El cliente no volvió"); err != nil {
		t.Fatalf("the warehouse releases the unit of its claim: %v", err)
	}
	if got := writeOffExisting(t, ctx, p, 2, 1); got != shelf+1 {
		t.Fatalf("a claim's release still returns its unit to stock: %d became %d", shelf, got)
	}
	if got := writeOffExisting(t, ctx, p, 3, 1); got != 10 {
		t.Fatalf("no write of this vertical moves another branch, got %d", got)
	}
}

// stockReachedFactory walks one case to the phase the factory answers in, which is where the verdicts
// of S11 arrive.
func stockReachedFactory(t *testing.T, ctx context.Context, p *pgxpool.Pool, id int64) {
	t.Helper()
	for _, tramo := range []struct {
		phase   string
		factory string
	}{
		{"in_transit", ""},
		{"at_warehouse", ""},
		{"at_factory", "LEG-1"},
	} {
		if _, err := p.Exec(ctx, journeySQL, id, tramo.phase, tramo.factory, 1,
			"Tramo del fixture"); err != nil {
			t.Fatalf("the case reaches %s: %v", tramo.phase, err)
		}
	}
}

// stockResolutionFixture is the whole prefix of this vertical plus the stock, the accounts and one
// covered sale the two doors need, applied through this version.
func stockResolutionFixture(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	applyMigrationRange(t, ctx, p, 69)
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
