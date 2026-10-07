// Command migrate initializes or verifies the L01 data foundation.
package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/bootstrap"
	"luson/api/internal/config"
	"luson/api/internal/db"
)

func main() { os.Exit(run()) }
func run() int {
	if len(os.Args) != 2 || (os.Args[1] != "initialize" && os.Args[1] != "check") {
		fmt.Fprintln(os.Stderr, "usage: migrate initialize|check")
		return 2
	}
	settings, err := config.LoadEnv()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, settings.DatabaseURL)
	if err != nil {
		fmt.Fprintln(os.Stderr, "database configuration could not be opened")
		return 1
	}
	defer pool.Close()
	if os.Args[1] == "initialize" {
		err = bootstrap.Initialize(ctx, pool, settings.Profile)
	} else {
		err = db.Check(ctx, pool)
		if err == nil {
			err = bootstrap.Check(ctx, pool)
		}
	}
	if err != nil {
		// Driver errors can contain connection data or SQL values. Do not echo them.
		fmt.Fprintln(os.Stderr, "database operation failed; verify connectivity, schema and dataset integrity privately")
		return 1
	}
	fmt.Fprintln(os.Stdout, "data foundation "+os.Args[1]+" succeeded")
	return 0
}
