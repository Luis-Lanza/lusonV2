// Package testpg supplies empty databases, never Docker lifecycle operations.
// Admission is test-only and independent of application initialization/auth.
package testpg

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const manifestEnv = "LUSON_TEST_PG_MANIFEST"
const manifestLimit = 32768

var fullID = regexp.MustCompile(`^[a-f0-9]{64}$`)
var imageID = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
var runID = regexp.MustCompile(`^[a-f0-9]{8}$`)
var databaseName = regexp.MustCompile(`^luson_test_[a-f0-9]{32}$`)
var errInspectorUnavailable = errors.New("test PostgreSQL inspector unavailable")

// These field names deliberately match the versioned manifest, not a DSN.
type manifest struct {
	Schema        string            `json:"schema"`
	Status        string            `json:"status"`
	Scope         string            `json:"scope"`
	RunID         string            `json:"run_id"`
	Labels        map[string]string `json:"labels"`
	DSNFile       string            `json:"dsn_file"`
	ExpectedUID   int               `json:"expected_uid"`
	ExpectedMode  string            `json:"expected_mode"`
	AdminDatabase string            `json:"admin_database"`
	AdminRole     string            `json:"admin_role"`
	Network       networkBinding    `json:"network"`
	Container     containerBinding  `json:"container"`
	DataBind      mount             `json:"data_bind"`
}
type ipamConfig struct {
	Subnet             string
	Gateway            string
	IPRange            string            `json:",omitempty"`
	AuxiliaryAddresses map[string]string `json:",omitempty"`
}
type ipam struct {
	Driver  string
	Options map[string]string
	Config  []ipamConfig
}
type networkBinding struct {
	ID       string            `json:"id"`
	Name     string            `json:"name"`
	Labels   map[string]string `json:"labels"`
	Driver   string            `json:"driver"`
	Internal bool              `json:"internal"`
	IPAM     ipam              `json:"ipam"`
}
type containerBinding struct {
	ID             string            `json:"id"`
	Name           string            `json:"name"`
	ImageID        string            `json:"image_id"`
	ImageReference string            `json:"image_reference"`
	Labels         map[string]string `json:"labels"`
	NetworkID      string            `json:"network_id"`
	NetworkName    string            `json:"network_name"`
	IP             string            `json:"ip"`
	Port           int               `json:"port"`
	PublishedPorts bool              `json:"published_ports"`
}
type mount struct {
	Type, Source, Destination, Mode string
	RW                              bool
	Propagation                     string
}
type networkInspection struct {
	ID         string `json:"Id"`
	Name       string
	Labels     map[string]string
	Driver     string
	Internal   bool
	IPAM       ipam
	Containers map[string]struct{ Name, IPv4Address string }
}
type containerInspection struct {
	ID          string `json:"Id"`
	Name, Image string
	Config      struct {
		Image  string
		Labels map[string]string
	}
	State struct {
		Running bool
		Health  struct{ Status string }
	}
	HostConfig struct {
		NetworkMode  string
		PortBindings map[string][]json.RawMessage
	}
	NetworkSettings struct {
		Ports    map[string][]json.RawMessage
		Networks map[string]struct{ NetworkID, IPAddress string }
	}
	Mounts []mount
}
type inspector func(context.Context, string, string) ([]byte, error)
type admission struct {
	binding manifest
	config  *pgxpool.Config
	mounts  []mount
}

func rejected() error { return errors.New("test PostgreSQL admission rejected") }

