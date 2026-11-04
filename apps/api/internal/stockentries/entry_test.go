package stockentries

import (
	"context"
	"errors"
	"fmt"
	"math"
	"reflect"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"luson/api/internal/auth"
)

func validInput() CreateInput {
	return CreateInput{
		OperationKey: "warehouse-ingress-key-0001",
		Note:         "Compra de proveedor",
		Lines:        []Line{{VariantID: 2, Quantity: 3}, {VariantID: 1, Quantity: 1}},
	}
}

func TestValidateCanonicalPayload(t *testing.T) {
	in := validInput()
	original := append([]Line(nil), in.Lines...)
	got, err := Validate(in)
	if err != nil {
		t.Fatal("valid ingress rejected")
	}
	if !reflect.DeepEqual(in.Lines, original) {
		t.Fatal("validation must not mutate the caller payload")
	}
	want := []Line{{VariantID: 1, Quantity: 1}, {VariantID: 2, Quantity: 3}}
	if !reflect.DeepEqual(got.Lines, want) {
		t.Fatal("lines must be canonicalized by variant id")
	}
	if got.OperationKey != in.OperationKey || got.Note != in.Note {
		t.Fatal("canonical payload must keep key and note")
	}
	reversed := validInput()
	reversed.Lines[0], reversed.Lines[1] = reversed.Lines[1], reversed.Lines[0]
	other, err := Validate(reversed)
	if err != nil || !reflect.DeepEqual(other, got) {
		t.Fatal("canonical payload must ignore line order")
	}
	changed := validInput()
	changed.Note = "Otra nota"
	if same, err := Validate(changed); err != nil || reflect.DeepEqual(same, got) {
		t.Fatal("note must bind the canonical payload")
	}
}

func TestValidateOperationKey(t *testing.T) {
	longest := strings.Repeat("a", 128)
	for _, key := range []string{"warehouse-ingress-key-0001", longest, "op_key-0000000001", strings.Repeat("Z", 16)} {
		if !ValidOperationKey(key) {
			t.Fatalf("valid operation key %q rejected", key)
		}
	}
	for _, key := range []string{"", "short-key", strings.Repeat("a", 15), strings.Repeat("a", 129),
		"warehouse ingress key 1", "warehouse.ingress.key", "warehouse/ingress/key", "clave-de-ingreso-ñ1", "warehouse-ingress-key-0001\x00"} {
		if ValidOperationKey(key) {
			t.Fatalf("invalid operation key %q accepted", key)
		}
	}
}

func TestValidateNoteLimits(t *testing.T) {
	for _, note := range []string{"", "nota", strings.Repeat("a", maxNote), strings.Repeat("ñ", maxNote)} {
		in := validInput()
		in.Note = note
		if _, err := Validate(in); err != nil {
			t.Fatalf("admitted note %q rejected", note)
		}
	}
	for _, note := range []string{strings.Repeat("a", maxNote+1), strings.Repeat("ñ", maxNote+1), "nota\x00oculta", "nota\xff"} {
		in := validInput()
		in.Note = note
		if _, err := Validate(in); !errors.Is(err, ErrInvalid) {
			t.Fatalf("note %q must be rejected", note)
		}
	}
}

