package testpg

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func syntheticManifest() manifest {
	labels := expectedLabels()
	root := "/home/luis/.local/share/luson-transfer-tests-1234abcd"
	return manifest{
		Schema: "luson.test-pg/v1", Status: "active", Scope: "transfer-requests/R01", RunID: "1234abcd",
		Labels: labels, DSNFile: root + "/admin-dsn", ExpectedUID: 1000, ExpectedMode: "0600", AdminDatabase: "luson_test", AdminRole: "luson_test",
		Network:   networkBinding{ID: strings.Repeat("a", 64), Name: "luson-transfer-tests-1234abcd-net", Labels: labels, Driver: "bridge", Internal: true, IPAM: ipam{Driver: "default", Config: []ipamConfig{{Subnet: "172.30.40.0/24", Gateway: "172.30.40.1"}}}},
		Container: containerBinding{ID: strings.Repeat("b", 64), Name: "luson-transfer-tests-1234abcd-pg", ImageID: "sha256:" + strings.Repeat("c", 64), ImageReference: "postgres:17.9-bookworm", Labels: labels, NetworkID: strings.Repeat("a", 64), NetworkName: "luson-transfer-tests-1234abcd-net", IP: "172.30.40.10", Port: 5432},
		DataBind:  mount{Type: "bind", Source: root + "/pgdata", Destination: "/var/lib/postgresql/data", RW: true, Propagation: "rprivate"},
	}
}
func encoded(t *testing.T, v any) []byte {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal("synthetic encoding failed")
	}
	return data
}
func syntheticInspection(m manifest) (networkInspection, containerInspection) {
	n := networkInspection{ID: m.Network.ID, Name: m.Network.Name, Labels: m.Labels, Driver: "bridge", Internal: true, IPAM: m.Network.IPAM}
	n.Containers = map[string]struct{ Name, IPv4Address string }{m.Container.ID: {m.Container.Name, m.Container.IP + "/24"}}
	var c containerInspection
	c.ID = m.Container.ID
	c.Name = "/" + m.Container.Name
	c.Image = m.Container.ImageID
	c.Config.Image = m.Container.ImageReference
	c.Config.Labels = m.Labels
	c.State.Running = true
	c.State.Health.Status = "healthy"
	c.HostConfig.NetworkMode = m.Network.Name
	c.NetworkSettings.Networks = map[string]struct{ NetworkID, IPAddress string }{m.Network.Name: {m.Network.ID, m.Container.IP}}
	c.NetworkSettings.Ports = map[string][]json.RawMessage{"5432/tcp": nil}
	c.Mounts = []mount{m.DataBind}
	return n, c
}
func TestR01AdmissionPure(t *testing.T) {
	for _, tc := range []struct {
		name, input string
		valid       bool
	}{
		{"valid_json_frame", `{"schema":"luson.test-pg/v1"}`, true},
		{"duplicate", `{"schema":"a","schema":"b"}`, false},
		{"trailing", `{} {}`, false},
		{"depth", strings.Repeat(`[`, 40) + strings.Repeat(`]`, 40), false},
		{"size", strings.Repeat(" ", 32769), false},
		{"nested_duplicate", `{"a":{"b":1,"b":2}}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if (validateDocument([]byte(tc.input)) == nil) != tc.valid {
				t.Fatal("JSON framing admission mismatch")
			}
		})
	}
	t.Run("valid_manifest", func(t *testing.T) {
		if _, err := parseManifest(encoded(t, syntheticManifest())); err != nil {
			t.Fatal("valid synthetic manifest rejected")
		}
	})
	changes := []struct {
		name   string
		change func(*manifest)
	}{
		{"version", func(m *manifest) { m.Schema = "luson.test-network/v1" }},
		{"inactive", func(m *manifest) { m.Status = "removed" }},
		{"scope", func(m *manifest) { m.Scope = "other" }},
		{"run_id", func(m *manifest) { m.RunID = "not-run-id" }},
		{"uid", func(m *manifest) { m.ExpectedUID = 999 }},
		{"mode", func(m *manifest) { m.ExpectedMode = "0644" }},
		{"admin_db", func(m *manifest) { m.AdminDatabase = "postgres" }},
		{"admin_role", func(m *manifest) { m.AdminRole = "postgres" }},
		{"dsn_path", func(m *manifest) { m.DSNFile = "relative" }},
		{"full_network_id", func(m *manifest) { m.Network.ID = "short" }},
		{"full_container_id", func(m *manifest) { m.Container.ID = "short" }},
		{"full_image_id", func(m *manifest) { m.Container.ImageID = "sha256:" + m.Container.ImageID }},
		{"network_name", func(m *manifest) { m.Network.Name = "bridge" }},
		{"container_name", func(m *manifest) { m.Container.Name = "foreign" }},
		{"labels_missing", func(m *manifest) { m.Labels = nil }},
		{"labels_extra", func(m *manifest) { m.Labels["extra"] = "foreign" }},
		{"labels_owner", func(m *manifest) { m.Labels["luson.owner"] = "foreign" }},
		{"labels_task", func(m *manifest) { m.Labels["luson.task"] = "L02" }},
		{"labels_feature", func(m *manifest) { delete(m.Labels, "luson.feature") }},
		{"labels_lifecycle", func(m *manifest) { m.Labels["luson.lifecycle"] = "operational" }},
		{"labels_purpose", func(m *manifest) { delete(m.Labels, "luson.purpose") }},
		{"network_labels", func(m *manifest) { m.Network.Labels = nil }},
		{"container_labels", func(m *manifest) { m.Container.Labels = nil }},
		{"internal", func(m *manifest) { m.Network.Internal = false }},
		{"driver", func(m *manifest) { m.Network.Driver = "host" }},
		{"ipam", func(m *manifest) { m.Network.IPAM.Driver = "foreign" }},
		{"subnet_noncanonical", func(m *manifest) { m.Network.IPAM.Config[0].Subnet = "172.30.40.1/24" }},
		{"gateway", func(m *manifest) { m.Network.IPAM.Config[0].Gateway = "8.8.8.8" }},
		{"public_ip", func(m *manifest) { m.Container.IP = "8.8.8.8" }},
		{"different_ip", func(m *manifest) { m.Container.IP = "172.31.40.10" }},
		{"network_link", func(m *manifest) { m.Container.NetworkID = strings.Repeat("d", 64) }},
		{"network_link_name", func(m *manifest) { m.Container.NetworkName = "bridge" }},
		{"image_reference", func(m *manifest) { m.Container.ImageReference = "postgres:latest" }},
		{"published", func(m *manifest) { m.Container.PublishedPorts = true }},
		{"port", func(m *manifest) { m.Container.Port = 5433 }},
		{"mount_source", func(m *manifest) { m.DataBind.Source = "/foreign" }},
		{"mount_destination", func(m *manifest) { m.DataBind.Destination = "/foreign" }},
		{"mount_type", func(m *manifest) { m.DataBind.Type = "volume" }},
		{"mount_mode", func(m *manifest) { m.DataBind.Mode = "rw" }},
		{"mount_readonly", func(m *manifest) { m.DataBind.RW = false }},
		{"mount_propagation", func(m *manifest) { m.DataBind.Propagation = "shared" }},
	}
	for _, tc := range changes {
		t.Run(tc.name, func(t *testing.T) {
			m := syntheticManifest()
			tc.change(&m)
			if _, err := parseManifest(encoded(t, m)); err == nil {
				t.Fatal("invalid manifest accepted")
			}
		})
	}
	for _, tc := range []struct {
		name   string
		modify func(string) string
	}{
		{"unknown", func(s string) string { return strings.Replace(s, `"schema":`, `"unknown":0,"schema":`, 1) }},
		{"case_sensitive", func(s string) string { return strings.Replace(s, `"schema":`, `"Schema":`, 1) }},
		{"missing_field", func(s string) string { return strings.Replace(s, `"status":"active",`, "", 1) }},
		{"duplicate_manifest", func(s string) string { return strings.Replace(s, `"status":`, `"status":"active","status":`, 1) }},
		{"null_field", func(s string) string { return strings.Replace(s, `"status":"active"`, `"status":null`, 1) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			data := tc.modify(string(encoded(t, syntheticManifest())))
			if _, err := parseManifest([]byte(data)); err == nil {
				t.Fatal("invalid manifest JSON accepted")
			}
		})
	}
	t.Run("optional_secret_mount_shape", func(t *testing.T) {
		m := syntheticManifest()
		secret := mount{Type: "bind", Source: filepath.Join(filepath.Dir(m.DSNFile), "synthetic-secret"), Destination: "/run/synthetic-secret", Mode: "ro", Propagation: "rprivate"}
		changed := func(b mount, change func(*mount)) mount { change(&b); return b }
		for _, tc := range []struct {
			name   string
			mounts []mount
			valid  bool
		}{
			{"data_only", []mount{m.DataBind}, true},
			{"data_and_secret", []mount{m.DataBind, secret}, true},
			{"secret_and_data", []mount{secret, m.DataBind}, true},
			{"empty_secret_mode", []mount{m.DataBind, changed(secret, func(b *mount) { b.Mode = "" })}, true},
			{"no_mounts", nil, false},
			{"no_data", []mount{secret}, false},
			{"duplicate_data", []mount{m.DataBind, m.DataBind}, false},
			{"two_secrets", []mount{m.DataBind, secret, changed(secret, func(b *mount) { b.Destination += "-other" })}, false},
			{"extra_duplicate_secret", []mount{m.DataBind, secret, secret}, false},
			{"unmatched_data", []mount{changed(m.DataBind, func(b *mount) { b.Source = "/foreign" })}, false},
			{"readonly_data", []mount{changed(m.DataBind, func(b *mount) { b.RW = false })}, false},
			{"rw_secret", []mount{m.DataBind, changed(secret, func(b *mount) { b.RW = true })}, false},
			{"unknown_destination", []mount{m.DataBind, changed(secret, func(b *mount) { b.Destination = "/foreign" })}, false},
			{"foreign_source", []mount{m.DataBind, changed(secret, func(b *mount) { b.Source = "/foreign" })}, false},
			{"unclean_source", []mount{m.DataBind, changed(secret, func(b *mount) { b.Source += "/../synthetic-secret" })}, false},
			{"unclean_destination", []mount{m.DataBind, changed(secret, func(b *mount) { b.Destination += "/../synthetic-secret" })}, false},
			{"volume_secret", []mount{m.DataBind, changed(secret, func(b *mount) { b.Type = "volume" })}, false},
			{"malformed_secret_mode", []mount{m.DataBind, changed(secret, func(b *mount) { b.Mode = "rw" })}, false},
			{"shared_secret", []mount{m.DataBind, changed(secret, func(b *mount) { b.Propagation = "shared" })}, false},
		} {
			t.Run(tc.name, func(t *testing.T) {
				if (validateMountShape(m, tc.mounts) == nil) != tc.valid {
					t.Fatal("optional secret mount shape admission mismatch")
				}
			})
		}
	})
	t.Run("opened_file_metadata", func(t *testing.T) {
		valid := syscall.Stat_t{Mode: syscall.S_IFREG | 0600, Uid: 1000, Size: 2}
		if !privateFileStat(valid, 32) {
			t.Fatal("valid opened-file metadata rejected")
		}
		for _, change := range []func(*syscall.Stat_t){
			func(st *syscall.Stat_t) { st.Uid = 999 },
			func(st *syscall.Stat_t) { st.Mode = syscall.S_IFREG | 0644 },
			func(st *syscall.Stat_t) { st.Mode = syscall.S_IFREG | 04600 },
			func(st *syscall.Stat_t) { st.Mode = syscall.S_IFLNK | 0600 },
			func(st *syscall.Stat_t) { st.Mode = syscall.S_IFIFO | 0600 },
			func(st *syscall.Stat_t) { st.Size = 0 },
			func(st *syscall.Stat_t) { st.Size = 33 },
		} {
			bad := valid
			change(&bad)
			if privateFileStat(bad, 32) {
				t.Fatal("invalid opened-file metadata accepted")
			}
		}
	})
	t.Run("private_files", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "manifest")
		if err := os.WriteFile(path, []byte("{}"), 0600); err != nil {
			t.Fatal("synthetic file creation failed")
		}
		if _, err := readPrivate(path, 32); err != nil {
			t.Fatal("private regular file rejected")
		}
		if err := os.Chmod(path, 0644); err != nil {
			t.Fatal("synthetic file mode change failed")
		}
		if _, err := readPrivate(path, 32); err == nil {
			t.Fatal("public file accepted")
		}
		if err := os.Chmod(path, 0600); err != nil {
			t.Fatal("synthetic file mode change failed")
		}
		if _, err := readPrivate(path, 1); err == nil {
			t.Fatal("oversized file accepted")
		}
		link := filepath.Join(dir, "link")
		if os.Symlink(path, link) != nil {
			t.Fatal("synthetic symlink failed")
		}
		if _, err := readPrivate(link, 32); err == nil {
			t.Fatal("symlink accepted")
		}
		fifo := filepath.Join(dir, "fifo")
		if syscall.Mkfifo(fifo, 0600) != nil {
			t.Fatal("synthetic FIFO failed")
		}
		if _, err := readPrivate(fifo, 32); err == nil {
			t.Fatal("FIFO accepted")
		}
		for _, bad := range []string{"", path + ".missing", dir, "relative"} {
			if _, err := readPrivate(bad, 32); err == nil {
				t.Fatal("invalid file accepted")
			}
		}
	})
	t.Run("missing_env_no_inspection", func(t *testing.T) {
		t.Setenv(manifestEnv, "")
		calls := 0
		_, err := admit(context.Background(), os.Getenv(manifestEnv), func(context.Context, string, string) ([]byte, error) {
			calls++
			return nil, errors.New("synthetic private failure")
		})
		if err == nil || calls != 0 {
			t.Fatal("missing pointer did not reject before inspection")
		}
	})
	t.Run("dsn", func(t *testing.T) {
		m := syntheticManifest()
		valid := "postgres://luson_test:synthetic-private-value@172.30.40.10:5432/luson_test?sslmode=disable"
		for _, s := range []string{valid, valid + "\n"} {
			cfg, err := parseDSN([]byte(s), m)
			if err != nil || cfg.MaxConns != 4 {
				t.Fatal("valid private DSN rejected")
			}
		}
		for _, bad := range []string{"", valid + "\n\n", valid + "\r\n", valid + "\x00", valid + " ", strings.Replace(valid, "luson_test:", "postgres:", 1), strings.Replace(valid, "/luson_test?", "/postgres?", 1), strings.Replace(valid, "172.30.40.10", "172.30.40.11", 1), strings.Replace(valid, ":5432/", ":5433/", 1), valid + "&host=foreign", strings.Replace(valid, "synthetic-private-value", "", 1), strings.Replace(valid, "sslmode=disable", "sslmode=require", 1), strings.Repeat("x", 4097)} {
			_, err := parseDSN([]byte(bad), m)
			if err == nil || strings.Contains(err.Error(), "synthetic-private-value") {
				t.Fatal("unsafe private DSN admission/error")
			}
		}
	})
	t.Run("ambient_pg_provider", func(t *testing.T) {
		t.Setenv("PGSERVICEFILE", "/synthetic/must-not-be-read")
		if _, err := parseDSN([]byte("postgres://luson_test:synthetic-private-value@172.30.40.10:5432/luson_test?sslmode=disable"), syntheticManifest()); err == nil {
			t.Fatal("ambient connection provider accepted")
		}
	})
	t.Run("inspection", func(t *testing.T) {
		m := syntheticManifest()
		n, c := syntheticInspection(m)
		compare := func(n networkInspection, c containerInspection) error {
			return compareInspection(m, encoded(t, []networkInspection{n}), encoded(t, []containerInspection{c}))
		}
		if compare(n, c) != nil {
			t.Fatal("valid read-only synthetic inspection rejected")
		}
		c.Config.Image = m.Container.ImageID
		if compare(n, c) != nil {
			t.Fatal("parent pinned-image launch rejected")
		}
		for _, change := range []func(*containerInspection){
			func(c *containerInspection) { c.ID = "wrong" }, func(c *containerInspection) { c.Name = "/foreign" }, func(c *containerInspection) { c.Image = "foreign" },
			func(c *containerInspection) { c.Config.Image = "postgres:latest" }, func(c *containerInspection) { c.Config.Labels = nil },
			func(c *containerInspection) { c.State.Running = false }, func(c *containerInspection) { c.State.Health.Status = "unhealthy" }, func(c *containerInspection) { c.HostConfig.NetworkMode = "bridge" },
			func(c *containerInspection) {
				c.NetworkSettings.Networks[m.Network.Name] = struct{ NetworkID, IPAddress string }{m.Network.ID, "172.30.40.11"}
			},
			func(c *containerInspection) {
				c.NetworkSettings.Networks["foreign"] = struct{ NetworkID, IPAddress string }{}
			},
			func(c *containerInspection) {
				c.NetworkSettings.Ports["5432/tcp"] = []json.RawMessage{json.RawMessage(`{"HostPort":"5432"}`)}
			},
			func(c *containerInspection) {
				c.HostConfig.PortBindings = map[string][]json.RawMessage{"5432/tcp": {json.RawMessage(`{}`)}}
			},
			func(c *containerInspection) { c.Mounts[0].Source = "/foreign" }, func(c *containerInspection) { c.Mounts = nil },
		} {
			n, c = syntheticInspection(m)
			change(&c)
			if compare(n, c) == nil {
				t.Fatal("container drift accepted")
			}
		}
		for _, change := range []func(*networkInspection){
			func(n *networkInspection) { n.ID = "wrong" }, func(n *networkInspection) { n.Name = "foreign" }, func(n *networkInspection) { n.Labels = nil }, func(n *networkInspection) { n.Internal = false },
			func(n *networkInspection) { n.IPAM.Options = map[string]string{"foreign": "value"} }, func(n *networkInspection) { n.Containers = nil },
			func(n *networkInspection) { n.Containers["foreign"] = struct{ Name, IPv4Address string }{} },
		} {
			n, c = syntheticInspection(m)
			change(&n)
			if compare(n, c) == nil {
				t.Fatal("network drift accepted")
			}
		}
		if compareInspection(m, []byte(`[]`), []byte(`[]`)) == nil {
			t.Fatal("missing frame accepted")
		}
	})
	t.Run("cleanup_guard_without_sql", func(t *testing.T) {
		for _, name := range []string{"luson_test", "postgres", "luson_test_" + strings.Repeat("a", 32)} {
			if dropOwned(context.Background(), admission{binding: syntheticManifest()}, "", name, 0) == nil {
				t.Fatal("unrecorded cleanup accepted")
			}
		}
	})
	t.Run("sanitized_inspector_error", func(t *testing.T) {
		if inspectionError(errInspectorUnavailable) != errInspectorUnavailable {
			t.Fatal("CLI availability classification lost")
		}
		if strings.Contains(inspectionError(errors.New("synthetic-private-value")).Error(), "synthetic-private-value") {
			t.Fatal("private inspector error leaked")
		}
	})
	t.Run("bounded_inspector_output", func(t *testing.T) {
		var b boundedOutput
		_, _ = b.Write(make([]byte, (1<<20)+1))
		if !b.overflow || b.Len() != 0 {
			t.Fatal("inspection output not bounded")
		}
	})
}

func TestR01AdmissionPostgres(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	path := os.Getenv(manifestEnv)
	a, err := admit(ctx, path, dockerInspect)
	if err != nil {
		t.Fatal(err)
	}
	t.Run("optional_secret_mount_real_metadata", func(t *testing.T) {
		// Synthetic data-only inspection shape, but actual read-only metadata
		// proof: no Docker mount changes, private file writes or chown.
		if validatePrivateMounts(a.binding, []mount{a.binding.DataBind}) != nil {
			t.Fatal("data-only form rejected with admitted filesystem metadata")
		}
		if len(a.mounts) != 2 || validatePrivateMounts(a.binding, a.mounts) != nil {
			t.Fatal("parent two-mount fixture metadata rejected")
		}
	})
	admin, err := pgx.ConnectConfig(ctx, a.config.ConnConfig.Copy())
	if err != nil {
		t.Fatal("fixture diagnostic connection failed")
	}
	defer admin.Close(context.Background())
	if verifyAdmin(ctx, admin, a.binding) != nil {
		t.Fatal("fixture admin identity failed")
	}
	var before int
	if admin.QueryRow(ctx, "SELECT count(*) FROM pg_database WHERE datname !~ '^luson_test_[a-f0-9]{32}$'").Scan(&before) != nil || before < 3 || before > 4 {
		t.Fatal("fixture catalog diagnostic failed")
	}
	var unexpected int
	if admin.QueryRow(ctx, "SELECT count(*) FROM pg_database WHERE datname NOT IN ('luson_test','postgres','template0','template1') AND datname !~ '^luson_test_[a-f0-9]{32}$'").Scan(&unexpected) != nil || unexpected != 0 {
		t.Fatal("fixture has foreign databases")
	}
	var name string
	t.Run("empty_isolated_pool", func(t *testing.T) {
		p := Open(t)
		name = p.Config().ConnConfig.Database
		var value, tables int
		if p.QueryRow(ctx, "SELECT 42").Scan(&value) != nil || value != 42 {
			t.Fatal("isolated query failed")
		}
		if p.QueryRow(ctx, "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'").Scan(&tables) != nil || tables != 0 {
			t.Fatal("helper initialized schema")
		}
		var oid uint32
		if admin.QueryRow(ctx, "SELECT oid FROM pg_database WHERE datname=$1", name).Scan(&oid) != nil {
			t.Fatal("created database not recorded")
		}
		if dropOwned(ctx, a, path, name, oid+1) == nil {
			t.Fatal("wrong database identity admitted for cleanup")
		}
		if dropOwned(ctx, a, path, a.binding.AdminDatabase, oid) == nil {
			t.Fatal("admin cleanup admitted")
		}
		drift := a
		drift.binding.Container.ID = strings.Repeat("0", 64)
		if dropOwned(ctx, drift, path, name, oid) == nil {
			t.Fatal("fixture drift admitted for cleanup")
		}
		p.Close() // Cleanup also accepts already closed pools.
	})
	var remaining, after, adminTables int
	if admin.QueryRow(ctx, "SELECT count(*) FROM pg_database WHERE datname=$1", name).Scan(&remaining) != nil || remaining != 0 {
		t.Fatal("owned database was not cleaned")
	}
	if admin.QueryRow(ctx, "SELECT count(*) FROM pg_database WHERE datname !~ '^luson_test_[a-f0-9]{32}$'").Scan(&after) != nil || after != before {
		t.Fatal("fixture database catalog changed")
	}
	if admin.QueryRow(ctx, "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'").Scan(&adminTables) != nil || adminTables != 0 {
		t.Fatal("admin schema changed")
	}
	// The runner starts bootstrap in another process. Wait read-only for its
	// admitted temporary databases to finish; never drop another test's DB.
	settled := false
	for i := 0; i < 150; i++ {
		var total int
		if admin.QueryRow(ctx, "SELECT count(*) FROM pg_database").Scan(&total) != nil {
			t.Fatal("final fixture catalog diagnostic failed")
		}
		if total == before {
			settled = true
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !settled {
		t.Fatal("fixture still has unexpected databases after checks")
	}
	if a.recheck(ctx, path) != nil {
		t.Fatal("fixture identity changed")
	}
	t.Logf("admitted fixture healthy; protected database count %d -> %d; owned database cleaned; admin public tables %d", before, after, adminTables)
}
