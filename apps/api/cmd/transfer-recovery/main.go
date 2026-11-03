// Command transfer-recovery administratively recovers a transfer stuck in transit.
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/config"
	"luson/api/internal/db"
	"luson/api/internal/transfers"
)

const help = "Usage: transfer-recovery --request-id ID --received-at RFC3339 --receive VARIANT=QUANTITY ... --arrival VARIANT=QUANTITY ... --reason TEXT --operator LABEL [--help|-h]\nAdministratively complete an in-transit transfer whose physical arrival included a variant that was never dispatched.\nDeclared undispatched arrivals are recorded as audit-only evidence in transfer_recovery_events and never credited to any balance.\nDispatched variants are received exactly like a normal receipt: credit min(dispatched,observed) per variant.\nPrints the change summary, then requires the typed request reference before writing; any failure writes nothing.\nRequires private server database configuration. No HTTP route, no UI and no general inventory adjustment.\n"

// quantities is a repeatable VARIANT=QUANTITY flag; order is never significant.
type quantities []transfers.Line

func (q *quantities) String() string { return "" }
func (q *quantities) Set(raw string) error {
	variant, quantity, ok := strings.Cut(raw, "=")
	id, idErr := strconv.ParseInt(variant, 10, 64)
	value, valueErr := strconv.ParseInt(quantity, 10, 64)
	if !ok || idErr != nil || valueErr != nil {
		return errors.New("quantities must be VARIANT=QUANTITY")
	}
	*q = append(*q, transfers.Line{VariantID: id, Quantity: value})
	return nil
}

func list(lines []transfers.Line) string {
	parts := make([]string, len(lines))
	for i, line := range lines {
		parts[i] = fmt.Sprintf("%d=%d", line.VariantID, line.Quantity)
	}
	return strings.Join(parts, ",")
}

// confirm requires the exact request reference and never writes on refusal.
func confirm(in io.Reader, out io.Writer, reference string) error {
	if _, err := fmt.Fprintf(out, "Type %s to confirm: ", reference); err != nil {
		return errors.New("confirmation prompt failed")
	}
	line, err := bufio.NewReader(in).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return errors.New("confirmation input failed")
	}
	if strings.TrimRight(line, "\r\n") != reference {
		return errors.New("confirmation declined; nothing written")
	}
	return nil
}

func run() error {
	if len(os.Args) == 2 && (os.Args[1] == "--help" || os.Args[1] == "-h") {
		_, err := fmt.Fprint(os.Stdout, help)
		return err
	}
	var received, arrivals quantities
	fs := flag.NewFlagSet("transfer-recovery", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	fs.Usage = func() {}
	requestID := fs.Int64("request-id", 0, "")
	receivedAt := fs.String("received-at", "", "")
	reason := fs.String("reason", "", "")
	operator := fs.String("operator", "", "")
	fs.Var(&received, "receive", "")
	fs.Var(&arrivals, "arrival", "")
	if err := fs.Parse(os.Args[1:]); err != nil {
		return errors.New("invalid arguments; use --help")
	}
	if fs.NArg() != 0 || *requestID < 1 || len(received) == 0 || len(arrivals) == 0 ||
		strings.TrimSpace(*reason) == "" || strings.TrimSpace(*operator) == "" {
		return errors.New("invalid arguments; use --help")
	}
	observed, err := time.Parse(time.RFC3339, *receivedAt)
	if err != nil {
		return errors.New("invalid --received-at; use RFC3339")
	}
	cfg, err := config.LoadEnv()
	if err != nil {
		return errors.New("invalid database configuration")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return errors.New("database unavailable")
	}
	defer pool.Close()
	if err := db.Check(ctx, pool); err != nil {
		return errors.New("complete migrated schema required")
	}
	store := transfers.New(pool)
	preview, err := store.RecoveryPreview(ctx, *requestID)
	if err != nil {
		return errors.New("transfer recovery refused")
	}
	if preview.Status != "in_transit" {
		return errors.New("transfer is not in transit")
	}
	dispatched := make([]transfers.Line, len(preview.Items))
	for i, item := range preview.Items {
		dispatched[i] = transfers.Line{VariantID: item.VariantID, Quantity: item.Quantity}
	}
	summary := fmt.Sprintf("Recovery summary for %s (in_transit)\n  operator: %s\n  observed arrival: %s\n  dispatched: %s\n  observed: %s\n  undispatched arrivals (audit only, never credited): %s\n  reason: %s\nThis records %d audit event(s) and credits min(dispatched,observed) for the dispatched variants only.\n",
		preview.Reference, *operator, observed.UTC().Format(time.RFC3339), list(dispatched), list(received), list(arrivals), *reason, len(arrivals))
	if _, err := fmt.Fprint(os.Stdout, summary); err != nil {
		return errors.New("terminal notification failed")
	}
	if err := confirm(os.Stdin, os.Stdout, preview.Reference); err != nil {
		return err
	}
	got, err := store.Recover(ctx, *requestID, transfers.RecoveryInput{Items: received, Arrivals: arrivals, Reason: *reason, Operator: *operator, ReceivedAt: observed})
	if err != nil {
		return errors.New("transfer recovery failed; nothing was written")
	}
	credited := make([]transfers.Line, len(got.Receipt.Items))
	for i, line := range got.Receipt.Items {
		credited[i] = transfers.Line{VariantID: line.VariantID, Quantity: line.AvailableQuantity}
	}
	if _, err := fmt.Fprintf(os.Stdout, "Transfer %s received at %s. Credited: %s. Undispatched arrivals recorded for audit only: %s.\n",
		got.Reference, got.ReceivedAt.UTC().Format(time.RFC3339), list(credited), list(arrivals)); err != nil {
		return errors.New("terminal notification failed")
	}
	return nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
