package migrations_test

import (
	"luson/api/migrations"
	"strings"
	"testing"
)

func TestRestitutionMigrationStructure(t *testing.T) {
	b, err := migrations.Files.ReadFile("012_transfer_restitutions.sql")
	if err != nil {
		t.Fatal("restitution migration must be embedded", err)
	}
	sql := string(b)
	for _, required := range []string{"CREATE TABLE transfer_restitution_operations", "CREATE TABLE transfer_restitution_proposals", "CREATE TABLE transfer_restitution_decisions", "CREATE TABLE transfer_restitution_applications", "CREATE FUNCTION transfer_restitute", "CREATE FUNCTION guard_restitution_application", "CREATE FUNCTION guard_count_restitution_conservation"} {
		if !strings.Contains(sql, required) {
			t.Errorf("missing %s", required)
		}
	}
	if strings.Contains(sql, "CREATE OR REPLACE") {
		t.Fatal("historical count workflow must remain additive")
	}
}
