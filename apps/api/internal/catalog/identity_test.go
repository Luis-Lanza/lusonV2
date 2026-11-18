package catalog

import (
	"encoding/json"
	"testing"
)

// The frozen contract of the variant identity: one shape every surface reads, a
// battery carrying its battery attributes and a product carrying its typed
// fields, with the name and the detail composed by the server.
func TestIdentityJSONContract(t *testing.T) {
	number := "5"
	text := "importado"
	for name, tc := range map[string]struct {
		identity Identity
		want     string
	}{
		"product": {
			identity: ProductIdentity(210, "Agua acidulada", []Field{
				{Name: "volumen en L", Kind: NumberField, Unit: "L", Number: &number},
			}),
			want: `{"variant_id":210,"kind":"other","name":"Agua acidulada","detail":"volumen en L: 5 L","battery":null,"fields":[{"name":"volumen en L","kind":"number","unit":"L","number":"5"}]}`,
		},
		"product_text_field": {
			identity: ProductIdentity(211, "Agua acidulada", []Field{
				{Name: "origen", Kind: TextField, Text: &text},
			}),
			want: `{"variant_id":211,"kind":"other","name":"Agua acidulada","detail":"origen: importado","battery":null,"fields":[{"name":"origen","kind":"text","text":"importado"}]}`,
		},
		"battery": {
			identity: BatteryIdentity(1, "CAR", "NS40ZL", "35", "L"),
			want:     `{"variant_id":1,"kind":"battery","name":"CAR · NS40ZL","detail":"35 Ah · L","battery":{"brand":"CAR","model":"NS40ZL","capacity_ah":"35","polarity":"L"},"fields":null}`,
		},
	} {
		got, err := json.Marshal(tc.identity)
		if err != nil {
			t.Fatalf("%s: identity is not encodable", name)
		}
		if string(got) != tc.want {
			t.Fatalf("%s identity drifted from the contract:\n got %s\nwant %s", name, got, tc.want)
		}
	}
}

// The detail is composed by the server so every surface agrees: the first three
// fields as "nombre: valor unidad", joined with " · ", and the remaining count
// appended as " · +N".
func TestFieldSummary(t *testing.T) {
	one, five, twenty := "1", "5", "20"
	for name, tc := range map[string]struct {
		fields []Field
		want   string
	}{
		"none": {nil, ""},
		"one_number_with_unit": {[]Field{
			{Name: "volumen en L", Kind: NumberField, Unit: "L", Number: &five},
		}, "volumen en L: 5 L"},
		"one_number_without_unit": {[]Field{
			{Name: "unidades", Kind: NumberField, Number: &twenty},
		}, "unidades: 20"},
		"number_without_value": {[]Field{
			{Name: "unidades", Kind: NumberField},
		}, "unidades: "},
		"text_has_no_unit": {[]Field{
			{Name: "presentación", Kind: TextField, Text: strPtr("paquete")},
		}, "presentación: paquete"},
		"three": {[]Field{
			{Name: "volumen en L", Kind: NumberField, Unit: "L", Number: &five},
			{Name: "presentación", Kind: TextField, Text: strPtr("paquete")},
			{Name: "unidades", Kind: NumberField, Number: &one},
		}, "volumen en L: 5 L · presentación: paquete · unidades: 1"},
		"four": {[]Field{
			{Name: "volumen en L", Kind: NumberField, Unit: "L", Number: &five},
			{Name: "presentación", Kind: TextField, Text: strPtr("paquete")},
			{Name: "unidades", Kind: NumberField, Number: &one},
			{Name: "origen", Kind: TextField, Text: strPtr("importado")},
		}, "volumen en L: 5 L · presentación: paquete · unidades: 1 · +1"},
		"seven": {[]Field{
			{Name: "a", Kind: NumberField, Number: &one},
			{Name: "b", Kind: NumberField, Number: &one},
			{Name: "c", Kind: NumberField, Number: &one},
			{Name: "d", Kind: NumberField, Number: &one},
			{Name: "e", Kind: NumberField, Number: &one},
			{Name: "f", Kind: NumberField, Number: &one},
			{Name: "g", Kind: NumberField, Number: &one},
		}, "a: 1 · b: 1 · c: 1 · +4"},
	} {
		if got := FieldSummary(tc.fields); got != tc.want {
			t.Fatalf("%s summary mismatch: got %q want %q", name, got, tc.want)
		}
	}
	// A product detail is its summary, and its own name when it declares no field:
	// neither the name nor the detail is ever empty.
	if got := ProductDetail("Agua acidulada", nil); got != "Agua acidulada" {
		t.Fatalf("an empty summary must fall back to the name, got %q", got)
	}
	if got := ProductDetail("Agua acidulada", []Field{{Name: "unidades", Kind: NumberField, Number: &twenty}}); got != "unidades: 20" {
		t.Fatalf("a declared field must be the detail, got %q", got)
	}
	if got := ProductIdentity(1, "Agua acidulada", nil); got.Detail != "Agua acidulada" || got.Fields == nil {
		t.Fatalf("a product without fields keeps a detail and a non-null field list: %+v", got)
	}
}

