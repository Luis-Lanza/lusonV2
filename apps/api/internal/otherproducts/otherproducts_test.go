package otherproducts

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"luson/api/internal/catalog"
)

// raw returns the decimal text exactly as the client typed it.
func raw(value string) *catalog.Decimal {
	parsed := catalog.Decimal(value)
	return &parsed
}

func text(value string) *string { return &value }

// describe renders a field set for a failure message.
func describe(fields []Field) string {
	parts := make([]string, 0, len(fields))
	for _, field := range fields {
		value := ""
		if field.Number != nil {
			value = "number=" + string(*field.Number)
		}
		if field.Text != nil {
			value = "text=" + *field.Text
		}
		parts = append(parts, field.Name+"/"+string(field.Kind)+"/"+field.Unit+"/"+value)
	}
	return "[" + strings.Join(parts, " ") + "]"
}

// sameFields compares two field sets value by value.
func sameFields(got, want []Field) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i].Name != want[i].Name || got[i].Kind != want[i].Kind || got[i].Unit != want[i].Unit ||
			(got[i].Number == nil) != (want[i].Number == nil) ||
			(got[i].Text == nil) != (want[i].Text == nil) {
			return false
		}
		if got[i].Number != nil && *got[i].Number != *want[i].Number {
			return false
		}
		if got[i].Text != nil && *got[i].Text != *want[i].Text {
			return false
		}
	}
	return true
}

// A product name is trimmed before it is bounded: 3 to 64 bytes, valid UTF-8 and
// free of control characters, so no untrimmed, over-long or control-bearing name
// ever reaches the database.
func TestOtherProductsCanonicalName(t *testing.T) {
	for _, c := range []struct {
		name  string
		value string
		want  string
		ok    bool
	}{
		{name: "minimal", value: "abc", want: "abc", ok: true},
		{name: "example", value: "Agua acidulada", want: "Agua acidulada", ok: true},
		{name: "trimmed", value: "  Agua acidulada  ", want: "Agua acidulada", ok: true},
		{name: "trimmed_tabs", value: "\tAgua acidulada\n", want: "Agua acidulada", ok: true},
		{name: "multibyte", value: "Agüita", want: "Agüita", ok: true},
		{name: "max_bytes", value: strings.Repeat("a", maxName), want: strings.Repeat("a", maxName), ok: true},
		{name: "over_bytes", value: strings.Repeat("a", maxName+1), ok: false},
		{name: "over_bytes_multibyte", value: strings.Repeat("ñ", maxName/2+1), ok: false},
		{name: "short", value: "ab", ok: false},
		{name: "short_after_trim", value: "  ab  ", ok: false},
		{name: "empty", value: "", ok: false},
		{name: "blank", value: "     ", ok: false},
		{name: "tab_only", value: "\t\t\t", ok: false},
		{name: "interior_control", value: "Agua\tacidulada", ok: false},
		{name: "newline", value: "Agua\nacidulada", ok: false},
		{name: "nul", value: "Agua acidulada\x00", ok: false},
		{name: "invalid_utf8", value: "Agua acidulada\xff", ok: false},
	} {
		t.Run(c.name, func(t *testing.T) {
			got, err := CanonicalName(c.value)
			if c.ok {
				if err != nil || got != c.want {
					t.Fatalf("CanonicalName(%q) = %q, %v; want %q", c.value, got, err, c.want)
				}
				return
			}
			if err != ErrInvalid {
				t.Fatalf("CanonicalName(%q) = %q, %v; want ErrInvalid", c.value, got, err)
			}
		})
	}
}

// A number field travels as the column's own canonical decimal text: twelve
// integral and six fractional digits, zero and negative values included, never a
// binary float and never a padded spelling.
func TestOtherProductsCanonicalNumber(t *testing.T) {
	for _, c := range []struct{ value, want string }{
		{"5", "5"},
		{"0", "0"},
		{"-5", "-5"},
		{"005.500", "5.5"},
		{"-005.500", "-5.5"},
		{"000.000", "0"},
		{"5.000", "5"},
		{"123456789012", "123456789012"},
		{"123456789012.123456", "123456789012.123456"},
		{"0.000001", "0.000001"},
		{"000000000000000005", "5"},
	} {
		got, err := CanonicalNumber(c.value)
		if err != nil || string(got) != c.want {
			t.Fatalf("CanonicalNumber(%q) = %q, %v; want %q", c.value, got, err, c.want)
		}
	}
	for _, value := range []string{
		"", "-", "+5", "5.", ".5", "5,5", "1e3", "0x10", "cinco", " 5", "5 ",
		"-0", "-0.0", "1234567890123", "5.0000001", strings.Repeat("9", 19),
	} {
		if got, err := CanonicalNumber(value); err != ErrInvalid {
			t.Fatalf("CanonicalNumber(%q) = %q, %v; want ErrInvalid", value, got, err)
		}
	}
}