// Token walk bounds recursion and rejects duplicate keys before struct decoding.
func validateDocument(data []byte) error {
	if len(data) == 0 || len(data) > manifestLimit {
		return rejected()
	}
	d := json.NewDecoder(bytes.NewReader(data))
	var walk func(int) error
	walk = func(depth int) error {
		if depth > 16 {
			return rejected()
		}
		token, err := d.Token()
		if err != nil {
			return rejected()
		}
		delim, ok := token.(json.Delim)
		if !ok {
			return nil
		}
		switch delim {
		case '{':
			seen := map[string]bool{}
			for d.More() {
				key, err := d.Token()
				if err != nil {
					return rejected()
				}
				s, ok := key.(string)
				if !ok || seen[s] {
					return rejected()
				}
				seen[s] = true
				if err := walk(depth + 1); err != nil {
					return err
				}
			}
		case '[':
			for d.More() {
				if err := walk(depth + 1); err != nil {
					return err
				}
			}
		default:
			return rejected()
		}
		if _, err := d.Token(); err != nil {
			return rejected()
		}
		return nil
	}
	if err := walk(0); err != nil {
		return err
	}
	if _, err := d.Token(); err != io.EOF {
		return rejected()
	}
	return nil
}

// encoding/json otherwise accepts case-insensitive struct keys. Validate exact
// names, required fields and nulls against the manifest type before decoding.
func exactFields(raw json.RawMessage, typ reflect.Type) bool {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return typ.Kind() == reflect.Map
	}
	switch typ.Kind() {
	case reflect.Struct:
		var fields map[string]json.RawMessage
		if json.Unmarshal(raw, &fields) != nil || fields == nil {
			return false
		}
		allowed := map[string]reflect.Type{}
		required := map[string]bool{}
		for i := 0; i < typ.NumField(); i++ {
			f := typ.Field(i)
			tag := strings.Split(f.Tag.Get("json"), ",")
			name := tag[0]
			if name == "" {
				name = f.Name
			}
			allowed[name] = f.Type
			if len(tag) < 2 || tag[1] != "omitempty" {
				required[name] = true
			}
		}
		for key, value := range fields {
			ft, ok := allowed[key]
			if !ok || !exactFields(value, ft) {
				return false
			}
			delete(required, key)
		}
		return len(required) == 0
	case reflect.Map:
		var values map[string]json.RawMessage
		if json.Unmarshal(raw, &values) != nil {
			return false
		}
		for _, value := range values {
			if !exactFields(value, typ.Elem()) {
				return false
			}
		}
	case reflect.Slice:
		var values []json.RawMessage
		if json.Unmarshal(raw, &values) != nil || values == nil {
			return false
		}
		for _, v := range values {
			if !exactFields(v, typ.Elem()) {
				return false
			}
		}
	}
	return true
}
func parseManifest(data []byte) (manifest, error) {
	var m manifest
	if validateDocument(data) != nil || !exactFields(data, reflect.TypeOf(m)) {
		return m, rejected()
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if d.Decode(&m) != nil || validateManifest(m) != nil {
		return manifest{}, rejected()
	}
	return m, nil
}
func expectedLabels() map[string]string {
	return map[string]string{"luson.feature": "transfer-requests", "luson.task": "R01", "luson.owner": "parent-session-luson-v2", "luson.lifecycle": "ephemeral-test-only", "luson.purpose": "go-postgresql-tests"}
}
func validateManifest(m manifest) error {
	n, c, b := m.Network, m.Container, m.DataBind
	root := filepath.Join("/home/luis/.local/share", "luson-transfer-tests-"+m.RunID)
	if m.Schema != "luson.test-pg/v1" || m.Status != "active" || m.Scope != "transfer-requests/R01" || !runID.MatchString(m.RunID) || m.ExpectedUID != 1000 || os.Getuid() != 1000 || m.ExpectedMode != "0600" || m.AdminDatabase != "luson_test" || m.AdminRole != "luson_test" || !reflect.DeepEqual(m.Labels, expectedLabels()) {
		return rejected()
	}
	if m.DSNFile != filepath.Join(root, "admin-dsn") || !fullID.MatchString(n.ID) || !fullID.MatchString(c.ID) || !imageID.MatchString(c.ImageID) {
		return rejected()
	}
	if n.Name != "luson-transfer-tests-"+m.RunID+"-net" || c.Name != "luson-transfer-tests-"+m.RunID+"-pg" || n.Driver != "bridge" || !n.Internal || n.IPAM.Driver != "default" || !reflect.DeepEqual(n.Labels, m.Labels) || !reflect.DeepEqual(c.Labels, m.Labels) {
		return rejected()
	}
	if c.ImageReference != "postgres:17.9-bookworm" || c.NetworkID != n.ID || c.NetworkName != n.Name || c.Port != 5432 || c.PublishedPorts {
		return rejected()
	}
	ip := net.ParseIP(c.IP)
	if ip == nil || ip.To4() == nil || !ip.IsPrivate() || ip.IsLoopback() || ip.String() != c.IP || len(n.IPAM.Config) != 1 {
		return rejected()
	}
	conf := n.IPAM.Config[0]
	_, subnet, err := net.ParseCIDR(conf.Subnet)
	gateway := net.ParseIP(conf.Gateway)
	if err != nil || subnet.String() != conf.Subnet || gateway == nil || gateway.String() != conf.Gateway || !gateway.IsPrivate() || !subnet.Contains(ip) || !subnet.Contains(gateway) || ip.Equal(gateway) || ip.Equal(subnet.IP) || conf.IPRange != "" || len(conf.AuxiliaryAddresses) != 0 {
		return rejected()
	}
	if b.Type != "bind" || b.Source != filepath.Join(root, "pgdata") || b.Destination != "/var/lib/postgresql/data" || b.Mode != "" || !b.RW || b.Propagation != "rprivate" {
		return rejected()
	}
	return nil
}

// O_NOFOLLOW avoids link replacement; O_NONBLOCK makes FIFOs harmless. All
// metadata checks are on the opened handle, before any bounded private read.
func readPrivate(path string, limit int) ([]byte, error) {
	if path == "" || !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, rejected()
	}
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, rejected()
	}
	f := os.NewFile(uintptr(fd), "private test admission file")
	defer f.Close()
	var st syscall.Stat_t
	if syscall.Fstat(fd, &st) != nil || !privateFileStat(st, limit) {
		return nil, rejected()
	}
	data, err := io.ReadAll(io.LimitReader(f, int64(limit)+1))
	if err != nil || len(data) > limit || len(data) == 0 {
		return nil, rejected()
	}
	return data, nil
}
func privateFileStat(st syscall.Stat_t, limit int) bool {
	return st.Mode&syscall.S_IFMT == syscall.S_IFREG && st.Mode&07777 == 0600 && st.Uid == 1000 && os.Getuid() == 1000 && st.Size > 0 && st.Size <= int64(limit)
}

