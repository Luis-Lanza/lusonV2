package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/inventory"
	"luson/api/internal/transfers"
)

// Decision tests use the real authenticated HTTP route, never SQL status setup.
func decisionCreate(t *testing.T, f *transferHTTPFixture, kind string, counterparty int, key string) transferDTO {
	t.Helper()
	body := fmt.Sprintf(`{"kind":%q,"counterparty_location_id":%d,"retry_key":%q,"items":[{"variant_id":2,"quantity":"1"},{"variant_id":1,"quantity":"1"}]}`, kind, counterparty, key)
	return transferWireRecord(t, f.request(t, 2, "POST", "/api/transfers", body), 201)
}

// Approval is the sole HTTP operation allowed to change this fixture baseline.
// Prove the full balance transformation, exact owned set and immutable payload
// before resetting it; the historical serve/cleanup invariance checks stay on.
func decisionServe(t *testing.T, f *transferHTTPFixture, r *http.Request, original transferDTO) *httptest.ResponseRecorder {
	t.Helper()
	proof := decisionProof(t, f, original)
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	proof(w)
	return w
}

// Capture before launching any worker; verify before accepting a new baseline.
func decisionProof(t *testing.T, f *transferHTTPFixture, original transferDTO) func(*httptest.ResponseRecorder) {
	t.Helper()
	before := fenceSnapshot(t, f)
	items, unrelated := decisionRows(t, f, original.ID)
	var expected string
	if err := f.p.QueryRow(f.ctx, `SELECT jsonb_agg(to_jsonb(b)||jsonb_build_object(
 'reserved',b.reserved+coalesce(i.quantity,0),
 'available',b.available-coalesce(i.quantity,0)) ORDER BY b.location_id,b.variant_id)::text
 FROM inventory_balances b LEFT JOIN transfer_request_items i
 ON i.request_id=$1 AND i.variant_id=b.variant_id AND b.location_id=$2`, original.ID, original.OriginLocationID).Scan(&expected); err != nil {
		t.Fatal("expected full reservation transformation unavailable")
	}
	return func(w *httptest.ResponseRecorder) {
		if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Content-Type-Options") != "nosniff" || w.Header().Get("Access-Control-Allow-Origin") != "" || len(w.Result().Cookies()) != 0 {
			t.Fatal("decision response security headers changed")
		}
		if w.Code != 200 {
			if fenceSnapshot(t, f) != before {
				t.Fatal("refused decision changed lifecycle or stock")
			}
			f.unchanged(t)
			return
		}
		var result transferDTO
		if json.Unmarshal(w.Body.Bytes(), &result) != nil {
			t.Fatal("decision response not JSON")
		}
		gotItems, gotUnrelated := decisionRows(t, f, original.ID)
		if gotItems != items || gotUnrelated != unrelated {
			t.Fatal("decision changed persisted immutable items or unrelated allocations")
		}
		decisionOriginal(t, original, result)
		if result.Status == "approved" {
			var exact bool
			if f.p.QueryRow(f.ctx, `SELECT
 (SELECT count(*) FROM transfer_request_allocations WHERE request_id=$1)=2
 AND NOT EXISTS(SELECT 1 FROM transfer_request_items i
 LEFT JOIN transfer_request_allocations a USING(request_id,variant_id)
 WHERE i.request_id=$1 AND (a.request_id IS NULL OR a.quantity<>i.quantity))
 AND NOT EXISTS(SELECT 1 FROM transfer_request_allocations a
 LEFT JOIN transfer_request_items i USING(request_id,variant_id)
 WHERE a.request_id=$1 AND i.request_id IS NULL)`, original.ID).Scan(&exact) != nil || !exact || f.stock(t) != expected {
				t.Fatal("approval changed unexpected balances or owned allocation set")
			}
			f.baseline = expected
		} else {
			var empty bool
			if f.p.QueryRow(f.ctx, "SELECT count(*)=0 FROM transfer_request_allocations WHERE request_id=$1", original.ID).Scan(&empty) != nil || !empty {
				t.Fatal("rejection created owned allocations")
			}
			f.unchanged(t)
		}
	}
}

