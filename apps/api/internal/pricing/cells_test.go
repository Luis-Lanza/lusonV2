package pricing

import (
	"errors"
	"testing"

	"luson/api/internal/catalog"
)

// Source cells belong to the preloaded catalogue: a seeded battery keeps reporting its
// three cells, while a battery created after the seed has none. A battery without
// source cells is empty payload, never a store failure, so the price matrix stops
// answering service_unavailable for it.
func TestCellsOfPreloadedBattery(t *testing.T) {
	source, err := catalog.Load()
	if err != nil {
		t.Fatalf("the embedded catalogue is unavailable: %v", err)
	}
	entry := source.Entries[0]
	cells, err := cellsOf(int64(entry.ID))
	if err != nil {
		t.Fatalf("a preloaded battery must report its cells: %v", err)
	}
	if len(cells) != 3 {
		t.Fatalf("a preloaded battery has three cells: %+v", cells)
	}
	for i, cell := range cells {
		if cell == "" || cell != entry.Cells[i] {
			t.Fatalf("cell %d does not match the source catalogue: %+v", i, cells)
		}
	}
	// The answer is a copy: a caller cannot rewrite the cached catalogue.
	cells[0] = "mutated"
	again, err := cellsOf(int64(entry.ID))
	if err != nil || len(again) != 3 || again[0] == "mutated" {
		t.Fatalf("cells must be copied on every read: %v %+v", err, again)
	}
}

func TestCellsOfBatteryPastTheFixture(t *testing.T) {
	source, err := catalog.Load()
	if err != nil {
		t.Fatalf("the embedded catalogue is unavailable: %v", err)
	}
	// Ids past the fixture are allocated by the database sequence of migration 028.
	for _, id := range []int64{int64(len(source.Entries)) + 1, 96, 1 << 20, 0, -1} {
		cells, err := cellsOf(id)
		if err != nil {
			t.Fatalf("entry %d must not be a store failure: %v", id, err)
		}
		if cells == nil || len(cells) != 0 {
			t.Fatalf("entry %d must answer an empty, non-nil list: %+v", id, cells)
		}
	}
}

// A broken embedded fixture keeps failing: the catalogue is validated once, and a
// recorded failure is never turned into empty payload.
func TestCellsOfBrokenFixtureFailsClosed(t *testing.T) {
	saved := cells.err
	t.Cleanup(func() { cells.err = saved })
	cells.err = errors.New("broken fixture")
	if got, err := cellsOf(1); err == nil || got != nil {
		t.Fatalf("a broken fixture must fail closed: %+v %v", got, err)
	}
}