// The identity of a battery is its brand and model, and its detail is the capacity
// with the polarity, exactly as the stock screen reads it.
func TestBatteryIdentityComposition(t *testing.T) {
	identity := BatteryIdentity(7, "CAR", "NS40ZL", "35", "R")
	if identity.Kind != BatteryKind || identity.Name != "CAR · NS40ZL" || identity.Detail != "35 Ah · R" {
		t.Fatalf("battery identity is not composed: %+v", identity)
	}
	if identity.Fields != nil {
		t.Fatal("a battery carries no typed fields")
	}
	if identity.Battery == nil || identity.Battery.Brand != "CAR" || identity.Battery.Model != "NS40ZL" ||
		identity.Battery.Capacity != "35" || identity.Battery.Polarity != "R" {
		t.Fatalf("battery attributes are not carried: %+v", identity.Battery)
	}
}

// The rule of each kind is strict and is the same rule every read applies: a
// battery still needs its brand, model, positive capacity and polarity, and a
// product needs its name and carries no battery attribute.
func TestIdentityValid(t *testing.T) {
	number := "5"
	product := ProductIdentity(210, "Agua acidulada", []Field{
		{Name: "volumen en L", Kind: NumberField, Unit: "L", Number: &number},
	})
	battery := BatteryIdentity(1, "CAR", "NS40ZL", "35", "L")
	for name, identity := range map[string]Identity{"product": product, "battery": battery} {
		if err := identity.Valid(); err != nil {
			t.Fatalf("%s identity must be admitted", name)
		}
	}
	clone := func(identity Identity) Identity {
		copied := identity
		if identity.Battery != nil {
			value := *identity.Battery
			copied.Battery = &value
		}
		if identity.Fields != nil {
			copied.Fields = append([]Field(nil), identity.Fields...)
		}
		return copied
	}
	for name, change := range map[string]func(*Identity){
		"zero_variant":     func(i *Identity) { i.VariantID = 0 },
		"empty_name":       func(i *Identity) { i.Name = "" },
		"empty_detail":     func(i *Identity) { i.Detail = "" },
		"nul_name":         func(i *Identity) { i.Name = "Agua\x00acidulada" },
		"unknown_kind":     func(i *Identity) { i.Kind = "battery_other" },
		"foreign_detail":   func(i *Identity) { i.Detail = "otra cosa" },
		"battery_missing":  func(i *Identity) { i.Battery = nil },
		"battery_brand":    func(i *Identity) { i.Battery.Brand = "" },
		"battery_model":    func(i *Identity) { i.Battery.Model = "" },
		"battery_capacity": func(i *Identity) { i.Battery.Capacity = "0" },
		"battery_padding":  func(i *Identity) { i.Battery.Capacity = "035" },
		"battery_polarity": func(i *Identity) { i.Battery.Polarity = "X" },
		"battery_fields":   func(i *Identity) { i.Fields = []Field{} },
	} {
		identity := clone(battery)
		change(&identity)
		if err := identity.Valid(); err == nil {
			t.Fatalf("battery %s must be refused", name)
		}
	}
	for name, change := range map[string]func(*Identity){
		"zero_variant":   func(i *Identity) { i.VariantID = 0 },
		"empty_name":     func(i *Identity) { i.Name = "" },
		"empty_detail":   func(i *Identity) { i.Detail = "" },
		"foreign_detail": func(i *Identity) { i.Detail = "volumen en L: 6 L" },
		"product_battery": func(i *Identity) {
			i.Battery = &BatteryAttributes{Brand: "CAR", Model: "NS40ZL", Capacity: "35", Polarity: "L"}
		},
		"null_fields":   func(i *Identity) { i.Fields = nil },
		"field_name":    func(i *Identity) { i.Fields[0].Name = "" },
		"field_kind":    func(i *Identity) { i.Fields[0].Kind = "money" },
		"field_number":  func(i *Identity) { i.Fields[0].Number = nil },
		"field_padding": func(i *Identity) { padded := "05"; i.Fields[0].Number = &padded },
		"field_unit":    func(i *Identity) { i.Fields[0].Unit = "" },
		"field_text_unit": func(i *Identity) {
			text := "x"
			i.Fields[0] = Field{Name: "origen", Kind: TextField, Unit: "L", Text: &text}
		},
	} {
		identity := clone(product)
		change(&identity)
		if err := identity.Valid(); err == nil {
			t.Fatalf("product %s must be refused", name)
		}
	}
	// A product without fields is a legitimate product: its detail is its name.
	empty := ProductIdentity(211, "Agua acidulada", nil)
	if err := empty.Valid(); err != nil {
		t.Fatalf("a product without fields must be admitted: %v", err)
	}
	if empty.Detail != empty.Name {
		t.Fatal("a product without fields shows its name as detail")
	}
}