func decisionRows(t *testing.T, f *transferHTTPFixture, id string) (string, string) {
	t.Helper()
	var items, unrelated string
	if f.p.QueryRow(f.ctx, `SELECT
 (SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY request_id,variant_id),'[]')::text FROM transfer_request_items i),
 (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY request_id,variant_id),'[]')::text FROM transfer_request_allocations a WHERE request_id<>$1)`, id).Scan(&items, &unrelated) != nil {
		t.Fatal("complete immutable item and unrelated allocation snapshot failed")
	}
	return items, unrelated
}

func decisionOriginal(t *testing.T, original, result transferDTO) {
	t.Helper()
	if result.Status != "approved" && result.Status != "rejected" {
		t.Fatal("decision did not return a terminal outcome")
	}
	if result.DecisionLocationID == nil || *result.DecisionLocationID != original.ApproverLocationID || result.DecidedAt == nil {
		t.Fatal("decision actor/time not server persisted")
	}
	stamp, err := time.Parse(time.RFC3339Nano, *result.DecidedAt)
	if err != nil || stamp.UTC().Format(time.RFC3339Nano) != *result.DecidedAt || !strings.HasSuffix(*result.DecidedAt, "Z") {
		t.Fatal("decision timestamp not canonical UTC")
	}
	result.Status = "pending"
	result.DecisionLocationID = nil
	result.DecidedAt = nil
	if !reflect.DeepEqual(result, original) {
		t.Fatal("decision changed immutable original fields or items")
	}
}

func TestA04DecisionOutcomes(t *testing.T) {
	for _, action := range []string{"approve", "reject"} {
		for _, flow := range []struct {
			name, kind             string
			counterparty, approver int
		}{
			{"warehouse_request", "request_stock", 1, 1},
			{"branch_request", "request_stock", 3, 3},
			{"warehouse_proposal", "send_to_warehouse", 1, 1},
		} {
			t.Run(action+"/"+flow.name, func(t *testing.T) {
				f := transferFixture(t)
				original := decisionCreate(t, f, flow.kind, flow.counterparty, "decision-original-key-0001")
				path := "/api/transfers/" + original.ID
				before := fenceSnapshot(t, f)
				for actor := 1; actor <= 3; actor++ {
					if actor == flow.approver {
						continue
					}
					status, code := 403, "forbidden"
					if actor != original.OriginLocationID && actor != original.DestinationLocationID {
						status, code = 404, "not_found"
					}
					expectTransferError(t, f.request(t, actor, "POST", path+"/"+action, "{}"), status, code)
					if fenceSnapshot(t, f) != before {
						t.Fatal("privacy refusal mutated request")
					}
				}
				w := decisionServe(t, f, f.newRequest(flow.approver, "POST", path+"/"+action, " \n{}\t"), original)
				want := transferObject(t, w, 200)
				var outcome transferDTO
				if json.Unmarshal(w.Body.Bytes(), &outcome) != nil {
					t.Fatal("invalid decision DTO")
				}
				decisionOriginal(t, original, outcome)
				var actor int
				var stamp time.Time
				if f.p.QueryRow(f.ctx, "SELECT decision_location_id,decided_at FROM transfer_requests WHERE id=$1", original.ID).Scan(&actor, &stamp) != nil || actor != *outcome.DecisionLocationID || stamp.UTC().Format(time.RFC3339Nano) != *outcome.DecidedAt {
					t.Fatal("response metadata differs from persisted outcome")
				}
				settled := fenceSnapshot(t, f)
				for _, call := range []struct {
					actor              int
					method, path, body string
				}{
					{flow.approver, "POST", path + "/" + action, "{}"},
					{original.OriginLocationID, "GET", path, ""},
					{original.DestinationLocationID, "GET", path, ""},
				} {
					got := f.request(t, call.actor, call.method, call.path, call.body)
					if !reflect.DeepEqual(transferObject(t, got, 200), want) || fenceSnapshot(t, f) != settled {
						t.Fatal("retry/lost reply recovery changed original outcome or stock")
					}
				}
				opposite := "approve"
				if action == "approve" {
					opposite = "reject"
				}
				expectTransferError(t, f.request(t, flow.approver, "POST", path+"/"+opposite, "{}"), 409, "decision_conflict")
				if fenceSnapshot(t, f) != settled {
					t.Fatal("opposite decision changed outcome")
				}
				replay := fmt.Sprintf(`{"kind":%q,"counterparty_location_id":%d,"retry_key":"decision-original-key-0001","items":[{"variant_id":1,"quantity":"1"},{"variant_id":2,"quantity":"1"}]}`, flow.kind, flow.counterparty)
				got := f.request(t, 2, "POST", "/api/transfers", replay)
				if !reflect.DeepEqual(transferObject(t, got, 200), want) || got.Header().Get("Location") != path {
					t.Fatal("original creation replay lost terminal payload")
				}
				expectTransferError(t, f.request(t, 2, "POST", "/api/transfers", strings.Replace(replay, `"quantity":"1"`, `"quantity":"2"`, 1)), 409, "retry_conflict")
				if fenceSnapshot(t, f) != settled {
					t.Fatal("creation replay/conflict mutated outcome")
				}
			})
		}
	}
}

