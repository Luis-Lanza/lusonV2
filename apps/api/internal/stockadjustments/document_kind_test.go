package stockadjustments

import (
	"errors"
	"testing"

	"luson/api/internal/catalog"
)

// The kind of a document is derived from its lines and never stored: a document
// whose lines are all of one kind is of that kind, and a document whose lines
// disagree is one written before the one-kind rule, which therefore has no kind at
// all instead of a guess.
func TestDocumentKind(t *testing.T) {
	for _, c := range []struct {
		name     string
		distinct int64
		sole     string
		want     catalog.Kind
	}{
		{"batteries_only", 1, string(catalog.BatteryKind), catalog.BatteryKind},
		{"products_only", 1, string(catalog.OtherKind), catalog.OtherKind},
		{"both_kinds", 2, string(catalog.BatteryKind), ""},
		{"both_kinds_other_minimum", 2, string(catalog.OtherKind), ""},
	} {
		kind, err := documentKind(c.distinct, c.sole)
		if err != nil || kind != c.want {
			t.Fatalf("%s must derive %q: got %q %v", c.name, c.want, kind, err)
		}
	}
	// Nothing else is a document this domain wrote, so nothing else is described.
	for name, c := range map[string]struct {
		distinct int64
		sole     string
	}{
		"no_lines":       {0, ""},
		"unknown_kind":   {1, "gift"},
		"blank_kind":     {1, ""},
		"negative_kinds": {-1, string(catalog.BatteryKind)},
	} {
		if _, err := documentKind(c.distinct, c.sole); !errors.Is(err, ErrUnavailable) {
			t.Fatalf("%s must fail closed", name)
		}
	}
}
