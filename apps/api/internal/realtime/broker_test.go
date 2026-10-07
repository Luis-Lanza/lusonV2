package realtime

import (
	"context"
	"fmt"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/bootstrap"
	"luson/api/internal/config"
	"luson/api/internal/testpg"
	"luson/api/internal/transfers"
)

func TestR03BrokerContract(t *testing.T) {
	if b, err := New(nil); b != nil || err != ErrUnavailable {
		t.Fatal("nil pool accepted")
	}
	if b, err := newBroker(nil); b != nil || err != ErrUnavailable {
		t.Fatal("nil config accepted")
	}
	var missing *Broker
	for _, b := range []*Broker{missing, {}} {
		if b.Start(context.Background()) != ErrUnavailable || b.Start(nil) != ErrUnavailable {
			t.Fatal("nil start boundary failed")
		}
		if s, err := b.Subscribe(2); s != nil || err != ErrUnavailable {
			t.Fatal("unready subscription accepted")
		}
		for _, location := range []int{-1, 0, 4} {
			if s, err := b.Subscribe(location); s != nil || err != ErrInvalid {
				t.Fatal("invalid location accepted")
			}
		}
	}
	if missing.Shutdown(context.Background()) != ErrUnavailable || (&Broker{}).Shutdown(nil) != ErrUnavailable {
		t.Fatal("nil shutdown boundary failed")
	}
	var nilSubscription *Subscription
	nilSubscription.Close()
	(&Subscription{}).Close()
	cfg, err := pgx.ParseConfig("host=localhost sslmode=disable")
	if err != nil {
		t.Fatal("synthetic config failed")
	}
	cfg.RuntimeParams["application_name"] = "original"
	b, err := newBroker(cfg)
	if err != nil {
		t.Fatal("synthetic constructor failed")
	}
	cfg.RuntimeParams["application_name"] = "changed"
	if b.cfg.RuntimeParams["application_name"] != "original" {
		t.Fatal("configuration not copied")
	}
	if b.Shutdown(context.Background()) != nil || b.Start(context.Background()) != ErrUnavailable {
		t.Fatal("single-use lifecycle failed")
	}
	for _, tc := range []struct {
		payload  string
		event    Event
		audience int
	}{{"inventory:0", Inventory, 0}, {"transfers:1", Transfers, 1}, {"transfers:2", Transfers, 2}, {"transfers:3", Transfers, 3}} {
		event, audience, ok := parsePayload(tc.payload)
		if !ok || event != tc.event || audience != tc.audience {
			t.Fatal("known metadata rejected")
		}
	}
	for _, payload := range []string{"", "resync:0", "inventory:1", "transfers:0", "transfers:4", "transfers:01", "transfers:+1", "transfers:1\n", " transfers:1", "transfers:1:2", `{"topic":"transfers","audience":1}`, strings.Repeat("x", 8192), "transfers:\xff"} {
		if _, _, ok := parsePayload(payload); ok {
			t.Fatal("unknown/oversized/ambiguous metadata accepted")
		}
	}
	ready := func() *Broker {
		return &Broker{ctx: context.Background(), ready: true, subscribers: make(map[uint64]*Subscription)}
	}
	t.Run("capacity", func(t *testing.T) {
		b := ready()
		for i := 0; i < maxSubscribers; i++ {
			s, err := b.Subscribe(i%3 + 1)
			if err != nil || <-s.Events != Resync {
				t.Fatal("bounded subscription capacity failed")
			}
		}
		if s, err := b.Subscribe(2); s != nil || err != ErrUnavailable {
			t.Fatal("subscriber cap not enforced")
		}
		b.unavailable()
		if len(b.subscribers) != 0 {
			t.Fatal("loss did not drain subscriptions")
		}
	})
	t.Run("overflow_only_slow_client", func(t *testing.T) {
		b := ready()
		slow, _ := b.Subscribe(1)
		fast, _ := b.Subscribe(2)
		<-slow.Events
		<-fast.Events
		for i := 0; i <= queueSize; i++ {
			if !b.install(map[string]int64{}, Inventory, 0) || <-fast.Events != Inventory {
				t.Fatal("nonblocking fanout failed")
			}
		}
		closedSubscription(t, slow)
		if len(b.subscribers) != 1 {
			t.Fatal("overflow disconnected healthy client")
		}
		slow.Close()
		slow.Close()
		fast.Close()
		fast.Close()
	})
	t.Run("close_fanout_race", func(t *testing.T) {
		b := ready()
		var wg sync.WaitGroup
		for i := 0; i < 32; i++ {
			s, _ := b.Subscribe(i%3 + 1)
			wg.Add(1)
			go func() { defer wg.Done(); s.Close(); s.Close() }()
		}
		for i := 0; i < 100; i++ {
			b.install(map[string]int64{}, Inventory, 0)
		}
		wg.Wait()
		b.unavailable()
		if len(b.subscribers) != 0 {
			t.Fatal("concurrent close leaked subscriptions")
		}
	})
}