func TestA04DecisionGuards(t *testing.T) {
	for _, action := range []string{"approve", "reject"} {
		t.Run(action, func(t *testing.T) {
			f := transferFixture(t)
			original := decisionCreate(t, f, "request_stock", 1, "decision-security-key-0001")
			path := "/api/transfers/" + original.ID + "/" + action
			before := fenceSnapshot(t, f)
			check := func(t *testing.T, r *http.Request, status int, code string) {
				t.Helper()
				w := f.serve(t, r)
				expectTransferError(t, w, status, code)
				if fenceSnapshot(t, f) != before {
					t.Fatal("refusal changed lifecycle/items/allocations/balances")
				}
			}
			for _, verb := range []string{"GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"} {
				t.Run("method/"+verb, func(t *testing.T) {
					w := f.request(t, 0, verb, path, "bad body")
					expectTransferError(t, w, 405, "method_not_allowed")
					if w.Header().Get("Allow") != "POST" || fenceSnapshot(t, f) != before {
						t.Fatal("decision method admission or invariance changed")
					}
				})
			}
			for name, id := range map[string]string{
				"zero": "0", "padded": "01", "signed": "+1", "negative": "-1",
				"exponent": "1e0", "overflow": "9223372036854775808", "text": "unknown",
			} {
				t.Run("id/"+name, func(t *testing.T) {
					check(t, f.newRequest(1, "POST", "/api/transfers/"+id+"/"+action, "{}"), 400, "invalid_request")
					check(t, f.newRequest(0, "POST", "/api/transfers/"+id+"/"+action+"?x=y", "bad"), 401, "unauthenticated")
				})
			}
			check(t, f.newRequest(1, "POST", "/api/transfers/9223372036854775807/"+action, "{}"), 404, "not_found")
			for _, query := range []string{"?", "?x=y", "?location_id=1"} {
				check(t, f.newRequest(1, "POST", path+query, "{}"), 400, "invalid_request")
			}
			for _, alias := range []struct {
				path   string
				status int
				code   string
			}{
				{"/api/transfers//" + original.ID + "/" + action, 404, "not_found"},
				{"/api/transfers/./" + original.ID + "/" + action, 404, "not_found"},
				{"/api/transfers/../" + original.ID + "/" + action, 404, "not_found"},
				{"/api/transfers/%31/" + action, 400, "invalid_request"},
				{"/api/transfers/" + original.ID + "/%" + fmt.Sprintf("%x", action[0]) + action[1:], 400, "invalid_request"},
			} {
				check(t, f.newRequest(0, "POST", alias.path, "bad"), alias.status, alias.code)
			}
			// Dispatch is now a known guarded mutation. This request is still
			// Pending, so its origin receives a deliberate lifecycle conflict.
			check(t, f.newRequest(original.OriginLocationID, "POST", "/api/transfers/"+original.ID+"/dispatch", "{}"), 409, "decision_conflict")
			check(t, f.newRequest(original.DestinationLocationID, "POST", "/api/transfers/"+original.ID+"/receive", `{"items":[{"variant_id":1,"actual_quantity":"1"},{"variant_id":2,"actual_quantity":"1"}]}`), 409, "decision_conflict")
			for _, unknown := range []string{path + "/", path + "/extra", "/api/transfers/" + original.ID + "/cancel"} {
				w := f.request(t, 1, "POST", unknown, "{}")
				if w.Code != 404 || len(w.Result().Cookies()) != 0 || fenceSnapshot(t, f) != before {
					t.Fatal("unknown operation/trailing segment admitted")
				}
			}
			for _, name := range []string{"no_cookie", "duplicate_cookie", "bad_cookie", "origin_missing", "origin_bad", "origin_duplicate", "fetch_bad", "fetch_duplicate", "csrf_missing", "csrf_bad", "csrf_duplicate"} {
				t.Run("identity_guard/"+name, func(t *testing.T) {
					r := f.newRequest(1, "POST", "/api/transfers/invalid/"+action+"?", "not JSON")
					status, code := 403, "forbidden"
					switch name {
					case "no_cookie":
						r.Header.Del("Cookie")
						status, code = 401, "unauthenticated"
					case "duplicate_cookie":
						r.AddCookie(&http.Cookie{Name: sessionCookie, Value: f.tokens[0]})
						status, code = 400, "invalid_request"
					case "bad_cookie":
						r.Header.Set("Cookie", sessionCookie+"=invalid")
						status, code = 401, "unauthenticated"
					case "origin_missing":
						r.Header.Del("Origin")
					case "origin_bad":
						r.Header.Set("Origin", "http://foreign.test")
					case "origin_duplicate":
						r.Header.Add("Origin", f.cfg.Origin)
					case "fetch_bad":
						r.Header.Set("Sec-Fetch-Site", "cross-site")
					case "fetch_duplicate":
						r.Header.Add("Sec-Fetch-Site", "same-origin")
					case "csrf_missing":
						r.Header.Del("X-CSRF-Token")
					case "csrf_bad":
						r.Header.Set("X-CSRF-Token", "invalid")
					case "csrf_duplicate":
						r.Header.Add("X-CSRF-Token", auth.CSRF(f.tokens[0]))
					}
					check(t, r, status, code)
				})
			}
			for name, body := range map[string]string{
				"unknown_key": `{"unknown":1}`, "actor": `{"decision_location_id":1}`,
				"reason": `{"reason":"no"}`, "duplicate": `{"x":1,"x":1}`,
				"escaped": `{"\u0078":1}`, "escaped_duplicate": `{"x":1,"\u0078":1}`,
				"array": `[]`, "null": `null`, "missing": "", "truncated": "{",
				"trailing_object": `{} {}`, "trailing_scalar": `{} true`, "utf8": "{}\xff",
				"oversized": "{}" + strings.Repeat(" ", (64<<10)-1),
			} {
				t.Run("body/"+name, func(t *testing.T) {
					check(t, f.newRequest(1, "POST", path, body), 400, "invalid_request")
				})
			}
			for i, headers := range [][]string{
				nil, {"text/json"}, {"application/json", "application/json"},
				{"application/json; charset=latin1"}, {"application/json; x=y"},
				{"application/json; charset=utf-8; charset=utf-8"},
				{"application/json; charset=\""}, {"application/json;"},
			} {
				t.Run(fmt.Sprintf("content_type/%d", i), func(t *testing.T) {
					r := f.newRequest(1, "POST", path, "{}")
					r.Header.Del("Content-Type")
					for _, header := range headers {
						r.Header.Add("Content-Type", header)
					}
					check(t, r, 400, "invalid_request")
				})
			}
			readFailure := f.newRequest(1, "POST", path, "{}")
			readFailure.Body = io.NopCloser(transferErrorReader{})
			check(t, readFailure, 400, "invalid_request")
			// A 64 KiB empty-object framing is valid. Use a visible nonapprover
			// so acceptance is proved by the domain 403 without changing stock.
			boundary := f.newRequest(2, "POST", path, "{}"+strings.Repeat(" ", (64<<10)-2))
			boundary.Header.Set("Content-Type", "application/json; charset=UTF-8")
			boundary.Header.Del("Sec-Fetch-Site")
			check(t, boundary, 403, "forbidden")
			for _, mode := range []string{"revoked", "expired"} {
				t.Run(mode, func(t *testing.T) {
					g := transferFixture(t)
					if mode == "revoked" {
						if g.svc.Logout(g.ctx, g.tokens[0]) != nil {
							t.Fatal("owned session revocation failed")
						}
					} else {
						g.clock.Add(int64(auth.AbsoluteTTL + time.Second))
					}
					expectTransferError(t, g.request(t, 1, "POST", "/api/transfers/invalid/"+action+"?", "bad"), 401, "unauthenticated")
				})
			}
		})
	}
}

