// Command server serves compiled public assets and the authentication/inventory API.
package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/bootstrap"
	"luson/api/internal/config"
	"luson/api/internal/httpapi"
	"luson/api/internal/inventory"
	"luson/api/internal/webui"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func run() error {
	if len(os.Args) != 1 {
		return errors.New("arguments are not accepted")
	}
	cfg, err := config.LoadEnv()
	if err != nil {
		return errors.New("invalid database configuration")
	}
	httpCfg, err := config.ParseAuth(cfg.Profile, os.Getenv("LUSON_ORIGIN"), os.Getenv("LUSON_LISTEN"), os.Getenv("LUSON_TLS_CERT"), os.Getenv("LUSON_TLS_KEY"))
	if err != nil {
		return err
	}
	tlsCfg, err := loadTLS(httpCfg)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	startup, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(startup, cfg.DatabaseURL)
	if err != nil {
		return errors.New("database unavailable")
	}
	defer pool.Close()
	if err := bootstrap.Initialize(startup, pool, cfg.Profile); err != nil {
		return errors.New("database initialization refused")
	}
	service, err := auth.New(pool, nil)
	if err != nil {
		return errors.New("authentication initialization failed")
	}
	handler, err := webui.New(os.Getenv("LUSON_WEB_DIR"), httpapi.New(service, httpCfg, inventory.New(pool)))
	if err != nil {
		return errors.New("invalid public asset directory")
	}
	server := &http.Server{Addr: httpCfg.Listen, Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 8192, TLSConfig: tlsCfg}
	listener, err := net.Listen("tcp", httpCfg.Listen)
	if err != nil {
		return errors.New("listener unavailable")
	}
	return serve(ctx, server, listener)
}

func loadTLS(cfg config.Auth) (*tls.Config, error) {
	if !cfg.Secure {
		return nil, nil
	}
	pair, err := tls.LoadX509KeyPair(cfg.TLSCert, cfg.TLSKey)
	if err != nil {
		return nil, errors.New("usable TLS certificate and key required")
	}
	return &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{pair}}, nil
}

// Shared runtime transport path permits testing with an owned ephemeral listener.
func serve(ctx context.Context, server *http.Server, listener net.Listener) error {
	if server.TLSConfig != nil {
		listener = tls.NewListener(listener, server.TLSConfig)
	}
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			shutdown, release := context.WithTimeout(context.Background(), 5*time.Second)
			defer release()
			_ = server.Shutdown(shutdown)
		case <-done:
		}
	}()
	err := server.Serve(listener)
	close(done)
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		return errors.New("HTTP server stopped unexpectedly")
	}
	return nil
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
