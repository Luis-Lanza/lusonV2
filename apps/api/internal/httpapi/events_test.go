package httpapi

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/config"
	"luson/api/internal/inventory"
	"luson/api/internal/realtime"
	"luson/api/internal/testpg"
	"luson/api/internal/transfers"
)

func TestR03RealtimeConstructor(t *testing.T) {
	cfg := transferConfig(t)
	for mask := 1; mask < 16; mask++ {
		svc := &auth.Service{}
		stock := inventory.New(&pgxpool.Pool{})
		requests := transfers.New(&pgxpool.Pool{})
		broker := &realtime.Broker{}
		if mask&1 != 0 {
			svc = nil
		}
		if mask&2 != 0 {
			stock = nil
		}
		if mask&4 != 0 {
			requests = nil
		}
		if mask&8 != 0 {
			broker = nil
		}
		h, err := NewWithRealtime(svc, cfg, stock, requests, broker)
		if err == nil || h != nil {
			t.Fatal("required nil dependency accepted")
		}
	}
	svc := &auth.Service{}
	stock := inventory.New(&pgxpool.Pool{})
	requests := transfers.New(&pgxpool.Pool{})
	broker := &realtime.Broker{}
	if h, err := NewWithRealtime(svc, transferConfig(t), stock, requests, broker); h == nil || err != nil {
		t.Fatal("explicit constructor unavailable")
	}
	if h, err := NewWithRealtime(svc, config.Auth{}, stock, requests, broker); h != nil || err == nil {
		t.Fatal("invalid configuration accepted")
	}
	transferHandler, err := NewWithTransfers(svc, cfg, stock, requests)
	if err != nil {
		t.Fatal("legacy checked constructor failed")
	}
	for _, h := range []http.Handler{New(nil, cfg), New(nil, cfg, inventory.New(nil)), transferHandler} {
		for _, method := range []string{"GET", "POST", "HEAD"} {
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest(method, "/api/events", nil))
			if w.Code != 404 {
				t.Fatal("legacy event route unexpectedly enabled")
			}
		}
	}
	t.Run("transport_capabilities_and_boundaries", func(t *testing.T) {
		if eventCapabilities(httptest.NewRecorder()) || eventCapabilities(&plainEventWriter{}) || eventCapabilities(&cycleEventWriter{}) {
			t.Fatal("unsupported/cyclic writer passed capabilities")
		}
		target := &controlledEventWriter{header: make(http.Header)}
		if !eventCapabilities(target) || !eventCapabilities(&wrappedEventWriter{target}) {
			t.Fatal("supported wrapped writer rejected")
		}
		rc := http.NewResponseController(target)
		if !streamWrite(target, rc, "event: resync\ndata: {}\n\n") || len(target.deadlines) != 2 || target.deadlines[0].IsZero() || !target.deadlines[1].IsZero() {
			t.Fatal("per-write deadline/clear contract failed")
		}
		for _, mode := range []string{"write", "flush", "deadline", "short"} {
			w := &controlledEventWriter{header: make(http.Header), fail: mode}
			if streamWrite(w, http.NewResponseController(w), "event: resync\ndata: {}\n\n") {
				t.Fatal("runtime transport error ignored")
			}
		}
	})
}

type eventEnvironment struct {
	f            *transferHTTPFixture
	broker       *realtime.Broker
	listenerName string
}

