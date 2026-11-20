package suppliers

import (
	"errors"
	"strings"
	"testing"

	"luson/api/internal/auth"
	"luson/api/internal/catalog"
)

// A supplier name is trimmed before it is bounded: 3 to 64 bytes of valid UTF-8
// without a control character, so no untrimmed, over-long or control-bearing name
// ever reaches the column's own check.
func TestCanonicalName(t *testing.T) {
	for _, want := range []string{"CAR", "Agua acidulada", "ñandú", strings.Repeat("a", 64)} {
		got, err := CanonicalName(want)
		if err != nil || got != want {
			t.Fatalf("CanonicalName(%q) = %q, %v", want, got, err)
		}
	}
	if got, err := CanonicalName("  Distribuidora Norte  "); err != nil || got != "Distribuidora Norte" {
		t.Fatalf("an untrimmed name must be trimmed, not refused: %q, %v", got, err)
	}
	for _, name := range []string{
		"",
		"   ",
		"ab",
		"  ab  ",
		strings.Repeat("a", 65),
		"Distri\tbuidora",
		"Distri\nbuidora",
		"Distri\x00buidora",
		"\xff\xfe ab",
	} {
		if _, err := CanonicalName(name); !errors.Is(err, ErrInvalid) {
			t.Fatalf("CanonicalName(%q) admitted", name)
		}
	}
}

// The contact is free text: 0 to 200 characters, never trimmed and never carrying
// a control character. The empty contact is the absence of one, and the column's
// own bound is counted in characters, so 200 accented characters fit.
func TestCanonicalContact(t *testing.T) {
	for _, want := range []string{"", "555-1234", "  espacios internos  ", strings.Repeat("ñ", 200)} {
		got, err := CanonicalContact(want)
		if err != nil || got != want {
			t.Fatalf("CanonicalContact(%q) = %q, %v", want, got, err)
		}
	}
	for _, contact := range []string{
		strings.Repeat("ñ", 201),
		strings.Repeat("a", 201),
		"555\t1234",
		"555\n1234",
		"555\x001234",
		"\xff\xfe",
	} {
		if _, err := CanonicalContact(contact); !errors.Is(err, ErrInvalid) {
			t.Fatalf("CanonicalContact(%q) admitted", contact)
		}
	}
}

// A creation and an edit decide the whole editable document: the name and the
// contact. Everything else — the identity and the offer set — is never part of it.
func TestCanonicalCreateAndEdit(t *testing.T) {
	created, err := CanonicalCreate(CreateInput{Name: "  Distribuidora Norte ", Contact: "555"})
	if err != nil || created.Name != "Distribuidora Norte" || created.Contact != "555" {
		t.Fatalf("CanonicalCreate = %+v, %v", created, err)
	}
	edited, err := CanonicalEdit(EditInput{Name: "sur", Contact: ""})
	if err != nil || edited.Name != "sur" || edited.Contact != "" {
		t.Fatalf("CanonicalEdit = %+v, %v", edited, err)
	}
	if _, err := CanonicalCreate(CreateInput{Name: "ab"}); !errors.Is(err, ErrInvalid) {
		t.Fatal("a short name was admitted on creation")
	}
	if _, err := CanonicalCreate(CreateInput{Name: "Distribuidora", Contact: strings.Repeat("a", 201)}); !errors.Is(err, ErrInvalid) {
		t.Fatal("a long contact was admitted on creation")
	}
	if _, err := CanonicalEdit(EditInput{Name: "Distribuidora\tNorte"}); !errors.Is(err, ErrInvalid) {
		t.Fatal("a control-bearing name was admitted on edit")
	}
	if _, err := CanonicalEdit(EditInput{Name: "Distribuidora", Contact: "a\x00b"}); !errors.Is(err, ErrInvalid) {
		t.Fatal("a control-bearing contact was admitted on edit")
	}
}

// The offer list is a set: order and repetition carry no meaning, an identity
// outside the catalogue bound is refused, and the admitted set is bounded so one
// read can always publish a whole supplier's offers.
func TestCanonicalOffers(t *testing.T) {
	empty, err := CanonicalOffers(nil)
	if err != nil || empty == nil || len(empty) != 0 {
		t.Fatalf("an empty set must be an empty list: %v, %v", empty, err)
	}
	got, err := CanonicalOffers([]int64{3, 1, 2, 1})
	if err != nil || len(got) != 3 || got[0] != 1 || got[1] != 2 || got[2] != 3 {
		t.Fatalf("CanonicalOffers = %v, %v", got, err)
	}
	for _, id := range []int64{0, -1, 1 << 31} {
		if _, err := CanonicalOffers([]int64{id}); !errors.Is(err, ErrInvalid) {
			t.Fatalf("entry id %d admitted", id)
		}
	}
	full := make([]int64, MaxOffers)
	for i := range full {
		full[i] = int64(i + 1)
	}
	if _, err := CanonicalOffers(full); err != nil {
		t.Fatalf("a full offer set was refused: %v", err)
	}
	if _, err := CanonicalOffers(append(full, MaxOffers+1)); !errors.Is(err, ErrInvalid) {
		t.Fatal("an oversized offer set was admitted")
	}
}

