package transfers_test

import (
	"context"
	"errors"
	"fmt"
	"math"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/bootstrap"
	"luson/api/internal/config"
	"luson/api/internal/testpg"
	"luson/api/internal/transfers"
)

func fixture(t *testing.T) (context.Context, *pgxpool.Pool, *transfers.Store) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	if bootstrap.Initialize(ctx, p, config.LocalTrial) != nil {
		t.Fatal("test initialization failed")
	}
	credentials := make([]bootstrap.Credentials, 3)
	for i := range credentials {
		credentials[i] = bootstrap.Credentials{Username: "u" + testpg.Random(t)[:20], Password: testpg.Random(t)}
	}
	if bootstrap.Provision(ctx, p, credentials) != nil {
		t.Fatal("test account provisioning failed")
	}
	return ctx, p, transfers.New(p)
}
func TestR01PendingStore(t *testing.T) {
	// Each subtest drops its own admitted DB before the final read-only audit.
	// The binding probe releases its DB immediately, not across other tests.
	var admin *pgx.Conn
	t.Cleanup(func() {
		if admin == nil {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		defer admin.Close(context.Background())
		for {
			var databases, owned int
			if admin.QueryRow(ctx, "SELECT count(*),count(*) FILTER (WHERE datname ~ '^luson_test_[a-f0-9]{32}$') FROM pg_database").Scan(&databases, &owned) != nil {
				t.Fatal("final fixture catalog audit failed")
			}
			if databases == 4 && owned == 0 {
				break
			}
			select {
			case <-ctx.Done():
				t.Fatal("fixture did not settle to four baseline databases and zero owned databases")
			case <-time.After(10 * time.Millisecond):
			}
		}
		var tables int
		if admin.QueryRow(ctx, "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'").Scan(&tables) != nil || tables != 0 {
			t.Fatal("admin schema was changed")
		}
		t.Log("settled fixture: four baseline databases, zero owned databases, zero admin public tables")
	})
	t.Run("fixture_audit_binding", func(t *testing.T) {
		audit := testpg.Open(t)
		cfg := audit.Config().ConnConfig.Copy()
		cfg.Database = "luson_test"
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		var err error
		admin, err = pgx.ConnectConfig(ctx, cfg)
		if err != nil {
			t.Fatal("fixture audit connection failed")
		}
		var user, database string
		if admin.QueryRow(ctx, "SELECT current_user,current_database()").Scan(&user, &database) != nil || user != "luson_test" || database != "luson_test" {
			t.Fatal("fixture audit admin identity mismatch")
		}
	})
	t.Run("three_legal_flows", func(t *testing.T) {
		ctx, p, s := fixture(t)
		before := stocks(t, ctx, p)
		var total int64
		for _, row := range before {
			total += row.Existing
		}
		if total != 8565 {
			t.Fatal("opening stock source formula changed")
		}
		t.Cleanup(func() { unchanged(t, before, stocks(t, ctx, p)) })
		for _, tc := range []struct {
			name                              string
			kind                              transfers.Kind
			counterparty, origin, destination int
		}{
			{"warehouse_request", transfers.RequestStock, 1, 1, 2},
			{"branch_request", transfers.RequestStock, 3, 3, 2},
			{"warehouse_proposal", transfers.SendToWarehouse, 1, 2, 1},
		} {
			t.Run(tc.name, func(t *testing.T) {
				in := input()
				in.Kind = tc.kind
				in.CounterpartyID = tc.counterparty
				in.RetryKey = "legal-flow-key-" + tc.name
				r, err := s.Create(ctx, actor(2), in)
				if err != nil || r.Replayed || r.Request.ID <= 0 || r.Request.Origin.ID != tc.origin || r.Request.Destination.ID != tc.destination || r.Request.Approver.ID != (map[transfers.Kind]int{transfers.RequestStock: tc.origin, transfers.SendToWarehouse: 1})[tc.kind] || r.Request.Status != "pending" || len(r.Request.Items) != 2 || r.Request.Creator.Name != "Sucursal A" || r.Request.Reference != fmt.Sprintf("TR-%03d", r.Request.ID) {
					t.Fatal("legal Pending request was not persisted with physical direction")
				}
			})
		}
	})
	t.Run("atomic_validation", testAtomicValidation)
	t.Run("retry_and_participants", testRetryAndParticipants)
	t.Run("exact_catalog_and_int64", testExactCatalog)
	t.Run("full_190_item_cart", testFullCart)
	t.Run("concurrent_global_references", testConcurrentReferences)
	t.Run("concurrent_actor_retry", testConcurrentRetry)
	t.Run("rollback_after_first_item", testRollback)
	t.Run("database_guards", testDatabaseGuards)
	t.Run("locked_stock_revalidation", testLockedStock)
	t.Run("canceled_stock_wait", testCanceledStock)
	t.Run("bounded_sanitized_errors", testStoreErrors)
}

type stockRow struct {
	Location, Variant             int
	Existing, Reserved, Available int64
}

func stocks(t *testing.T, ctx context.Context, p *pgxpool.Pool) []stockRow {
	t.Helper()
	rows, err := p.Query(ctx, "SELECT location_id,variant_id,existing,reserved,available FROM inventory_balances ORDER BY location_id,variant_id")
	if err != nil {
		t.Fatal("stock snapshot failed")
	}
	defer rows.Close()
	var result []stockRow
	for rows.Next() {
		var r stockRow
		if rows.Scan(&r.Location, &r.Variant, &r.Existing, &r.Reserved, &r.Available) != nil {
			t.Fatal("stock snapshot scan failed")
		}
		result = append(result, r)
	}
	if rows.Err() != nil || len(result) != 570 {
		t.Fatal("incomplete stock snapshot")
	}
	return result
}
func unchanged(t *testing.T, a, b []stockRow) {
	t.Helper()
	if !reflect.DeepEqual(a, b) {
		t.Fatal("Pending changed an inventory balance")
	}
}
func scalar(t *testing.T, ctx context.Context, p *pgxpool.Pool, query string) int64 {
	t.Helper()
	var n int64
	if p.QueryRow(ctx, query).Scan(&n) != nil {
		t.Fatal("test scalar query failed")
	}
	return n
}
func create(t *testing.T, ctx context.Context, s *transfers.Store, id int, in transfers.CreateInput) transfers.CreateResult {
	t.Helper()
	r, err := s.Create(ctx, actor(id), in)
	if err != nil {
		t.Fatal("Pending creation failed")
	}
	return r
}
func testAtomicValidation(t *testing.T) {
	ctx, p, s := fixture(t)
	before := stocks(t, ctx, p)
	for _, tc := range []struct {
		name   string
		id     int
		change func(*transfers.CreateInput)
		want   error
	}{
		{"warehouse", 1, func(*transfers.CreateInput) {}, transfers.ErrForbidden},
		{"zero", 2, func(in *transfers.CreateInput) { in.Items[1].Quantity = 0 }, transfers.ErrInvalid},
		{"duplicate", 2, func(in *transfers.CreateInput) { in.Items[1].VariantID = 2 }, transfers.ErrInvalid},
		{"unknown_variant", 2, func(in *transfers.CreateInput) { in.Items[0].VariantID = 1000 }, transfers.ErrInvalid},
		{"missing_balance", 2, func(in *transfers.CreateInput) { in.Items[0].VariantID = 3 }, transfers.ErrInvalid},
		{"later_insufficient", 2, func(in *transfers.CreateInput) { in.Items[0].Quantity = math.MaxInt64 }, transfers.ErrInsufficientStock},
		{"branch_source_insufficient", 2, func(in *transfers.CreateInput) { in.CounterpartyID = 3; in.Items[1].Quantity = 10 }, transfers.ErrInsufficientStock},
		{"sending_branch_source_insufficient", 2, func(in *transfers.CreateInput) { in.Kind = transfers.SendToWarehouse; in.Items[0].Quantity = 6 }, transfers.ErrInsufficientStock},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.name == "missing_balance" {
				if _, err := p.Exec(ctx, "DELETE FROM inventory_balances WHERE location_id=1 AND variant_id=3"); err != nil {
					t.Fatal("test balance removal failed")
				}
			}
			in := input()
			tc.change(&in)
			_, err := s.Create(ctx, actor(tc.id), in)
			if !errors.Is(err, tc.want) {
				t.Fatal("invalid all-item request not refused")
			}
			if tc.name == "missing_balance" {
				if _, err := p.Exec(ctx, "INSERT INTO inventory_balances(location_id,variant_id,existing,reserved) VALUES(1,3,1,0)"); err != nil {
					t.Fatal("test balance restoration failed")
				}
			}
			if scalar(t, ctx, p, "SELECT count(*) FROM transfer_requests") != 0 || scalar(t, ctx, p, "SELECT count(*) FROM transfer_request_items") != 0 {
				t.Fatal("failed creation left partial records")
			}
			unchanged(t, before, stocks(t, ctx, p))
		})
	}
	// No trusted account binding exists merely because an identity has valid IDs.
	q := testpg.Open(t)
	if bootstrap.Initialize(ctx, q, config.LocalTrial) != nil {
		t.Fatal("unprovisioned test initialization failed")
	}
	if _, err := transfers.New(q).Create(ctx, actor(2), input()); !errors.Is(err, transfers.ErrForbidden) {
		t.Fatal("unprovisioned creator admitted")
	}
}
func testRetryAndParticipants(t *testing.T) {
	ctx, p, s := fixture(t)
	before := stocks(t, ctx, p)
	in := input()
	first := create(t, ctx, s, 2, in)
	in.Items[0], in.Items[1] = in.Items[1], in.Items[0]
	replay := create(t, ctx, s, 2, in)
	if !replay.Replayed || !reflect.DeepEqual(first.Request, replay.Request) {
		t.Fatal("canonical retry did not return original complete record")
	}
	changed := in
	changed.Items = append([]transfers.Line(nil), in.Items...)
	changed.Items[0].Quantity++
	if _, err := s.Create(ctx, actor(2), changed); !errors.Is(err, transfers.ErrRetryConflict) {
		t.Fatal("conflicting actor retry accepted")
	}
	other := create(t, ctx, s, 3, in)
	if other.Request.ID == first.Request.ID || other.Replayed {
		t.Fatal("retry key not actor scoped")
	}
	for _, id := range []int{1, 2} {
		got, err := s.Get(ctx, actor(id), first.Request.ID)
		if err != nil || !reflect.DeepEqual(got, first.Request) {
			t.Fatal("participant could not read complete request")
		}
	}
	for _, id := range []int64{first.Request.ID, math.MaxInt64} {
		if _, err := s.Get(ctx, actor(3), id); !errors.Is(err, transfers.ErrNotFound) {
			t.Fatal("third-account existence leaked")
		}
	}
	if _, err := s.Get(ctx, actor(0), first.Request.ID); !errors.Is(err, transfers.ErrForbidden) {
		t.Fatal("unassigned read admitted")
	}
	unchanged(t, before, stocks(t, ctx, p))
	// Only this test changes stock. A valid replay checks its immutable payload
	// first; a new key must revalidate the now unavailable physical source.
	if _, err := p.Exec(ctx, "UPDATE inventory_balances SET existing=0 WHERE location_id=1 AND variant_id IN (1,2)"); err != nil {
		t.Fatal("test stock decrease failed")
	}
	decreased := stocks(t, ctx, p)
	replay = create(t, ctx, s, 2, in)
	if !replay.Replayed || !reflect.DeepEqual(replay.Request, first.Request) {
		t.Fatal("stock decrease changed a legitimate retry")
	}
	in.RetryKey = "new-key-after-stock-decrease"
	if _, err := s.Create(ctx, actor(2), in); !errors.Is(err, transfers.ErrInsufficientStock) {
		t.Fatal("new request ignored decreased stock")
	}
	unchanged(t, decreased, stocks(t, ctx, p))
	if scalar(t, ctx, p, "SELECT count(*) FROM transfer_requests") != 2 {
		t.Fatal("retry created duplicate header")
	}
}
func testExactCatalog(t *testing.T) {
	ctx, p, s := fixture(t)
	var variant int64
	if p.QueryRow(ctx, "SELECT v.id FROM catalog_variants v JOIN catalog_entries e ON e.id=v.catalog_entry_id WHERE e.brand='TOYO_MOTO' AND e.model='12N6,5_3B' AND v.polarity='L'").Scan(&variant) != nil {
		t.Fatal("fractional catalog lookup failed")
	}
	if _, err := p.Exec(ctx, "UPDATE inventory_balances SET existing=$1,reserved=0 WHERE location_id=1 AND variant_id=$2", int64(math.MaxInt64), variant); err != nil {
		t.Fatal("exact test stock setup failed")
	}
	before := stocks(t, ctx, p)
	in := input()
	in.Items = []transfers.Line{{VariantID: variant, Quantity: math.MaxInt64}}
	r := create(t, ctx, s, 2, in)
	item := r.Request.Items[0]
	if item.Quantity != math.MaxInt64 || item.Capacity != "6.5" || item.Brand != "TOYO_MOTO" || item.Model != "12N6,5_3B" || item.Polarity != "L" {
		t.Fatal("catalog or bigint precision changed")
	}
	unchanged(t, before, stocks(t, ctx, p))
}
func testFullCart(t *testing.T) {
	ctx, p, s := fixture(t)
	if _, err := p.Exec(ctx, "UPDATE inventory_balances SET existing=GREATEST(existing,1) WHERE location_id=1"); err != nil {
		t.Fatal("owned full-cart stock setup failed")
	}
	before := stocks(t, ctx, p)
	in := input()
	in.Items = make([]transfers.Line, 190)
	for i := range in.Items {
		in.Items[i] = transfers.Line{VariantID: int64(190 - i), Quantity: 1}
	}
	r := create(t, ctx, s, 2, in)
	if len(r.Request.Items) != 190 || scalar(t, ctx, p, "SELECT count(*) FROM transfer_request_items") != 190 {
		t.Fatal("bounded complete cart not persisted")
	}
	for i, item := range r.Request.Items {
		if item.VariantID != int64(i+1) || item.Quantity != 1 || item.Capacity == "" {
			t.Fatal("complete cart item/canonical order changed")
		}
	}
	unchanged(t, before, stocks(t, ctx, p))
}