func eventFixture(t *testing.T) *eventEnvironment {
	t.Helper()
	f := transferFixture(t)
	// Only this own database adopts a realistic wallclock for route expiry timers.
	now := time.Now().UTC().Truncate(time.Microsecond)
	f.clock.Store(now.UnixNano())
	if _, err := f.p.Exec(f.ctx, "UPDATE auth_sessions SET created_at=$1,last_seen_at=$1,idle_deadline=$2,absolute_deadline=$3", now, now.Add(auth.IdleTTL), now.Add(auth.AbsoluteTTL)); err != nil {
		t.Fatal("owned stream clock setup failed")
	}
	cfg := f.p.Config().Copy()
	name := "events_listener_" + testpg.Random(t)[:20]
	cfg.ConnConfig.RuntimeParams["application_name"] = name
	listenerPool, err := pgxpool.NewWithConfig(f.ctx, cfg)
	if err != nil {
		t.Fatal("listener configuration copy failed")
	}
	t.Cleanup(listenerPool.Close)
	broker, err := realtime.New(listenerPool)
	if err != nil || broker.Start(f.ctx) != nil {
		t.Fatal("event broker startup failed")
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
		defer cancel()
		if broker.Shutdown(ctx) != nil {
			t.Error("event broker failed to join")
		}
	})
	f.handler, err = NewWithRealtime(f.svc, f.cfg, inventory.New(f.p), transfers.New(f.p), broker)
	if err != nil {
		t.Fatal("event constructor failed")
	}
	return &eventEnvironment{f, broker, name}
}
func eventServer(t *testing.T, env *eventEnvironment) *httptest.Server {
	t.Helper()
	server := httptest.NewUnstartedServer(env.f.handler)
	server.Config.WriteTimeout = 15 * time.Second
	server.Config.ReadHeaderTimeout = 5 * time.Second
	server.Start()
	t.Cleanup(server.Close)
	return server
}

type eventClient struct {
	response *http.Response
	reader   *bufio.Reader
	cancel   context.CancelFunc
}

