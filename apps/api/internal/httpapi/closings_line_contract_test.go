package httpapi

import (
	"encoding/json"
	"testing"

	"luson/api/internal/catalog"
	"luson/api/internal/closings"
)

// The count line of the acta is a contract two screens and every stored settlement read, and the
// second catalogue kind was added to it without moving the first one: a battery line publishes the
// same keys, the same values and the same order it published before, and a product line publishes its
// own identity and no battery attribute at all (S2, S3, S12). These tests read the bytes the acta
// publishes, through the same builder the routes use, so a reordered, renamed or invented key fails
// here instead of reaching a screen.

// wireCountLine publishes one count line exactly as the acta does and reports whether the record
// admitted it: the byte assertions below never decode the JSON again, so nothing but the contract's
// own order can produce them.
func wireCountLine(t *testing.T, line closings.CountLine) (string, bool) {
	t.Helper()
	record, ok := closingCountLineRecord(line, 0)
	if !ok {
		return "", false
	}
	published, err := json.Marshal(record)
	if err != nil {
		t.Fatalf("the count line must be publishable: %v", err)
	}
	return string(published), true
}

// countLineBattery is one admitted battery line: the identity its catalogue entry composes, the
// snapshot the database took at the cut and the count the warehouse wrote.
func countLineBattery(variantID, catalogEntryID int64, brand, model, capacity, polarity string,
	expected int64, counted *int64) closings.CountLine {
	return closings.CountLine{
		VariantID:        variantID,
		Identity:         catalog.BatteryIdentity(int(variantID), brand, model, capacity, polarity),
		CatalogEntryID:   catalogEntryID,
		ExpectedQuantity: expected,
		CountedQuantity:  counted,
	}
}

// countLineProduct is one admitted product line: its name and the detail the catalogue composes of its
// typed fields, with no battery attribute anywhere.
func countLineProduct(variantID, catalogEntryID int64, name string, fields []catalog.Field,
	expected int64, counted *int64) closings.CountLine {
	return closings.CountLine{
		VariantID:        variantID,
		Identity:         catalog.ProductIdentity(int(variantID), name, fields),
		CatalogEntryID:   catalogEntryID,
		ExpectedQuantity: expected,
		CountedQuantity:  counted,
	}
}

// TestCountLineContractBatteryBytes pins S12 and S3 at the wire: the battery line of a settlement
// written before the second kind existed is published with exactly the same bytes today, so no stored
// acta changes its meaning and no reader has to learn a new shape.
func TestCountLineContractBatteryBytes(t *testing.T) {
	published, ok := wireCountLine(t, countLineBattery(3, 2, "TOYO", "NS60L", "45", "L", 12, ptrInt64(12)))
	if !ok {
		t.Fatal("a complete battery line must be admitted")
	}
	want := `{"variant_id":3,"catalog_entry_id":2,"brand":"TOYO","model":"NS60L","capacity_ah":"45",` +
		`"polarity":"L","expected_quantity":12,"counted_quantity":12}`
	if published != want {
		t.Fatalf("the battery line of the acta changed:\n got %s\nwant %s", published, want)
	}
	// The pending line of a sheet written before the seeding still publishes its null count, and that
	// null is the only difference the contract allows.
	pending, ok := wireCountLine(t, countLineBattery(3, 2, "TOYO", "NS60L", "45", "L", 12, nil))
	if !ok {
		t.Fatal("a pending battery line must be admitted")
	}
	wantPending := `{"variant_id":3,"catalog_entry_id":2,"brand":"TOYO","model":"NS60L",` +
		`"capacity_ah":"45","polarity":"L","expected_quantity":12,"counted_quantity":null}`
	if pending != wantPending {
		t.Fatalf("the pending battery line of the acta changed:\n got %s\nwant %s", pending, wantPending)
	}
}