func testConcurrentReferences(t *testing.T) {
	ctx, p, s := fixture(t)
	before := stocks(t, ctx, p)
	if _, err := p.Exec(ctx, "SELECT setval('transfer_requests_id_seq',999,true)"); err != nil {
		t.Fatal("owned sequence boundary setup failed")
	}
	const workers = 8
	start := make(chan struct{})
	results := make(chan transfers.CreateResult, workers)
	errs := make(chan error, workers)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			in := input()
			in.RetryKey = fmt.Sprintf("parallel-global-key-%02d", i)
			// Each Pending may request the full available source quantity;
			// their aggregate is not a reservation or availability promise.
			in.Items[1].Quantity = 18
			if i%2 == 0 {
				in.Items[0], in.Items[1] = in.Items[1], in.Items[0]
			}
			r, err := s.Create(ctx, actor(2+i%2), in)
			results <- r
			errs <- err
		}(i)
	}
	close(start)
	wg.Wait()
	close(results)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal("parallel allocation failed")
		}
	}
	ids := map[int64]bool{}
	for r := range results {
		if ids[r.Request.ID] || r.Request.ID < 1000 || r.Request.Reference != fmt.Sprintf("TR-%03d", r.Request.ID) || r.Replayed {
			t.Fatal("global reference allocation collided or truncated")
		}
		ids[r.Request.ID] = true
	}
	if len(ids) != workers || scalar(t, ctx, p, "SELECT count(*) FROM transfer_requests") != workers || scalar(t, ctx, p, "SELECT count(*) FROM transfer_request_items") != workers*2 {
		t.Fatal("parallel allocation incomplete")
	}
	unchanged(t, before, stocks(t, ctx, p))
}
func testConcurrentRetry(t *testing.T) {
	ctx, p, s := fixture(t)
	before := stocks(t, ctx, p)
	const workers = 8
	start := make(chan struct{})
	results := make(chan transfers.CreateResult, workers)
	errs := make(chan error, workers)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			in := input()
			if i%2 == 0 {
				in.Items[0], in.Items[1] = in.Items[1], in.Items[0]
			}
			r, err := s.Create(ctx, actor(2), in)
			results <- r
			errs <- err
		}(i)
	}
	close(start)
	wg.Wait()
	close(results)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal("concurrent retry failed")
		}
	}
	var first int64
	originals := 0
	for r := range results {
		if first == 0 {
			first = r.Request.ID
		}
		if r.Request.ID != first {
			t.Fatal("concurrent retry created duplicate requests")
		}
		if !r.Replayed {
			originals++
		}
	}
	if originals != 1 || scalar(t, ctx, p, "SELECT count(*) FROM transfer_requests") != 1 || scalar(t, ctx, p, "SELECT count(*) FROM transfer_request_items") != 2 {
		t.Fatal("retry authority did not serialize actor/key")
	}
	// Two different canonical payloads racing the same new key: one winner,
	// one stable conflict, regardless of scheduling.
	key := "parallel-conflicting-retry-key"
	conflicts := make(chan error, 2)
	start = make(chan struct{})
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			in := input()
			in.RetryKey = key
			in.Items[0].Quantity += int64(i)
			_, err := s.Create(ctx, actor(2), in)
			conflicts <- err
		}(i)
	}
	close(start)
	wg.Wait()
	close(conflicts)
	wins, refusals := 0, 0
	for err := range conflicts {
		if err == nil {
			wins++
		} else if errors.Is(err, transfers.ErrRetryConflict) {
			refusals++
		} else {
			t.Fatal("conflicting concurrency returned unstable error")
		}
	}
	if wins != 1 || refusals != 1 || scalar(t, ctx, p, "SELECT count(*) FROM transfer_requests") != 2 {
		t.Fatal("conflicting payloads both committed")
	}
	unchanged(t, before, stocks(t, ctx, p))
}
func testRollback(t *testing.T) {
	ctx, p, s := fixture(t)
	before := stocks(t, ctx, p)
	if _, err := p.Exec(ctx, `CREATE FUNCTION fail_second_item() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.variant_id=2 THEN RAISE EXCEPTION 'injected item failure'; END IF; RETURN NEW; END $$;
  CREATE TRIGGER fail_second_item BEFORE INSERT ON transfer_request_items FOR EACH ROW EXECUTE FUNCTION fail_second_item()`); err != nil {
		t.Fatal("owned failure injection setup failed")
	}
	if _, err := s.Create(ctx, actor(2), input()); !errors.Is(err, transfers.ErrUnavailable) {
		t.Fatal("injected item failure did not roll back")
	}
	if scalar(t, ctx, p, "SELECT count(*) FROM transfer_requests") != 0 || scalar(t, ctx, p, "SELECT count(*) FROM transfer_request_items") != 0 {
		t.Fatal("failure after first item left partial records")
	}
	unchanged(t, before, stocks(t, ctx, p))
	if _, err := p.Exec(ctx, "ALTER TABLE transfer_request_items DISABLE TRIGGER fail_second_item"); err != nil {
		t.Fatal("owned injected trigger disable failed")
	}
	r := create(t, ctx, s, 2, input())
	if r.Replayed {
		t.Fatal("failed transaction retained retry key")
	}
	unchanged(t, before, stocks(t, ctx, p))
}
func sqlState(err error, code string) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == code
}
func testDatabaseGuards(t *testing.T) {
	ctx, p, s := fixture(t)
	before := stocks(t, ctx, p)
	r := create(t, ctx, s, 2, input())
	for _, query := range []string{
		"UPDATE transfer_requests SET status='pending'", "UPDATE transfer_requests SET retry_key='other-valid-retry-key'",
		"UPDATE transfer_requests SET origin_location_id=3", "UPDATE transfer_requests SET payload_sha256=decode(repeat('00',32),'hex')",
		"UPDATE transfer_requests SET id=id+100", "UPDATE transfer_requests SET created_at=now()", "DELETE FROM transfer_requests",
		"UPDATE transfer_request_items SET quantity=quantity+1", "DELETE FROM transfer_request_items", "TRUNCATE transfer_request_items", "TRUNCATE transfer_requests CASCADE",
	} {
		if _, err := p.Exec(ctx, query); err == nil {
			t.Fatal("immutable record mutation admitted")
		}
	}
	if _, err := p.Exec(ctx, "INSERT INTO transfer_request_items(request_id,variant_id,quantity) VALUES($1,3,1)", r.Request.ID); err == nil {
		t.Fatal("late item append admitted")
	}
	header := `INSERT INTO transfer_requests(creator_location_id,kind,origin_location_id,destination_location_id,approver_location_id,retry_key,payload_sha256)
 VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`
	for _, tc := range []struct {
		name                                   string
		creator, origin, destination, approver int
		kind                                   string
	}{
		{"warehouse_creator", 1, 2, 1, 2, "request_stock"}, {"self", 2, 2, 2, 2, "request_stock"},
		{"inverted_request", 2, 2, 1, 2, "request_stock"}, {"wrong_approver", 2, 1, 2, 3, "request_stock"},
		{"send_to_branch", 2, 2, 3, 3, "send_to_warehouse"}, {"invalid_kind", 2, 1, 2, 1, "approval"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tx, err := p.Begin(ctx)
			if err != nil {
				t.Fatal("constraint test begin failed")
			}
			defer tx.Rollback(ctx)
			var id int64
			err = tx.QueryRow(ctx, header, tc.creator, tc.kind, tc.origin, tc.destination, tc.approver, "direct-invalid-key-"+tc.name, make([]byte, 32)).Scan(&id)
			if !sqlState(err, "23514") {
				t.Fatal("direction/creator constraint not enforced at insert")
			}
		})
	}
	for _, tc := range []struct {
		name      string
		variant   int
		quantity  int64
		code      string
		duplicate bool
	}{
		{"zero_quantity", 1, 0, "23514", false}, {"negative_quantity", 1, -1, "23514", false},
		{"unknown_catalog", 1000, 1, "23503", false}, {"duplicate_variant", 1, 1, "23505", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tx, err := p.Begin(ctx)
			if err != nil {
				t.Fatal("item constraint begin failed")
			}
			defer tx.Rollback(ctx)
			var id int64
			if tx.QueryRow(ctx, header, 2, "request_stock", 1, 2, 1, "direct-item-key-"+tc.name, make([]byte, 32)).Scan(&id) != nil {
				t.Fatal("valid direct header failed")
			}
			if tc.duplicate {
				if _, err := tx.Exec(ctx, "INSERT INTO transfer_request_items VALUES($1,1,1)", id); err != nil {
					t.Fatal("direct first item failed")
				}
			}
			_, err = tx.Exec(ctx, "INSERT INTO transfer_request_items VALUES($1,$2,$3)", id, tc.variant, tc.quantity)
			if !sqlState(err, tc.code) {
				t.Fatal("direct item constraint not enforced")
			}
		})
	}
	for _, tc := range []struct {
		name        string
		id          int64
		status, key string
		digest      []byte
		code        string
	}{
		{"nonpositive_id", 0, "pending", "direct-valid-key-00001", make([]byte, 32), "23514"},
		{"status", 100, "approved", "direct-valid-key-00001", make([]byte, 32), "23514"},
		{"short_key", 100, "pending", "short", make([]byte, 32), "23514"},
		{"fingerprint", 100, "pending", "direct-valid-key-00001", []byte{0}, "23514"},
		{"duplicate_id", r.Request.ID, "pending", "direct-valid-key-00001", make([]byte, 32), "23505"},
		{"duplicate_actor_key", 100, "pending", input().RetryKey, make([]byte, 32), "23505"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := p.Exec(ctx, `INSERT INTO transfer_requests
			 (id,creator_location_id,kind,origin_location_id,destination_location_id,approver_location_id,retry_key,payload_sha256,status)
			 VALUES($1,2,'request_stock',1,2,1,$2,$3,$4)`, tc.id, tc.key, tc.digest, tc.status)
			if !sqlState(err, tc.code) {
				t.Fatal("header bound/uniqueness not enforced")
			}
		})
	}
	// Completeness is checked at commit, not merely through Store.Create.
	tx, err := p.Begin(ctx)
	if err != nil {
		t.Fatal("orphan header begin failed")
	}
	var id int64
	if tx.QueryRow(ctx, header, 2, "request_stock", 1, 2, 1, "direct-orphan-key-00001", make([]byte, 32)).Scan(&id) != nil {
		t.Fatal("orphan test header failed")
	}
	if err := tx.Commit(ctx); !sqlState(err, "23514") {
		t.Fatal("orphan header committed")
	}
	if scalar(t, ctx, p, "SELECT count(*) FROM transfer_requests") != 1 || scalar(t, ctx, p, "SELECT count(*) FROM transfer_request_items") != 2 {
		t.Fatal("SQL negatives changed requests")
	}
	if scalar(t, ctx, p, "SELECT count(*) FROM pg_sequences WHERE schemaname='public' AND sequencename='transfer_requests_id_seq' AND cycle=false") != 1 {
		t.Fatal("request sequence can cycle")
	}
	got, err := s.Get(ctx, actor(2), r.Request.ID)
	if err != nil || !reflect.DeepEqual(got, r.Request) {
		t.Fatal("SQL attempts changed complete request")
	}
	unchanged(t, before, stocks(t, ctx, p))
}