// Connection-local instrumentation observes real SQL stages, not production
// hooks. Gates pause only after a successful UPDATE while its locks are held.
type decisionTraceKey struct{}
type decisionTrace struct {
	match            string
	end              bool
	arrived          chan uint32
	release          chan struct{}
	once             sync.Once
	mu               sync.Mutex
	updates, reloads int
	commit, commitOK bool
	rollback         bool
}

func (g *decisionTrace) TraceQueryStart(ctx context.Context, c *pgx.Conn, d pgx.TraceQueryStartData) context.Context {
	if g.arrived != nil && !g.end && strings.Contains(d.SQL, g.match) {
		g.once.Do(func() { g.arrived <- c.PgConn().PID() })
	}
	return context.WithValue(ctx, decisionTraceKey{}, d.SQL)
}

func (g *decisionTrace) TraceQueryEnd(ctx context.Context, c *pgx.Conn, d pgx.TraceQueryEndData) {
	sql, _ := ctx.Value(decisionTraceKey{}).(string)
	g.mu.Lock()
	if strings.Contains(sql, "UPDATE transfer_requests SET status=") && d.Err == nil {
		g.updates++
	}
	if strings.Contains(sql, "FROM transfer_request_items i") && d.Err == nil {
		g.reloads++
	}
	if strings.EqualFold(sql, "commit") {
		g.commit, g.commitOK = true, d.Err == nil
	}
	if strings.EqualFold(sql, "rollback") && d.Err == nil {
		g.rollback = true
	}
	g.mu.Unlock()
	if g.arrived != nil && g.end && strings.Contains(sql, g.match) && d.Err == nil {
		g.once.Do(func() {
			g.arrived <- c.PgConn().PID()
			select {
			case <-g.release:
			case <-ctx.Done():
			}
		})
	}
}