// Only the frozen page contract is admitted: a page from 1 to MaxPage and one of
// the three published sizes.
func TestValidPage(t *testing.T) {
	for _, c := range []struct {
		page, pageSize int
		want           bool
	}{
		{1, 10, true},
		{1, 25, true},
		{MaxPage, 50, true},
		{0, 10, false},
		{MaxPage + 1, 10, false},
		{1, 0, false},
		{1, 15, false},
		{1, 100, false},
	} {
		if got := ValidPage(c.page, c.pageSize); got != c.want {
			t.Fatalf("ValidPage(%d,%d) = %v, want %v", c.page, c.pageSize, got, c.want)
		}
	}
}

// The two catalogue reads admit the absent kind, which lists both kinds, and
// exactly the two catalogue kinds. "all" is not an alias here: the absent value
// already means both.
func TestValidQueries(t *testing.T) {
	for _, kind := range []catalog.Kind{"", catalog.BatteryKind, catalog.OtherKind} {
		if !ValidEntryQuery(EntryQuery{Kind: kind, PageSize: 10}) {
			t.Fatalf("kind %q was refused", kind)
		}
		if !ValidVariantQuery(VariantQuery{Kind: kind}) {
			t.Fatalf("variant kind %q was refused", kind)
		}
	}
	for _, kind := range []catalog.Kind{"all", "Battery", "product"} {
		if ValidEntryQuery(EntryQuery{Kind: kind, PageSize: 10}) {
			t.Fatalf("kind %q was admitted", kind)
		}
		if ValidVariantQuery(VariantQuery{Kind: kind}) {
			t.Fatalf("variant kind %q was admitted", kind)
		}
	}
	if ValidEntryQuery(EntryQuery{PageSize: 15}) || ValidEntryQuery(EntryQuery{PageSize: 0}) {
		t.Fatal("an inadmissible catalogue page size was admitted")
	}
	long := strings.Repeat("ñ", maxSearch)
	if !ValidEntryQuery(EntryQuery{PageSize: 10, Search: long}) || !ValidVariantQuery(VariantQuery{Search: long}) {
		t.Fatal("a 128-rune search was refused")
	}
	for _, search := range []string{long + "ñ", "agua\x00acidulada", "\xff"} {
		if ValidEntryQuery(EntryQuery{PageSize: 10, Search: search}) {
			t.Fatalf("catalogue search %q was admitted", search)
		}
		if ValidVariantQuery(VariantQuery{Search: search}) {
			t.Fatalf("variant search %q was admitted", search)
		}
	}
}

// The kinds of a supplier are derived from its offers in the catalogue's own
// order, and a supplier with no offer has an empty list instead of null.
func TestKinds(t *testing.T) {
	empty := Kinds(nil)
	if empty == nil || len(empty) != 0 {
		t.Fatalf("Kinds(nil) = %v", empty)
	}
	both := Kinds([]Offer{{Kind: catalog.OtherKind}, {Kind: catalog.BatteryKind}})
	if len(both) != 2 || both[0] != catalog.BatteryKind || both[1] != catalog.OtherKind {
		t.Fatalf("Kinds = %v", both)
	}
	only := Kinds([]Offer{{Kind: catalog.OtherKind}, {Kind: catalog.OtherKind}})
	if len(only) != 1 || only[0] != catalog.OtherKind {
		t.Fatalf("Kinds = %v", only)
	}
}

// The warehouse administrator is the whole authority of this domain: account 1
// assigned to location 1 with a completed password change.
func TestWarehouseAdmin(t *testing.T) {
	warehouse := auth.Identity{AccountID: 1, Location: auth.Location{ID: 1}}
	if !WarehouseAdmin(warehouse) {
		t.Fatal("the warehouse administrator was refused")
	}
	for _, actor := range []auth.Identity{
		{AccountID: 2, Location: auth.Location{ID: 2}},
		{AccountID: 1, Location: auth.Location{ID: 2}},
		{AccountID: 2, Location: auth.Location{ID: 1}},
		{},
		{AccountID: 1, Location: auth.Location{ID: 1}, MustChangePassword: true},
	} {
		if WarehouseAdmin(actor) {
			t.Fatalf("identity %+v was admitted", actor)
		}
	}
}
