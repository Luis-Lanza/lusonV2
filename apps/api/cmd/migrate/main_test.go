package main

import (
	"os"
	"testing"
)

func TestLoadMigrateBeforeDatabase(t *testing.T) {
	old := os.Args
	os.Args = []string{"migrate", "check"}
	defer func() { os.Args = old }()
	t.Setenv("LUSON_DATABASE_URL", "postgres://test:fixture-only@127.0.0.1:1/test")
	t.Setenv("LUSON_DATABASE_URL_FILE", "")
	t.Setenv("LUSON_PROFILE", "local-trial")
	if code := run(); code != 2 {
		t.Fatal("duplicate providers must fail before database access")
	}
}
