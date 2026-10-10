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

	"github.com/jackc/pgx/v5"
)

// Network requests use the real server while the existing SSE clients stay live.
func decisionNetwork(t *testing.T, f *transferHTTPFixture, server *httptest.Server, r *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	wire, err := http.NewRequestWithContext(f.ctx, r.Method, server.URL+r.URL.RequestURI(), r.Body)
	if err != nil {
		t.Fatal("live decision request construction failed")
	}
	wire.Header = r.Header.Clone()
	response, err := server.Client().Do(wire)
	if err != nil {
		t.Fatal("live decision HTTP transport failed")
	}
	defer response.Body.Close()
	if response.Header.Get("Cache-Control") != "no-store" || response.Header.Get("X-Content-Type-Options") != "nosniff" || response.Header.Get("Access-Control-Allow-Origin") != "" || len(response.Cookies()) != 0 {
		t.Fatal("live decision/refetch security headers changed")
	}
	w := httptest.NewRecorder()
	for key, values := range response.Header {
		w.Header()[key] = append([]string(nil), values...)
	}
	w.WriteHeader(response.StatusCode)
	if _, err := io.Copy(w, response.Body); err != nil {
		t.Fatal("live decision response read failed")
	}
	return w
}

func decisionRevisions(t *testing.T, f *transferHTTPFixture) [4]int64 {
	t.Helper()
	var values []int64
	if f.p.QueryRow(f.ctx, "SELECT array_agg(revision ORDER BY scope) FROM realtime_revisions").Scan(&values) != nil || len(values) != 4 {
		t.Fatal("complete internal revision snapshot failed")
	}
	return [4]int64{values[0], values[1], values[2], values[3]}
}

func decisionLiveViews(t *testing.T, f *transferHTTPFixture, server *httptest.Server, original transferDTO, status string, want map[string]json.RawMessage) {
	t.Helper()
	for actor := 1; actor <= 3; actor++ {
		visible := actor == original.OriginLocationID || actor == original.DestinationLocationID
		detail := decisionNetwork(t, f, server, f.newRequest(actor, "GET", "/api/transfers/"+original.ID, ""))
		if visible {
			if !reflect.DeepEqual(transferObject(t, detail, 200), want) {
				t.Fatal("participant SSE detail refetch differs from full response")
			}
		} else {
			expectTransferError(t, detail, 404, "not_found")
		}
		for _, selected := range []string{"pending", "approved", "rejected", "in_transit", "received"} {
			page := transferObject(t, decisionNetwork(t, f, server, f.newRequest(actor, "GET", "/api/transfers?status="+selected, "")), 200)
			var rows []map[string]json.RawMessage
			var total string
			expected := "0"
			if visible && selected == status {
				expected = "1"
			}
			if json.Unmarshal(page["records"], &rows) != nil || json.Unmarshal(page["total_count"], &total) != nil || total != expected || fmt.Sprint(len(rows)) != expected {
				t.Fatal("participant SSE status-list refetch has incorrect exact total")
			}
			if expected == "1" && !reflect.DeepEqual(rows[0], want) {
				t.Fatal("SSE list did not retain original full immutable payload")
			}
		}
		counts := transferObject(t, decisionNetwork(t, f, server, f.newRequest(actor, "GET", "/api/transfers/counts", "")), 200)
		pending, action := `"0"`, `"0"`
		if status == "pending" && visible {
			pending = `"1"`
		}
		if (status == "pending" && actor == original.ApproverLocationID) ||
			(status == "approved" && actor == original.OriginLocationID) ||
			(status == "in_transit" && actor == original.DestinationLocationID) {
			action = `"1"`
		}
		if len(counts) != 2 || string(counts["pending_total"]) != pending || string(counts["action_count"]) != action {
			t.Fatal("Pending/workflow count does not match the persisted location-owned obligation")
		}
	}
	f.unchanged(t)
}

func decisionListen(t *testing.T, f *transferHTTPFixture) *pgx.Conn {
	t.Helper()
	c, err := pgx.ConnectConfig(f.ctx, f.p.Config().ConnConfig.Copy())
	if err != nil {
		t.Fatal("owned metadata listener failed")
	}
	t.Cleanup(func() {
		if c.Close(context.Background()) != nil {
			t.Error("metadata listener close failed")
		}
	})
	if _, err := c.Exec(f.ctx, "LISTEN luson_realtime"); err != nil {
		t.Fatal("metadata LISTEN failed")
	}
	return c
}

