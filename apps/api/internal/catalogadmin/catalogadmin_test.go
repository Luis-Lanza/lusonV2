package catalogadmin

import (
	"strings"
	"testing"

	"luson/api/internal/catalog"
)

// The canonical input of a battery is decided before any statement runs: the
// brand and model are exact bounded text, the capacity is the catalogue decimal
// and the polarities are one or both of L and R in ascending order.
func TestCatalogAdminCanonicalCreate(t *testing.T) {
	for _, c := range []struct {
		name string
		in   CreateInput
		want CreateInput
	}{
		{
			name: "both_polarities",
			in:   CreateInput{Brand: "CAR", Model: "NS40ZL", Capacity: "45", Polarities: []catalog.Polarity{catalog.Left, catalog.Right}},
			want: CreateInput{Brand: "CAR", Model: "NS40ZL", Capacity: "45", Polarities: []catalog.Polarity{catalog.Left, catalog.Right}},
		},
		{
			name: "left_only",
			in:   CreateInput{Brand: "CAR", Model: "NS40ZL", Capacity: "45", Polarities: []catalog.Polarity{catalog.Left}},
			want: CreateInput{Brand: "CAR", Model: "NS40ZL", Capacity: "45", Polarities: []catalog.Polarity{catalog.Left}},
		},
		{
			name: "right_only",
			in:   CreateInput{Brand: "CAR", Model: "NS40ZL", Capacity: "45", Polarities: []catalog.Polarity{catalog.Right}},
			want: CreateInput{Brand: "CAR", Model: "NS40ZL", Capacity: "45", Polarities: []catalog.Polarity{catalog.Right}},
		},
		{
			name: "capacity_is_canonicalized",
			in:   CreateInput{Brand: "CAR", Model: "NS40ZL", Capacity: "000123.450000", Polarities: []catalog.Polarity{catalog.Left, catalog.Right}},
			want: CreateInput{Brand: "CAR", Model: "NS40ZL", Capacity: "123.45", Polarities: []catalog.Polarity{catalog.Left, catalog.Right}},
		},
		{
			name: "text_is_preserved_exactly",
			in:   CreateInput{Brand: " CAR ", Model: "NS 40ZL", Capacity: "45.5", Polarities: []catalog.Polarity{catalog.Left}},
			want: CreateInput{Brand: " CAR ", Model: "NS 40ZL", Capacity: "45.5", Polarities: []catalog.Polarity{catalog.Left}},
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			got, err := CanonicalCreate(c.in)
			if err != nil {
				t.Fatalf("refused %v: %v", c.in, err)
			}
			if got.Brand != c.want.Brand || got.Model != c.want.Model ||
				got.Capacity != c.want.Capacity || len(got.Polarities) != len(c.want.Polarities) {
				t.Fatalf("canonical %v, want %v", got, c.want)
			}
			for i := range got.Polarities {
				if got.Polarities[i] != c.want.Polarities[i] {
					t.Fatalf("polarity %d = %q, want %q", i, got.Polarities[i], c.want.Polarities[i])
				}
			}
		})
	}
}