func parseDSN(data []byte, m manifest) (*pgxpool.Config, error) {
	if len(data) > 4096 {
		return nil, rejected()
	}
	s := strings.TrimSuffix(string(data), "\n")
	if s == "" || strings.ContainsAny(s, "\r\n\x00 \t") {
		return nil, rejected()
	}
	u, err := url.Parse(s)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") || u.User == nil || u.User.Username() != m.AdminRole || u.Hostname() != m.Container.IP || u.Port() != "5432" || u.Path != "/"+m.AdminDatabase || u.Fragment != "" || u.RawPath != "" {
		return nil, rejected()
	}
	password, ok := u.User.Password()
	if !ok || password == "" || strings.ContainsAny(password, "\r\n\x00") || u.RawQuery != "sslmode=disable" {
		return nil, rejected()
	}
	// pgx otherwise consults ambient service/pass files and PG* defaults. The
	// admitted URL is the only connection provider, including in pure tests.
	for _, key := range []string{"PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD", "PGPASSFILE", "PGSERVICE", "PGSERVICEFILE", "PGSSLMODE", "PGSSLCERT", "PGSSLKEY", "PGSSLROOTCERT", "PGSSLCRL", "PGOPTIONS", "PGAPPNAME", "PGTARGETSESSIONATTRS", "PGCONNECT_TIMEOUT"} {
		if _, present := os.LookupEnv(key); present {
			return nil, rejected()
		}
	}
	cfg, err := pgxpool.ParseConfig(s)
	if err != nil || cfg.ConnConfig.User != m.AdminRole || cfg.ConnConfig.Database != m.AdminDatabase || cfg.ConnConfig.Host != m.Container.IP || cfg.ConnConfig.Port != 5432 || cfg.ConnConfig.Password != password || len(cfg.ConnConfig.Fallbacks) != 0 || cfg.ConnConfig.TLSConfig != nil || len(cfg.ConnConfig.RuntimeParams) != 0 {
		return nil, rejected()
	}
	cfg.MaxConns = 4
	cfg.MinConns = 0
	cfg.ConnConfig.ConnectTimeout = 5 * time.Second
	return cfg, nil
}
func directory(path string, uid uint32, mode uint32) bool {
	var st syscall.Stat_t
	return syscall.Lstat(path, &st) == nil && st.Mode&syscall.S_IFMT == syscall.S_IFDIR && st.Uid == uid && st.Mode&07777 == mode
}
func validatePrivateMounts(m manifest, mounts []mount) error {
	root := filepath.Dir(m.DSNFile)
	if !directory(root, 1000, 0700) {
		return errors.New("test PostgreSQL private directory metadata rejected")
	}
	var st syscall.Stat_t
	if syscall.Lstat(m.DataBind.Source, &st) != nil || st.Mode&syscall.S_IFMT != syscall.S_IFDIR || st.Uid != 999 || st.Mode&0077 != 0 {
		return errors.New("test PostgreSQL data directory metadata rejected")
	}
	if err := validateMountShape(m, mounts); err != nil {
		return err
	}
	for _, b := range mounts {
		if b.Destination == m.DataBind.Destination {
			continue
		}
		if syscall.Lstat(b.Source, &st) != nil || st.Mode&syscall.S_IFMT != syscall.S_IFREG || st.Mode&07777 != 0600 || st.Uid != 1000 {
			return errors.New("test PostgreSQL secret file metadata rejected")
		}
	}
	return nil
}