// This group is pure: the placeholder pool is never connected, queried or
// closed. Nil context must be rejected before the pool can be accessed.
func TestR01PendingDependencies(t *testing.T) {
	for _, tc := range []struct {
		name  string
		store *transfers.Store
		ctx   context.Context
	}{
		{"nil_context", transfers.New(&pgxpool.Pool{}), nil},
		{"nil_pool", transfers.New(nil), context.Background()},
		{"zero_store", &transfers.Store{}, context.Background()},
		{"nil_receiver", nil, context.Background()},
	} {
		t.Run(tc.name+"/Create", func(t *testing.T) {
			defer func() {
				if recover() != nil {
					t.Error("Create dependency boundary panicked")
				}
			}()
			result, err := tc.store.Create(tc.ctx, actor(2), input())
			if err != transfers.ErrUnavailable || !reflect.DeepEqual(result, transfers.CreateResult{}) {
				t.Fatal("Create dependency boundary did not return sanitized zero result")
			}
		})
		t.Run(tc.name+"/Get", func(t *testing.T) {
			defer func() {
				if recover() != nil {
					t.Error("Get dependency boundary panicked")
				}
			}()
			result, err := tc.store.Get(tc.ctx, actor(2), 1)
			if err != transfers.ErrUnavailable || !reflect.DeepEqual(result, transfers.Request{}) {
				t.Fatal("Get dependency boundary did not return sanitized zero result")
			}
		})
	}
}