func TestCatalogAdminRejectsNonCanonicalCreate(t *testing.T) {
	long := strings.Repeat("A", 129)
	for _, c := range []struct {
		name string
		in   CreateInput
	}{
		{"empty_brand", CreateInput{Brand: "", Model: "M", Capacity: "45", Polarities: []catalog.Polarity{catalog.Left}}},
		{"blank_brand", CreateInput{Brand: "   ", Model: "M", Capacity: "45", Polarities: []catalog.Polarity{catalog.Left}}},
		{"nul_brand", CreateInput{Brand: "A\x00B", Model: "M", Capacity: "45", Polarities: []catalog.Polarity{catalog.Left}}},
		{"long_brand", CreateInput{Brand: long, Model: "M", Capacity: "45", Polarities: []catalog.Polarity{catalog.Left}}},
		{"empty_model", CreateInput{Brand: "B", Model: "", Capacity: "45", Polarities: []catalog.Polarity{catalog.Left}}},
		{"blank_model", CreateInput{Brand: "B", Model: "\t", Capacity: "45", Polarities: []catalog.Polarity{catalog.Left}}},
		{"zero_capacity", CreateInput{Brand: "B", Model: "M", Capacity: "0", Polarities: []catalog.Polarity{catalog.Left}}},
		{"zero_decimal_capacity", CreateInput{Brand: "B", Model: "M", Capacity: "00.000", Polarities: []catalog.Polarity{catalog.Left}}},
		{"negative_capacity", CreateInput{Brand: "B", Model: "M", Capacity: "-1", Polarities: []catalog.Polarity{catalog.Left}}},
		{"signed_capacity", CreateInput{Brand: "B", Model: "M", Capacity: "+1", Polarities: []catalog.Polarity{catalog.Left}}},
		{"exponent_capacity", CreateInput{Brand: "B", Model: "M", Capacity: "1e3", Polarities: []catalog.Polarity{catalog.Left}}},
		{"over_precise_capacity", CreateInput{Brand: "B", Model: "M", Capacity: "45.0000001", Polarities: []catalog.Polarity{catalog.Left}}},
		{"over_wide_capacity", CreateInput{Brand: "B", Model: "M", Capacity: "1234567", Polarities: []catalog.Polarity{catalog.Left}}},
		{"no_polarity", CreateInput{Brand: "B", Model: "M", Capacity: "45", Polarities: nil}},
		{"empty_polarities", CreateInput{Brand: "B", Model: "M", Capacity: "45", Polarities: []catalog.Polarity{}}},
		{"repeated_polarity", CreateInput{Brand: "B", Model: "M", Capacity: "45", Polarities: []catalog.Polarity{catalog.Left, catalog.Left}}},
		{"descending_polarities", CreateInput{Brand: "B", Model: "M", Capacity: "45", Polarities: []catalog.Polarity{catalog.Right, catalog.Left}}},
		{"three_polarities", CreateInput{Brand: "B", Model: "M", Capacity: "45", Polarities: []catalog.Polarity{catalog.Left, catalog.Right, catalog.Left}}},
		{"unknown_polarity", CreateInput{Brand: "B", Model: "M", Capacity: "45", Polarities: []catalog.Polarity{"X"}}},
		{"empty_polarity", CreateInput{Brand: "B", Model: "M", Capacity: "45", Polarities: []catalog.Polarity{""}}},
	} {
		t.Run(c.name, func(t *testing.T) {
			if got, err := CanonicalCreate(c.in); err != ErrInvalid {
				t.Fatalf("admitted %v as %v", c.in, got)
			}
		})
	}
}

// An edit carries exactly the three identity fields: brand, model and capacity.
func TestCatalogAdminCanonicalEdit(t *testing.T) {
	got, err := CanonicalEdit(EditInput{Brand: "CAR", Model: "NS40ZL", Capacity: "00045.500"})
	if err != nil || got.Brand != "CAR" || got.Model != "NS40ZL" || got.Capacity != "45.5" {
		t.Fatalf("canonical edit %v %v", got, err)
	}
	for _, c := range []EditInput{
		{Brand: "", Model: "M", Capacity: "45"},
		{Brand: "B", Model: " ", Capacity: "45"},
		{Brand: "B", Model: "M", Capacity: "0"},
		{Brand: "B", Model: "M", Capacity: "4,5"},
	} {
		if _, err := CanonicalEdit(c); err != ErrInvalid {
			t.Fatalf("admitted edit %v", c)
		}
	}
}

func TestCatalogAdminValidName(t *testing.T) {
	for _, c := range []struct {
		value string
		want  bool
	}{
		{"A", true},
		{strings.Repeat("A", 128), true},
		{strings.Repeat("A", 129), false},
		{"", false},
		{" ", false},
		{"\u00a0", false},
		{"A\x00B", false},
		{"CAR 12", true},
	} {
		if got := ValidName(c.value); got != c.want {
			t.Fatalf("ValidName(%q) = %v, want %v", c.value, got, c.want)
		}
	}
}
