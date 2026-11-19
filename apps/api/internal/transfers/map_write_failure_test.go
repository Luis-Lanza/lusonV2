package transfers

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

// TestMapWriteFailurePublishesTheFreeze pins the translation every guarded write shares (S1): the
// SQLSTATE alone decides, so the freeze reaches the counter as its own refusal and every other
// failure keeps the historical meaning -- cancellation when the context died, an outage otherwise.
func TestMapWriteFailurePublishesTheFreeze(t *testing.T) {
	frozen := &pgconn.PgError{Code: "LC001", Message: "The branch has an open account settlement and cannot operate"}
	if err := mapWriteFailure(context.Background(), frozen); !errors.Is(err, ErrBranchFrozen) {
		t.Fatalf("LC001 must be the freeze's own refusal, got %v", err)
	}
	// A wrapped driver error is still the freeze: the caller keeps wrapping its own way.
	if err := mapWriteFailure(context.Background(), errors.Join(frozen)); !errors.Is(err, ErrBranchFrozen) {
		t.Fatalf("a wrapped LC001 must still be the freeze, got %v", err)
	}
	// The same message under another SQLSTATE is not the freeze; it keeps the historical meaning.
	if err := mapWriteFailure(context.Background(), &pgconn.PgError{Code: "23503", Message: frozen.Message}); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("only LC001 is the freeze, got %v", err)
	}
	// The SQLSTATE alone decides: the message is never matched.
	if err := mapWriteFailure(context.Background(), &pgconn.PgError{Code: "LC001", Message: "unrelated"}); !errors.Is(err, ErrBranchFrozen) {
		t.Fatalf("the SQLSTATE alone decides, got %v", err)
	}
	if err := mapWriteFailure(context.Background(), errors.New("private backend error")); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("an unknown failure keeps the historical outage, got %v", err)
	}
	// A dead context keeps its precedence: the freeze is a decision, never a cancellation.
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if err := mapWriteFailure(canceled, frozen); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation must outrank the freeze, got %v", err)
	}
}