type brokerFixture struct {
	ctx    context.Context
	p      *pgxpool.Pool
	actors []auth.Identity
	store  *transfers.Store
	key    int
}

func brokerFixtureDB(t *testing.T) *brokerFixture {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	if bootstrap.Initialize(ctx, p, config.LocalTrial) != nil {
		t.Fatal("broker fixture initialization failed")
	}
	creds := make([]bootstrap.Credentials, 3)
	for i := range creds {
		creds[i] = bootstrap.Credentials{Username: "u" + testpg.Random(t)[:20], Password: testpg.Random(t)}
	}
	if bootstrap.Provision(ctx, p, creds) != nil {
		t.Fatal("broker fixture provisioning failed")
	}
	svc, err := auth.New(p, nil)
	if err != nil {
		t.Fatal("broker auth service failed")
	}
	f := &brokerFixture{ctx: ctx, p: p, actors: make([]auth.Identity, 3), store: transfers.New(p)}
	for i, c := range creds {
		session, _, err := svc.Login(ctx, c.Username, c.Password, fmt.Sprintf("127.0.0.%d", i+1), "")
		if err != nil {
			t.Fatal("broker assigned login failed")
		}
		f.actors[i] = session.Identity
	}
	return f
}
func (f *brokerFixture) start(t *testing.T, trace pgx.QueryTracer) (*Broker, []*Subscription) {
	t.Helper()
	cfg := f.p.Config().ConnConfig.Copy()
	if trace != nil {
		cfg.Tracer = trace
	}
	b, err := New(f.p)
	if trace != nil {
		b, err = newBroker(cfg)
	}
	if err != nil {
		t.Fatal("broker constructor failed")
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
		defer cancel()
		if b.Shutdown(ctx) != nil {
			t.Error("broker shutdown did not join")
		}
	})
	if b.Start(f.ctx) != nil {
		t.Fatal("broker startup unavailable")
	}
	return b, subscribeThree(t, b)
}
func subscribeThree(t *testing.T, b *Broker) []*Subscription {
	t.Helper()
	all := make([]*Subscription, 3)
	for i := range all {
		s, err := b.Subscribe(i + 1)
		if err != nil {
			t.Fatal("live subscriber delivery unavailable")
		}
		all[i] = s
		expectEvent(t, s, Resync)
	}
	return all
}
func expectEvent(t *testing.T, s *Subscription, want Event) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	select {
	case event, ok := <-s.Events:
		if !ok || event != want {
			t.Fatalf("public event mismatch: got=%q want=%q open=%v", event, want, ok)
		}
	case <-ctx.Done():
		t.Fatal("expected event deadline exceeded")
	}
}
func closedSubscription(t *testing.T, s *Subscription) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		select {
		case _, ok := <-s.Events:
			if !ok {
				return
			}
		case <-ctx.Done():
			t.Fatal("subscription closure unavailable")
		}
	}
}
func (f *brokerFixture) boundary(t *testing.T, all []*Subscription, expected [][]Event) {
	t.Helper()
	if _, err := f.p.Exec(f.ctx, "SELECT pg_notify($1,'inventory:0')", channel); err != nil {
		t.Fatal("ordered notification barrier failed")
	}
	for i, s := range all {
		for _, event := range expected[i] {
			expectEvent(t, s, event)
		}
		expectEvent(t, s, Inventory)
	}
}
func (f *brokerFixture) revisions(t *testing.T) map[string]int64 {
	t.Helper()
	rows, err := f.p.Query(f.ctx, "SELECT scope,revision FROM realtime_revisions ORDER BY scope")
	if err != nil {
		t.Fatal("revision query failed")
	}
	defer rows.Close()
	out := map[string]int64{}
	for rows.Next() {
		var key string
		var revision int64
		if rows.Scan(&key, &revision) != nil {
			t.Fatal("revision scan failed")
		}
		out[key] = revision
	}
	if rows.Err() != nil || len(out) != 4 {
		t.Fatal("revision set incomplete")
	}
	return out
}
func (f *brokerFixture) stock(t *testing.T) string {
	t.Helper()
	var data string
	if f.p.QueryRow(f.ctx, "SELECT jsonb_agg(to_jsonb(b) ORDER BY location_id,variant_id)::text FROM inventory_balances b").Scan(&data) != nil {
		t.Fatal("full stock snapshot failed")
	}
	return data
}
func (f *brokerFixture) unchanged(t *testing.T, before string) {
	t.Helper()
	if f.stock(t) != before {
		t.Fatal("Pending/broker modified complete stock snapshot")
	}
}
func (f *brokerFixture) input(kind transfers.Kind, counterparty int) transfers.CreateInput {
	f.key++
	return transfers.CreateInput{Kind: kind, CounterpartyID: counterparty, RetryKey: fmt.Sprintf("broker-retry-key-%04d", f.key), Items: []transfers.Line{{VariantID: 1, Quantity: 1}}}
}
func (f *brokerFixture) create(t *testing.T, actor int, input transfers.CreateInput) transfers.CreateResult {
	t.Helper()
	result, err := f.store.Create(f.ctx, f.actors[actor-1], input)
	if err != nil {
		t.Fatal("broker test transfer creation failed")
	}
	return result
}
func (f *brokerFixture) header(t *testing.T, tx pgx.Tx, actor, origin, destination int) int64 {
	t.Helper()
	f.key++
	var id int64
	if tx.QueryRow(f.ctx, `INSERT INTO transfer_requests(creator_location_id,kind,origin_location_id,destination_location_id,approver_location_id,retry_key,payload_sha256) VALUES($1,'request_stock',$2,$3,$2,$4,decode(repeat('00',32),'hex')) RETURNING id`, actor, origin, destination, fmt.Sprintf("broker-direct-key-%04d", f.key)).Scan(&id) != nil {
		t.Fatal("owned pending header setup failed")
	}
	return id
}
func (f *brokerFixture) item(t *testing.T, tx pgx.Tx, id int64) {
	t.Helper()
	if _, err := tx.Exec(f.ctx, "INSERT INTO transfer_request_items VALUES($1,1,1)", id); err != nil {
		t.Fatal("owned pending item setup failed")
	}
}
func TestR03BrokerPostgres(t *testing.T) {
	root := t
	t.Run("live_delivery", func(t *testing.T) { f := brokerFixtureDB(t); registerBrokerAudit(root, f.p); testBrokerFlows(t, f) })
	t.Run("commit_rollback_deferred_failure", testBrokerTransactions)
	t.Run("inventory_changes_noop_pending_silence", testBrokerInventory)
	t.Run("reversed_audience_lock_order", testBrokerLockOrder)
	t.Run("listen_snapshot_subscription_race", testBrokerStartupRace)
	t.Run("recovery_overflow_cancellation", testBrokerRecovery)
	t.Run("failed_startup_backoff_cancellation", testBrokerBackoff)
}
func testBrokerFlows(t *testing.T, f *brokerFixture) {
	b, all := f.start(t, nil)
	before := f.stock(t)
	original := f.revisions(t)
	for _, tc := range []struct {
		actor, counterparty, origin, destination int
		kind                                     transfers.Kind
	}{{2, 1, 1, 2, transfers.RequestStock}, {2, 3, 3, 2, transfers.RequestStock}, {2, 1, 2, 1, transfers.SendToWarehouse}} {
		versions := f.revisions(t)
		input := f.input(tc.kind, tc.counterparty)
		result := f.create(t, tc.actor, input)
		events := make([][]Event, 3)
		events[tc.origin-1] = []Event{Transfers}
		events[tc.destination-1] = []Event{Transfers}
		f.boundary(t, all, events)
		after := f.revisions(t)
		for location := 1; location <= 3; location++ {
			key := fmt.Sprintf("transfers:%d", location)
			want := versions[key]
			if location == tc.origin || location == tc.destination {
				want++
			}
			if after[key] != want {
				t.Fatal("private audience revision changed incorrectly")
			}
		}
		if after["inventory"] != original["inventory"] {
			t.Fatal("Pending emitted inventory revision")
		}
		replay := f.create(t, tc.actor, input)
		if !replay.Replayed || replay.Request.ID != result.Request.ID {
			t.Fatal("retry replay changed record")
		}
		f.boundary(t, all, make([][]Event, 3))
		if !reflect.DeepEqual(after, f.revisions(t)) {
			t.Fatal("replay changed revisions")
		}
		f.unchanged(t, before)
	}
	// No application-pool slot is held while the listener waits.
	if f.p.Stat().AcquiredConns() != 0 {
		t.Fatal("listener permanently occupies application pool")
	}
	b.mu.Lock()
	versions := b.versions
	b.mu.Unlock()
	if !reflect.DeepEqual(versions, f.revisions(t)) {
		t.Fatal("internal readiness/recovery snapshot not fresh")
	}
	for _, query := range []string{"INSERT INTO realtime_revisions VALUES('other',0)", "UPDATE realtime_revisions SET revision=-1 WHERE scope='inventory'", "UPDATE realtime_revisions SET revision=0 WHERE scope='inventory'", "UPDATE realtime_revisions SET scope='other' WHERE scope='inventory'", "DELETE FROM realtime_revisions WHERE scope='inventory'"} {
		if _, err := f.p.Exec(f.ctx, query); err == nil {
			t.Fatal("invalid internal revision mutation accepted")
		}
	}
}
func testBrokerTransactions(t *testing.T) {
	f := brokerFixtureDB(t)
	_, all := f.start(t, nil)
	before := f.stock(t)
	versions := f.revisions(t)
	tx, err := f.p.Begin(f.ctx)
	if err != nil {
		t.Fatal("owned transaction failed")
	}
	id := f.header(t, tx, 2, 1, 2)
	f.item(t, tx, id)
	// A committed marker on another connection passes the uncommitted writer.
	f.boundary(t, all, make([][]Event, 3))
	if !reflect.DeepEqual(versions, f.revisions(t)) {
		t.Fatal("uncommitted revisions became visible")
	}
	if tx.Commit(f.ctx) != nil {
		t.Fatal("owned complete transaction commit failed")
	}
	f.boundary(t, all, [][]Event{{Transfers}, {Transfers}, nil})
	versions = f.revisions(t)
	tx, err = f.p.Begin(f.ctx)
	if err != nil {
		t.Fatal("owned rollback transaction failed")
	}
	id = f.header(t, tx, 2, 3, 2)
	f.item(t, tx, id)
	if tx.Rollback(f.ctx) != nil {
		t.Fatal("owned rollback failed")
	}
	f.boundary(t, all, make([][]Event, 3))
	if !reflect.DeepEqual(versions, f.revisions(t)) {
		t.Fatal("rollback retained revisions")
	}
	tx, err = f.p.Begin(f.ctx)
	if err != nil {
		t.Fatal("owned incomplete transaction failed")
	}
	f.header(t, tx, 2, 1, 2)
	if tx.Commit(f.ctx) == nil {
		t.Fatal("deferred completeness failure committed")
	}
	f.boundary(t, all, make([][]Event, 3))
	if !reflect.DeepEqual(versions, f.revisions(t)) {
		t.Fatal("deferred failure emitted revisions")
	}
	tx, err = f.p.Begin(f.ctx)
	if err != nil {
		t.Fatal("owned failed-item transaction failed")
	}
	id = f.header(t, tx, 2, 1, 2)
	if _, err := tx.Exec(f.ctx, "INSERT INTO transfer_request_items VALUES($1,1,0)", id); err == nil {
		t.Fatal("invalid item accepted")
	}
	_ = tx.Rollback(f.ctx)
	f.boundary(t, all, make([][]Event, 3))
	if !reflect.DeepEqual(versions, f.revisions(t)) {
		t.Fatal("failed item emitted revisions")
	}
	f.unchanged(t, before)
}
func testBrokerInventory(t *testing.T) {
	f := brokerFixtureDB(t)
	_, all := f.start(t, nil)
	versions := f.revisions(t)
	before := f.stock(t)
	if _, err := f.p.Exec(f.ctx, "UPDATE inventory_balances SET existing=existing,reserved=reserved WHERE location_id=1"); err != nil {
		t.Fatal("owned no-op failed")
	}
	f.boundary(t, all, make([][]Event, 3))
	if !reflect.DeepEqual(versions, f.revisions(t)) {
		t.Fatal("no-op stock update invalidated")
	}
	f.unchanged(t, before)
	// Explicit test-only real stock mutation: one known row, no stock reset.
	var existing, reserved int64
	if f.p.QueryRow(f.ctx, "SELECT existing,reserved FROM inventory_balances WHERE location_id=1 AND variant_id=1").Scan(&existing, &reserved) != nil {
		t.Fatal("owned stock fact query failed")
	}
	if _, err := f.p.Exec(f.ctx, "UPDATE inventory_balances SET existing=existing+1 WHERE location_id=1 AND variant_id=1"); err != nil {
		t.Fatal("owned stock mutation failed")
	}
	f.boundary(t, all, [][]Event{{Inventory}, {Inventory}, {Inventory}})
	after := f.revisions(t)
	if after["inventory"] != versions["inventory"]+1 {
		t.Fatal("actual inventory revision missing")
	}
	var actual int64
	if f.p.QueryRow(f.ctx, "SELECT existing FROM inventory_balances WHERE location_id=1 AND variant_id=1").Scan(&actual) != nil || actual != existing+1 {
		t.Fatal("actual owned mutation fact missing")
	}
	expected := f.stock(t)
	f.create(t, 2, f.input(transfers.RequestStock, 1))
	f.boundary(t, all, [][]Event{{Transfers}, {Transfers}, nil})
	f.unchanged(t, expected)
	versions = f.revisions(t)
	tx, err := f.p.Begin(f.ctx)
	if err != nil {
		t.Fatal("owned stock rollback transaction failed")
	}
	if _, err := tx.Exec(f.ctx, "UPDATE inventory_balances SET reserved=reserved+1 WHERE location_id=1 AND variant_id=1"); err != nil {
		t.Fatal("owned reserved setup failed")
	}
	_ = tx.Rollback(f.ctx)
	f.boundary(t, all, make([][]Event, 3))
	if !reflect.DeepEqual(versions, f.revisions(t)) {
		t.Fatal("stock rollback invalidated")
	}
	f.unchanged(t, expected)
	if _, err := f.p.Exec(f.ctx, "UPDATE inventory_balances SET reserved=reserved+1 WHERE location_id=1 AND variant_id=1"); err != nil {
		t.Fatal("owned reserved mutation failed")
	}
	f.boundary(t, all, [][]Event{{Inventory}, {Inventory}, {Inventory}})
	if f.revisions(t)["inventory"] != versions["inventory"]+1 {
		t.Fatal("reserved change did not invalidate")
	}
	// INSERT/DELETE are supported operational balance changes, confined here to
	// an unrelated row of this owned database; the original row is restored.
	var quantity int64
	if f.p.QueryRow(f.ctx, "SELECT existing FROM inventory_balances WHERE location_id=3 AND variant_id=190").Scan(&quantity) != nil {
		t.Fatal("owned balance fact missing")
	}
	versions = f.revisions(t)
	if _, err := f.p.Exec(f.ctx, "DELETE FROM inventory_balances WHERE location_id=3 AND variant_id=190"); err != nil {
		t.Fatal("owned balance delete failed")
	}
	f.boundary(t, all, [][]Event{{Inventory}, {Inventory}, {Inventory}})
	if _, err := f.p.Exec(f.ctx, "INSERT INTO inventory_balances(location_id,variant_id,existing,reserved) VALUES(3,190,$1,0)", quantity); err != nil {
		t.Fatal("owned balance insert failed")
	}
	f.boundary(t, all, [][]Event{{Inventory}, {Inventory}, {Inventory}})
	if f.revisions(t)["inventory"] != versions["inventory"]+2 {
		t.Fatal("balance insert/delete revision missing")
	}
	if bootstrap.Initialize(f.ctx, f.p, config.LocalTrial) != nil {
		t.Fatal("initialization replay failed")
	}
	f.boundary(t, all, make([][]Event, 3))
	var seen, held int64
	if f.p.QueryRow(f.ctx, "SELECT existing,reserved FROM inventory_balances WHERE location_id=1 AND variant_id=1").Scan(&seen, &held) != nil || seen != existing+1 || held != reserved+1 {
		t.Fatal("initialization reset operational stock")
	}
}
func testBrokerLockOrder(t *testing.T) {
	f := brokerFixtureDB(t)
	_, all := f.start(t, nil)
	before := f.stock(t)
	first, err := pgx.ConnectConfig(f.ctx, f.p.Config().ConnConfig.Copy())
	if err != nil {
		t.Fatal("owned first writer failed")
	}
	defer first.Close(context.Background())
	second, err := pgx.ConnectConfig(f.ctx, f.p.Config().ConnConfig.Copy())
	if err != nil {
		t.Fatal("owned second writer failed")
	}
	defer second.Close(context.Background())
	// Hold the smaller key before starting BOTH directions. An origin-first
	// implementation would let the 3->2 writer retain key3 while waiting for2.
	// NOWAIT probing key3 distinguishes real ascending locking deterministically.
	blocker, err := f.p.Begin(f.ctx)
	if err != nil {
		t.Fatal("owned lock barrier failed")
	}
	defer blocker.Rollback(context.Background())
	if _, err := blocker.Exec(f.ctx, "SELECT scope FROM realtime_revisions WHERE scope='transfers:2' FOR UPDATE"); err != nil {
		t.Fatal("owned smaller-key lock failed")
	}
	writerCtx, cancelWriters := context.WithCancel(f.ctx)
	var writers sync.WaitGroup
	defer func() { cancelWriters(); writers.Wait() }()
	tx1, err := first.Begin(writerCtx)
	if err != nil {
		t.Fatal("owned first transaction failed")
	}
	tx2, err := second.Begin(writerCtx)
	if err != nil {
		t.Fatal("owned second transaction failed")
	}
	insert := func(tx pgx.Tx, actor, origin, destination int, key string) <-chan error {
		result := make(chan error, 1)
		writers.Add(1)
		go func() {
			defer writers.Done()
			_, err := tx.Exec(writerCtx, `INSERT INTO transfer_requests(creator_location_id,kind,origin_location_id,destination_location_id,approver_location_id,retry_key,payload_sha256) VALUES($1,'request_stock',$2,$3,$2,$4,decode(repeat('00',32),'hex'))`, actor, origin, destination, key)
			result <- err
		}()
		return result
	}
	blocked := func(pid uint32) {
		waitCondition(t, f.ctx, func() bool {
			var waiting bool
			err := f.p.QueryRow(f.ctx, "SELECT cardinality(pg_blocking_pids($1))>0 FROM pg_stat_activity WHERE pid=$1 AND datname=current_database()", int32(pid)).Scan(&waiting)
			return err == nil && waiting
		})
	}
	firstResult := insert(tx1, 3, 2, 3, "broker-reversed-key-0001")
	blocked(first.PgConn().PID())
	secondResult := insert(tx2, 2, 3, 2, "broker-reversed-key-0002")
	blocked(second.PgConn().PID())
	probe, err := f.p.Begin(f.ctx)
	if err != nil {
		t.Fatal("owned larger-key probe failed")
	}
	_, probeErr := probe.Exec(f.ctx, "SELECT scope FROM realtime_revisions WHERE scope='transfers:3' FOR UPDATE NOWAIT")
	_ = probe.Rollback(f.ctx)
	if probeErr != nil {
		t.Fatal("reversed writer locked larger key before smaller key")
	}
	if blocker.Commit(f.ctx) != nil {
		t.Fatal("smaller-key barrier release failed")
	}
	finish := func(tx pgx.Tx, result <-chan error, key string) {
		select {
		case err := <-result:
			if err != nil {
				t.Fatal("reversed audience insertion deadlocked")
			}
		case <-f.ctx.Done():
			t.Fatal("reversed audience writer did not release")
		}
		var id int64
		if tx.QueryRow(f.ctx, "SELECT id FROM transfer_requests WHERE retry_key=$1", key).Scan(&id) != nil {
			t.Fatal("reversed header fact missing")
		}
		f.item(t, tx, id)
		if tx.Commit(f.ctx) != nil {
			t.Fatal("reversed audience commit failed")
		}
	}
	finish(tx1, firstResult, "broker-reversed-key-0001")
	finish(tx2, secondResult, "broker-reversed-key-0002")
	f.boundary(t, all, [][]Event{nil, {Transfers, Transfers}, {Transfers, Transfers}})
	f.unchanged(t, before)
	// A multi-header statement gathers all keys before increments as well.
	tx, err := f.p.Begin(f.ctx)
	if err != nil {
		t.Fatal("owned multi-header transaction failed")
	}
	rows, err := tx.Query(f.ctx, `INSERT INTO transfer_requests(creator_location_id,kind,origin_location_id,destination_location_id,approver_location_id,retry_key,payload_sha256) VALUES(3,'request_stock',2,3,2,'broker-multi-key-00001',decode(repeat('00',32),'hex')),(2,'request_stock',1,2,1,'broker-multi-key-00002',decode(repeat('00',32),'hex')) RETURNING id`)
	if err != nil {
		t.Fatal("owned multi-header insert failed")
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if rows.Scan(&id) != nil {
			t.Fatal("multi-header scan failed")
		}
		ids = append(ids, id)
	}
	rows.Close()
	if rows.Err() != nil || len(ids) != 2 {
		t.Fatal("multi-header set incomplete")
	}
	for _, id := range ids {
		f.item(t, tx, id)
	}
	if tx.Commit(f.ctx) != nil {
		t.Fatal("multi-header commit failed")
	}
	f.boundary(t, all, [][]Event{{Transfers}, {Transfers}, {Transfers}})
	f.unchanged(t, before)
}

