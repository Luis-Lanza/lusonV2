// Package testpg preserves the historical test import path without lifecycle effects.
package testpg

import (
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	generic "luson/api/internal/testpg"
)

func Open(t *testing.T) *pgxpool.Pool {
	t.Helper()
	return generic.Open(t)
}

func Random(t *testing.T) string {
	t.Helper()
	return generic.Random(t)
}