func decisionTraced(t *testing.T, f *transferHTTPFixture, g *decisionTrace) http.Handler {
	t.Helper()
	cfg := f.p.Config().Copy()
	cfg.ConnConfig.Tracer = g
	p, err := pgxpool.NewWithConfig(f.ctx, cfg)
	if err != nil {
		t.Fatal("owned HTTP tracer pool failed")
	}
	t.Cleanup(p.Close)
	h, err := NewWithTransfers(f.svc, f.cfg, inventory.New(f.p), transfers.New(p))
	if err != nil {
		t.Fatal("traced guarded HTTP composition failed")
	}
	return h
}

func decisionArrived(t *testing.T, f *transferHTTPFixture, g *decisionTrace) uint32 {
	t.Helper()
	select {
	case pid := <-g.arrived:
		return pid
	case <-f.ctx.Done():
		t.Fatal("HTTP SQL stage handshake did not arrive")
		return 0
	}
}

func decisionWait(t *testing.T, f *transferHTTPFixture, pid uint32) {
	t.Helper()
	ctx, cancel := context.WithTimeout(f.ctx, 5*time.Second)
	defer cancel()
	for {
		var blocked bool
		if f.p.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock' AND wait_event='advisory')", pid).Scan(&blocked) != nil {
			t.Fatal("guarded HTTP reservation wait handshake failed")
		}
		if blocked {
			return
		}
	}
}