func openEvents(t *testing.T, env *eventEnvironment, server *httptest.Server, actor int, lastID string) *eventClient {
	t.Helper()
	ctx, cancel := context.WithTimeout(env.f.ctx, 40*time.Second)
	r, err := http.NewRequestWithContext(ctx, "GET", server.URL+"/api/events", nil)
	if err != nil {
		cancel()
		t.Fatal("stream request construction failed")
	}
	r.AddCookie(&http.Cookie{Name: sessionCookie, Value: env.f.tokens[actor-1]})
	if lastID != "" {
		r.Header.Set("Last-Event-ID", lastID)
	}
	response, err := server.Client().Do(r)
	if err != nil {
		cancel()
		t.Fatal("event HTTP request failed")
	}
	if response.StatusCode != 200 || response.Header.Get("Content-Type") != "text/event-stream" || response.Header.Get("Cache-Control") != "no-store, no-transform" || response.Header.Get("X-Content-Type-Options") != "nosniff" || response.Header.Get("Access-Control-Allow-Origin") != "" || len(response.Cookies()) != 0 {
		response.Body.Close()
		cancel()
		t.Fatal("authenticated stream headers/status changed")
	}
	client := &eventClient{response, bufio.NewReaderSize(response.Body, 256), cancel}
	t.Cleanup(client.close)
	return client
}
func (c *eventClient) close() { c.cancel(); _ = c.response.Body.Close() }
func (c *eventClient) frame() (string, error) {
	var b strings.Builder
	for i := 0; i < 8; i++ {
		line, err := c.reader.ReadString('\n')
		if err != nil {
			return "", err
		}
		if b.Len()+len(line) > 512 {
			return "", errors.New("oversized event frame")
		}
		b.WriteString(line)
		if line == "\n" {
			return b.String(), nil
		}
	}
	return "", errors.New("too many event lines")
}
func expectHTTPEvent(t *testing.T, c *eventClient, want string) {
	t.Helper()
	for i := 0; i < 8; i++ {
		frame, err := c.frame()
		if err != nil {
			t.Fatal("expected HTTP event unavailable")
		}
		if frame == ": heartbeat\n\n" {
			continue
		}
		if frame != "event: "+want+"\ndata: {}\n\n" {
			t.Fatal("public SSE kind/data/privacy framing changed")
		}
		return
	}
	t.Fatal("HTTP event absent behind heartbeats")
}
func expectStreamClosed(t *testing.T, c *eventClient, budget time.Duration) {
	t.Helper()
	done := make(chan struct{})
	go func() { _, _ = io.Copy(io.Discard, c.reader); close(done) }()
	timer := time.NewTimer(budget)
	defer timer.Stop()
	select {
	case <-done:
		return
	case <-timer.C:
		c.close()
		<-done
		t.Fatal("stream closure exceeded bounded detection budget")
	}
}
func eventBoundary(t *testing.T, env *eventEnvironment, clients []*eventClient, expected [][]string) {
	t.Helper()
	if _, err := env.f.p.Exec(env.f.ctx, "SELECT pg_notify('luson_realtime','inventory:0')"); err != nil {
		t.Fatal("ordered event test barrier failed")
	}
	for i, client := range clients {
		for _, kind := range expected[i] {
			expectHTTPEvent(t, client, kind)
		}
		expectHTTPEvent(t, client, "inventory")
	}
}
func TestR03Events(t *testing.T) {
	root := t
	t.Run("initial_resync_commit_privacy_replay_rollback", func(t *testing.T) {
		env := eventFixture(t)
		registerTransferAudit(root, env.f.p)
		server := eventServer(t, env)
		before := passiveState(t, env.f)
		env.f.clock.Add(int64(2 * time.Minute))
		clients := make([]*eventClient, 3)
		for i := range clients {
			clients[i] = openEvents(t, env, server, i+1, "ignored-not-an-authority")
			expectHTTPEvent(t, clients[i], "resync")
		}
		if passiveState(t, env.f) != before {
			t.Fatal("SSE initial authorization/probe used touching Current")
		}
		for _, tc := range []struct {
			kind         string
			counterparty int
			affected     []int
		}{{"request_stock", 1, []int{0, 1}}, {"request_stock", 3, []int{1, 2}}, {"send_to_warehouse", 1, []int{0, 1}}} {
			body := strings.Replace(validTransferJSON, "request_stock", tc.kind, 1)
			if tc.counterparty == 3 {
				body = strings.Replace(body, `"counterparty_location_id":1`, `"counterparty_location_id":3`, 1)
			}
			body = strings.Replace(body, "http-retry-key-00001", "http-events-key-"+tc.kind+string(rune('0'+tc.counterparty)), 1)
			// Create through the real guarded HTTP->Store->committed NOTIFY chain.
			created := transferWireRecord(t, env.f.request(t, 2, "POST", "/api/transfers", body), 201)
			expected := make([][]string, 3)
			for _, i := range tc.affected {
				expected[i] = []string{"transfers"}
			}
			eventBoundary(t, env, clients, expected)
			replay := transferWireRecord(t, env.f.request(t, 2, "POST", "/api/transfers", body), 200)
			if replay.ID != created.ID {
				t.Fatal("HTTP retry changed durable request")
			}
			eventBoundary(t, env, clients, make([][]string, 3))
		}
		// An own transaction header queues metadata but rollback must remain silent.
		tx, err := env.f.p.Begin(env.f.ctx)
		if err != nil {
			t.Fatal("owned event rollback transaction failed")
		}
		if _, err := tx.Exec(env.f.ctx, `INSERT INTO transfer_requests(creator_location_id,kind,origin_location_id,destination_location_id,approver_location_id,retry_key,payload_sha256) VALUES(2,'request_stock',1,2,1,'http-events-rollback-key',decode(repeat('00',32),'hex'))`); err != nil {
			t.Fatal("owned rollback header failed")
		}
		_ = tx.Rollback(env.f.ctx)
		eventBoundary(t, env, clients, make([][]string, 3))
		// POST legitimately touched Current; SSE must not renew beyond that touch.
		before = passiveState(t, env.f)
		env.f.clock.Add(int64(2 * time.Minute))
		eventBoundary(t, env, clients, make([][]string, 3))
		if passiveState(t, env.f) != before {
			t.Fatal("SSE validations renewed idle authority")
		}
		env.f.unchanged(t)
		if env.broker.Shutdown(context.Background()) != nil {
			t.Fatal("lifetime broker shutdown failed")
		}
		for _, client := range clients {
			expectStreamClosed(t, client, 5*time.Second)
		}
	})
	t.Run("guards_and_capabilities", testEventGuards)
	for _, mode := range []string{"revoked", "idle_expired", "absolute_deadline_wake", "idle_deadline_wake", "peek_stall"} {
		t.Run(mode, func(t *testing.T) { testEventAuthLoss(t, mode) })
	}
	t.Run("listener_loss_reconnect_resync", testEventRecovery)
	t.Run("write_timeout_15s_route_survives_16s", testEventLongLived)
	t.Run("bounded_slow_writer_and_subscriber_cleanup", testEventSlowWriter)
}
func testEventGuards(t *testing.T) {
	env := eventFixture(t)
	f := env.f
	for _, verb := range []string{"POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"} {
		w := f.request(t, 2, verb, "/api/events", "")
		expectTransferError(t, w, 405, "method_not_allowed")
		if w.Header().Get("Allow") != "GET" {
			t.Fatal("SSE Allow changed")
		}
	}
	expectTransferError(t, f.request(t, 0, "GET", "/api/events", ""), 401, "unauthenticated")
	for _, query := range []string{"?", "?page=1", "?token=ignored", "?%ZZ"} {
		expectTransferError(t, f.request(t, 2, "GET", "/api/events"+query, ""), 400, "invalid_request")
	}
	for _, path := range []string{"/api/events/", "/api/events//", "/api/events/../inventory", "/api/./events", "/api//events"} {
		if f.request(t, 2, "GET", path, "").Code != 404 {
			t.Fatal("unsafe SSE path redirected or accepted")
		}
	}
	for _, path := range []string{"/api/%65vents", "/%61pi/events"} {
		expectTransferError(t, f.request(t, 2, "GET", path, ""), 400, "invalid_request")
	}
	for _, tc := range []struct {
		header string
		values []string
		status int
		code   string
	}{
		{"Origin", []string{"https://evil.test"}, 403, "forbidden"}, {"Origin", []string{f.cfg.Origin, f.cfg.Origin}, 403, "forbidden"}, {"Origin", []string{""}, 403, "forbidden"},
		{"Sec-Fetch-Site", []string{"same-site"}, 403, "forbidden"}, {"Sec-Fetch-Site", []string{"cross-site"}, 403, "forbidden"}, {"Sec-Fetch-Site", []string{"same-origin", "same-origin"}, 403, "forbidden"},
		{passiveHeader, []string{""}, 400, "invalid_request"}, {passiveHeader, []string{"1", "1"}, 400, "invalid_request"}, {"Last-Event-ID", []string{strings.Repeat("x", 129)}, 400, "invalid_request"}, {"Last-Event-ID", []string{"1", "2"}, 400, "invalid_request"},
	} {
		r := f.newRequest(2, "GET", "/api/events", "")
		r.Header.Del(tc.header)
		for _, value := range tc.values {
			r.Header.Add(tc.header, value)
		}
		expectTransferError(t, f.serve(t, r), tc.status, tc.code)
	}
	r := f.newRequest(2, "GET", "/api/events", "")
	r.AddCookie(&http.Cookie{Name: sessionCookie, Value: f.tokens[1]})
	expectTransferError(t, f.serve(t, r), 400, "invalid_request")
	r = f.newRequest(0, "GET", "/api/events", "")
	r.AddCookie(&http.Cookie{Name: sessionCookie, Value: "invalid"})
	expectTransferError(t, f.serve(t, r), 401, "unauthenticated")
	// Recorder has Flush but no deadline support: no stream/private bytes begin.
	expectTransferError(t, f.request(t, 2, "GET", "/api/events", ""), 503, "service_unavailable")
	zero, err := NewWithRealtime(f.svc, f.cfg, inventory.New(f.p), transfers.New(f.p), &realtime.Broker{})
	if err != nil {
		t.Fatal("opaque zero broker constructor failed")
	}
	w := &controlledEventWriter{header: make(http.Header)}
	zero.ServeHTTP(w, f.newRequest(2, "GET", "/api/events", ""))
	if w.code != 503 || strings.Contains(w.body.String(), "event:") {
		t.Fatal("unready broker claimed stream readiness")
	}
	// Supported capabilities can still fail at runtime after headers. Empty
	// preparation flush fails before any kind/data; never append a JSON503 to200.
	w = &controlledEventWriter{header: make(http.Header), fail: "flush"}
	f.handler.ServeHTTP(w, f.newRequest(2, "GET", "/api/events", ""))
	if strings.Contains(w.body.String(), "event:") || strings.Contains(w.body.String(), "data:") {
		t.Fatal("failed preparatory flush exposed event bytes")
	}
	// Expired/revoked credentials are rejected before subscribing/headers.
	if f.svc.Logout(f.ctx, f.tokens[1]) != nil {
		t.Fatal("test prestream revocation failed")
	}
	expectTransferError(t, f.request(t, 2, "GET", "/api/events", ""), 401, "unauthenticated")
}
func testEventAuthLoss(t *testing.T, mode string) {
	env := eventFixture(t)
	shortExpiry := mode == "absolute_deadline_wake" || mode == "idle_deadline_wake"
	if shortExpiry {
		deadline := time.Now().Add(600 * time.Millisecond)
		query := "UPDATE auth_sessions SET idle_deadline=$1 WHERE account_id=2"
		if mode == "absolute_deadline_wake" {
			query = "UPDATE auth_sessions SET idle_deadline=$1,absolute_deadline=$1 WHERE account_id=2"
		}
		if _, err := env.f.p.Exec(env.f.ctx, query, deadline); err != nil {
			t.Fatal("owned short expiry setup failed")
		}
	}
	server := eventServer(t, env)
	client := openEvents(t, env, server, 2, "")
	expectHTTPEvent(t, client, "resync")
	before := passiveState(t, env.f)
	switch mode {
	case "revoked":
		if env.f.svc.Logout(env.f.ctx, env.f.tokens[1]) != nil {
			t.Fatal("test midstream revocation failed")
		}
	case "idle_expired":
		env.f.clock.Add(int64(auth.IdleTTL))
	case "peek_stall":
		tx, err := env.f.p.Begin(env.f.ctx)
		if err != nil {
			t.Fatal("owned auth stall transaction failed")
		}
		defer tx.Rollback(context.Background())
		if _, err := tx.Exec(env.f.ctx, "LOCK auth_sessions IN ACCESS EXCLUSIVE MODE"); err != nil {
			t.Fatal("owned auth query stall setup failed")
		}
	}
	started := time.Now()
	expectStreamClosed(t, client, 5*time.Second)
	if time.Since(started) > 5*time.Second {
		t.Fatal("revocation/expiry/stall detection unbounded")
	}
	if shortExpiry && time.Since(started) >= eventCheckInterval {
		t.Fatal("effective expiry waited for heartbeat instead of earlier deadline")
	}
	if mode == "idle_expired" && passiveState(t, env.f) != before {
		t.Fatal("SSE extended expired idle deadline")
	}
	if mode == "revoked" || mode == "idle_expired" {
		expectTransferError(t, env.f.request(t, 2, "GET", "/api/events", ""), 401, "unauthenticated")
		r := env.f.newRequest(2, "GET", "/api/auth/session", "")
		r.Header.Set(passiveHeader, "1")
		if string(transferObject(t, env.f.serve(t, r), 200)["authenticated"]) != "false" {
			t.Fatal("dead stream session restored authority")
		}
	}
}
func testEventRecovery(t *testing.T) {
	env := eventFixture(t)
	server := eventServer(t, env)
	first := openEvents(t, env, server, 2, "")
	expectHTTPEvent(t, first, "resync")
	if !regexp.MustCompile(`^luson_test_[a-f0-9]{32}$`).MatchString(env.f.p.Config().ConnConfig.Database) {
		t.Fatal("event database ownership rejected")
	}
	var pid int32
	if env.f.p.QueryRow(env.f.ctx, "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND usename=current_user AND application_name=$1 AND backend_type='client backend'", env.listenerName).Scan(&pid) != nil {
		t.Fatal("known own listener PID missing")
	}
	var terminated bool
	if env.f.p.QueryRow(env.f.ctx, "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid=$1 AND datname=current_database() AND usename=current_user AND application_name=$2 AND backend_type='client backend'", pid, env.listenerName).Scan(&terminated) != nil || !terminated {
		t.Fatal("guarded own listener termination refused")
	}
	expectStreamClosed(t, first, 5*time.Second)
	// Subscribe availability is observed, not inferred from an arbitrary sleep.
	limit, cancel := context.WithTimeout(env.f.ctx, 5*time.Second)
	defer cancel()
	for {
		sub, err := env.broker.Subscribe(2)
		if err == nil {
			sub.Close()
			break
		}
		select {
		case <-limit.Done():
			t.Fatal("listener fresh readiness did not recover")
		case <-time.After(5 * time.Millisecond):
		}
	}
	record := transferWireRecord(t, env.f.request(t, 2, "POST", "/api/transfers", validTransferJSON), 201)
	second := openEvents(t, env, server, 2, "999999-ignored")
	expectHTTPEvent(t, second, "resync")
	r := env.f.newRequest(2, "GET", "/api/transfers", "")
	r.Header.Set(passiveHeader, "1")
	total, records := transferWirePage(t, env.f.serve(t, r))
	if total != 1 || len(records) != 1 || records[0].ID != record.ID {
		t.Fatal("reconnect resync lacks committed current state")
	}
	second.close()
	first.close()
	env.f.unchanged(t)
}
func testEventLongLived(t *testing.T) {
	env := eventFixture(t)
	server := eventServer(t, env)
	before := passiveState(t, env.f)
	started := time.Now()
	client := openEvents(t, env, server, 2, "")
	expectHTTPEvent(t, client, "resync")
	// One explicitly timed real-network smoke, not a queue/race ordering proof.
	for time.Since(started) < 16*time.Second {
		frame, err := client.frame()
		if err != nil || frame != ": heartbeat\n\n" {
			t.Fatal("valid stream lost to inherited global15s write timeout")
		}
	}
	if passiveState(t, env.f) != before {
		t.Fatal("heartbeats renewed idle authority")
	}
	client.close()
	// Broker lifetime cancellation closes an actual stream before server shutdown.
	next := openEvents(t, env, server, 3, "")
	expectHTTPEvent(t, next, "resync")
	if env.broker.Shutdown(context.Background()) != nil {
		t.Fatal("broker lifetime did not join")
	}
	expectStreamClosed(t, next, 5*time.Second)
	shutdown, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if server.Config.Shutdown(shutdown) != nil {
		t.Fatal("active stream prevented HTTP shutdown")
	}
}
func testEventSlowWriter(t *testing.T) {
	env := eventFixture(t)
	writer := &controlledEventWriter{header: make(http.Header), slow: true}
	started := time.Now()
	env.f.handler.ServeHTTP(writer, env.f.newRequest(2, "GET", "/api/events", ""))
	if time.Since(started) > 2*time.Second || writer.body.Len() != 0 || writer.writes != 1 {
		t.Fatal("slow writer was not bounded before private bytes")
	}
	// Its stream must have unsubscribed: all128 slots remain available afterwards.
	var subscriptions []*realtime.Subscription
	for i := 0; i < 128; i++ {
		sub, err := env.broker.Subscribe(2)
		if err != nil {
			t.Fatal("slow stream leaked broker subscription")
		}
		subscriptions = append(subscriptions, sub)
	}
	for _, sub := range subscriptions {
		sub.Close()
	}
}

