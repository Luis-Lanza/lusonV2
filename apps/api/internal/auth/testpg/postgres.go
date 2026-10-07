// Package testpg supplies PostgreSQL only on the explicit parent-owned active test network.
package testpg

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type descriptor struct {
	Schema string            `json:"schema"`
	Status string            `json:"status"`
	Name   string            `json:"name"`
	ID     string            `json:"id"`
	Labels map[string]string `json:"labels"`
	Scope  string            `json:"scope"`
}
type networkInspection struct {
	ID     string `json:"Id"`
	Name   string
	Labels map[string]string
}

func manifestPath(path string) (string, error) {
	if path == "" {
		return "", fmt.Errorf("explicit manifest required")
	}
	if filepath.IsAbs(path) {
		return filepath.Clean(path), nil
	}
	_, source, _, ok := runtime.Caller(0)
	if !ok || !filepath.IsAbs(source) {
		return "", fmt.Errorf("repository root unavailable")
	}
	root, err := filepath.EvalSymlinks(filepath.Join(filepath.Dir(source), "../../../../.."))
	if err != nil {
		return "", fmt.Errorf("canonical repository root unavailable")
	}
	return filepath.Join(root, path), nil
}
func validateManifest(d descriptor, network string) error {
	want := map[string]string{"luson.feature": "login-inventory", "luson.task": "L03", "luson.owner": "parent-session-luson-v2", "luson.lifecycle": "ephemeral-test-only"}
	if d.Schema != "luson.test-network/v1" || d.Status != "active" || network == "" || d.Name != network || !regexp.MustCompile(`^luson-l03-test-isolated-[a-f0-9]{12}$`).MatchString(d.Name) || !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(d.ID) || !reflect.DeepEqual(d.Labels, want) || strings.TrimSpace(d.Scope) == "" {
		return fmt.Errorf("invalid active test network manifest")
	}
	return nil
}
func loadManifest(network, path string) (descriptor, error) {
	var d descriptor
	absolute, err := manifestPath(path)
	if err != nil {
		return d, err
	}
	data, err := os.ReadFile(absolute)
	if err != nil {
		return d, fmt.Errorf("test network manifest unavailable")
	}
	if json.Unmarshal(data, &d) != nil {
		return d, fmt.Errorf("invalid test network descriptor")
	}
	return d, validateManifest(d, network)
}
func compareNetwork(d descriptor, actual []networkInspection) error {
	if len(actual) != 1 || actual[0].ID != d.ID || actual[0].Name != d.Name || !reflect.DeepEqual(actual[0].Labels, d.Labels) {
		return fmt.Errorf("exclusive network identity mismatch")
	}
	return nil
}

func Random(t *testing.T) string {
	t.Helper()
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		t.Fatal("test random generation failed")
	}
	return hex.EncodeToString(b)
}

func Open(t *testing.T) *pgxpool.Pool {
	t.Helper()
	binding, err := loadManifest(os.Getenv("LUSON_TEST_NETWORK"), os.Getenv("LUSON_TEST_NETWORK_MANIFEST"))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	t.Cleanup(cancel)
	output, err := exec.CommandContext(ctx, "docker", "network", "inspect", binding.Name).Output()
	if err != nil {
		t.Fatal("exclusive network inspection failed")
	}
	var networks []networkInspection
	if json.Unmarshal(output, &networks) != nil || compareNetwork(binding, networks) != nil {
		t.Fatal("exclusive network identity mismatch")
	}
	name, password := "luson-l03-test-"+Random(t)[:16], Random(t)
	cmd := exec.CommandContext(ctx, "docker", "run", "--rm", "-d", "--name", name, "--label", "luson.task=L03", "--label", "luson.feature=login-inventory", "--label", "luson.owner=parent-session-luson-v2", "--label", "luson.lifecycle=ephemeral-test-only", "--network", binding.Name, "--publish", "127.0.0.1::5432", "--tmpfs", "/var/lib/postgresql/data", "-e", "POSTGRES_PASSWORD="+password, "-e", "POSTGRES_DB=l03_test", "postgres:17.9")
	if err := cmd.Run(); err != nil {
		t.Fatal("start owned isolated PostgreSQL failed")
	}
	t.Cleanup(func() {
		cleanup, done := context.WithTimeout(context.Background(), 30*time.Second)
		defer done()
		if err := exec.CommandContext(cleanup, "docker", "stop", "--time", "5", name).Run(); err != nil {
			t.Errorf("cleanup owned container %s failed", name)
		} else {
			t.Log("cleaned owned container", name)
		}
	})
	output, err = exec.CommandContext(ctx, "docker", "port", name, "5432/tcp").Output()
	if err != nil {
		t.Fatal("owned container port lookup failed")
	}
	address := strings.TrimSpace(string(output))
	if !strings.HasPrefix(address, "127.0.0.1:") || strings.Contains(address, "\n") {
		t.Fatal("unexpected test binding")
	}
	pool, err := pgxpool.New(ctx, fmt.Sprintf("postgres://postgres:%s@%s/l03_test?sslmode=disable", password, address))
	if err != nil {
		t.Fatal("test pool configuration failed")
	}
	t.Cleanup(pool.Close)
	for i := 0; i < 100; i++ {
		if pool.Ping(ctx) == nil {
			return pool
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("owned PostgreSQL not ready")
	return nil
}