// Polls only observable state under a hard deadline. Sleeps never establish
// notification silence or race ordering; transaction/trace barriers do that.
func waitCondition(t *testing.T, ctx context.Context, condition func() bool) {
	t.Helper()
	limit, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	for {
		if condition() {
			return
		}
		select {
		case <-limit.Done():
			t.Fatal("deterministic state condition deadline exceeded")
		case <-time.After(5 * time.Millisecond):
		}
	}
}

type snapshotTraceKey struct{}
type brokerTrace struct {
	pid             atomic.Uint32
	counted, resume chan struct{}
	once            sync.Once
}

func (tr *brokerTrace) TraceQueryStart(ctx context.Context, conn *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	tr.pid.Store(conn.PgConn().PID())
	if strings.HasPrefix(data.SQL, "SELECT scope,revision FROM realtime_revisions") {
		return context.WithValue(ctx, snapshotTraceKey{}, true)
	}
	return ctx
}
func (tr *brokerTrace) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	if tr.counted == nil || ctx.Value(snapshotTraceKey{}) != true || data.Err != nil {
		return
	}
	tr.once.Do(func() {
		close(tr.counted)
		select {
		case <-tr.resume:
		case <-ctx.Done():
		}
	})
}
func testBrokerStartupRace(t *testing.T) {
	f := brokerFixtureDB(t)
	trace := &brokerTrace{counted: make(chan struct{}), resume: make(chan struct{})}
	cfg := f.p.Config().ConnConfig.Copy()
	cfg.Tracer = trace
	b, err := newBroker(cfg)
	if err != nil {
		t.Fatal("startup race constructor failed")
	}
	defer b.Shutdown(context.Background())
	started := make(chan error, 1)
	go func() { started <- b.Start(f.ctx) }()
	select {
	case <-trace.counted:
	case <-f.ctx.Done():
		t.Fatal("committed LISTEN snapshot barrier missing")
	}
	if s, err := b.Subscribe(2); s != nil || err != ErrUnavailable {
		t.Fatal("before-ready subscription claimed live state")
	}
	// Commit precisely after initial snapshot and before readiness. LISTEN is
	// already committed, so the invalidation is queued while the tracer pauses.
	result := f.create(t, 2, f.input(transfers.RequestStock, 1))
	fresh := f.revisions(t)
	close(trace.resume)
	select {
	case err := <-started:
		if err != nil {
			t.Fatal("startup readiness failed")
		}
	case <-f.ctx.Done():
		t.Fatal("startup did not finish")
	}
	all := subscribeThree(t, b)
	if _, err := f.p.Exec(f.ctx, "SELECT pg_notify($1,'inventory:0')", channel); err != nil {
		t.Fatal("startup barrier notify failed")
	}
	for i, s := range all {
		for {
			ctx, cancel := context.WithTimeout(f.ctx, 5*time.Second)
			select {
			case event, ok := <-s.Events:
				cancel()
				if !ok {
					t.Fatal("startup subscription closed")
				}
				if event == Inventory {
					goto next
				}
				if event != Transfers || i == 2 {
					t.Fatal("startup race leaked audience")
				}
			case <-ctx.Done():
				cancel()
				t.Fatal("startup ordered boundary failed")
			}
		}
	next:
	}
	b.mu.Lock()
	versions := b.versions
	b.mu.Unlock()
	if !reflect.DeepEqual(versions, fresh) {
		t.Fatal("startup queued commit lost from fresh revisions")
	}
	page, err := f.store.List(f.ctx, f.actors[1], transfers.Query{})
	if err != nil || page.Total != 1 || len(page.Records) != 1 || page.Records[0].ID != result.Request.ID {
		t.Fatal("initial resync lacks concurrently committed state")
	}
}
func testBrokerRecovery(t *testing.T) {
	f := brokerFixtureDB(t)
	trace := &brokerTrace{}
	cfg := f.p.Config().ConnConfig.Copy()
	cfg.Tracer = trace
	name := "luson_listener_" + testpg.Random(t)
	cfg.RuntimeParams["application_name"] = name
	b, err := newBroker(cfg)
	if err != nil {
		t.Fatal("recovery constructor failed")
	}
	defer b.Shutdown(context.Background())
	if b.Start(f.ctx) != nil {
		t.Fatal("recovery start failed")
	}
	all := subscribeThree(t, b)
	pid := trace.pid.Load()
	// One guarded SQL statement targets only this recorded listener backend in
	// the cryptographically owned test database, never admin/foreign sessions.
	if !regexp.MustCompile(`^luson_test_[a-f0-9]{32}$`).MatchString(f.p.Config().ConnConfig.Database) {
		t.Fatal("listener database ownership rejected")
	}
	var terminated bool
	if f.p.QueryRow(f.ctx, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid=$1 AND datname=current_database() AND usename=current_user AND application_name=$2 AND backend_type='client backend'`, int32(pid), name).Scan(&terminated) != nil || !terminated {
		t.Fatal("known owned listener termination refused")
	}
	for _, s := range all {
		closedSubscription(t, s)
	}
	waitCondition(t, f.ctx, func() bool { b.mu.Lock(); defer b.mu.Unlock(); return b.ready && trace.pid.Load() != pid })
	all = subscribeThree(t, b)
	fresh := f.revisions(t)
	b.mu.Lock()
	versions := b.versions
	b.mu.Unlock()
	if !reflect.DeepEqual(versions, fresh) {
		t.Fatal("recovery became ready without fresh revisions")
	}
	// Invalid framing disconnects instead of forwarding arbitrary trusted-DB
	// bytes or retaining a false live claim; fresh subscriptions resync again.
	if _, err := f.p.Exec(f.ctx, "SELECT pg_notify($1,'transfers:99')", channel); err != nil {
		t.Fatal("owned malformed notification setup failed")
	}
	for _, s := range all {
		closedSubscription(t, s)
	}
	waitCondition(t, f.ctx, func() bool { b.mu.Lock(); defer b.mu.Unlock(); return b.ready })
	all = subscribeThree(t, b)
	// A stalled client fills its bounded queue. Other clients actively consume
	// each commit, proving overflow isolates the slow client without blocking.
	for i := 0; i <= queueSize; i++ {
		if _, err := f.p.Exec(f.ctx, "SELECT pg_notify($1,'inventory:0')", channel); err != nil {
			t.Fatal("owned overflow notification failed")
		}
		expectEvent(t, all[1], Inventory)
		expectEvent(t, all[2], Inventory)
	}
	closedSubscription(t, all[0])
	all[1].Close()
	all[1].Close()
	all[2].Close()
	// Start with a cancelable lifetime and verify dedicated connection closure.
	ctx, cancel := context.WithCancel(f.ctx)
	otherTrace := &brokerTrace{}
	otherCfg := f.p.Config().ConnConfig.Copy()
	otherCfg.Tracer = otherTrace
	other, err := newBroker(otherCfg)
	if err != nil || other.Start(ctx) != nil {
		t.Fatal("cancelable broker setup failed")
	}
	sub, err := other.Subscribe(2)
	if err != nil {
		t.Fatal("cancelable subscription failed")
	}
	expectEvent(t, sub, Resync)
	otherPID := otherTrace.pid.Load()
	cancel()
	closedSubscription(t, sub)
	if other.Shutdown(context.Background()) != nil {
		t.Fatal("cancellation did not join listener")
	}
	var count int
	if f.p.QueryRow(f.ctx, "SELECT count(*) FROM pg_stat_activity WHERE pid=$1 AND datname=current_database()", int32(otherPID)).Scan(&count) != nil || count != 0 {
		t.Fatal("canceled dedicated listener remained active")
	}
	if b.Shutdown(context.Background()) != nil || b.Shutdown(context.Background()) != nil {
		t.Fatal("idempotent shutdown did not join")
	}
	if s, err := b.Subscribe(2); s != nil || err != ErrUnavailable {
		t.Fatal("shutdown allowed new subscriptions")
	}
}

type failedSnapshotTrace struct {
	mu    sync.Mutex
	times []time.Time
}

func (tr *failedSnapshotTrace) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if strings.HasPrefix(data.SQL, "SELECT scope,revision FROM realtime_revisions") {
		return context.WithValue(ctx, snapshotTraceKey{}, true)
	}
	return ctx
}
func (tr *failedSnapshotTrace) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	if ctx.Value(snapshotTraceKey{}) == true && data.Err != nil {
		tr.mu.Lock()
		tr.times = append(tr.times, time.Now())
		tr.mu.Unlock()
	}
}
func testBrokerBackoff(t *testing.T) {
	f := brokerFixtureDB(t)
	cfg := f.p.Config().ConnConfig.Copy()
	// Session-local search_path makes the readiness query unavailable without
	// changing schema, operator configuration, resource bindings or table data.
	cfg.RuntimeParams["search_path"] = "pg_catalog"
	trace := &failedSnapshotTrace{}
	cfg.Tracer = trace
	b, err := newBroker(cfg)
	if err != nil {
		t.Fatal("backoff constructor failed")
	}
	ctx, cancel := context.WithCancel(f.ctx)
	defer cancel()
	defer b.Shutdown(context.Background())
	started := make(chan error, 1)
	go func() { started <- b.Start(ctx) }()
	waitCondition(t, f.ctx, func() bool {
		trace.mu.Lock()
		defer trace.mu.Unlock()
		return len(trace.times) >= 2
	})
	trace.mu.Lock()
	elapsed := trace.times[1].Sub(trace.times[0])
	trace.mu.Unlock()
	if elapsed < 100*time.Millisecond {
		t.Fatal("failed listener reconnect busy-looped")
	}
	if s, err := b.Subscribe(2); s != nil || err != ErrUnavailable {
		t.Fatal("failed readiness accepted subscription")
	}
	cancel()
	select {
	case err := <-started:
		if err != ErrUnavailable {
			t.Fatal("failed startup not sanitized")
		}
	case <-f.ctx.Done():
		t.Fatal("startup cancellation did not interrupt backoff")
	}
	if b.Shutdown(context.Background()) != nil {
		t.Fatal("failed startup goroutine did not join")
	}
}

func registerBrokerAudit(t *testing.T, p *pgxpool.Pool) {
	t.Helper()
	cfg := p.Config().ConnConfig.Copy()
	cfg.Database = "luson_test"
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	admin, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		t.Fatal("broker audit connection failed")
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		defer admin.Close(ctx)
		var user, db string
		if admin.QueryRow(ctx, "SELECT current_user,current_database()").Scan(&user, &db) != nil || user != "luson_test" || db != "luson_test" {
			t.Fatal("broker audit identity refused")
		}
		for {
			var total, owned, foreign int
			if admin.QueryRow(ctx, `SELECT count(*),count(*) FILTER (WHERE datname ~ '^luson_test_[a-f0-9]{32}$'),count(*) FILTER (WHERE datname NOT IN ('luson_test','postgres','template0','template1')) FROM pg_database`).Scan(&total, &owned, &foreign) != nil {
				t.Fatal("broker audit catalog failed")
			}
			if total == 4 && owned == 0 && foreign == 0 {
				break
			}
			select {
			case <-ctx.Done():
				t.Fatal("broker fixture databases did not settle")
			case <-time.After(10 * time.Millisecond):
			}
		}
		var tables int
		if admin.QueryRow(ctx, "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'").Scan(&tables) != nil || tables != 0 {
			t.Fatal("broker changed admin schema")
		}
		t.Log("broker settled fixture: baseline=4 owned=0 nonbaseline=0 admin_public=0")
	})
}
