package config

import (
	"errors"
	"io"
	"os"
	"strconv"
	"strings"
	"syscall"

	"github.com/jackc/pgx/v5/pgxpool"
)

const maxDatabaseURLBytes = 4096

func privateOwner(uid uint32) bool { return uid == uint32(os.Getuid()) }

// LoadEnv accepts exactly one PRESENT provider. Errors intentionally contain
// neither paths, URLs, file contents nor driver diagnostics. Environment DSNs
// remain compatible with generated tests; deployments use private file secrets.
func LoadEnv() (Config, error) {
	fail := func() (Config, error) {
		return Config{}, errors.New("invalid database configuration")
	}
	raw, direct := os.LookupEnv("LUSON_DATABASE_URL")
	path, file := os.LookupEnv("LUSON_DATABASE_URL_FILE")
	if direct == file {
		return fail()
	}
	for _, identity := range []struct {
		key    string
		actual int
	}{{"LUSON_APP_UID", os.Getuid()}, {"LUSON_APP_GID", os.Getgid()}} {
		if value, present := os.LookupEnv(identity.key); present {
			parsed, err := strconv.ParseUint(value, 10, 32)
			if err != nil || parsed == 0 || parsed != uint64(identity.actual) {
				return fail()
			}
		}
	}
	if file {
		data, err := readPrivateURL(path)
		if err != nil {
			return fail()
		}
		raw = strings.TrimSuffix(string(data), "\n")
	}
	if len(raw) == 0 || len(raw) > maxDatabaseURLBytes || strings.ContainsAny(raw, "\r\n\x00") || strings.TrimSpace(raw) != raw {
		return fail()
	}
	cfg, err := Parse(raw, os.Getenv("LUSON_PROFILE"))
	if err != nil {
		return fail()
	}
	// The URL parser alone does not validate PostgreSQL connection options.
	if _, err := pgxpool.ParseConfig(raw); err != nil {
		return fail()
	}
	return cfg, nil
}

func readPrivateURL(path string) ([]byte, error) {
	refused := errors.New("private provider refused")
	before, err := os.Lstat(path)
	if err != nil || !before.Mode().IsRegular() {
		return nil, refused
	}
	// NOFOLLOW prevents last-component substitution; NONBLOCK avoids hanging on
	// a FIFO swapped in between lstat/open. Validate the opened inode, not just path.
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, refused
	}
	f := os.NewFile(uintptr(fd), "private database configuration")
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || info.Mode()&(os.ModeSetuid|os.ModeSetgid|os.ModeSticky) != 0 || !os.SameFile(before, info) || info.Size() < 1 || info.Size() > maxDatabaseURLBytes {
		return nil, refused
	}
	owner, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !privateOwner(owner.Uid) {
		return nil, refused
	}
	data, err := io.ReadAll(io.LimitReader(f, maxDatabaseURLBytes+1))
	if err != nil || len(data) > maxDatabaseURLBytes || int64(len(data)) != info.Size() {
		return nil, refused
	}
	return data, nil
}