// Shape validation is pure; validatePrivateMounts still checks every source's
// filesystem metadata before this admission can reach a connection or SQL.
func validateMountShape(m manifest, mounts []mount) error {
	root := filepath.Dir(m.DSNFile)
	dataFound := false
	for _, b := range mounts {
		if b.Destination == m.DataBind.Destination {
			if dataFound || b != m.DataBind {
				return rejected()
			}
			dataFound = true
			continue
		}
		// The sole additional bind may be the parent's read-only password file.
		if b.Type != "bind" || filepath.Dir(b.Source) != root || filepath.Clean(b.Source) != b.Source || !strings.HasPrefix(b.Destination, "/run/") || filepath.Clean(b.Destination) != b.Destination || b.RW || b.Propagation != "rprivate" || (b.Mode != "ro" && b.Mode != "") {
			return errors.New("test PostgreSQL secret mount identity rejected")
		}
	}
	if !dataFound || len(mounts) > 2 {
		return rejected()
	}
	return nil
}
func compareInspection(m manifest, networkData, containerData []byte) error {
	var ns []networkInspection
	var cs []containerInspection
	if json.Unmarshal(networkData, &ns) != nil || json.Unmarshal(containerData, &cs) != nil || len(ns) != 1 || len(cs) != 1 {
		return rejected()
	}
	n, c := ns[0], cs[0]
	if n.ID != m.Network.ID || n.Name != m.Network.Name || n.Driver != m.Network.Driver || n.Internal != m.Network.Internal || !reflect.DeepEqual(n.Labels, m.Labels) || !reflect.DeepEqual(n.IPAM, m.Network.IPAM) || len(n.Containers) != 1 {
		return errors.New("test PostgreSQL network identity rejected")
	}
	member, ok := n.Containers[m.Container.ID]
	if !ok || member.Name != m.Container.Name || member.IPv4Address != m.Container.IP+"/"+strings.Split(m.Network.IPAM.Config[0].Subnet, "/")[1] {
		return errors.New("test PostgreSQL network member identity rejected")
	}
	if c.ID != m.Container.ID || c.Name != "/"+m.Container.Name {
		return errors.New("test PostgreSQL container name or ID rejected")
	}
	if c.Image != m.Container.ImageID {
		return errors.New("test PostgreSQL container immutable image rejected")
	}
	// Docker records the immutable ID here when the parent launches by ID;
	// the resulting Image must still equal the manifest's exact pinned ID.
	if c.Config.Image != m.Container.ImageReference && c.Config.Image != m.Container.ImageID {
		return errors.New("test PostgreSQL container image reference rejected")
	}
	if !reflect.DeepEqual(c.Config.Labels, m.Labels) {
		return errors.New("test PostgreSQL container labels rejected")
	}
	if c.HostConfig.NetworkMode != m.Network.Name || len(c.NetworkSettings.Networks) != 1 {
		return errors.New("test PostgreSQL container network mode rejected")
	}
	if !c.State.Running || c.State.Health.Status != "healthy" {
		return errors.New("test PostgreSQL container health rejected")
	}
	attach, ok := c.NetworkSettings.Networks[m.Network.Name]
	if !ok || attach.NetworkID != m.Network.ID || attach.IPAddress != m.Container.IP {
		return rejected()
	}
	for _, ports := range c.HostConfig.PortBindings {
		if len(ports) != 0 {
			return rejected()
		}
	}
	for name, ports := range c.NetworkSettings.Ports {
		if name != "5432/tcp" || len(ports) != 0 {
			return rejected()
		}
	}
	found := 0
	for _, b := range c.Mounts {
		if b.Destination == m.DataBind.Destination {
			if b != m.DataBind {
				return rejected()
			}
			found++
		}
	}
	if found != 1 {
		return rejected()
	}
	return nil
}

