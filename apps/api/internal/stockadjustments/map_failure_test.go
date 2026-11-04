package stockadjustments

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

// mapFailure publishes exactly the database's own decision: every guard SQLSTATE
// has one public error, an unrecognized one fails closed, and cancellation keeps
// its semantics.
func TestMapFailurePublishesTheDatabaseDecision(t *testing.T) {
	for code, want := range map[string]error{
		"LS001": ErrInsufficientStock,
		"LS002": ErrInvalid,
		"LS003": ErrInvalid,
		"LS005": ErrInvalid,
		"LS006": ErrInvalid,
		"LS007": ErrInvalid,
		"LS008": ErrInvalid,
		"LS004": ErrUnavailable,
		"23514": ErrUnavailable,
	} {
		if got := mapFailure(context.Background(), &pgconn.PgError{Code: code}); !errors.Is(got, want) {
			t.Fatalf("%s must map to %v, got %v", code, want, got)
		}
	}
	if got := mapFailure(context.Background(), nil); got != nil {
		t.Fatalf("a nil failure must stay nil, got %v", got)
	}
	if got := mapFailure(context.Background(), errors.New("driver failure")); !errors.Is(got, ErrUnavailable) {
		t.Fatalf("an unknown failure must fail closed, got %v", got)
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if got := mapFailure(cancelled, &pgconn.PgError{Code: "LS002"}); !errors.Is(got, context.Canceled) {
		t.Fatalf("cancellation must keep its semantics, got %v", got)
	}
}