func TestValidateLines(t *testing.T) {
	many := validInput()
	many.Lines = make([]Line, 0, 191)
	for i := 1; i <= 191; i++ {
		many.Lines = append(many.Lines, Line{VariantID: int64(i), Quantity: 1})
	}
	if _, err := Validate(many); !errors.Is(err, ErrInvalid) {
		t.Fatal("more than 190 lines must be rejected")
	}
	allowed := validInput()
	allowed.Lines = many.Lines[:190]
	if _, err := Validate(allowed); err != nil {
		t.Fatal("190 lines must be admitted")
	}
	for name, change := range map[string]func(*CreateInput){
		"no_lines":         func(in *CreateInput) { in.Lines = nil },
		"empty_lines":      func(in *CreateInput) { in.Lines = []Line{} },
		"duplicate":        func(in *CreateInput) { in.Lines = []Line{{VariantID: 1, Quantity: 1}, {VariantID: 1, Quantity: 2}} },
		"zero_variant":     func(in *CreateInput) { in.Lines = []Line{{VariantID: 0, Quantity: 1}} },
		"negative_variant": func(in *CreateInput) { in.Lines = []Line{{VariantID: -1, Quantity: 1}} },
		"huge_variant":     func(in *CreateInput) { in.Lines = []Line{{VariantID: math.MaxInt32 + 1, Quantity: 1}} },
		"zero_quantity":    func(in *CreateInput) { in.Lines = []Line{{VariantID: 1, Quantity: 0}} },
		"negative_qty":     func(in *CreateInput) { in.Lines = []Line{{VariantID: 1, Quantity: -1}} },
		"quantity_bound":   func(in *CreateInput) { in.Lines = []Line{{VariantID: 1, Quantity: maxQuantity + 1}} },
		"quantity_huge":    func(in *CreateInput) { in.Lines = []Line{{VariantID: 1, Quantity: math.MaxInt64}} },
	} {
		in := validInput()
		change(&in)
		if _, err := Validate(in); !errors.Is(err, ErrInvalid) {
			t.Fatalf("%s must be rejected", name)
		}
	}
	max := validInput()
	max.Lines = []Line{{VariantID: 1, Quantity: maxQuantity}}
	if _, err := Validate(max); err != nil {
		t.Fatal("the maximum admitted quantity must be accepted")
	}
}

func TestWarehouseAdminIdentity(t *testing.T) {
	warehouse := auth.Identity{AccountID: 1, Location: auth.Location{ID: 1}}
	if !warehouseAdmin(warehouse) {
		t.Fatal("warehouse administrator must be admitted")
	}
	for name, actor := range map[string]auth.Identity{
		"branch":          {AccountID: 2, Location: auth.Location{ID: 2}},
		"branch_admin":    {AccountID: 1, Location: auth.Location{ID: 2}},
		"warehouse_clerk": {AccountID: 4, Location: auth.Location{ID: 1}},
		"unassigned":      {},
		"negative":        {AccountID: -1, Location: auth.Location{ID: -1}},
	} {
		if warehouseAdmin(actor) {
			t.Fatalf("%s identity must be forbidden", name)
		}
	}
	pending := warehouse
	pending.MustChangePassword = true
	if warehouseAdmin(pending) {
		t.Fatal("an unfinished password change must be forbidden")
	}
}

// Only an exact SQLSTATE is trusted; every other failure stays an opaque 503.
func TestMapFailureSQLState(t *testing.T) {
	ctx := context.Background()
	for code, want := range map[string]error{
		"LS001": ErrInsufficientStock,
		"LS002": ErrInvalid,
		"LS003": ErrInvalid,
		"LS004": ErrUnavailable,
		"LS005": ErrInvalid,
		"LS006": ErrInvalid,
		"LS007": ErrInvalid,
		"23505": ErrUnavailable,
		"23514": ErrUnavailable,
		"42501": ErrUnavailable,
	} {
		got := mapFailure(ctx, fmt.Errorf("wrapped database failure: %w", &pgconn.PgError{Code: code}))
		if !errors.Is(got, want) {
			t.Fatalf("SQLSTATE %s must map to %v, got %v", code, want, got)
		}
	}
	if got := mapFailure(ctx, errors.New("driver detail")); !errors.Is(got, ErrUnavailable) {
		t.Fatal("an unknown failure must stay unavailable")
	}
	if got := mapFailure(ctx, errors.New("select secret from private")); !errors.Is(got, ErrUnavailable) {
		t.Fatal("driver details must not leak")
	}
	if got := mapFailure(ctx, nil); got != nil {
		t.Fatal("a nil failure must stay nil")
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if got := mapFailure(cancelled, context.Canceled); !errors.Is(got, context.Canceled) {
		t.Fatal("cancellation must keep its semantics")
	}
}

func TestSameLines(t *testing.T) {
	if !sameLines([]EntryLine{{VariantID: 1, Quantity: 2}}, []Line{{VariantID: 1, Quantity: 2}}) {
		t.Fatal("identical canonical lines must match")
	}
	for _, other := range [][]Line{
		{{VariantID: 1, Quantity: 3}},
		{{VariantID: 2, Quantity: 2}},
		{{VariantID: 1, Quantity: 2}, {VariantID: 2, Quantity: 1}},
		{},
	} {
		if sameLines([]EntryLine{{VariantID: 1, Quantity: 2}}, other) {
			t.Fatal("different payloads must not match")
		}
	}
}