type plainEventWriter struct {
	header http.Header
	body   bytes.Buffer
}

func (w *plainEventWriter) Header() http.Header {
	if w.header == nil {
		w.header = make(http.Header)
	}
	return w.header
}
func (w *plainEventWriter) Write(p []byte) (int, error) { return w.body.Write(p) }
func (w *plainEventWriter) WriteHeader(int)             {}

type cycleEventWriter struct{ plainEventWriter }

func (w *cycleEventWriter) Unwrap() http.ResponseWriter { return w }

type wrappedEventWriter struct{ http.ResponseWriter }

func (w *wrappedEventWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

type controlledEventWriter struct {
	header    http.Header
	body      bytes.Buffer
	code      int
	deadlines []time.Time
	deadline  time.Time
	fail      string
	slow      bool
	writes    int
}

func (w *controlledEventWriter) Header() http.Header { return w.header }
func (w *controlledEventWriter) WriteHeader(code int) {
	if w.code == 0 {
		w.code = code
	}
}
func (w *controlledEventWriter) SetWriteDeadline(deadline time.Time) error {
	w.deadline = deadline
	w.deadlines = append(w.deadlines, deadline)
	if w.fail == "deadline" {
		return http.ErrNotSupported
	}
	return nil
}
func (w *controlledEventWriter) FlushError() error {
	w.WriteHeader(200)
	if w.fail == "flush" {
		return errors.New("test flush failed")
	}
	return nil
}
func (w *controlledEventWriter) Write(p []byte) (int, error) {
	w.writes++
	if w.fail == "write" {
		return 0, errors.New("test write failed")
	}
	if w.fail == "short" {
		return 0, nil
	}
	if w.slow {
		if w.deadline.IsZero() {
			return 0, errors.New("missing bounded write deadline")
		}
		timer := time.NewTimer(time.Until(w.deadline))
		defer timer.Stop()
		<-timer.C
		return 0, context.DeadlineExceeded
	}
	w.WriteHeader(200)
	return w.body.Write(p)
}