// The whole field set is decided before any statement runs: at most twenty fields,
// a trimmed unique name of 1 to 40 bytes each, exactly one value kind, and a
// canonical decimal on every number.
func TestOtherProductsCanonicalFields(t *testing.T) {
	canonicalized := Field{Name: "volumen en L", Kind: KindNumber, Number: raw("5.000")}
	got, err := CanonicalFields([]Field{canonicalized})
	if err != nil || len(got) != 1 || got[0].Number == nil || *got[0].Number != "5" {
		t.Fatalf("canonical number %v %v", got, err)
	}
	for _, c := range []struct {
		name string
		in   []Field
		want []Field
	}{
		{name: "empty_set", in: nil, want: []Field{}},
		{
			name: "number_with_unit",
			in:   []Field{{Name: "volumen en L", Kind: KindNumber, Unit: "L", Number: raw("5")}},
			want: []Field{{Name: "volumen en L", Kind: KindNumber, Unit: "L", Number: raw("5")}},
		},
		{
			name: "number_without_unit",
			in:   []Field{{Name: "volumen en L", Kind: KindNumber, Number: raw("5.5")}},
			want: []Field{{Name: "volumen en L", Kind: KindNumber, Number: raw("5.5")}},
		},
		{
			name: "number_canonicalized",
			in:   []Field{{Name: "volumen en L", Kind: KindNumber, Number: raw("0005.500")}},
			want: []Field{{Name: "volumen en L", Kind: KindNumber, Number: raw("5.5")}},
		},
		{
			name: "number_zero",
			in:   []Field{{Name: "volumen en L", Kind: KindNumber, Number: raw("000.0000")}},
			want: []Field{{Name: "volumen en L", Kind: KindNumber, Number: raw("0")}},
		},
		{
			name: "number_negative",
			in:   []Field{{Name: "volumen en L", Kind: KindNumber, Unit: "L", Number: raw("-005.500")}},
			want: []Field{{Name: "volumen en L", Kind: KindNumber, Unit: "L", Number: raw("-5.5")}},
		},
		{
			name: "number_largest_integral",
			in:   []Field{{Name: "volumen en L", Kind: KindNumber, Number: raw("123456789012")}},
			want: []Field{{Name: "volumen en L", Kind: KindNumber, Number: raw("123456789012")}},
		},
		{
			name: "text",
			in:   []Field{{Name: "origen", Kind: KindText, Text: text("importado")}},
			want: []Field{{Name: "origen", Kind: KindText, Text: text("importado")}},
		},
		{
			name: "text_is_preserved_exactly",
			in:   []Field{{Name: "origen", Kind: KindText, Text: text(" importado ")}},
			want: []Field{{Name: "origen", Kind: KindText, Text: text(" importado ")}},
		},
		{
			name: "name_and_unit_trimmed",
			in:   []Field{{Name: " volumen en L ", Kind: KindNumber, Unit: " L ", Number: raw("5")}},
			want: []Field{{Name: "volumen en L", Kind: KindNumber, Unit: "L", Number: raw("5")}},
		},
		{
			name: "client_order_is_preserved",
			in: []Field{
				{Name: "origen", Kind: KindText, Text: text("importado")},
				{Name: "volumen en L", Kind: KindNumber, Unit: "L", Number: raw("5")},
			},
			want: []Field{
				{Name: "origen", Kind: KindText, Text: text("importado")},
				{Name: "volumen en L", Kind: KindNumber, Unit: "L", Number: raw("5")},
			},
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			got, err := CanonicalFields(c.in)
			if err != nil {
				t.Fatalf("refused %v: %v", c.in, err)
			}
			if !sameFields(got, c.want) {
				t.Fatalf("canonical %v, want %v", describe(got), describe(c.want))
			}
		})
	}
	many := make([]Field, maxFields)
	for i := range many {
		many[i] = Field{Name: fmt.Sprintf("campo %d", i), Kind: KindText, Text: text("valor")}
	}
	if _, err := CanonicalFields(many); err != nil {
		t.Fatalf("refused the admitted field count %d: %v", maxFields, err)
	}
}