func TestA04DecisionConcurrency(t *testing.T) {
	for _, actions := range [][2]string{{"approve", "approve"}, {"reject", "reject"}, {"approve", "reject"}, {"reject", "approve"}} {
		t.Run(actions[0]+"_then_"+actions[1], func(t *testing.T) {
			f := transferFixture(t)
			other := decisionCreate(t, f, "request_stock", 1, "decision-race-owned-key-01")
			transferObject(t, decisionServe(t, f, f.newRequest(1, "POST", "/api/transfers/"+other.ID+"/approve", "{}"), other), 200)
			original := decisionCreate(t, f, "request_stock", 1, "decision-race-pending-0001")
			proof := decisionProof(t, f, original)
			winner := &decisionTrace{match: "UPDATE transfer_requests SET status=", end: true, arrived: make(chan uint32, 1), release: make(chan struct{})}
			loser := &decisionTrace{match: "pg_advisory_xact_lock(714025,1)", arrived: make(chan uint32, 1)}
			firstHandler, secondHandler := decisionTraced(t, f, winner), decisionTraced(t, f, loser)
			var release sync.Once
			unblock := func() { release.Do(func() { close(winner.release) }) }
			start := func(h http.Handler, action string) <-chan *httptest.ResponseRecorder {
				done := make(chan *httptest.ResponseRecorder, 1)
				r := f.newRequest(1, "POST", "/api/transfers/"+original.ID+"/"+action, "{}")
				go func() {
					w := httptest.NewRecorder()
					h.ServeHTTP(w, r)
					done <- w
				}()
				return done
			}
			one := start(firstHandler, actions[0])
			var two <-chan *httptest.ResponseRecorder
			firstRead, secondRead := false, false
			t.Cleanup(func() {
				unblock()
				if !firstRead {
					<-one
				}
				if two != nil && !secondRead {
					<-two
				}
			})
			decisionArrived(t, f, winner)
			two = start(secondHandler, actions[1])
			decisionWait(t, f, decisionArrived(t, f, loser))
			unblock()
			first := <-one
			firstRead = true
			second := <-two
			secondRead = true
			proof(first)
			want := transferObject(t, first, 200)
			if actions[0] == actions[1] {
				if !reflect.DeepEqual(transferObject(t, second, 200), want) {
					t.Fatal("concurrent same action changed persisted metadata")
				}
			} else {
				expectTransferError(t, second, 409, "decision_conflict")
			}
			settled := fenceSnapshot(t, f)
			for _, call := range []struct{ method, path, body string }{
				{"GET", "/api/transfers/" + original.ID, ""},
				{"POST", "/api/transfers/" + original.ID + "/" + actions[0], "{}"},
			} {
				if !reflect.DeepEqual(transferObject(t, f.request(t, 1, call.method, call.path, call.body), 200), want) || fenceSnapshot(t, f) != settled {
					t.Fatal("race did not persist exactly one stable whole outcome")
				}
			}
		})
	}
}

func decisionExec(t *testing.T, f *transferHTTPFixture, sql string, args ...any) {
	t.Helper()
	if _, err := f.p.Exec(f.ctx, sql, args...); err != nil {
		t.Fatal("owned decision test instrumentation failed")
	}
}

