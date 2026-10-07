package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"luson/api/internal/auth"
	"luson/api/internal/auth/testpg"
	"luson/api/internal/bootstrap"
	"luson/api/internal/config"
	"luson/api/internal/httpapi"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLoadServerBeforeTLS(t *testing.T) {
	old := os.Args
	os.Args = []string{"server"}
	defer func() { os.Args = old }()
	t.Setenv("LUSON_DATABASE_URL", "postgres://test:fixture-only@127.0.0.1:1/test")
	t.Setenv("LUSON_DATABASE_URL_FILE", "")
	t.Setenv("LUSON_PROFILE", "local-trial")
	if err := run(); err == nil || err.Error() != "invalid database configuration" {
		t.Fatal("duplicate providers must fail before TLS or database access")
	}
}

func TestAuthProductionTLSRefusal(t *testing.T) {
	previous := os.Args
	os.Args = []string{"server"}
	defer func() { os.Args = previous }()
	t.Setenv("LUSON_DATABASE_URL", "postgres://test:"+testpg.Random(t)+"@127.0.0.1:1/test")
	t.Setenv("LUSON_PROFILE", "production")
	t.Setenv("LUSON_ORIGIN", "https://example.test")
	t.Setenv("LUSON_LISTEN", "127.0.0.1:8443")
	t.Setenv("LUSON_TLS_CERT", "missing-test-certificate")
	t.Setenv("LUSON_TLS_KEY", "missing-test-key")
	err := run()
	if err == nil || !strings.Contains(err.Error(), "TLS certificate") {
		t.Fatal("production did not refuse unusable TLS before database startup")
	}
}

func TestAuthRuntimeTLS(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal("ephemeral key generation failed")
	}
	now := time.Now()
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "owned runtime test"},
		NotBefore: now.Add(-time.Minute), NotAfter: now.Add(time.Hour),
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1")},
		KeyUsage:    x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal("ephemeral certificate generation failed")
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal("ephemeral key encoding failed")
	}
	dir := t.TempDir()
	certPath, keyPath := filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	for path, data := range map[string][]byte{
		certPath: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		keyPath:  pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}),
	} {
		if os.WriteFile(path, data, 0600) != nil {
			t.Fatal("ephemeral TLS file write failed")
		}
	}
	p := testpg.Open(t)
	if bootstrap.Initialize(context.Background(), p, config.LocalTrial) != nil {
		t.Fatal("owned database initialization failed")
	}
	s, err := auth.New(p, nil)
	if err != nil {
		t.Fatal("authentication initialization failed")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal("owned listener failed")
	}
	t.Cleanup(func() { _ = listener.Close() })
	origin := "https://" + listener.Addr().String()
	cfg, err := config.ParseAuth(config.Production, origin, listener.Addr().String(), certPath, keyPath)
	if err != nil {
		t.Fatal("production TLS configuration refused")
	}
	tlsCfg, err := loadTLS(cfg) // Same file loading as run, not an httptest TLS toy.
	if err != nil {
		t.Fatal("runtime TLS loading failed")
	}
	server := &http.Server{Handler: httpapi.New(s, cfg), TLSConfig: tlsCfg, ReadHeaderTimeout: time.Second}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- serve(ctx, server, listener) }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Error("runtime transport shutdown failed")
			}
		case <-time.After(10 * time.Second):
			t.Error("runtime transport shutdown timed out")
		}
	})
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal("test trust certificate failed")
	}
	roots := x509.NewCertPool()
	roots.AddCert(cert)
	transport := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}}
	t.Cleanup(transport.CloseIdleConnections)
	client := &http.Client{Transport: transport, Timeout: 5 * time.Second}
	response, err := client.Get(origin + "/api/auth/session")
	if err != nil {
		t.Fatal("trusted runtime HTTPS session request failed")
	}
	defer response.Body.Close()
	var body map[string]any
	if json.NewDecoder(response.Body).Decode(&body) != nil || response.StatusCode != 200 || body["authenticated"] != false {
		t.Fatal("runtime HTTPS anonymous session contract failed")
	}
	if response.TLS == nil || len(response.TLS.VerifiedChains) == 0 || response.TLS.Version < tls.VersionTLS12 {
		t.Fatal("runtime connection lacks verified TLS")
	}
	cookies := response.Cookies()
	if len(cookies) != 1 || cookies[0].Name != "luson_prelogin" || !cookies[0].Secure || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode {
		t.Fatal("runtime HTTPS session cookie protection failed")
	}
}
