package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"luson/api/internal/transfers"
)

func fenceSnapshot(t *testing.T, f *transferHTTPFixture) string {
	t.Helper()
	var value string
	if f.p.QueryRow(f.ctx, `SELECT jsonb_build_array(
 (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM transfer_requests r),
 (SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY request_id,variant_id),'[]') FROM transfer_request_items i),
 (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY request_id,variant_id),'[]') FROM transfer_request_allocations a),
 (SELECT jsonb_agg(to_jsonb(b) ORDER BY location_id,variant_id) FROM inventory_balances b))::text`).Scan(&value) != nil {
		t.Fatal("HTTP lifecycle snapshot failed")
	}
	return value
}

// Only real guarded transitions in the freshly admitted owned database.
func fenceDecision(t *testing.T, f *transferHTTPFixture, id, status string) {
	t.Helper()
	tx, err := f.p.BeginTx(f.ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		t.Fatal("HTTP outcome transaction begin failed")
	}
	defer tx.Rollback(context.Background())
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := tx.Exec(f.ctx, query, args...); err != nil {
			t.Fatal("HTTP guarded outcome setup failed")
		}
	}
	exec("SELECT pg_advisory_xact_lock(714025,1)")
	expectedStock := f.baseline
	if status == "approved" {
		if tx.QueryRow(f.ctx, `SELECT jsonb_agg(to_jsonb(b)||jsonb_build_object('reserved',b.reserved+coalesce(i.quantity,0),'available',b.available-coalesce(i.quantity,0)) ORDER BY b.location_id,b.variant_id)::text
 FROM inventory_balances b LEFT JOIN (SELECT i.* FROM transfer_request_items i JOIN transfer_requests r ON r.id=i.request_id WHERE i.request_id=$1) i
 ON b.variant_id=i.variant_id AND b.location_id=(SELECT origin_location_id FROM transfer_requests WHERE id=$1)`, id).Scan(&expectedStock) != nil {
			t.Fatal("expected reservation snapshot failed")
		}
		exec(`INSERT INTO transfer_request_allocations(request_id,variant_id,quantity)
 SELECT request_id,variant_id,quantity FROM transfer_request_items WHERE request_id=$1 ORDER BY variant_id`, id)
		exec(`UPDATE inventory_balances b SET reserved=b.reserved+i.quantity
 FROM transfer_request_items i JOIN transfer_requests r ON r.id=i.request_id
 WHERE i.request_id=$1 AND b.location_id=r.origin_location_id AND b.variant_id=i.variant_id`, id)
	}
	exec("UPDATE transfer_requests SET status=$2 WHERE id=$1", id, status)
	if tx.Commit(f.ctx) != nil {
		t.Fatal("HTTP guarded outcome commit failed")
	}
	var exact bool
	wantAllocations := 0
	if status == "approved" {
		wantAllocations = 2
	}
	if f.p.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM transfer_request_allocations WHERE request_id=$1)=$2 AND NOT EXISTS(
 SELECT 1 FROM transfer_request_allocations a JOIN transfer_request_items i USING(request_id,variant_id)
 WHERE a.request_id=$1 AND a.quantity<>i.quantity)`, id, wantAllocations).Scan(&exact) != nil || !exact || f.stock(t) != expectedStock {
		t.Fatal("guarded decision changed unexpected stock or owned allocations")
	}
	// Exact ownership and all 570 expected balances are proved before reset.
	f.baseline = expectedStock
}

func TestA01bPendingFence(t *testing.T) {
	for _, status := range []string{"approved", "rejected"} {
		for _, flow := range []struct {
			name, kind                        string
			counterparty, origin, destination int
		}{
			{"warehouse_request", "request_stock", 1, 1, 2},
			{"branch_request", "request_stock", 3, 3, 2},
			{"warehouse_proposal", "send_to_warehouse", 1, 2, 1},
		} {
			t.Run(status+"/"+flow.name, func(t *testing.T) {
				f := transferFixture(t)
				body := fmt.Sprintf(`{"kind":%q,"counterparty_location_id":%d,"retry_key":"fence-original-key-0001","items":[{"variant_id":2,"quantity":"1"},{"variant_id":1,"quantity":"1"}]}`, flow.kind, flow.counterparty)
				created := f.request(t, 2, "POST", "/api/transfers", body)
				terminal := transferWireRecord(t, created, 201)
				path := "/api/transfers/" + terminal.ID
				if created.Header().Get("Location") != path {
					t.Fatal("Pending creation Location changed")
				}
				pendingBody := strings.Replace(body, "fence-original-key-0001", "fence-pending-key-00001", 1)
				pendingCreate := f.request(t, 2, "POST", "/api/transfers", pendingBody)
				pending := transferWireRecord(t, pendingCreate, 201)
				pendingPath := "/api/transfers/" + pending.ID
				if pendingCreate.Header().Get("Location") != pendingPath {
					t.Fatal("second Pending Location changed")
				}
				fenceDecision(t, f, terminal.ID, status)
				before := fenceSnapshot(t, f)
				var decision int
				var decided time.Time
				if f.p.QueryRow(f.ctx, "SELECT decision_location_id,decided_at FROM transfer_requests WHERE id=$1", terminal.ID).Scan(&decision, &decided) != nil {
					t.Fatal("persisted HTTP decision unavailable")
				}
				want := transferObject(t, created, 201)
				want["status"] = json.RawMessage(fmt.Sprintf("%q", status))
				want["decision_location_id"] = json.RawMessage(fmt.Sprint(decision))
				want["decided_at"] = json.RawMessage(fmt.Sprintf("%q", decided.UTC().Format(time.RFC3339Nano)))
				check := func() {
					t.Helper()
					if fenceSnapshot(t, f) != before {
						t.Fatal("HTTP read/replay/error changed headers/items/allocations/balances")
					}
				}
				reordered := strings.Replace(body, `{"variant_id":2,"quantity":"1"},{"variant_id":1,"quantity":"1"}`, `{"variant_id":1,"quantity":"1"},{"variant_id":2,"quantity":"1"}`, 1)
				for _, call := range []struct {
					name, method, path, body string
					actor                    int
				}{
					{"origin_detail", "GET", path, "", flow.origin},
					{"destination_detail", "GET", path, "", flow.destination},
					{"creator_replay", "POST", "/api/transfers", reordered, 2},
				} {
					t.Run(call.name, func(t *testing.T) {
						w := f.request(t, call.actor, call.method, call.path, call.body)
						check()
						if !reflect.DeepEqual(transferObject(t, w, 200), want) {
							t.Fatal("full original terminal record or persisted metadata changed")
						}
						location := ""
						if call.method == "POST" {
							location = path
						}
						if w.Header().Get("Location") != location {
							t.Fatal("terminal detail/replay Location changed")
						}
					})
				}
				for participant := 1; participant <= 3; participant++ {
					visible := participant == flow.origin || participant == flow.destination
					if !visible {
						expectTransferError(t, f.request(t, participant, "GET", path, ""), 404, "not_found")
						check()
					}
					expectTransferError(t, f.request(t, participant, "GET", "/api/transfers/9223372036854775807", ""), 404, "not_found")
					check()
					if visible {
						detail := transferWireRecord(t, f.request(t, participant, "GET", pendingPath, ""), 200)
						if !reflect.DeepEqual(detail, pending) {
							t.Fatal("Pending participant detail changed")
						}
						check()
					}
					total, records := transferWirePage(t, f.request(t, participant, "GET", "/api/transfers", ""))
					if (visible && (total != 1 || len(records) != 1 || !reflect.DeepEqual(records[0], pending))) || (!visible && (total != 0 || len(records) != 0)) {
						t.Fatal("terminal included in Pending list/count")
					}
					check()
					counts := transferObject(t, f.request(t, participant, "GET", "/api/transfers/counts", ""), 200)
					pendingTotal, actions := `"0"`, `"0"`
					if visible {
						pendingTotal = `"1"`
						if participant == decision {
							actions = `"1"`
						}
					}
					if len(counts) != 2 || string(counts["pending_total"]) != pendingTotal || string(counts["action_count"]) != actions {
						t.Fatal("terminal count or physical participant action semantics incorrect")
					}
					check()
					page := transferObject(t, f.request(t, participant, "GET", "/api/transfers?status="+status, ""), 200)
					var terminalRecords []map[string]json.RawMessage
					if json.Unmarshal(page["records"], &terminalRecords) != nil || terminalRecords == nil || string(page["status"]) != fmt.Sprintf("%q", status) || (visible && (string(page["total_count"]) != `"1"` || len(terminalRecords) != 1 || !reflect.DeepEqual(terminalRecords[0], want))) || (!visible && (string(page["total_count"]) != `"0"` || len(terminalRecords) != 0)) {
						t.Fatal("terminal page private total/full record disagrees with detail/replay")
					}
					check()
				}
				replay := f.request(t, 2, "POST", "/api/transfers", pendingBody)
				if !reflect.DeepEqual(transferWireRecord(t, replay, 200), pending) || replay.Body.String() != pendingCreate.Body.String() || replay.Header().Get("Location") != pendingPath {
					t.Fatal("Pending replay whitelist/body/Location changed")
				}
				check()
				for _, call := range []struct {
					actor              int
					method, path, body string
					status             int
					code               string
				}{
					{0, "GET", path, "", 401, "unauthenticated"},
					{0, "POST", "/api/transfers", body, 401, "unauthenticated"},
					{2, "POST", "/api/transfers", `{}`, 400, "invalid_request"},
					{2, "POST", "/api/transfers", strings.Replace(body, `"quantity":"1"`, `"quantity":"2"`, 1), 409, "retry_conflict"},
					{1, "POST", "/api/transfers", body, 403, "forbidden"},
				} {
					expectTransferError(t, f.request(t, call.actor, call.method, call.path, call.body), call.status, call.code)
					check()
				}
				for _, guard := range []string{"Origin", "X-CSRF-Token"} {
					r := f.newRequest(2, "POST", "/api/transfers", body)
					r.Header.Set(guard, "invalid")
					expectTransferError(t, f.serve(t, r), 403, "forbidden")
					check()
				}
			})
		}
	}
}

func TestA04CountsHTTP(t *testing.T) {
	f := transferFixture(t)
	read := func(actor int, total, action string) {
		t.Helper()
		before, sessions := fenceSnapshot(t, f), passiveState(t, f)
		w := f.request(t, actor, "GET", "/api/transfers/counts", "")
		if w.Code != 200 || w.Body.String() != fmt.Sprintf("{\"pending_total\":%q,\"action_count\":%q}\n", total, action) || len(w.Header().Values("Set-Cookie")) != 0 || w.Header().Get("Location") != "" {
			t.Fatalf("exact count response mismatch: status=%d", w.Code)
		}
		if fenceSnapshot(t, f) != before || passiveState(t, f) != sessions {
			t.Fatal("counts changed state or touched session")
		}
	}
	read(1, "0", "0")
	f.request(t, 2, "POST", "/api/transfers", validTransferJSON)
	// Advancing a live session would expose an accidental Current idle touch.
	f.clock.Add(int64(time.Minute))
	read(1, "1", "1")
	read(2, "1", "0")
	read(3, "0", "0")
	for _, values := range [][]string{{"1"}, {"0"}, {"1", "1"}} {
		r := f.newRequest(2, "GET", "/api/transfers/counts", "")
		r.Header[passiveHeader] = values
		before := passiveState(t, f)
		w := f.serve(t, r)
		if len(values) == 1 && values[0] == "1" {
			if w.Code != 200 {
				t.Fatal("explicit passive count read failed")
			}
		} else {
			expectTransferError(t, w, 400, "invalid_request")
		}
		if passiveState(t, f) != before {
			t.Fatal("passive count selector touched session")
		}
	}
	for _, tc := range []struct {
		actor      int
		verb, path string
		status     int
		code       string
	}{
		{0, "GET", "/api/transfers/counts?actor=2", 401, "unauthenticated"},
		{2, "GET", "/api/transfers/counts?", 400, "invalid_request"},
		{2, "GET", "/api/transfers/counts?status=pending", 400, "invalid_request"},
		{2, "GET", "/api/transfers/counts?page=1", 400, "invalid_request"},
		{2, "GET", "/api/transfers/counts?location_id=1", 400, "invalid_request"},
		{2, "GET", "/api/transfers/%63ounts", 400, "invalid_request"},
		{2, "GET", "/api/transfers//counts", 404, "not_found"},
		{2, "GET", "/api/transfers/./counts", 404, "not_found"},
	} {
		expectTransferError(t, f.request(t, tc.actor, tc.verb, tc.path, ""), tc.status, tc.code)
	}
	for _, path := range []string{"/api/transfers/counts/", "/api/transfers/counts/1"} {
		w := f.request(t, 2, "GET", path, "")
		if w.Code != 404 || w.Header().Get("Location") != "" || len(w.Result().Cookies()) != 0 {
			t.Fatal("unknown count alias redirected or exposed a route")
		}
	}
	for _, verb := range []string{"POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"} {
		w := f.request(t, 0, verb, "/api/transfers/counts", "")
		expectTransferError(t, w, 405, "method_not_allowed")
		if w.Header().Get("Allow") != "GET" {
			t.Fatal("counts method Allow changed")
		}
	}
	for _, mode := range []string{"duplicate", "malformed", "revoked", "idle_expired", "absolute_expired"} {
		t.Run(mode, func(t *testing.T) {
			g := transferFixture(t)
			r := g.newRequest(2, "GET", "/api/transfers/counts", "")
			status, code := 401, "unauthenticated"
			switch mode {
			case "duplicate":
				r.AddCookie(&http.Cookie{Name: sessionCookie, Value: g.tokens[1]})
				status, code = 400, "invalid_request"
			case "malformed":
				r.Header.Set("Cookie", sessionCookie+"=bad")
			case "revoked":
				if _, err := g.p.Exec(g.ctx, "UPDATE auth_sessions SET revoked_at=created_at WHERE account_id=2"); err != nil {
					t.Fatal("owned revoke setup failed")
				}
			case "idle_expired":
				g.clock.Add(int64(31 * time.Minute))
			case "absolute_expired":
				g.clock.Add(int64(25 * time.Hour))
			}
			before := passiveState(t, g)
			expectTransferError(t, g.serve(t, r), status, code)
			if passiveState(t, g) != before {
				t.Fatal("failed count read touched session")
			}
		})
	}
}

func TestA04OutcomeEncoding(t *testing.T) {
	created := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	decided := created.Add(time.Second).In(time.FixedZone("offset", 3600))
	location, wrong, unbounded := 1, 2, 4
	for _, status := range []string{"approved", "rejected"} {
		valid := transfers.Request{Status: status, CreatedAt: created, DecisionLocationID: &location, DecidedAt: &decided}
		valid.Approver.ID = location
		dto, err := transferRecord(valid)
		if err != nil || dto.DecidedAt == nil || *dto.DecidedAt != "2026-01-01T12:00:01Z" {
			t.Fatal("persisted time was not canonicalized losslessly")
		}
		for _, change := range []func(*transfers.Request){
			func(r *transfers.Request) { r.DecisionLocationID = nil },
			func(r *transfers.Request) { r.DecidedAt = nil },
			func(r *transfers.Request) { r.DecisionLocationID = &wrong },
			func(r *transfers.Request) { r.DecisionLocationID = &unbounded },
			func(r *transfers.Request) { zero := time.Time{}; r.DecidedAt = &zero },
			func(r *transfers.Request) { earlier := created.Add(-time.Second); r.DecidedAt = &earlier },
			func(r *transfers.Request) { r.Status = "pending" },
			func(r *transfers.Request) { r.Status = "unknown" },
		} {
			invalid := valid
			change(&invalid)
			got, err := transferRecord(invalid)
			if err != transfers.ErrUnavailable || !reflect.DeepEqual(got, transferDTO{}) {
				t.Fatal("invalid internal metadata invented or exposed an outcome")
			}
			page, pageErr := transferPage(transfers.Page{Status: status, Records: []transfers.Request{valid, invalid}})
			if pageErr != transfers.ErrUnavailable || !reflect.DeepEqual(page, transferPageDTO{}) {
				t.Fatal("invalid list metadata exposed a partial page")
			}
			w := httptest.NewRecorder()
			transferFailure(w, err)
			expectTransferError(t, w, 503, "service_unavailable")
		}
	}
}
