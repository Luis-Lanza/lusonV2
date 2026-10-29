// Command recover-warehouse recovers only the existing protected administrator.
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/term"
	"luson/api/internal/auth"
	"luson/api/internal/config"
	"luson/api/internal/db"
)

const help = "Usage: recover-warehouse [--help|-h]\nRecover only the existing warehouse administrator using a private terminal.\nEnter and confirm a hidden temporary password (12–128 UTF-8 bytes, no NUL; spaces preserved).\nNo password arguments, environment input, account selection or public recovery.\nRequires private server database configuration and a complete migrated schema.\nAll warehouse sessions are retired; change the temporary password after login.\n"

func run() error {
	if len(os.Args) == 2 && (os.Args[1] == "--help" || os.Args[1] == "-h") {
		_, err := fmt.Fprint(os.Stdout, help)
		return err
	}
	if len(os.Args) != 1 {
		return errors.New("arguments are not accepted; use --help")
	}
	cfg, err := config.LoadEnv()
	if err != nil {
		return errors.New("invalid database configuration")
	}
	tty, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
	if err != nil {
		return errors.New("private terminal required")
	}
	defer tty.Close()
	fd := int(tty.Fd())
	if !term.IsTerminal(fd) {
		return errors.New("private terminal required")
	}
	state, err := term.GetState(fd)
	if err != nil {
		return errors.New("terminal unavailable")
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
			return "", errors.New("terminal input failed")
		}
		value, err := term.ReadPassword(fd)
		_, _ = fmt.Fprintln(tty)
		if err != nil {
			return "", errors.New("terminal input failed")
		}
		result := string(value)
		for i := range value {
			value[i] = 0
		}
		return result, nil
	}
	password, err := read("Temporary password (hidden): ")
	if err != nil {
		return err
	}
	confirmation, err := read("Confirm password (hidden): ")
	if err != nil {
		return err
	}
	if password != confirmation {
		return errors.New("password confirmation mismatch")
	}
	if !auth.ValidCredentials("valid", password) {
		return errors.New("password must contain 12–128 UTF-8 bytes without NUL")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return errors.New("database unavailable")
	}
	defer pool.Close()
	if err := db.Check(ctx, pool); err != nil {
		return errors.New("complete migrated schema required")
	}
	service, err := auth.New(pool, nil)
	if err != nil {
		return errors.New("warehouse recovery refused")
	}
	if err := service.RecoverWarehouseCredential(ctx, password); err != nil {
		return errors.New("warehouse recovery refused")
	}
	if _, err := fmt.Fprintln(tty, "Warehouse credential replaced. Log in and change the temporary password."); err != nil {
		return errors.New("credential replaced; terminal notification failed")
	}
	return nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
