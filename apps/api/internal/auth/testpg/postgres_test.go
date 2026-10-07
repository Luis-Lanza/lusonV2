package testpg

import (
	"regexp"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Compile-time compatibility protects callers without requiring a PG fixture.
var _ func(*testing.T) *pgxpool.Pool = Open
var _ func(*testing.T) string = Random

func TestRandomCompatibility(t *testing.T) {
	a, b := Random(t), Random(t)
	if !regexp.MustCompile(`^[a-f0-9]{48}$`).MatchString(a) || !regexp.MustCompile(`^[a-f0-9]{48}$`).MatchString(b) || a == b {
		t.Fatal("cryptographic helper compatibility failed")
	}
	if len(a[:16]) != 16 || len(a[:32]) != 32 {
		t.Fatal("caller slicing compatibility failed")
	}
}
