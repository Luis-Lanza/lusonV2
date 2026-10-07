package main

import (
	"os"
	"testing"
)

func TestLoadBootstrapBeforeTTY(t *testing.T) {
	old := os.Args
	os.Args = []string{"bootstrap-accounts"}
	defer func() { os.Args = old }()
	t.Setenv("LUSON_DATABASE_URL", "postgres://test:fixture-only@127.0.0.1:1/test")
	t.Setenv("LUSON_DATABASE_URL_FILE", "")
	t.Setenv("LUSON_PROFILE", "local-trial")
	if err := run(); err == nil || err.Error() != "invalid database configuration" {
		t.Fatal("duplicate providers must fail before private terminal access")
	}
}