func TestOtherProductsRejectsNonCanonicalFields(t *testing.T) {
	full := make([]Field, maxFields)
	for i := range full {
		full[i] = Field{Name: fmt.Sprintf("campo %d", i), Kind: KindText, Text: text("valor")}
	}
	tooMany := append(full, Field{Name: "ultimo", Kind: KindText, Text: text("valor")})
	for _, c := range []struct {
		name string
		in   []Field
	}{
		{name: "too_many_fields", in: tooMany},
		{name: "empty_name", in: []Field{{Name: "", Kind: KindText, Text: text("v")}}},
		{name: "blank_name", in: []Field{{Name: "   ", Kind: KindText, Text: text("v")}}},
		{name: "long_name", in: []Field{{Name: strings.Repeat("a", maxFieldName+1), Kind: KindText, Text: text("v")}}},
		{name: "nul_name", in: []Field{{Name: "ori\x00gen", Kind: KindText, Text: text("v")}}},
		{name: "invalid_utf8_name", in: []Field{{Name: "ori\xffgen", Kind: KindText, Text: text("v")}}},
		{name: "duplicate_name", in: []Field{
			{Name: "origen", Kind: KindText, Text: text("a")},
			{Name: "origen", Kind: KindText, Text: text("b")},
		}},
		{name: "duplicate_name_ignoring_case", in: []Field{
			{Name: "Origen", Kind: KindText, Text: text("a")},
			{Name: "origen", Kind: KindText, Text: text("b")},
		}},
		{name: "duplicate_name_after_trim", in: []Field{
			{Name: "origen", Kind: KindText, Text: text("a")},
			{Name: " origen ", Kind: KindText, Text: text("b")},
		}},
		{name: "unknown_kind", in: []Field{{Name: "origen", Kind: Kind("NUMBER"), Number: raw("5")}}},
		{name: "empty_kind", in: []Field{{Name: "origen", Kind: Kind(""), Text: text("v")}}},
		{name: "number_without_value", in: []Field{{Name: "volumen", Kind: KindNumber}}},
		{name: "number_with_text", in: []Field{{Name: "volumen", Kind: KindNumber, Number: raw("5"), Text: text("cinco")}}},
		{name: "number_over_precise", in: []Field{{Name: "volumen", Kind: KindNumber, Number: raw("5.0000001")}}},
		{name: "number_over_integral", in: []Field{{Name: "volumen", Kind: KindNumber, Number: raw("1234567890123")}}},
		{name: "number_negative_zero", in: []Field{{Name: "volumen", Kind: KindNumber, Number: raw("-0")}}},
		{name: "number_negative_zero_decimal", in: []Field{{Name: "volumen", Kind: KindNumber, Number: raw("-0.000")}}},
		{name: "number_signed", in: []Field{{Name: "volumen", Kind: KindNumber, Number: raw("+5")}}},
		{name: "number_exponent", in: []Field{{Name: "volumen", Kind: KindNumber, Number: raw("1e3")}}},
		{name: "number_trailing_point", in: []Field{{Name: "volumen", Kind: KindNumber, Number: raw("5.")}}},
		{name: "number_leading_point", in: []Field{{Name: "volumen", Kind: KindNumber, Number: raw(".5")}}},
		{name: "number_not_a_decimal", in: []Field{{Name: "volumen", Kind: KindNumber, Number: raw("cinco")}}},
		{name: "field_name_control", in: []Field{{Name: "volu\tmen", Kind: KindText, Text: text("v")}}},
		{name: "unit_control", in: []Field{{Name: "volumen", Kind: KindNumber, Unit: "L\t", Number: raw("5")}}},
		{name: "unit_too_long", in: []Field{{Name: "volumen", Kind: KindNumber, Unit: strings.Repeat("a", maxUnit+1), Number: raw("5")}}},
		{name: "unit_blank", in: []Field{{Name: "volumen", Kind: KindNumber, Unit: "  ", Number: raw("5")}}},
		{name: "unit_nul", in: []Field{{Name: "volumen", Kind: KindNumber, Unit: "L\x00", Number: raw("5")}}},
		{name: "text_without_value", in: []Field{{Name: "origen", Kind: KindText}}},
		{name: "text_empty", in: []Field{{Name: "origen", Kind: KindText, Text: text("")}}},
		{name: "text_too_long", in: []Field{{Name: "origen", Kind: KindText, Text: text(strings.Repeat("a", maxText+1))}}},
		{name: "text_with_unit", in: []Field{{Name: "origen", Kind: KindText, Unit: "L", Text: text("importado")}}},
		{name: "text_with_number", in: []Field{{Name: "origen", Kind: KindText, Number: raw("5"), Text: text("importado")}}},
		{name: "text_nul", in: []Field{{Name: "origen", Kind: KindText, Text: text("importado\x00")}}},
	} {
		t.Run(c.name, func(t *testing.T) {
			if got, err := CanonicalFields(c.in); err != ErrInvalid {
				t.Fatalf("admitted %v as %v", c.name, describe(got))
			}
		})
	}
}

