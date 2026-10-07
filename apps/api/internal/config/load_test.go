package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A parser-only fixture, never a provisioned account or operational secret.
const testURL = "postgres://generated:fixture-only@localhost/trial"

func cleanEnv(t *testing.T) {
	t.Helper()
	for _, key := range []string{"LUSON_DATABASE_URL", "LUSON_DATABASE_URL_FILE", "LUSON_PROFILE", "LUSON_APP_UID", "LUSON_APP_GID"} {
		old, present := os.LookupEnv(key)
		t.Cleanup(func() {
			if present {
				_ = os.Setenv(key, old)
			} else {
				_ = os.Unsetenv(key)
			}
		})
		_ = os.Unsetenv(key)
	}
	t.Setenv("LUSON_PROFILE", "local-trial")
}

func privateURL(t *testing.T, content string, mode os.FileMode) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "database-url")
	if err := os.WriteFile(path, []byte(content), mode); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoadEnvironment(t *testing.T) {
	cleanEnv(t)
	t.Setenv("LUSON_DATABASE_URL", testURL)
	cfg, err := LoadEnv()
	if err != nil || cfg.DatabaseURL != testURL || cfg.Profile != LocalTrial {
		t.Fatalf("generated environment compatibility: %v", err)
	}
}

func TestLoadPrivateFile(t *testing.T) {
	for _, ending := range []string{"", "\n"} {
		t.Run("ending"+string(rune(len(ending)+'0')), func(t *testing.T) {
			cleanEnv(t)
			t.Setenv("LUSON_DATABASE_URL_FILE", privateURL(t, testURL+ending, 0600))
			cfg, err := LoadEnv()
			if err != nil || cfg.DatabaseURL != testURL {
				t.Fatalf("private file: %v", err)
			}
		})
	}
}

func TestLoadRefusalsSanitized(t *testing.T) {
	for _, scenario := range []string{
		"missing", "both", "both-empty", "empty-env", "empty-file", "missing-file",
		"permissions", "oversize", "symlink", "directory", "newline", "carriage", "nul",
		"whitespace", "bad-profile", "bad-url", "bad-pg-query", "zero-uid", "mismatched-gid",
	} {
		t.Run(scenario, func(t *testing.T) {
			cleanEnv(t)
			path := privateURL(t, testURL, 0600)
			t.Setenv("LUSON_DATABASE_URL_FILE", path)
			switch scenario {
			case "missing":
				_ = os.Unsetenv("LUSON_DATABASE_URL_FILE")
			case "both":
				t.Setenv("LUSON_DATABASE_URL", testURL)
			case "both-empty":
				t.Setenv("LUSON_DATABASE_URL", "")
				t.Setenv("LUSON_DATABASE_URL_FILE", "")
			case "empty-env":
				_ = os.Unsetenv("LUSON_DATABASE_URL_FILE")
				t.Setenv("LUSON_DATABASE_URL", "")
			case "empty-file":
				t.Setenv("LUSON_DATABASE_URL_FILE", privateURL(t, "", 0600))
			case "missing-file":
				t.Setenv("LUSON_DATABASE_URL_FILE", path+"-absent")
			case "permissions":
				if err := os.Chmod(path, 0640); err != nil {
					t.Fatal(err)
				}
			case "oversize":
				t.Setenv("LUSON_DATABASE_URL_FILE", privateURL(t, testURL+"?application_name="+strings.Repeat("x", 4097-len(testURL+"?application_name=")), 0600))
			case "symlink":
				link := path + "-link"
				if err := os.Symlink(path, link); err != nil {
					t.Fatal(err)
				}
				t.Setenv("LUSON_DATABASE_URL_FILE", link)
			case "directory":
				t.Setenv("LUSON_DATABASE_URL_FILE", filepath.Dir(path))
			case "newline":
				t.Setenv("LUSON_DATABASE_URL_FILE", privateURL(t, testURL+"\n\n", 0600))
			case "carriage":
				t.Setenv("LUSON_DATABASE_URL_FILE", privateURL(t, testURL+"\r\n", 0600))
			case "nul":
				t.Setenv("LUSON_DATABASE_URL_FILE", privateURL(t, testURL+"\x00", 0600))
			case "whitespace":
				t.Setenv("LUSON_DATABASE_URL_FILE", privateURL(t, " "+testURL, 0600))
			case "bad-profile":
				t.Setenv("LUSON_PROFILE", "private-invalid-profile")
			case "bad-url":
				t.Setenv("LUSON_DATABASE_URL_FILE", privateURL(t, "postgres://sensitive%ZZ@localhost/db", 0600))
			case "bad-pg-query":
				t.Setenv("LUSON_DATABASE_URL_FILE", privateURL(t, testURL+"?connect_timeout=sensitive", 0600))
			case "zero-uid":
				t.Setenv("LUSON_APP_UID", "0")
			case "mismatched-gid":
				t.Setenv("LUSON_APP_GID", "4294967295")
			}
			_, err := LoadEnv()
			if err == nil || err.Error() != "invalid database configuration" {
				t.Fatal("must reject with fixed sanitized error")
			}
		})
	}
}

func TestLoadSizeBoundaries(t *testing.T) {
	prefix := testURL + "?application_name="
	for _, c := range []struct {
		name     string
		size     int
		ending   string
		accepted bool
	}{
		{"exact-raw-limit", 4096, "", true},
		{"exact-file-limit-with-lf", 4095, "\n", true},
		{"oversized-with-lf", 4096, "\n", false},
		{"oversized-raw", 4097, "", false},
	} {
		t.Run(c.name, func(t *testing.T) {
			cleanEnv(t)
			raw := prefix + strings.Repeat("x", c.size-len(prefix))
			t.Setenv("LUSON_DATABASE_URL_FILE", privateURL(t, raw+c.ending, 0600))
			cfg, err := LoadEnv()
			if c.accepted {
				if err != nil || cfg.DatabaseURL != raw {
					t.Fatal("exact boundary must retain raw URL")
				}
			} else if err == nil || err.Error() != "invalid database configuration" {
				t.Fatal("oversized valid URL must fail with fixed error")
			}
		})
	}
}

func TestLoadOwnerPolicy(t *testing.T) {
	// Test the same predicate used on fstat without privileged chown or a skip.
	if !privateOwner(uint32(os.Getuid())) || privateOwner(uint32(os.Getuid()+1)) {
		t.Fatal("only current UID is permitted")
	}
}
