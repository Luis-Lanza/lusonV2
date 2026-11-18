package catalog

import (
	"context"
	"errors"
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// ErrIdentity reports a variant identity this catalogue could not have produced:
// a kind the catalogue does not have, a battery without its battery shape, a
// product carrying one, or a name and a detail the server never composes.
var ErrIdentity = errors.New("invalid variant identity")

// Kind is the kind of a catalogue entry. A battery is identified by a brand, a
// model, a capacity and a polarity; an other product is identified by a free name
// and its typed custom fields.
type Kind string

const (
	BatteryKind Kind = "battery"
	OtherKind   Kind = "other"
)

// KindFilter is the three-state kind selection every kind-aware read accepts. The
// absent value is the battery-only listing every existing caller already had, so
// defaulting it never changes an answer that predates the second kind.
type KindFilter string

const (
	AllKinds    KindFilter = "all"
	BatteryOnly KindFilter = "battery"
	OtherOnly   KindFilter = "other"
)

// Valid admits the three states of the filter and the absent value the store
// defaults to the battery-only listing.
func (f KindFilter) Valid() bool {
	switch f {
	case "", AllKinds, BatteryOnly, OtherOnly:
		return true
	}
	return false
}

// Filter resolves the absent value to the battery-only listing.
func (f KindFilter) Filter() KindFilter {
	if f == "" {
		return BatteryOnly
	}
	return f
}

// Field kinds: a number, which may declare a unit, or free text.
const (
	NumberField = "number"
	TextField   = "text"
)

const (
	// MaxFields is the admitted number of custom fields of one product.
	MaxFields = 20
	// maxFieldName, maxFieldUnit and maxFieldText are the column's own bounds,
	// restated here so a row this contract could not publish never reaches a
	// screen.
	maxFieldName = 40
	maxFieldUnit = 8
	maxFieldText = 200
	// maxIntegral is the integral width of the numeric(18,6) number column.
	maxIntegral = 12
)

// Field is one typed custom field of an other product as every surface reads it.
// A number field carries its canonical decimal text and an optional unit; a text
// field carries its text and no unit. The wire form is the catalog's own.
type Field struct {
	Name   string  `json:"name"`
	Kind   string  `json:"kind"`
	Unit   string  `json:"unit,omitempty"`
	Number *string `json:"number,omitempty"`
	Text   *string `json:"text,omitempty"`
}

// Battery is the battery identity of a variant: the brand, the model, the
// capacity as the canonical decimal text and the polarity.
type BatteryAttributes struct {
	Brand    string `json:"brand"`
	Model    string `json:"model"`
	Capacity string `json:"capacity_ah"`
	Polarity string `json:"polarity"`
}

// Identity is the variant identity every screen reads: one shape for both kinds,
// where the kind shows in the name and the detail. A battery carries its battery
// attributes and no typed field; a product carries its typed fields and no
// battery attribute.
type Identity struct {
	VariantID int                `json:"variant_id"`
	Kind      Kind               `json:"kind"`
	Name      string             `json:"name"`
	Detail    string             `json:"detail"`
	Battery   *BatteryAttributes `json:"battery"`
	Fields    []Field            `json:"fields"`
}

// BatteryName is the first line of a battery row: the brand and the model.
func BatteryName(brand, model string) string { return brand + " · " + model }

// BatteryDetail is the second line of a battery row: the capacity with its unit
// and the polarity, joined the way a field summary is.
func BatteryDetail(capacity, polarity string) string { return capacity + " Ah · " + polarity }

// BatteryIdentity composes the identity of one battery variant.
func BatteryIdentity(variantID int, brand, model, capacity, polarity string) Identity {
	return Identity{
		VariantID: variantID,
		Kind:      BatteryKind,
		Name:      BatteryName(brand, model),
		Detail:    BatteryDetail(capacity, polarity),
		Battery:   &BatteryAttributes{Brand: brand, Model: model, Capacity: capacity, Polarity: polarity},
	}
}

// ProductIdentity composes the identity of one other-product variant: its free
// name and the summary of its typed fields.
func ProductIdentity(variantID int, name string, fields []Field) Identity {
	if fields == nil {
		fields = []Field{}
	}
	return Identity{
		VariantID: variantID,
		Kind:      OtherKind,
		Name:      name,
		Detail:    ProductDetail(name, fields),
		Fields:    fields,
	}
}

// FieldSummary renders the typed fields as the one summary line every surface
// shows: the first three as "nombre: valor unidad", joined with " · ", and the
// count of the remaining fields appended as " · +N". A text field has no unit; a
// number field renders its canonical value followed by its unit when it declares
// one.
func FieldSummary(fields []Field) string {
	shown := fields
	if len(shown) > 3 {
		shown = shown[:3]
	}
	parts := make([]string, 0, len(shown)+1)
	for _, field := range shown {
		value := ""
		switch field.Kind {
		case NumberField:
			if field.Number != nil {
				value = *field.Number
			}
		case TextField:
			if field.Text != nil {
				value = *field.Text
			}
		}
		if value != "" && field.Unit != "" {
			value += " " + field.Unit
		}
		parts = append(parts, field.Name+": "+value)
	}
	summary := strings.Join(parts, " · ")
	if len(fields) > 3 {
		summary += " · +" + strconv.Itoa(len(fields)-3)
	}
	return summary
}

// ProductDetail is the detail line of a product: the summary of its typed fields,
// or its own name when it declares none, because a name and a detail are never
// empty.
func ProductDetail(name string, fields []Field) string {
	if summary := FieldSummary(fields); summary != "" {
		return summary
	}
	return name
}

// Row is one catalogue row as every identity read selects it. The battery
// columns are empty exactly when the entry is an other product.
type Row struct {
	VariantID      int
	CatalogEntryID int
	Kind           Kind
	Brand          string
	Model          string
	Capacity       string
	Polarity       string
	Name           string
}

// Identity composes the identity of this row with the typed fields of its own
// entry and re-checks it against the rule of its kind, so a row this contract
// could not publish is refused instead of described.
func (v Row) Identity(fields []Field) (Identity, error) {
	var identity Identity
	switch v.Kind {
	case BatteryKind:
		capacity, err := ParseDecimal(v.Capacity)
		if err != nil {
			return Identity{}, ErrIdentity
		}
		identity = BatteryIdentity(v.VariantID, v.Brand, v.Model, string(capacity), v.Polarity)
	case OtherKind:
		identity = ProductIdentity(v.VariantID, v.Name, fields)
	default:
		return Identity{}, ErrIdentity
	}
	if err := identity.Valid(); err != nil {
		return Identity{}, err
	}
	return identity, nil
}

// Valid re-checks one identity against the rule of its kind: a battery still
// requires a non-empty brand and model, a positive capacity and a polarity L or
// R, and a product requires a non-empty name and carries no battery attribute.
// The name and the detail must be the ones the server composes.
func (i Identity) Valid() error {
	if i.VariantID < 1 || i.VariantID > math.MaxInt32 || !identityText(i.Name) || !identityText(i.Detail) {
		return ErrIdentity
	}
	switch i.Kind {
	case BatteryKind:
		if i.Battery == nil || i.Fields != nil {
			return ErrIdentity
		}
		battery := *i.Battery
		if !identityText(battery.Brand) || !identityText(battery.Model) {
			return ErrIdentity
		}
		capacity, err := ParseDecimal(battery.Capacity)
		if err != nil || string(capacity) != battery.Capacity {
			return ErrIdentity
		}
		if battery.Polarity != "L" && battery.Polarity != "R" {
			return ErrIdentity
		}
		if i.Name != BatteryName(battery.Brand, battery.Model) ||
			i.Detail != BatteryDetail(battery.Capacity, battery.Polarity) {
			return ErrIdentity
		}
	case OtherKind:
		if i.Battery != nil || i.Fields == nil || len(i.Fields) > MaxFields {
			return ErrIdentity
		}
		for _, field := range i.Fields {
			canonical, err := canonicalField(field)
			if err != nil || !sameField(canonical, field) {
				return ErrIdentity
			}
		}
		if i.Detail != ProductDetail(i.Name, i.Fields) {
			return ErrIdentity
		}
	default:
		return ErrIdentity
	}
	return nil
}

// identityText admits the catalogue text of a name, a detail or a battery
// attribute: never empty, valid UTF-8 and free of a NUL or a control character,
// which the catalog never holds.
func identityText(value string) bool {
	return value != "" && utf8.ValidString(value) && validIdentityRunes(value)
}

func validIdentityRunes(value string) bool {
	if strings.ContainsRune(value, 0) {
		return false
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

// numberPattern is the admitted spelling of a number field before it is
// canonicalized: an optional sign, at most eighteen digits and at most six
// decimals, which is the whole text form of the numeric(18,6) column.
var numberPattern = regexp.MustCompile(`^-?[0-9]{1,18}(\.[0-9]{1,6})?$`)

// CanonicalNumber admits the value of a number field and returns the canonical
// decimal text the catalog holds: no leading zero in the integral part, no
// trailing zero in the fraction and no negative zero, so "005.50" travels as
// "5.5".
//
// It is deliberately not ParseDecimal: a capacity is a positive battery property,
// while a number field is any value the product declares, so zero and a negative
// value are values here. The bound is the column's own numeric(18,6): at most
// twelve integral and six fractional digits, refused here so the database never
// rounds or overflows what the operator typed.
func CanonicalNumber(value string) (Decimal, error) {
	if !numberPattern.MatchString(value) {
		return "", ErrIdentity
	}
	negative := strings.HasPrefix(value, "-")
	whole, fraction, _ := strings.Cut(strings.TrimPrefix(value, "-"), ".")
	integral := strings.TrimLeft(whole, "0")
	if integral == "" {
		integral = "0"
	}
	if len(integral) > maxIntegral {
		return "", ErrIdentity
	}
	fraction = strings.TrimRight(fraction, "0")
	if integral == "0" && fraction == "" {
		if negative {
			return "", ErrIdentity
		}
		return Decimal("0"), nil
	}
	canonical := integral
	if fraction != "" {
		canonical += "." + fraction
	}
	if negative {
		canonical = "-" + canonical
	}
	return Decimal(canonical), nil
}

// CanonicalField admits one typed field and returns the exact shape every
// surface publishes: a trimmed name of 1 to 40 bytes that is unique inside its
// product, a value of exactly one kind, a canonical number with an optional unit
// of 1 to 8 bytes, and text of 1 to 200 bytes without a unit.
func CanonicalField(name, kind string, unit, number, text *string) (Field, error) {
	if !identityText(name) || len(name) > maxFieldName || strings.TrimSpace(name) != name {
		return Field{}, ErrIdentity
	}
	field := Field{Name: name, Kind: kind}
	switch kind {
	case NumberField:
		if number == nil || text != nil {
			return Field{}, ErrIdentity
		}
		canonical, err := CanonicalNumber(*number)
		if err != nil {
			return Field{}, err
		}
		value := string(canonical)
		field.Number = &value
		if unit != nil {
			if !identityText(*unit) || len(*unit) > maxFieldUnit || strings.TrimSpace(*unit) != *unit {
				return Field{}, ErrIdentity
			}
			field.Unit = *unit
		}
	case TextField:
		if text == nil || number != nil || unit != nil {
			return Field{}, ErrIdentity
		}
		if !identityText(*text) || len(*text) > maxFieldText {
			return Field{}, ErrIdentity
		}
		value := *text
		field.Text = &value
	default:
		return Field{}, ErrIdentity
	}
	return field, nil
}

// canonicalField re-checks one already published field against the same rule.
func canonicalField(field Field) (Field, error) {
	var unit *string
	if field.Unit != "" {
		value := field.Unit
		unit = &value
	}
	return CanonicalField(field.Name, field.Kind, unit, field.Number, field.Text)
}

// sameField compares a canonical field with the field it was computed from: the
// stored text is already the canonical one, so any difference is a row this
// contract did not write.
func sameField(canonical, field Field) bool {
	return canonical.Name == field.Name && canonical.Kind == field.Kind && canonical.Unit == field.Unit &&
		sameOptional(canonical.Number, field.Number) && sameOptional(canonical.Text, field.Text)
}

func sameOptional(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// FieldRows is the read dependency of the shared field reader.
type FieldRows interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

// ReadFields reads the persisted typed fields of the given catalogue entries in
// one statement, in the order the catalog holds them per entry, and validates
// every one: a row this contract could not publish is an error, never a product
// with a partial field set.
func ReadFields(ctx context.Context, q FieldRows, entryIDs []int32) (map[int][]Field, error) {
	fields := make(map[int][]Field, len(entryIDs))
	if len(entryIDs) == 0 {
		return fields, nil
	}
	rows, err := q.Query(ctx, `SELECT catalog_entry_id,name,kind,unit,number_value::text,text_value
 FROM catalog_entry_fields WHERE catalog_entry_id = ANY($1::integer[])
 ORDER BY catalog_entry_id,id`, entryIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var entryID int
		var name, kind string
		var unit, number, text *string
		if rows.Scan(&entryID, &name, &kind, &unit, &number, &text) != nil {
			return nil, ErrIdentity
		}
		field, err := CanonicalField(name, kind, unit, number, text)
		if err != nil {
			return nil, err
		}
		if entryID < 1 || len(fields[entryID]) >= MaxFields {
			return nil, ErrIdentity
		}
		fields[entryID] = append(fields[entryID], field)
	}
	if rows.Err() != nil {
		return nil, ErrIdentity
	}
	return fields, nil
}
