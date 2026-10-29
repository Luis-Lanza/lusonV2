//go:build linux

package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
	"golang.org/x/term"
	"luson/api/internal/auth"
	"luson/api/internal/bootstrap"
	"luson/api/internal/config"
	"luson/api/internal/testpg"
)

// Run the actual command entry point in a new process, never the human TTY.
func TestT7CommandProcess(t *testing.T) {
	if os.Getenv("T7_COMMAND_PROCESS") != "1" {
		return
	}
	os.Args = append([]string{"recover-warehouse"}, os.Args[3:]...)
	main()
	os.Exit(0)
}

const usage = "Usage: recover-warehouse [--help|-h]\nRecover only the existing warehouse administrator using a private terminal.\nEnter and confirm a hidden temporary password (12–128 UTF-8 bytes, no NUL; spaces preserved).\nNo password arguments, environment input, account selection or public recovery.\nRequires private server database configuration and a complete migrated schema.\nAll warehouse sessions are retired; change the temporary password after login.\n"

func command(t *testing.T, dsn string, args ...string) (*exec.Cmd, *bytes.Buffer, *bytes.Buffer) {
	t.Helper()
	cmd := exec.CommandContext(context.Background(), os.Args[0], append([]string{"-test.run=^TestT7CommandProcess$", "--"}, args...)...)
	cmd.Env = []string{"T7_COMMAND_PROCESS=1", "LUSON_PROFILE=local-trial", "LUSON_DATABASE_URL=" + dsn}
	out, errout := new(bytes.Buffer), new(bytes.Buffer)
	cmd.Stdout = out
	cmd.Stderr = errout
	return cmd, out, errout
}

func exitCode(err error) int {
	if err == nil {
		return 0
	}
	if e, ok := err.(*exec.ExitError); ok {
		return e.ExitCode()
	}
	return -1
}

func TestT7CommandPublicErrors(t *testing.T) {
	for _, tc := range []struct {
		args     []string
		code     int
		out, err string
	}{
		{[]string{"--help"}, 0, usage, ""}, {[]string{"-h"}, 0, usage, ""},
		{[]string{"attacker-secret"}, 1, "", "arguments are not accepted; use --help\n"},
		{[]string{"--help", "attacker-secret"}, 1, "", "arguments are not accepted; use --help\n"},
		{nil, 1, "", "invalid database configuration\n"},
	} {
		cmd, out, errout := command(t, "invalid-config-secret", tc.args...)
		cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
		err := cmd.Run()
		if exitCode(err) != tc.code || out.String() != tc.out || errout.String() != tc.err {
			t.Errorf("public command contract: exit=%d stdout=%q stderr=%q", exitCode(err), out.String(), errout.String())
		}
	}
	cmd, out, errout := command(t, "postgres://fixture:fixture@127.0.0.1:1/fixture")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Run(); exitCode(err) != 1 || out.Len() != 0 || errout.String() != "private terminal required\n" {
		t.Fatal("terminal rejection contract")
	}
}