// Controlled inventory setup, with full expected 570-row proof before reset.
func decisionExhaust(t *testing.T, f *transferHTTPFixture, original transferDTO, laterOnly bool) {
	t.Helper()
	if laterOnly {
		var firstAvailable bool
		if f.p.QueryRow(f.ctx, "SELECT available>=1 FROM inventory_balances WHERE location_id=$1 AND variant_id=1", original.OriginLocationID).Scan(&firstAvailable) != nil || !firstAvailable {
			t.Fatal("later-item shortage did not preserve first-item availability")
		}
	}
	var expected string
	if f.p.QueryRow(f.ctx, `SELECT jsonb_agg(CASE WHEN location_id=$1 AND
 (variant_id=2 OR (variant_id=1 AND NOT $2)) THEN to_jsonb(b)||
 jsonb_build_object('reserved',existing,'available',0) ELSE to_jsonb(b) END
 ORDER BY location_id,variant_id)::text FROM inventory_balances b`, original.OriginLocationID, laterOnly).Scan(&expected) != nil {
		t.Fatal("expected exhaustion snapshot failed")
	}
	decisionExec(t, f, "UPDATE inventory_balances SET reserved=existing WHERE location_id=$1 AND (variant_id=2 OR (variant_id=1 AND NOT $2))", original.OriginLocationID, laterOnly)
	if f.stock(t) != expected {
		t.Fatal("exhaustion changed physical/destination/unrelated balances")
	}
	f.baseline = expected
}

func decisionFailure(t *testing.T, f *transferHTTPFixture) {
	t.Helper()
	decisionExec(t, f, "CREATE SEQUENCE a04_failure_seen")
	decisionExec(t, f, `CREATE FUNCTION a04_fail_decision() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
 IF NEW.status IN ('approved','rejected') THEN
   PERFORM nextval('a04_failure_seen');
   RAISE EXCEPTION 'private injected decision failure' USING ERRCODE='P0001';
 END IF;
 RETURN NEW;
 END $$`)
	decisionExec(t, f, `CREATE CONSTRAINT TRIGGER a04_fail_decision AFTER UPDATE ON transfer_requests
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION a04_fail_decision()`)
}

func decisionFailureProof(t *testing.T, f *transferHTTPFixture, g *decisionTrace) {
	t.Helper()
	g.mu.Lock()
	defer g.mu.Unlock()
	var reached bool
	if f.p.QueryRow(f.ctx, "SELECT is_called AND last_value=1 FROM a04_failure_seen").Scan(&reached) != nil || !reached || g.updates != 1 || g.reloads != 2 || !g.commit || g.commitOK {
		t.Fatal("HTTP deferred failure did not follow successful status UPDATE/reload and failed COMMIT")
	}
}

func TestA04DecisionFailuresAndAuthority(t *testing.T) {
	for _, action := range []string{"approve", "reject"} {
		t.Run(action+"/deferred_commit", func(t *testing.T) {
			f := transferFixture(t)
			original := decisionCreate(t, f, "request_stock", 1, "decision-commit-key-00001")
			decisionFailure(t, f)
			g := &decisionTrace{}
			f.handler = decisionTraced(t, f, g)
			before := fenceSnapshot(t, f)
			expectTransferError(t, f.request(t, 1, "POST", "/api/transfers/"+original.ID+"/"+action, "{}"), 503, "service_unavailable")
			decisionFailureProof(t, f, g)
			if fenceSnapshot(t, f) != before || !reflect.DeepEqual(transferWireRecord(t, f.request(t, 2, "GET", "/api/transfers/"+original.ID, ""), 200), original) {
				t.Fatal("failed HTTP COMMIT exposed a partial outcome or left writes")
			}
		})
		t.Run(action+"/touching_current_and_exhausted_retry", func(t *testing.T) {
			f := transferFixture(t)
			original := decisionCreate(t, f, "request_stock", 1, "decision-current-key-0001")
			before := passiveState(t, f)
			f.clock.Add(int64(5 * time.Minute))
			r := f.newRequest(1, "POST", "/api/transfers/"+original.ID+"/"+action, "{}")
			r.Header.Set(passiveHeader, "1")
			w := decisionServe(t, f, r, original)
			want := transferObject(t, w, 200)
			var touched bool
			if passiveState(t, f) == before || f.p.QueryRow(f.ctx, "SELECT count(*)=1 FROM auth_sessions WHERE last_seen_at=$1 AND idle_deadline=$2", time.Unix(0, f.clock.Load()).UTC(), time.Unix(0, f.clock.Load()).UTC().Add(auth.IdleTTL)).Scan(&touched) != nil || !touched {
				t.Fatal("POST passive selector bypassed touching Current")
			}
			decisionExhaust(t, f, original, false)
			settled := fenceSnapshot(t, f)
			if !reflect.DeepEqual(transferObject(t, f.request(t, 1, "POST", "/api/transfers/"+original.ID+"/"+action, "{}"), 200), want) || fenceSnapshot(t, f) != settled {
				t.Fatal("same action retry revalidated exhausted stock or changed outcome")
			}
		})
		t.Run(action+"/canceled_context", func(t *testing.T) {
			f := transferFixture(t)
			original := decisionCreate(t, f, "request_stock", 1, "decision-context-key-0001")
			r := f.newRequest(1, "POST", "/api/transfers/"+original.ID+"/"+action, "{}")
			ctx, cancel := context.WithCancel(r.Context())
			cancel()
			before := fenceSnapshot(t, f)
			expectTransferError(t, f.serve(t, r.WithContext(ctx)), 503, "service_unavailable")
			if fenceSnapshot(t, f) != before {
				t.Fatal("canceled HTTP request changed state")
			}
		})
		t.Run(action+"/backend_unavailable", func(t *testing.T) {
			f := transferFixture(t)
			original := decisionCreate(t, f, "request_stock", 1, "decision-backend-key-0001")
			h, err := NewWithTransfers(f.svc, f.cfg, inventory.New(f.p), transfers.New(nil))
			if err != nil {
				t.Fatal("unavailable store HTTP setup failed")
			}
			f.handler = h
			before := fenceSnapshot(t, f)
			expectTransferError(t, f.request(t, 1, "POST", "/api/transfers/"+original.ID+"/"+action, "{}"), 503, "service_unavailable")
			if fenceSnapshot(t, f) != before {
				t.Fatal("unavailable backend changed state")
			}
		})
	}
}