func TestA04DecisionLive(t *testing.T) {
	for _, action := range []string{"approve", "reject"} {
		for _, flow := range []struct {
			name, kind   string
			counterparty int
		}{
			{"warehouse_request", "request_stock", 1},
			{"branch_request", "request_stock", 3},
			{"warehouse_proposal", "send_to_warehouse", 1},
		} {
			t.Run(action+"/"+flow.name, func(t *testing.T) {
				env := eventFixture(t)
				f := env.f
				original := decisionCreate(t, f, flow.kind, flow.counterparty, "decision-live-key-00001")
				server := eventServer(t, env)
				clients := []*eventClient{
					openEvents(t, env, server, 1, ""),
					openEvents(t, env, server, 2, ""),
					openEvents(t, env, server, 3, ""),
				}
				for _, client := range clients {
					expectHTTPEvent(t, client, "resync")
				}
				eventBoundary(t, env, clients, [][]string{nil, nil, nil})
				path := "/api/transfers/" + original.ID
				pending := transferObject(t, f.request(t, 2, "GET", path, ""), 200)
				beforeState := fenceSnapshot(t, f)
				decisionLiveViews(t, f, server, original, "pending", pending)
				if fenceSnapshot(t, f) != beforeState {
					t.Fatal("predecision refetch mutated Pending")
				}
				revisions := decisionRevisions(t, f)
				metadata := decisionListen(t, f)
				t.Cleanup(func() {
					for _, client := range clients {
						client.close()
					}
					server.Close()
				})
				proof := decisionProof(t, f, original)
				w := decisionNetwork(t, f, server, f.newRequest(original.ApproverLocationID, "POST", path+"/"+action, "{}"))
				proof(w)
				want := transferObject(t, w, 200)
				status := "rejected"
				var expected [3][]string
				var raw []string
				if action == "approve" {
					status = "approved"
					revisions[0] += 2 // two actual changed balance rows, one coalesced hint
					raw = append(raw, "inventory:0")
					for i := range expected {
						expected[i] = append(expected[i], "inventory")
					}
				}
				for actor := 1; actor <= 3; actor++ {
					if actor == original.OriginLocationID || actor == original.DestinationLocationID {
						expected[actor-1] = append(expected[actor-1], "transfers")
						raw = append(raw, fmt.Sprintf("transfers:%d", actor))
						revisions[actor]++
					}
				}
				for _, payload := range raw {
					n, err := metadata.WaitForNotification(f.ctx)
					if err != nil || n.Channel != "luson_realtime" || n.Payload != payload {
						t.Fatal("committed inventory/private transfer metadata changed or leaked payload")
					}
				}
				eventBoundary(t, env, clients, expected[:])
				if decisionRevisions(t, f) != revisions {
					t.Fatal("committed revisions did not increment exact affected scopes once")
				}
				decisionLiveViews(t, f, server, original, status, want)
				settled := fenceSnapshot(t, f)
				replay := fmt.Sprintf(`{"kind":%q,"counterparty_location_id":%d,"retry_key":"decision-live-key-00001","items":[{"variant_id":1,"quantity":"1"},{"variant_id":2,"quantity":"1"}]}`, flow.kind, flow.counterparty)
				for _, call := range []struct {
					actor      int
					path, body string
				}{
					{original.ApproverLocationID, path + "/" + action, "{}"},
					{2, "/api/transfers", replay},
				} {
					got := decisionNetwork(t, f, server, f.newRequest(call.actor, "POST", call.path, call.body))
					if !reflect.DeepEqual(transferObject(t, got, 200), want) {
						t.Fatal("live retry/original replay changed metadata/items")
					}
					if call.path == "/api/transfers" && got.Header().Get("Location") != path {
						t.Fatal("original live replay Location changed")
					}
				}
				opposite := "approve"
				if action == "approve" {
					opposite = "reject"
				}
				expectTransferError(t, decisionNetwork(t, f, server, f.newRequest(original.ApproverLocationID, "POST", path+"/"+opposite, "{}")), 409, "decision_conflict")
				expectTransferError(t, decisionNetwork(t, f, server, f.newRequest(2, "POST", "/api/transfers", strings.Replace(replay, `"quantity":"1"`, `"quantity":"2"`, 1))), 409, "retry_conflict")
				if fenceSnapshot(t, f) != settled || decisionRevisions(t, f) != revisions {
					t.Fatal("live retries/conflicts changed committed state/revisions")
				}
				eventBoundary(t, env, clients, [][]string{nil, nil, nil})
				for _, client := range clients {
					client.close()
				}
				server.Close() // joins HTTP handlers before broker/listener/owned DB cleanup
			})
		}
	}
}

