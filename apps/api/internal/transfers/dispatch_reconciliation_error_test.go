package transfers

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestDR2StoreMutationErrorRedaction(t *testing.T) {
	for _, tc := range []struct {
		code, message string
		want          error
	}{
		{"42501", "Reconciliation endpoint unauthorized", ErrForbidden},
		{"42501", "Only initiator may replace a pending reconciliation", ErrForbidden},
		{"42501", "Only exact reconciliation counterparty may decide", ErrForbidden},
		{"23505", "Reconciliation operation identity conflicts", ErrRetryConflict},
		{"23514", "Reconciliation requires an originally expected variant", ErrInvalid},
		{"23514", "Reconciled dispatch must equal effective received count and change dispatch", ErrInvalid},
		{"23514", "Stale reconciliation revision", ErrDecisionConflict},
		{"23514", "Reconciliation excluded after restitution", ErrDecisionConflict},
		{"23514", "Reconciliation predecessor changed", ErrDecisionConflict},
		{"23514", "Reconciliation requires covered nonoverflowing endpoint stock", ErrInsufficientStock},
		{"23514", "Reconciliation requires both endpoint balances", ErrInsufficientStock},
		{"25000", "Reconciliations require READ COMMITTED", ErrUnavailable},
		{"23514", "private unknown constraint", ErrUnavailable},
		{"42501", "private unknown permission", ErrUnavailable},
		{"23505", "private unknown uniqueness", ErrUnavailable},
		{"XX000", "Reconciliation predecessor changed", ErrUnavailable},
	} {
		if got := dispatchReconciliationError(context.Background(), &pgconn.PgError{Code: tc.code, Message: tc.message}); got != tc.want {
			t.Fatalf("code %s: got %v want %v", tc.code, got, tc.want)
		}
	}
	if got := dispatchReconciliationError(context.Background(), errors.New("private driver details")); got != ErrUnavailable {
		t.Fatal(got)
	}
}