func testStoreErrors(t *testing.T) {
	ctx, p, s := fixture(t)
	expired, cancel := context.WithDeadline(ctx, time.Now().Add(-time.Second))
	defer cancel()
	if _, err := s.Create(expired, actor(2), input()); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("creation deadline not propagated")
	}
	if _, err := s.Get(expired, actor(2), 1); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("read deadline not propagated")
	}
	if _, err := s.Get(ctx, actor(2), 0); !errors.Is(err, transfers.ErrNotFound) {
		t.Fatal("nonpositive lookup admitted")
	}
	p.Close()
	if _, err := s.Create(ctx, actor(2), input()); err != transfers.ErrUnavailable {
		t.Fatal("pool error was not sanitized")
	}
	if _, err := s.Get(ctx, actor(2), 1); err != transfers.ErrUnavailable {
		t.Fatal("read pool error was not sanitized")
	}
}

func waitStockLock(t *testing.T, ctx context.Context, p *pgxpool.Pool) {
	t.Helper()
	wait, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	for {
		var locked bool
		if p.QueryRow(wait, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
   AND wait_event_type='Lock' AND query LIKE 'SELECT b.variant_id,b.available%')`).Scan(&locked) != nil {
			t.Fatal("stock lock handshake query failed")
		}
		if locked {
			return
		}
		select {
		case <-wait.Done():
			t.Fatal("store never waited for source row lock")
		case <-time.After(5 * time.Millisecond):
		}
	}
}
func testLockedStock(t *testing.T) {
	ctx, p, s := fixture(t)
	before := stocks(t, ctx, p)
	tx, err := p.Begin(ctx)
	if err != nil {
		t.Fatal("test stock mutator begin failed")
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, "UPDATE inventory_balances SET existing=0 WHERE location_id=1 AND variant_id=1"); err != nil {
		t.Fatal("locked test stock update failed")
	}
	result := make(chan error, 1)
	go func() { _, err := s.Create(ctx, actor(2), input()); result <- err }()
	waitStockLock(t, ctx, p)
	if err := tx.Commit(ctx); err != nil {
		t.Fatal("test stock mutator commit failed")
	}
	if err := <-result; !errors.Is(err, transfers.ErrInsufficientStock) {
		t.Fatal("source mutation not revalidated under row lock")
	}
	expected := append([]stockRow(nil), before...)
	expected[0].Existing = 0
	expected[0].Available = 0
	unchanged(t, expected, stocks(t, ctx, p))
	if scalar(t, ctx, p, "SELECT count(*) FROM transfer_requests") != 0 {
		t.Fatal("locked insufficient creation committed")
	}
}
func testCanceledStock(t *testing.T) {
	ctx, p, s := fixture(t)
	before := stocks(t, ctx, p)
	tx, err := p.Begin(ctx)
	if err != nil {
		t.Fatal("cancellation blocker begin failed")
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, "SELECT 1 FROM inventory_balances WHERE location_id=1 AND variant_id=1 FOR UPDATE"); err != nil {
		t.Fatal("cancellation blocker lock failed")
	}
	canceled, cancel := context.WithCancel(ctx)
	defer cancel()
	result := make(chan error, 1)
	go func() { _, err := s.Create(canceled, actor(2), input()); result <- err }()
	waitStockLock(t, ctx, p)
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatal("cancellation was not propagated")
		}
	case <-ctx.Done():
		t.Fatal("canceled creation did not finish")
	}
	if tx.Rollback(ctx) != nil {
		t.Fatal("cancellation blocker release failed")
	}
	if scalar(t, ctx, p, "SELECT count(*) FROM transfer_requests") != 0 || scalar(t, ctx, p, "SELECT count(*) FROM transfer_request_items") != 0 {
		t.Fatal("canceled creation left rows")
	}
	unchanged(t, before, stocks(t, ctx, p))
	r := create(t, ctx, s, 2, input())
	if r.Replayed {
		t.Fatal("canceled transaction retained retry authority")
	}
	unchanged(t, before, stocks(t, ctx, p))
}
