package main

import (
	"bytes"
	"context"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	"luson/api/internal/auth"
	"luson/api/internal/bootstrap"
	"luson/api/internal/config"
	"luson/api/internal/testpg"
	"luson/api/internal/transfers"
)

// Run the actual command entry point in a new process, never the test stdin.
func TestRecoveryCommandProcess(t *testing.T) {
	if os.Getenv("TRANSFER_RECOVERY_PROCESS") != "1" {
		return
	}
	os.Args = append([]string{"transfer-recovery"}, os.Args[3:]...)
	main()
	os.Exit(0)
}

func command(t *testing.T, dsn, input string, args ...string) (int, string, string) {
	t.Helper()
	cmd := exec.Command(os.Args[0], append([]string{"-test.run=^TestRecoveryCommandProcess$", "--"}, args...)...)
	cmd.Env = []string{"TRANSFER_RECOVERY_PROCESS=1", "LUSON_PROFILE=local-trial", "LUSON_DATABASE_URL=" + dsn}
	cmd.Stdin = strings.NewReader(input)
	out, errout := new(bytes.Buffer), new(bytes.Buffer)
	cmd.Stdout, cmd.Stderr = out, errout
	err := cmd.Run()
	code := 0
	if e, ok := err.(*exec.ExitError); ok {
		code = e.ExitCode()
	} else if err != nil {
		t.Fatal("command process failed")
	}
	return code, out.String(), errout.String()
}

func TestRecoveryCommandArguments(t *testing.T) {
	for _, tc := range []struct {
		name, dsn string
		args      []string
		code      int
		out, err  string
	}{
		{"help", "unused", []string{"--help"}, 0, help, ""},
		{"short_help", "unused", []string{"-h"}, 0, help, ""},
		{"unknown_flag", "unused", []string{"--request-id", "1", "--attacker-secret"}, 1, "", "flag provided but not defined: -attacker-secret\ninvalid arguments; use --help\n"},
		{"no_arguments", "unused", nil, 1, "", "invalid arguments; use --help\n"},
		{"missing_arrival", "unused", []string{"--request-id", "1", "--received-at", "2026-11-03T10:00:00Z", "--receive", "1=2", "--reason", "why", "--operator", "op"}, 1, "", "invalid arguments; use --help\n"},
		{"bad_quantity", "unused", []string{"--request-id", "1", "--received-at", "2026-11-03T10:00:00Z", "--receive", "1=x", "--arrival", "3=5", "--reason", "why", "--operator", "op"}, 1, "", "invalid value \"1=x\" for flag -receive: quantities must be VARIANT=QUANTITY\ninvalid arguments; use --help\n"},
		{"bad_received_at", "unused", []string{"--request-id", "1", "--received-at", "yesterday", "--receive", "1=2", "--arrival", "3=5", "--reason", "why", "--operator", "op"}, 1, "", "invalid --received-at; use RFC3339\n"},
		{"private_configuration", "invalid-config-secret", []string{"--request-id", "1", "--received-at", "2026-11-03T10:00:00Z", "--receive", "1=2", "--arrival", "3=5", "--reason", "why", "--operator", "op"}, 1, "", "invalid database configuration\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			code, out, errout := command(t, tc.dsn, "", tc.args...)
			if code != tc.code || out != tc.out || errout != tc.err {
				t.Fatalf("command contract: exit=%d stdout=%q stderr=%q", code, out, errout)
			}
			if tc.name == "private_configuration" && strings.Contains(errout, "invalid-config-secret") {
				t.Fatal("configuration secret disclosed")
			}
		})
	}
}

// The confirmation gate names the persisted request and must refuse a wrong
// answer before any write, leaving the transfer in transit.
func TestRecoveryCommandConfirmation(t *testing.T) {
	ctx := context.Background()
	p := testpg.Open(t)
	if err := bootstrap.Initialize(ctx, p, config.LocalTrial); err != nil {
		t.Fatal("initialize failed")
	}
	creds := []bootstrap.Credentials{{Username: "warehouse", Password: "warehouse password"}, {Username: "branch_a", Password: "branch a password"}, {Username: "branch_b", Password: "branch b password"}}
	if err := bootstrap.Provision(ctx, p, creds); err != nil {
		t.Fatal("provision failed")
	}
	branch, warehouse := auth.Identity{AccountID: 2, Location: auth.Location{ID: 2}}, auth.Identity{AccountID: 1, Location: auth.Location{ID: 1}}
	s := transfers.New(p)
	created, err := s.Create(ctx, branch, transfers.CreateInput{Kind: transfers.RequestStock, CounterpartyID: 1, RetryKey: "recovery-command-key-0001", Items: []transfers.Line{{VariantID: 1, Quantity: 2}, {VariantID: 2, Quantity: 1}}})
	if err != nil {
		t.Fatal("creation failed")
	}
	if _, err = s.Approve(ctx, warehouse, created.Request.ID); err != nil {
		t.Fatal("approval failed")
	}
	dispatched, err := s.Dispatch(ctx, warehouse, created.Request.ID)
	if err != nil {
		t.Fatal("dispatch failed")
	}
	cfg := p.Config().ConnConfig
	u := url.URL{Scheme: "postgres", User: url.UserPassword(cfg.User, cfg.Password), Host: net.JoinHostPort(cfg.Host, strconv.Itoa(int(cfg.Port))), Path: "/" + cfg.Database, RawQuery: "sslmode=disable"}
	args := []string{"--request-id", strconv.FormatInt(dispatched.ID, 10), "--received-at", time.Now().UTC().Format(time.RFC3339), "--receive", "1=2", "--receive", "2=0", "--arrival", "3=5", "--reason", "arrived but was never dispatched", "--operator", "operator-a"}
	code, out, errout := command(t, u.String(), "TR-999\n", args...)
	if code != 1 || errout != "confirmation declined; nothing written\n" || !strings.HasPrefix(out, fmt.Sprintf("Recovery summary for %s (in_transit)", dispatched.Reference)) || !strings.HasSuffix(out, fmt.Sprintf("Type %s to confirm: ", dispatched.Reference)) {
		t.Fatalf("confirmation gate: exit=%d stdout=%q stderr=%q", code, out, errout)
	}
	if got, err := s.Get(ctx, branch, dispatched.ID); err != nil || got.Status != "in_transit" {
		t.Fatal("refused confirmation wrote the recovery", err)
	}
	var events int
	if p.QueryRow(ctx, "SELECT count(*) FROM transfer_recovery_events").Scan(&events) != nil || events != 0 {
		t.Fatal("refused confirmation recorded evidence")
	}
	code, out, errout = command(t, u.String(), dispatched.Reference+"\n", args...)
	if code != 0 || errout != "" || !strings.Contains(out, fmt.Sprintf("Transfer %s received at ", dispatched.Reference)) {
		t.Fatalf("confirmed recovery: exit=%d stdout=%q stderr=%q", code, out, errout)
	}
	if got, err := s.Get(ctx, branch, dispatched.ID); err != nil || got.Status != "received" || got.ReceiptLocationID == nil || *got.ReceiptLocationID != branch.Location.ID {
		t.Fatal("confirmed recovery did not complete the receipt", err)
	}
	if p.QueryRow(ctx, "SELECT count(*) FROM transfer_recovery_events WHERE request_id=$1 AND variant_id=3 AND quantity=5", dispatched.ID).Scan(&events) != nil || events != 1 {
		t.Fatal("confirmed recovery did not record the audit evidence")
	}
}
