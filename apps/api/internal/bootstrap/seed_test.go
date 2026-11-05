package bootstrap

import (
	"testing"

	"luson/api/internal/catalog"
)

// seeded builds the rows a freshly seeded database would report: the fixture
// identities with one balance row in every listed active location.
func seeded(t *testing.T, source catalog.Catalog, locations []int) seedRows {
	t.Helper()
	rows := seedRows{locations: locations}
	for _, entry := range source.Entries {
		rows.entries = append(rows.entries, entryRow{id: entry.ID, brand: entry.Brand, model: entry.Model, capacity: entry.Capacity})
	}
	for _, variant := range source.Variants() {
		rows.variants = append(rows.variants, variantRow{id: variant.ID, entryID: variant.CatalogID, polarity: variant.Polarity})
		for _, location := range locations {
			rows.balances = append(rows.balances, balanceRow{locationID: location, variantID: variant.ID})
		}
	}
	return rows
}

// allocate appends one operational battery created after the seed, with its two
// polarities and the balance rows the branch fan-out gives it.
func allocate(rows *seedRows, entryID int, variantIDs []int) {
	rows.entries = append(rows.entries, entryRow{id: entryID, brand: "OPERATIONAL", model: "OPERATIONAL-1", capacity: "40"})
	for _, id := range variantIDs {
		rows.variants = append(rows.variants, variantRow{id: id, entryID: entryID, polarity: catalog.Left})
		for _, location := range rows.locations {
			rows.balances = append(rows.balances, balanceRow{locationID: location, variantID: id})
		}
	}
}

func TestVerifyFixtureAcceptsSeed(t *testing.T) {
	source, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	if err := verifyFixture(source, seeded(t, source, []int{1, 2, 3})); err != nil {
		t.Fatalf("seeded fixture rejected: %v", err)
	}
}

// The database is the catalog authority: batteries past the fixture and the
// balances of a branch created after the seed are operational data, so the
// seed's integrity check must keep accepting the dataset.
func TestVerifyFixtureToleratesOperationalBatteries(t *testing.T) {
	source, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	rows := seeded(t, source, []int{1, 2, 3})
	allocate(&rows, len(source.Entries)+1, []int{191, 192})
	if err := verifyFixture(source, rows); err != nil {
		t.Fatalf("operational battery rejected: %v", err)
	}

	branch := seeded(t, source, []int{1, 2, 3, 4})
	allocate(&branch, len(source.Entries)+1, []int{191, 192})
	if err := verifyFixture(source, branch); err != nil {
		t.Fatalf("operational branch rejected: %v", err)
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
		"brand":         func(rows *seedRows) { rows.entries[0].brand = "CARGO" },
		"model":         func(rows *seedRows) { rows.entries[0].model = "NS40ZL-X" },
		"capacity":      func(rows *seedRows) { rows.entries[0].capacity = "36" },
		"missing variant": func(rows *seedRows) {
			rows.variants = append(rows.variants[:1], rows.variants[2:]...)
		},
		"polarity": func(rows *seedRows) { rows.variants[0].polarity = catalog.Right },
		"variant entry": func(rows *seedRows) {
			rows.variants[0].entryID = 2
		},
		"missing balance": func(rows *seedRows) { rows.balances = rows.balances[1:] },
	} {
		t.Run(name, func(t *testing.T) {
			rows := seeded(t, source, []int{1, 2, 3})
			mutate(&rows)
			if err := verifyFixture(source, rows); err == nil {
				t.Fatal("tampered fixture accepted")
			}
		})
	}
}

// A branch created after the seed still owes the fixture its balance matrix.
func TestVerifyFixtureRejectsMissingBranchBalances(t *testing.T) {
	source, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	rows := seeded(t, source, []int{1, 2, 3})
	rows.locations = append(rows.locations, 4)
	if err := verifyFixture(source, rows); err == nil {
		t.Fatal("accepted a branch without the seeded balance matrix")
	}
}
