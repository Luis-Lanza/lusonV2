package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
)

// Cancel after the real transition has credited stock, before COMMIT. The
// response and complete persistence/revision snapshots must remain unfinalized.
func receiptHTTPRollback(t *testing.T, f *transferHTTPFixture, transit transferDTO, body string) {
	t.Helper()
	g := &decisionTrace{match: "UPDATE transfer_requests SET status='received'", end: true, arrived: make(chan uint32, 1), release: make(chan struct{})}
	h := decisionTraced(t, f, g)
	ctx, cancel := context.WithCancel(f.ctx)
	defer cancel()
	r := f.newRequest(transit.DestinationLocationID, "POST", "/api/transfers/"+transit.ID+"/receive", body).WithContext(ctx)
	done := make(chan *httptest.ResponseRecorder, 1)
	joined := false
	var once sync.Once
	release := func() { once.Do(func() { close(g.release) }) }
	t.Cleanup(func() {
		cancel()
		release()
		if !joined {
			<-done
		}
	})
	go func() { w := httptest.NewRecorder(); h.ServeHTTP(w, r); done <- w }()
	decisionArrived(t, f, g)
	cancel()
	release()
	w := <-done
	joined = true
	expectTransferError(t, w, 503, "service_unavailable")
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.updates != 1 || g.commit || !g.rollback {
		t.Fatal("receipt cancellation did not roll back a real successful transition")
	}
}

func TestR1ReceiptEvents(t *testing.T) {
	for _, mode := range []string{"expected_credit", "unexpected_only"} {
		t.Run(mode, func(t *testing.T) {
			env := eventFixture(t)
			f := env.f
			transit := receiptHTTPDispatch(t, f, "request_stock", 1)
			path := "/api/transfers/" + transit.ID
			server := eventServer(t, env)
			clients := []*eventClient{openEvents(t, env, server, 1, ""), openEvents(t, env, server, 2, ""), openEvents(t, env, server, 3, "")}
			t.Cleanup(func() {
				for _, client := range clients {
					client.close()
				}
				server.Close()
			})
			for _, client := range clients {
				expectHTTPEvent(t, client, "resync")
			}
			eventBoundary(t, env, clients, [][]string{nil, nil, nil})
			body := receiptExactBody
			credit1, credit2 := int64(1), int64(1)
			if mode == "unexpected_only" {
				body = `{"items":[{"variant_id":1,"actual_quantity":"0"},{"variant_id":2,"actual_quantity":"0"},{"variant_id":3,"actual_quantity":"7"}]}`
				credit1, credit2 = 0, 0
			}
			before, revisions := receiptHTTPState(t, f), decisionRevisions(t, f)
			receiptHTTPRollback(t, f, transit, body)
			if receiptHTTPState(t, f) != before || decisionRevisions(t, f) != revisions {
				t.Fatal("receipt rollback leaked state/revisions")
			}
			expectTransferError(t, decisionNetwork(t, f, server, f.newRequest(2, "POST", path+"/receive", `{"items":[{"variant_id":1,"actual_quantity":"0"},{"variant_id":2,"actual_quantity":"0"}]}`)), 400, "invalid_request")
			eventBoundary(t, env, clients, [][]string{nil, nil, nil})
			metadata := decisionListen(t, f)
			proof := receiptHTTPProof(t, f, transit, credit1, credit2)
			w := decisionNetwork(t, f, server, f.newRequest(2, "POST", path+"/receive", body))
			proof(w)
			want := transferObject(t, w, 200)
			raw := []string{"transfers:1", "transfers:2"}
			expected := [][]string{{"transfers"}, {"transfers"}, nil}
			if mode == "expected_credit" {
				revisions[0] += 2
				raw = append([]string{"inventory:0"}, raw...)
				expected = [][]string{{"inventory", "transfers"}, {"inventory", "transfers"}, {"inventory"}}
			}
			revisions[1]++
			revisions[2]++
			for _, payload := range raw {
				n, err := metadata.WaitForNotification(f.ctx)
				if err != nil || n.Channel != "luson_realtime" || n.Payload != payload {
					t.Fatal("receipt metadata changed/leaked", err)
				}
			}
			eventBoundary(t, env, clients, expected)
			if decisionRevisions(t, f) != revisions {
				t.Fatal("receipt exact revision scopes mismatch")
			}
			decisionLiveViews(t, f, server, transit, "received", want)
			settled := receiptHTTPState(t, f)
			for _, call := range []struct {
				actor        int
				action, body string
			}{{2, "receive", body}, {1, "approve", "{}"}, {1, "dispatch", "{}"}} {
				got := decisionNetwork(t, f, server, f.newRequest(call.actor, "POST", path+"/"+call.action, call.body))
				if !reflect.DeepEqual(transferObject(t, got, 200), want) {
					t.Fatal("live received retry changed immutable DTO")
				}
			}
			changed := strings.Replace(body, `"actual_quantity":"1"`, `"actual_quantity":"2"`, 1)
			if mode == "unexpected_only" {
				changed = strings.Replace(body, `"actual_quantity":"7"`, `"actual_quantity":"8"`, 1)
			}
			expectTransferError(t, decisionNetwork(t, f, server, f.newRequest(2, "POST", path+"/receive", changed)), 409, "retry_conflict")
			expectTransferError(t, decisionNetwork(t, f, server, f.newRequest(1, "POST", path+"/reject", "{}")), 409, "decision_conflict")
			if receiptHTTPState(t, f) != settled || decisionRevisions(t, f) != revisions {
				t.Fatal("received retries/conflicts emitted mutation")
			}
			eventBoundary(t, env, clients, [][]string{nil, nil, nil})
			for _, client := range clients {
				client.close()
			}
			server.Close()
		})
	}
}

