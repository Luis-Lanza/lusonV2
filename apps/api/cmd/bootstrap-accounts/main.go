// Command bootstrap-accounts reads human credentials only from a private TTY.
package main

import (
	"context"
	"fmt"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/term"
	"luson/api/internal/bootstrap"
	"luson/api/internal/catalog"
	"luson/api/internal/config"
	"luson/api/internal/db"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func run() error {
	if len(os.Args) != 1 {
		return fmt.Errorf("arguments are not accepted")
	}
	cfg, err := config.LoadEnv()
	if err != nil {
		return fmt.Errorf("invalid database configuration")
	}
	tty, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
	if err != nil {
		return fmt.Errorf("private terminal required")
	}
	defer tty.Close()
	fd := int(tty.Fd())
	if !term.IsTerminal(fd) {
		return fmt.Errorf("private terminal required")
	}
	state, err := term.GetState(fd)
	if err != nil {
		return fmt.Errorf("terminal unavailable")
	}
	defer term.Restore(fd, state)
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	finished := make(chan struct{})
	defer close(finished)
	go func() {
		select {
		case <-signals:
			_ = term.Restore(fd, state)
			os.Exit(1)
		case <-finished:
		}
	}()
	read := func(prompt string) (string, error) {
		if _, err := fmt.Fprint(tty, prompt); err != nil {
			return "", err
		}
		value, err := term.ReadPassword(fd)
		_, _ = fmt.Fprintln(tty)
		if err != nil {
			return "", fmt.Errorf("terminal input failed")
		}
		result := string(value)
		for i := range value {
			value[i] = 0
		}
		return result, nil
	}
	credentials := make([]bootstrap.Credentials, 3)
	for i, location := range catalog.Locations() {
		username, err := read(location.Name + " username (hidden): ")
		if err != nil {
			return err
		}
		password, err := read(location.Name + " password (hidden): ")
		if err != nil {
			return err
		}
		confirmation, err := read("Confirm password (hidden): ")
		if err != nil {
			return err
		}
		if password != confirmation {
			return fmt.Errorf("password confirmation mismatch")
		}
		credentials[i] = bootstrap.Credentials{Username: username, Password: password}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("database unavailable")
	}
	defer pool.Close()
	// The data initializer is a separate explicit operation. This CLI never seeds.
	if err := db.Check(ctx, pool); err != nil {
		return fmt.Errorf("complete migrated schema required")
	}
	if err := bootstrap.Provision(ctx, pool, credentials); err != nil {
		return fmt.Errorf("provisioning refused; check credential rules and existing account state privately")
	}
	fmt.Fprintln(tty, "Three accounts provisioned.")
	return nil
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