// The canonical set is a new slice: the caller's fields are never modified.
func TestOtherProductsCanonicalFieldsDoNotModifyInput(t *testing.T) {
	unit := " L "
	raw := "005.500"
	input := []Field{{Name: " volumen en L ", Kind: KindNumber, Unit: unit, Number: (*catalog.Decimal)(&raw)}}
	if _, err := CanonicalFields(input); err != nil {
		t.Fatalf("refused %v: %v", describe(input), err)
	}
	if input[0].Name != " volumen en L " || input[0].Unit != unit || *input[0].Number != catalog.Decimal(raw) {
		t.Fatalf("the caller's field was rewritten: %v", describe(input))
	}
}

// A creation and an edit carry the same document: the free name and the whole
// field set, never an id.
func TestOtherProductsCanonicalDocuments(t *testing.T) {
	created, err := CanonicalCreate(CreateInput{
		Name:   "  Agua acidulada ",
		Fields: []Field{{Name: "volumen en L", Kind: KindNumber, Unit: "L", Number: raw("5.000")}},
	})
	if err != nil || created.Name != "Agua acidulada" || len(created.Fields) != 1 ||
		created.Fields[0].Number == nil || *created.Fields[0].Number != "5" {
		t.Fatalf("canonical creation %v %v", describe(created.Fields), err)
	}
	edited, err := CanonicalEdit(EditInput{Name: "Agua acidulada", Fields: []Field{}})
	if err != nil || edited.Name != "Agua acidulada" || edited.Fields == nil || len(edited.Fields) != 0 {
		t.Fatalf("canonical edit %v %v", edited, err)
	}
	if _, err := CanonicalCreate(CreateInput{Name: "ab"}); err != ErrInvalid {
		t.Fatal("admitted a short product name")
	}
	if _, err := CanonicalEdit(EditInput{Name: "Agua acidulada", Fields: []Field{{Name: "", Kind: KindText, Text: text("v")}}}); err != ErrInvalid {
		t.Fatal("admitted an empty field name")
	}
}

// The read filter is the price matrix's own page contract.
func TestOtherProductsValidQuery(t *testing.T) {
	for _, c := range []struct {
		name  string
		query Query
		ok    bool
	}{
		{name: "defaults", query: Query{Page: 1, PageSize: 10}, ok: true},
		{name: "all_filters", query: Query{Search: "agua", Page: 2, PageSize: 25}, ok: true},
		{name: "large_page", query: Query{Page: MaxPage, PageSize: 50}, ok: true},
		{name: "max_search", query: Query{Search: strings.Repeat("a", maxSearch), Page: 1, PageSize: 10}, ok: true},
		{name: "max_search_multibyte", query: Query{Search: strings.Repeat("ñ", maxSearch), Page: 1, PageSize: 10}, ok: true},
		{name: "zero_page", query: Query{Page: 0, PageSize: 10}, ok: false},
		{name: "negative_page", query: Query{Page: -1, PageSize: 10}, ok: false},
		{name: "page_bound", query: Query{Page: MaxPage + 1, PageSize: 10}, ok: false},
		{name: "size_fifteen", query: Query{Page: 1, PageSize: 15}, ok: false},
		{name: "zero_size", query: Query{Page: 1, PageSize: 0}, ok: false},
		{name: "size_bound", query: Query{Page: 1, PageSize: 51}, ok: false},
		{name: "long_search", query: Query{Search: strings.Repeat("a", maxSearch+1), Page: 1, PageSize: 10}, ok: false},
		{name: "nul_search", query: Query{Search: "agua\x00", Page: 1, PageSize: 10}, ok: false},
		{name: "invalid_utf8_search", query: Query{Search: "agua\xff", Page: 1, PageSize: 10}, ok: false},
	} {
		t.Run(c.name, func(t *testing.T) {
			if got := ValidQuery(c.query); got != c.ok {
				t.Fatalf("ValidQuery(%v) = %v, want %v", c.query, got, c.ok)
			}
		})
	}
}