func TestR1ReceiptDeferredFailureEvents(t *testing.T) {
	env := eventFixture(t)
	f := env.f
	transit := receiptHTTPDispatch(t, f, "request_stock", 1)
	if _, err := f.p.Exec(f.ctx, `CREATE SEQUENCE r1_receipt_failure_seen; CREATE FUNCTION r1_receipt_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='received' THEN PERFORM nextval('r1_receipt_failure_seen'); RAISE EXCEPTION 'receipt commit failure'; END IF; RETURN NULL; END $$; CREATE CONSTRAINT TRIGGER r1_receipt_commit_failure AFTER UPDATE ON transfer_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION r1_receipt_commit_failure()`); err != nil {
		t.Fatal("receipt commit failure injection")
	}
	server := eventServer(t, env)
	clients := []*eventClient{openEvents(t, env, server, 1, ""), openEvents(t, env, server, 2, ""), openEvents(t, env, server, 3, "")}
	t.Cleanup(func() {
		for _, client := range clients {
			client.close()
		}
		server.Close()
	})
	for _, client := range clients {
		expectHTTPEvent(t, client, "resync")
	}
	eventBoundary(t, env, clients, [][]string{nil, nil, nil})
	before, revisions := receiptHTTPState(t, f), decisionRevisions(t, f)
	g := &decisionTrace{}
	mutationServer := httptest.NewServer(decisionTraced(t, f, g))
	t.Cleanup(mutationServer.Close)
	w := decisionNetwork(t, f, mutationServer, f.newRequest(2, "POST", "/api/transfers/"+transit.ID+"/receive", receiptExactBody))
	expectTransferError(t, w, 503, "service_unavailable")
	g.mu.Lock()
	var reached bool
	observed := f.p.QueryRow(f.ctx, "SELECT is_called AND last_value=1 FROM r1_receipt_failure_seen").Scan(&reached) == nil
	validStages := g.updates == 1 && g.reloads == 2 && g.commit && !g.commitOK
	g.mu.Unlock()
	if !observed || !reached || !validStages {
		t.Fatal("receipt failure did not reach its successful transition/reload and deferred failed commit")
	}
	mutationServer.Close()
	if receiptHTTPState(t, f) != before || decisionRevisions(t, f) != revisions {
		t.Fatal("failed commit leaked receipt or inventory invalidation")
	}
	var received transferDTO
	response := f.request(t, 2, "GET", fmt.Sprintf("/api/transfers/%s", transit.ID), "")
	if json.Unmarshal(response.Body.Bytes(), &received) != nil || !reflect.DeepEqual(received, transit) {
		t.Fatal("failed receipt GET exposed partial outcome")
	}
	eventBoundary(t, env, clients, [][]string{nil, nil, nil})
	for _, client := range clients {
		client.close()
	}
	server.Close()
}