// A catalogue row composes the identity of its own kind and re-checks it, so a
// row this contract could not have published never reaches a screen.
func TestVariantIdentity(t *testing.T) {
	number := "5"
	fields := []Field{{Name: "volumen en L", Kind: NumberField, Unit: "L", Number: &number}}
	battery := Row{VariantID: 2, CatalogEntryID: 1, Kind: BatteryKind, Brand: "CAR", Model: "NS40ZL", Capacity: "35.000000", Polarity: "L"}
	identity, err := battery.Identity(nil)
	if err != nil {
		t.Fatalf("a battery row must compose its identity: %v", err)
	}
	if identity.Name != "CAR · NS40ZL" || identity.Detail != "35 Ah · L" || identity.Battery == nil ||
		identity.Battery.Capacity != "35" || identity.Fields != nil {
		t.Fatalf("battery row identity drifted from the contract: %+v", identity)
	}
	product := Row{VariantID: 210, CatalogEntryID: 96, Kind: OtherKind, Name: "Agua acidulada"}
	identity, err = product.Identity(fields)
	if err != nil {
		t.Fatalf("a product row must compose its identity: %v", err)
	}
	if identity.Name != "Agua acidulada" || identity.Detail != "volumen en L: 5 L" ||
		identity.Battery != nil || len(identity.Fields) != 1 {
		t.Fatalf("product row identity drifted from the contract: %+v", identity)
	}
	for name, row := range map[string]Row{
		"unknown_kind":     {VariantID: 1, Kind: "gift", Name: "x"},
		"unknown_entry":    {VariantID: 1, Kind: OtherKind, Name: ""},
		"battery_capacity": {VariantID: 1, Kind: BatteryKind, Brand: "CAR", Model: "NS40ZL", Capacity: "", Polarity: "L"},
		"battery_polarity": {VariantID: 1, Kind: BatteryKind, Brand: "CAR", Model: "NS40ZL", Capacity: "35", Polarity: ""},
	} {
		if _, err := row.Identity(nil); err == nil {
			t.Fatalf("%s must not compose an identity", name)
		}
	}
}

// The kind filter is the frozen three-state selection of every kind-aware read,
// and the absent value is the battery-only listing every caller already had.
func TestKindFilter(t *testing.T) {
	for _, filter := range []KindFilter{"", AllKinds, BatteryOnly, OtherOnly} {
		if !filter.Valid() {
			t.Fatalf("%q must be admitted", filter)
		}
	}
	for _, filter := range []KindFilter{"ALL", "batteries", "other ", "gift", "two"} {
		if filter.Valid() {
			t.Fatalf("%q must be refused", filter)
		}
	}
	if KindFilter("").Filter() != BatteryOnly {
		t.Fatal("an absent kind must select the battery-only listing")
	}
	if AllKinds.Filter() != AllKinds {
		t.Fatal("an explicit kind must stay as it is")
	}
}

// The number grammar is the column's own numeric(18,6), shared by the catalog
// write and by every identity read.
func TestCanonicalNumber(t *testing.T) {
	for value, want := range map[string]string{
		"5": "5", "005.50": "5.5", "-0.5": "-0.5", "0": "0", "-12": "-12",
		"123456789012": "123456789012", "0.000001": "0.000001",
	} {
		got, err := CanonicalNumber(value)
		if err != nil || string(got) != want {
			t.Fatalf("%q canonicalized to %q (%v), want %q", value, got, err, want)
		}
	}
	for _, value := range []string{"", " 5", "5 ", "-0", "+5", "1e3", "5.0000000", "1234567890123", ".5", "5."} {
		if _, err := CanonicalNumber(value); err == nil {
			t.Fatalf("%q must be refused", value)
		}
	}
}

func strPtr(value string) *string { return &value }