// Cancel after the actual status UPDATE succeeded, before commit. Release and
// join the guarded HTTP worker, not merely its client context, before assertions.
func decisionHTTPRollback(t *testing.T, f *transferHTTPFixture, original transferDTO, action string) {
	t.Helper()
	g := &decisionTrace{match: "UPDATE transfer_requests SET status=", end: true, arrived: make(chan uint32, 1), release: make(chan struct{})}
	h := decisionTraced(t, f, g)
	ctx, cancel := context.WithCancel(f.ctx)
	r := f.newRequest(original.ApproverLocationID, "POST", "/api/transfers/"+original.ID+"/"+action, "{}").WithContext(ctx)
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		done <- w
	}()
	joined := false
	var released sync.Once
	unblock := func() { released.Do(func() { close(g.release) }) }
	t.Cleanup(func() {
		cancel()
		unblock()
		if !joined {
			<-done
		}
	})
	decisionArrived(t, f, g)
	cancel()
	unblock()
	w := <-done
	joined = true
	expectTransferError(t, w, 503, "service_unavailable")
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.updates != 1 || g.commit || !g.rollback {
		t.Fatal("explicit rollback did not follow actual successful status UPDATE before COMMIT")
	}
}

func TestA04DecisionLiveRefusals(t *testing.T) {
	for _, flow := range []struct {
		name, kind   string
		counterparty int
	}{
		{"warehouse_request", "request_stock", 1},
		{"branch_request", "request_stock", 3},
		{"warehouse_proposal", "send_to_warehouse", 1},
	} {
		for _, action := range []string{"approve", "reject"} {
			for _, mode := range []string{"rollback", "deferred_commit", "later_item_shortage"} {
				if mode == "later_item_shortage" && action == "reject" {
					continue
				}
				t.Run(flow.name+"/"+action+"/"+mode, func(t *testing.T) {
					env := eventFixture(t)
					f := env.f
					original := decisionCreate(t, f, flow.kind, flow.counterparty, "decision-live-failure-0001")
					if mode == "later_item_shortage" {
						decisionExhaust(t, f, original, true)
					}
					if mode == "deferred_commit" {
						decisionFailure(t, f)
					}
					server := eventServer(t, env)
					clients := []*eventClient{openEvents(t, env, server, 1, ""), openEvents(t, env, server, 2, ""), openEvents(t, env, server, 3, "")}
					for _, client := range clients {
						expectHTTPEvent(t, client, "resync")
					}
					eventBoundary(t, env, clients, [][]string{nil, nil, nil})
					before := fenceSnapshot(t, f)
					revisions := decisionRevisions(t, f)
					switch mode {
					case "rollback":
						decisionHTTPRollback(t, f, original, action)
					case "deferred_commit":
						g := &decisionTrace{}
						mutationServer := httptest.NewServer(decisionTraced(t, f, g))
						t.Cleanup(mutationServer.Close)
						w := decisionNetwork(t, f, mutationServer, f.newRequest(original.ApproverLocationID, "POST", "/api/transfers/"+original.ID+"/"+action, "{}"))
						expectTransferError(t, w, 503, "service_unavailable")
						decisionFailureProof(t, f, g)
						mutationServer.Close()
					case "later_item_shortage":
						w := decisionNetwork(t, f, server, f.newRequest(original.ApproverLocationID, "POST", "/api/transfers/"+original.ID+"/approve", "{}"))
						expectTransferError(t, w, 409, "insufficient_stock")
					}
					if fenceSnapshot(t, f) != before || decisionRevisions(t, f) != revisions {
						t.Fatal("failed decision left lifecycle/stock/allocation/revision effects")
					}
					if !reflect.DeepEqual(transferWireRecord(t, f.request(t, 2, "GET", "/api/transfers/"+original.ID, ""), 200), original) {
						t.Fatal("failed decision GET exposed partial terminal payload")
					}
					pending := transferObject(t, f.request(t, 2, "GET", "/api/transfers/"+original.ID, ""), 200)
					decisionLiveViews(t, f, server, original, "pending", pending)
					eventBoundary(t, env, clients, [][]string{nil, nil, nil})
					for _, client := range clients {
						client.close()
					}
					server.Close()
				})
			}
		}
	}
}