// Bound Docker stdout too: inspection includes private environment metadata.
type boundedOutput struct {
	bytes.Buffer
	overflow bool
}

func (b *boundedOutput) Write(p []byte) (int, error) {
	n := len(p)
	if b.Len()+n > 1<<20 {
		b.overflow = true
		return n, nil
	}
	_, _ = b.Buffer.Write(p)
	return n, nil
}
func dockerInspect(ctx context.Context, kind, id string) ([]byte, error) {
	if (kind != "network" && kind != "container") || !fullID.MatchString(id) {
		return nil, rejected()
	}
	if _, err := exec.LookPath("docker"); err != nil {
		return nil, errInspectorUnavailable
	}
	cmd := exec.CommandContext(ctx, "docker", kind, "inspect", id)
	var out boundedOutput
	cmd.Stdout = &out
	if cmd.Run() != nil || out.overflow {
		return nil, errors.New("test PostgreSQL identity inspection failed")
	}
	return out.Bytes(), nil
}
func inspectionError(err error) error {
	if errors.Is(err, errInspectorUnavailable) {
		return errInspectorUnavailable
	}
	return errors.New("test PostgreSQL identity inspection failed")
}

func admit(ctx context.Context, path string, inspect inspector) (admission, error) {
	var a admission
	data, err := readPrivate(path, manifestLimit)
	if err != nil {
		return a, err
	}
	m, err := parseManifest(data)
	if err != nil {
		return a, err
	}
	secret, err := readPrivate(m.DSNFile, 4096)
	if err != nil {
		return a, err
	}
	cfg, err := parseDSN(secret, m)
	if err != nil {
		return a, err
	}
	network, err := inspect(ctx, "network", m.Network.ID)
	if err != nil {
		return a, inspectionError(err)
	}
	container, err := inspect(ctx, "container", m.Container.ID)
	if err != nil {
		return a, inspectionError(err)
	}
	if err := compareInspection(m, network, container); err != nil {
		return a, err
	}
	var cs []containerInspection
	if json.Unmarshal(container, &cs) != nil {
		return a, errors.New("test PostgreSQL container frame rejected")
	}
	if err := validatePrivateMounts(m, cs[0].Mounts); err != nil {
		return a, err
	}
	sort.Slice(cs[0].Mounts, func(i, j int) bool { return cs[0].Mounts[i].Destination < cs[0].Mounts[j].Destination })
	return admission{m, cfg, cs[0].Mounts}, nil
}
func (a admission) recheck(ctx context.Context, path string) error {
	next, err := admit(ctx, path, dockerInspect)
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(next.binding, a.binding) || !reflect.DeepEqual(next.mounts, a.mounts) || next.config.ConnConfig.ConnString() != a.config.ConnConfig.ConnString() {
		return errors.New("test PostgreSQL admission identity changed")
	}
	return nil
}
func verifyAdmin(ctx context.Context, c *pgx.Conn, m manifest) error {
	var user, db string
	if c.QueryRow(ctx, "SELECT current_user,current_database()").Scan(&user, &db) != nil || user != m.AdminRole || db != m.AdminDatabase {
		return errors.New("test PostgreSQL admin identity mismatch")
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

// Open never initializes schema. Callers retain their existing provisioning.
func Open(t *testing.T) *pgxpool.Pool {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	path := os.Getenv(manifestEnv)
	a, err := admit(ctx, path, dockerInspect)
	if err != nil {
		t.Fatal(err)
	}
	admin, err := pgx.ConnectConfig(ctx, a.config.ConnConfig.Copy())
	if err != nil {
		t.Fatal("test PostgreSQL admin connection failed")
	}
	defer admin.Close(context.Background())
	if verifyAdmin(ctx, admin, a.binding) != nil || a.recheck(ctx, path) != nil {
		t.Fatal("test PostgreSQL pre-create identity rejected")
	}
	name := "luson_test_" + Random(t)[:32]
	if !databaseName.MatchString(name) {
		t.Fatal("test PostgreSQL database name rejected")
	}
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize()+" OWNER "+pgx.Identifier{a.binding.AdminRole}.Sanitize()); err != nil {
		t.Fatal("test PostgreSQL database creation failed")
	}
	var pool *pgxpool.Pool
	var oid uint32
	// Register before any post-CREATE operation (including pool construction).
	t.Cleanup(func() {
		if pool != nil {
			pool.Close()
		}
		cleanup, done := context.WithTimeout(context.Background(), 30*time.Second)
		defer done()
		if err := dropOwned(cleanup, a, path, name, oid); err != nil {
			t.Error(err)
		}
	})
	if admin.QueryRow(ctx, "SELECT oid FROM pg_database WHERE datname=$1", name).Scan(&oid) != nil {
		t.Fatal("test PostgreSQL database recording failed")
	}
	cfg := a.config.Copy()
	cfg.ConnConfig.Database = name
	pool, err = pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal("test PostgreSQL pool configuration failed")
	}
	var user, db string
	if pool.QueryRow(ctx, "SELECT current_user,current_database()").Scan(&user, &db) != nil || user != a.binding.AdminRole || db != name {
		t.Fatal("test PostgreSQL isolated connection failed")
	}
	return pool
}
func dropOwned(ctx context.Context, a admission, path, name string, oid uint32) error {
	if !databaseName.MatchString(name) || name == a.binding.AdminDatabase || oid == 0 || a.recheck(ctx, path) != nil {
		return errors.New("test PostgreSQL cleanup identity rejected")
	}
	admin, err := pgx.ConnectConfig(ctx, a.config.ConnConfig.Copy())
	if err != nil {
		return errors.New("test PostgreSQL cleanup connection failed")
	}
	defer admin.Close(context.Background())
	if verifyAdmin(ctx, admin, a.binding) != nil {
		return errors.New("test PostgreSQL cleanup admin identity rejected")
	}
	var actual uint32
	var owner string
	if admin.QueryRow(ctx, "SELECT oid,pg_get_userbyid(datdba) FROM pg_database WHERE datname=$1", name).Scan(&actual, &owner) != nil || actual != oid || owner != a.binding.AdminRole {
		return errors.New("test PostgreSQL cleanup database identity rejected")
	}
	if _, err := admin.Exec(ctx, "DROP DATABASE "+pgx.Identifier{name}.Sanitize()); err != nil {
		return errors.New("test PostgreSQL owned database cleanup failed")
	}
	return nil
}
