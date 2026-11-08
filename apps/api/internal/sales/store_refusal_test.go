package sales

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

// TestUnitRefusalNamesTheSerial pins D8 for the second producer of the already-sold refusal.
// The unit guard raises LV009 with the serial in its detail, but a concurrent writer is
// refused by the unique index instead, and that error carries no key at all: the mapping
// alone cannot name the battery. The insertion knows the serial it was writing, so the
// published refusal carries it and the counter never receives a refusal it cannot act on.
func TestUnitRefusalNamesTheSerial(t *testing.T) {
	serial := SerialNumber("ABC123")
	refused := mapUnitFailure(context.Background(), &pgconn.PgError{
		Code:           "23505",
		ConstraintName: "sale_units_serial_number",
		Detail:         "Key (upper(btrim(serial_number)))=(ABC123) already exists.",
	}, serial)
	var already *SerialAlreadySold
	if !errors.As(refused, &already) || !errors.Is(refused, ErrSerialAlreadySold) {
		t.Fatalf("a concurrent serial must be the already-sold refusal: %v", refused)
	}
	if already.Serial != serial {
		t.Fatalf("the index refusal must name the serial it was inserting, got %q", already.Serial)
	}
	// The guard's own refusal already names the battery the database refused, so it is
	// published unchanged instead of being overwritten by the caller's serial.
	guarded := mapUnitFailure(context.Background(), &pgconn.PgError{
		Code: "LV009", Detail: "FROM-DATABASE",
	}, serial)
	if !errors.As(guarded, &already) || already.Serial != "FROM-DATABASE" {
		t.Fatalf("the guard's own serial must survive the mapping: %v", guarded)
	}
	// A unique violation that is not the serial index is not a serial refusal, and a nil
	// failure stays nil: the mapping publishes the database's decision and nothing else.
	for name, failure := range map[string]error{
		"other_unique": mapUnitFailure(context.Background(), &pgconn.PgError{
			Code: "23505", ConstraintName: "sales_branch_location_id_warranty_number_key",
		}, serial),
		"nil": mapUnitFailure(context.Background(), nil, serial),
	} {
		if failure != nil && errors.Is(failure, ErrSerialAlreadySold) {
			t.Fatalf("%s must not be published as an already-sold serial: %v", name, failure)
		}
	}
	if mapped := mapUnitFailure(context.Background(), &pgconn.PgError{
		Code: "23505", ConstraintName: "sales_branch_location_id_warranty_number_key",
	}, serial); !errors.Is(mapped, ErrUnavailable) {
		t.Fatalf("an unmapped unique violation must fail closed: %v", mapped)
	}
}