// TestCountLineContractProductKeys pins S3: a product line carries its own identity and no battery key
// at all, because the sheet publishes the attributes of the kind a row has and never an empty slot of
// the other kind.
func TestCountLineContractProductKeys(t *testing.T) {
	volume := "2"
	published, ok := wireCountLine(t, countLineProduct(4, 3, "Agua acidulada",
		[]catalog.Field{{Name: "volumen", Kind: catalog.NumberField, Unit: "L", Number: &volume}},
		5, ptrInt64(4)))
	if !ok {
		t.Fatal("a complete product line must be admitted")
	}
	want := `{"variant_id":4,"catalog_entry_id":3,"name":"Agua acidulada","detail":"volumen: 2 L",` +
		`"expected_quantity":5,"counted_quantity":4}`
	if published != want {
		t.Fatalf("the product line of the acta changed:\n got %s\nwant %s", published, want)
	}
	// The keys are named one by one as well, so the failure of an added or a missing attribute says
	// which one it was: the battery attributes are absent, never published empty.
	var keys map[string]json.RawMessage
	if json.Unmarshal([]byte(published), &keys) != nil {
		t.Fatalf("the product line must be decodable: %s", published)
	}
	for _, key := range []string{"brand", "model", "capacity_ah", "polarity"} {
		if _, present := keys[key]; present {
			t.Fatalf("a product line must carry no %q at all: %s", key, published)
		}
	}
	for _, key := range []string{"variant_id", "catalog_entry_id", "name", "detail",
		"expected_quantity", "counted_quantity"} {
		if _, present := keys[key]; !present {
			t.Fatalf("a product line must state %q: %s", key, published)
		}
	}
	if len(keys) != 6 {
		t.Fatalf("a product line states exactly its six keys: %s", published)
	}
}

// TestCountLineContractRefusals pins S3's other half: the gates relaxed for the product kind without
// accepting a battery the catalogue could not have written, so a line of neither kind, of both kinds
// or with a variant the identity does not name is refused instead of published.
func TestCountLineContractRefusals(t *testing.T) {
	volume := "2"
	bothKinds := countLineProduct(4, 3, "Agua acidulada", nil, 5, ptrInt64(4))
	bothKinds.Identity.Battery = catalog.BatteryIdentity(4, "TOYO", "NS60L", "45", "L").Battery
	batteryWithFields := countLineBattery(3, 2, "TOYO", "NS60L", "45", "L", 12, ptrInt64(12))
	batteryWithFields.Identity.Fields = []catalog.Field{{Name: "volumen", Kind: catalog.NumberField,
		Unit: "L", Number: &volume}}
	disagreeingVariant := countLineBattery(3, 2, "TOYO", "NS60L", "45", "L", 12, ptrInt64(12))
	disagreeingVariant.VariantID = 4
	for name, line := range map[string]closings.CountLine{
		// A line is of one kind: the identity of a product never carries a battery attribute, and a
		// battery was never written with typed fields.
		"product with battery attributes": bothKinds,
		"battery with product fields":     batteryWithFields,
		// The row's key and the identity's variant are the one value the database read.
		"variant disagrees with identity": disagreeingVariant,
		// A product is named, and its name is the one its detail is composed from.
		"product without a name": countLineProduct(4, 3, "", nil, 5, ptrInt64(4)),
		"product unknown to the catalogue": func() closings.CountLine {
			line := countLineProduct(4, 3, "Agua acidulada", nil, 5, ptrInt64(4))
			line.Identity = catalog.Identity{VariantID: 4, Kind: catalog.Kind("battery2"),
				Name: "Agua acidulada", Detail: "Agua acidulada"}
			return line
		}(),
		// A capacity is the canonical decimal the catalogue stores: another text of the same number is
		// a row the catalogue never wrote and is never published as if it were.
		"battery with a non-canonical capacity": countLineBattery(3, 2, "TOYO", "NS60L", "45.0", "L",
			12, ptrInt64(12)),
		"battery without a polarity": countLineBattery(3, 2, "TOYO", "NS60L", "45", "", 12,
			ptrInt64(12)),
	} {
		if published, ok := wireCountLine(t, line); ok {
			t.Fatalf("%s must be refused, not published: %s", name, published)
		}
	}
}
