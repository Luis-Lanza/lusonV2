package bootstrap

import (
	"testing"

	"luson/api/internal/catalog"
)

// seeded builds the rows a freshly seeded database would report: the fixture
// identities and no missing balance pair at all.
func seeded(t *testing.T, source catalog.Catalog) seedRows {
	t.Helper()
	rows := seedRows{}
	for _, entry := range source.Entries {
		rows.entries = append(rows.entries, entryRow{id: entry.ID, brand: entry.Brand, model: entry.Model})
	}
	for _, variant := range source.Variants() {
		rows.variants = append(rows.variants, variantRow{id: variant.ID, entryID: variant.CatalogID, polarity: variant.Polarity})
	}
	return rows
}

// allocate appends one operational battery created after the seed, with its two
// polarities and the balances the branch fan-out gives it. Operational balances are
// never reported: the check only asks for fixture pairs that are missing.
func allocate(rows *seedRows, entryID int, variantIDs []int) {
	rows.entries = append(rows.entries, entryRow{id: entryID, brand: "OPERATIONAL", model: "OPERATIONAL-1"})
	for _, id := range variantIDs {
		rows.variants = append(rows.variants, variantRow{id: id, entryID: entryID, polarity: catalog.Left})
	}
}

func TestVerifyFixtureAcceptsSeed(t *testing.T) {
	source, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	if err := verifyFixture(source, seeded(t, source)); err != nil {
		t.Fatalf("seeded fixture rejected: %v", err)
	}
}

// The database is the catalog authority: batteries past the fixture, their variants
// and the balance rows a later branch created for them are operational data, so the
// seed's integrity check must keep accepting the dataset while asking nothing about
// them.
func TestVerifyFixtureToleratesOperationalBatteries(t *testing.T) {
	source, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	rows := seeded(t, source)
	allocate(&rows, len(source.Entries)+1, []int{191, 192})
	if err := verifyFixture(source, rows); err != nil {
		t.Fatalf("operational battery rejected: %v", err)
	}
}

// Tampering with a seeded identity must still fail: the fixture stays the seed,
// not a suggestion.
func TestVerifyFixtureRejectsTampering(t *testing.T) {
	source, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*seedRows){
		"missing entry": func(rows *seedRows) { rows.entries = rows.entries[1:] },
		"entry identity": func(rows *seedRows) {
			rows.entries[0].id = 96
		},
		"missing variant": func(rows *seedRows) {
			rows.variants = append(rows.variants[:1], rows.variants[2:]...)
		},
		"polarity": func(rows *seedRows) { rows.variants[0].polarity = catalog.Right },
		"variant entry": func(rows *seedRows) {
			rows.variants[0].entryID = 2
		},
		"missing balance": func(rows *seedRows) {
			rows.missing = append(rows.missing, missingBalance{locationID: 1, variantID: source.Variants()[0].ID})
		},
	} {
		t.Run(name, func(t *testing.T) {
			rows := seeded(t, source)
			mutate(&rows)
			if err := verifyFixture(source, rows); err == nil {
				t.Fatal("tampered fixture accepted")
			}
		})
	}
}

// An administrator may edit a seeded battery: the identity is proven, its values are
// operational data. The check reads no authored value, so an edited battery needs no
// repair and cannot silently weaken the identity assertions above.
func TestVerifyFixtureAcceptsEditedEntries(t *testing.T) {
	source, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	rows := seeded(t, source)
	rows.entries[0].brand = "EDITADA"
	rows.entries[0].model = "NUEVO MODELO"
	if err := verifyFixture(source, rows); err != nil {
		t.Fatalf("an edited battery must stay verifiable: %v", err)
	}
}

// A branch created after the seed still owes the fixture its balance matrix, and the
// database reports that debt as the exact missing pair.
func TestVerifyFixtureRejectsMissingBranchBalances(t *testing.T) {
	source, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	rows := seeded(t, source)
	rows.missing = append(rows.missing, missingBalance{locationID: 4, variantID: source.Variants()[0].ID})
	if err := verifyFixture(source, rows); err == nil {
		t.Fatal("accepted a branch without the seeded balance matrix")
	}
}

// The old check accepted any balance row it was handed and cross-producted the whole
// matrix in memory; the new one refuses every missing pair, including the last one.
func TestVerifyFixtureRejectsEveryMissingPair(t *testing.T) {
	source, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	rows := seeded(t, source)
	for _, location := range []int{1, 2, 3} {
		for _, variant := range source.Variants() {
			rows.missing = []missingBalance{{locationID: location, variantID: variant.ID}}
			if err := verifyFixture(source, rows); err == nil {
				t.Fatalf("accepted a missing balance for location %d variant %d", location, variant.ID)
			}
		}
	}
}
