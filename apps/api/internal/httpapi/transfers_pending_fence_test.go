package httpapi

import (
	"context"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
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
	if status == "approved" {
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
	// transferFixture checks every request and cleanup against this baseline.
	f.baseline = f.stock(t)
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
						expectTransferError(t, w, 503, "service_unavailable")
						if w.Header().Get("Location") != "" {
							t.Fatal("terminal response leaked Location")
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