// A fresh kernel PTY is owned by each case; synchronize on prompts AND echo-off
// before sending input, so the test itself cannot introduce an echo race.
func privateCommand(t *testing.T, dsn, password, confirmation string, interrupt bool) (int, string, string, string) {
	t.Helper()
	fd, err := unix.Open("/dev/ptmx", unix.O_RDWR|unix.O_NOCTTY|unix.O_CLOEXEC, 0)
	if err != nil {
		t.Fatal("PTY unavailable")
	}
	master := os.NewFile(uintptr(fd), "owned test PTY")
	defer master.Close()
	if err := unix.IoctlSetPointerInt(fd, unix.TIOCSPTLCK, 0); err != nil {
		t.Fatal("PTY unlock failed")
	}
	n, err := unix.IoctlGetInt(fd, unix.TIOCGPTN)
	if err != nil {
		t.Fatal("PTY number failed")
	}
	slave, err := os.OpenFile(fmt.Sprintf("/dev/pts/%d", n), os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		t.Fatal("PTY slave failed")
	}
	defer slave.Close()
	original, err := term.GetState(int(slave.Fd()))
	if err != nil {
		t.Fatal("PTY state failed")
	}
	cmd, out, errout := command(t, dsn)
	cmd.Stdin = slave
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}
	if err := cmd.Start(); err != nil {
		t.Fatal("command start failed")
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	chunks := make(chan string, 32)
	go func() {
		b := make([]byte, 512)
		for {
			n, e := master.Read(b)
			if n > 0 {
				chunks <- string(b[:n])
			}
			if e != nil {
				return
			}
		}
	}()
	transcript := ""
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	sent := 0
	for {
		select {
		case chunk := <-chunks:
			transcript += chunk
		case err := <-done:
			// Drain currently queued terminal output after process exit.
			for {
				select {
				case c := <-chunks:
					transcript += c
				default:
					goto drained
				}
			}
		drained:
			state, e := unix.IoctlGetTermios(int(slave.Fd()), unix.TCGETS)
			if e != nil || state.Lflag&unix.ECHO == 0 {
				t.Fatal("terminal echo not restored")
			}
			_ = term.Restore(int(slave.Fd()), original)
			for _, secret := range []string{password, confirmation} {
				if secret != "" && (strings.Contains(transcript, secret) || strings.Contains(out.String(), secret) || strings.Contains(errout.String(), secret)) {
					t.Fatal("private input disclosed")
				}
			}
			return exitCode(err), out.String(), errout.String(), transcript
		case <-timer.C:
			_ = cmd.Process.Kill()
			<-done
			t.Fatal("private command did not complete")
		}
		prompt := "Temporary password (hidden): "
		if sent == 1 {
			prompt = "Confirm password (hidden): "
		}
		if sent < 2 && strings.Contains(transcript, prompt) {
			deadline := time.Now().Add(time.Second)
			for {
				state, e := unix.IoctlGetTermios(int(slave.Fd()), unix.TCGETS)
				if e == nil && state.Lflag&unix.ECHO == 0 {
					break
				}
				if time.Now().After(deadline) {
					_ = cmd.Process.Kill()
					<-done
					t.Fatal("hidden input not enabled")
				}
				time.Sleep(time.Millisecond)
			}
			if interrupt {
				_ = cmd.Process.Signal(os.Interrupt)
				sent = 2
				continue
			}
			value := password
			if sent == 1 {
				value = confirmation
			}
			if _, err := io.WriteString(master, value+"\n"); err != nil {
				t.Fatal("PTY input failed")
			}
			sent++
		}
	}
}

func TestT7CommandPrivateRecovery(t *testing.T) {
	ctx := context.Background()
	p := testpg.Open(t)
	if err := bootstrap.Initialize(ctx, p, config.LocalTrial); err != nil {
		t.Fatal("initialize failed")
	}
	creds := []bootstrap.Credentials{{Username: "warehouse", Password: "old warehouse password"}, {Username: "operator_a", Password: "operator a password"}, {Username: "operator_b", Password: "operator b password"}}
	if err := bootstrap.Provision(ctx, p, creds); err != nil {
		t.Fatal("provision failed")
	}
	s, err := auth.New(p, nil)
	if err != nil {
		t.Fatal("service failed")
	}
	_, old, err := s.Login(ctx, "warehouse", creds[0].Password, "127.0.0.1", "")
	if err != nil {
		t.Fatal("login failed")
	}
	// ConnString retains the admission connection's original database; build
	// configuration only from the owned pool's live randomized target fields.
	cfg := p.Config().ConnConfig
	u := url.URL{Scheme: "postgres", User: url.UserPassword(cfg.User, cfg.Password), Host: net.JoinHostPort(cfg.Host, strconv.Itoa(int(cfg.Port))), Path: "/" + cfg.Database, RawQuery: "sslmode=disable"}
	dsn := u.String()
	for _, tc := range []struct {
		password, confirmation, message string
		interrupt                       bool
	}{
		{"private password one", "private password two", "password confirmation mismatch\n", false},
		{"short", "short", "password must contain 12–128 UTF-8 bytes without NUL\n", false},
		{"interrupted private password", "interrupted private password", "", true},
	} {
		code, out, errout, _ := privateCommand(t, dsn, tc.password, tc.confirmation, tc.interrupt)
		if code != 1 || out != "" || errout != tc.message {
			t.Fatal("private rejection output contract")
		}
		if _, _, err := s.Peek(ctx, old); err != nil {
			t.Fatal("rejection retired authority")
		}
	}
	temporary := " private temporary password "
	code, out, errout, _ := privateCommand(t, dsn, temporary, temporary, false)
	if code != 0 || out != "" || errout != "" {
		t.Fatal("private success output contract")
	}
	if _, _, err := s.Peek(ctx, old); err != auth.ErrSession {
		t.Fatal("CLI did not retire old session")
	}
	if _, _, err := s.Login(ctx, "warehouse", creds[0].Password, "127.0.0.2", ""); err != auth.ErrCredentials {
		t.Fatal("CLI retained old password")
	}
	session, token, err := s.Login(ctx, "warehouse", temporary, "127.0.0.3", "")
	if err != nil || !session.Identity.MustChangePassword {
		t.Fatal("CLI temporary credential failed")
	}
	if err := s.Administrator(ctx, token); err != auth.ErrAdminForbidden {
		t.Fatal("CLI bypassed forced-change gate")
	}
}