// The database's own refusals are published as this contract's errors: a duplicate
// active name is a conflict, a repeated field name stays an invalid request, and
// nothing is invented for an error the mapping does not know.
func TestOtherProductsWriteError(t *testing.T) {
	for _, c := range []struct {
		name string
		err  error
		want error
	}{
		{name: "duplicate_product_name", err: &pgconn.PgError{Code: "23505", ConstraintName: "catalog_entries_active_other_name"}, want: ErrConflict},
		{name: "duplicate_battery_identity", err: &pgconn.PgError{Code: "23505", ConstraintName: "catalog_entries_active_brand_model"}, want: ErrConflict},
		{name: "duplicate_field_name", err: &pgconn.PgError{Code: "23505", ConstraintName: "catalog_entry_fields_name"}, want: ErrInvalid},
		{name: "unknown_parent", err: &pgconn.PgError{Code: "23503"}, want: ErrInvalid},
		{name: "kind_shape", err: &pgconn.PgError{Code: "23514", ConstraintName: "catalog_entries_kind_shape"}, want: ErrInvalid},
		{name: "field_shape", err: &pgconn.PgError{Code: "23514", ConstraintName: "catalog_entry_fields_shape"}, want: ErrInvalid},
		{name: "retired_field_parent", err: &pgconn.PgError{Code: "23514", ConstraintName: "catalog_entry_field_retired"}, want: ErrInvalid},
		{name: "numeric_range", err: &pgconn.PgError{Code: "22003"}, want: ErrInvalid},
		{name: "malformed_argument", err: &pgconn.PgError{Code: "22P02"}, want: ErrInvalid},
	} {
		t.Run(c.name, func(t *testing.T) {
			if got := writeError(fmt.Errorf("write: %w", c.err)); got != c.want {
				t.Fatalf("writeError = %v, want %v", got, c.want)
			}
		})
	}
	unknown := errors.New("driver failure")
	if got := writeError(unknown); got != unknown {
		t.Fatalf("writeError invented %v for an unknown error", got)
	}
	serialization := &pgconn.PgError{Code: "40001"}
	if got := writeError(serialization); got != error(serialization) {
		t.Fatalf("writeError invented %v for a serialization failure", got)
	}
}

func TestOtherProductsRetiredError(t *testing.T) {
	blocked := &pgconn.PgError{Code: "23514", ConstraintName: "catalog_retirement_blocked"}
	if got := retiredError(fmt.Errorf("retire: %w", blocked)); got != ErrConflict {
		t.Fatalf("retiredError = %v, want ErrConflict", got)
	}
	other := &pgconn.PgError{Code: "23514", ConstraintName: "catalog_entry_retired_immutable"}
	if got := retiredError(other); got != error(other) {
		t.Fatalf("retiredError invented %v for another refusal", got)
	}
}

// fail keeps cancellation semantics and never leaks driver details.
func TestOtherProductsFail(t *testing.T) {
	if got := fail(context.Background()); got != ErrUnavailable {
		t.Fatalf("fail = %v, want ErrUnavailable", got)
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if got := fail(cancelled); !errors.Is(got, context.Canceled) {
		t.Fatalf("fail = %v, want the cancellation", got)
	}
}

// Every operation refuses before the first statement when its authority is
// missing: the gate is never satisfied by an absent store, pool or service.
func TestOtherProductsStoreWithoutAuthority(t *testing.T) {
	ctx := context.Background()
	input := CreateInput{Name: "Agua acidulada"}
	edit := EditInput{Name: "Agua acidulada"}
	query := Query{Page: 1, PageSize: 10}
	var empty *Store
	for _, c := range []struct {
		name string
		call func(*Store) error
	}{
		{name: "create", call: func(s *Store) error { _, err := s.Create(ctx, "token", input); return err }},
		{name: "edit", call: func(s *Store) error { _, err := s.Edit(ctx, "token", 113, edit); return err }},
		{name: "retire", call: func(s *Store) error { return s.Retire(ctx, "token", 113) }},
		{name: "list", call: func(s *Store) error { _, err := s.List(ctx, "token", query); return err }},
		{name: "administrator", call: func(s *Store) error { return s.Administrator(ctx, "token") }},
	} {
		t.Run(c.name, func(t *testing.T) {
			if err := c.call(empty); err != ErrUnavailable {
				t.Fatalf("nil store answered %v", err)
			}
			if err := c.call(New(nil, nil)); err != ErrUnavailable {
				t.Fatalf("empty store answered %v", err)
			}
		})
	}
}

// The search is a literal substring: a typed wildcard never widens the query.
func TestOtherProductsLiteralPattern(t *testing.T) {
	for _, c := range []struct{ search, want string }{
		{"", ""},
		{"agua", "%agua%"},
		{"50%", `%50\%%`},
		{"a_b", `%a\_b%`},
		{`a\b`, `%a\\b%`},
	} {
		if got := literalPattern(c.search); got != c.want {
			t.Fatalf("literalPattern(%q) = %q, want %q", c.search, got, c.want)
		}
	}
}