func TestA04DecisionBlockedContext(t *testing.T) {
	for _, action := range []string{"approve", "reject"} {
		t.Run(action, func(t *testing.T) {
			f := transferFixture(t)
			original := decisionCreate(t, f, "request_stock", 1, "decision-blocked-key-0001")
			before := fenceSnapshot(t, f)
			blocker, err := f.p.Begin(f.ctx)
			if err != nil {
				t.Fatal("owned advisory blocker begin failed")
			}
			t.Cleanup(func() { _ = blocker.Rollback(context.Background()) })
			if _, err := blocker.Exec(f.ctx, "SELECT pg_advisory_xact_lock(714025,1)"); err != nil {
				t.Fatal("owned advisory blocker failed")
			}
			g := &decisionTrace{match: "pg_advisory_xact_lock(714025,1)", arrived: make(chan uint32, 1)}
			h := decisionTraced(t, f, g)
			ctx, cancel := context.WithCancel(f.ctx)
			r := f.newRequest(1, "POST", "/api/transfers/"+original.ID+"/"+action, "{}").WithContext(ctx)
			done := make(chan *httptest.ResponseRecorder, 1)
			go func() {
				w := httptest.NewRecorder()
				h.ServeHTTP(w, r)
				done <- w
			}()
			joined := false
			t.Cleanup(func() {
				cancel()
				if !joined {
					<-done
				}
			})
			decisionWait(t, f, decisionArrived(t, f, g))
			cancel()
			w := <-done
			joined = true
			expectTransferError(t, w, 503, "service_unavailable")
			if blocker.Rollback(f.ctx) != nil {
				t.Fatal("owned advisory blocker rollback failed")
			}
			if fenceSnapshot(t, f) != before {
				t.Fatal("canceled guarded domain wait left effects")
			}
			f.unchanged(t)
			// Expired request context is separately refused, without needing a
			// timing-dependent deadline race or substituting another identity.
			expired, stop := context.WithDeadline(f.ctx, time.Now().Add(-time.Second))
			defer stop()
			expectTransferError(t, f.serve(t, f.newRequest(1, "POST", "/api/transfers/"+original.ID+"/"+action, "{}").WithContext(expired)), 503, "service_unavailable")
			if fenceSnapshot(t, f) != before {
				t.Fatal("expired guarded context left effects")
			}
		})
	}
}
