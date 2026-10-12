package httpapi

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"reflect"
	"testing"
)

func TestC01CancellationEvents(t *testing.T) {
	for _, approved := range []bool{false, true} {
		name := "pending"
		if approved {
			name = "approved"
		}
		t.Run(name, func(t *testing.T) {
			env := eventFixture(t)
			f := env.f
			original := decisionCreate(t, f, "request_stock", 1, "cancel-events-http-key-01")
			path := "/api/transfers/" + original.ID
			if approved {
				w := decisionServe(t, f, f.newRequest(1, "POST", path+"/approve", "{}"), original)
				if json.Unmarshal(w.Body.Bytes(), &original) != nil {
					t.Fatal("events approval setup failed")
				}
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
			before, revisions := fenceSnapshot(t, f), decisionRevisions(t, f)

			// Cancel a real completed UPDATE (and Approved release) before commit.
			g := &decisionTrace{match: "UPDATE transfer_requests SET status=", end: true, arrived: make(chan uint32, 1), release: make(chan struct{})}
			h := decisionTraced(t, f, g)
			ctx, cancel := context.WithCancel(f.ctx)
			defer cancel()
			done := make(chan *httptest.ResponseRecorder, 1)
			go func() {
				w := httptest.NewRecorder()
				h.ServeHTTP(w, f.newRequest(2, "POST", path+"/cancel", "{}").WithContext(ctx))
				done <- w
			}()
			decisionArrived(t, f, g)
			cancel()
			close(g.release)
			expectTransferError(t, <-done, 503, "service_unavailable")
			g.mu.Lock()
			rolledBack := g.updates == 1 && g.rollback && !g.commit
			g.mu.Unlock()
			if !rolledBack || fenceSnapshot(t, f) != before || decisionRevisions(t, f) != revisions {
				t.Fatal("successful cancellation UPDATE rollback leaked state/revisions")
			}
			eventBoundary(t, env, clients, [][]string{nil, nil, nil})

			// A deferred failure must suppress notifications as well as undo the
			// entire release. The sequence proves the commit guard was reached.
			decisionExec(t, f, `CREATE SEQUENCE c01_event_failure_seen;
 CREATE FUNCTION c01_event_fail() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN IF NEW.status='cancelled' THEN PERFORM nextval('c01_event_failure_seen');
 RAISE EXCEPTION 'injected cancellation commit failure'; END IF; RETURN NULL; END $$;
 CREATE CONSTRAINT TRIGGER c01_event_fail AFTER UPDATE ON transfer_requests DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION c01_event_fail()`)
			expectTransferError(t, f.request(t, 2, "POST", path+"/cancel", "{}"), 503, "service_unavailable")
			var reached bool
			if f.p.QueryRow(f.ctx, "SELECT is_called FROM c01_event_failure_seen").Scan(&reached) != nil || !reached || fenceSnapshot(t, f) != before || decisionRevisions(t, f) != revisions {
				t.Fatal("deferred cancellation failure leaked state/revisions or missed commit guard")
			}
			eventBoundary(t, env, clients, [][]string{nil, nil, nil})
			decisionExec(t, f, "DROP TRIGGER c01_event_fail ON transfer_requests")

			metadata := decisionListen(t, f)
			var proof func(*httptest.ResponseRecorder)
			if approved {
				proof = cancellationProof(t, f, original)
			}
			w := decisionNetwork(t, f, server, f.newRequest(2, "POST", path+"/cancel", "{}"))
			if approved {
				proof(w)
			} else {
				f.unchanged(t)
			}
			want := transferObject(t, w, 200)
			cancellationMetadata(t, f, original.ID, want, 2)
			expected := [][]string{{"transfers"}, {"transfers"}, nil}
			payloads := []string{"transfers:1", "transfers:2"}
			if approved {
				revisions[0] += 2
				expected = [][]string{{"inventory", "transfers"}, {"inventory", "transfers"}, {"inventory"}}
				payloads = append([]string{"inventory:0"}, payloads...)
			}
			revisions[1]++
			revisions[2]++
			for _, payload := range payloads {
				n, err := metadata.WaitForNotification(f.ctx)
				if err != nil || n.Channel != "luson_realtime" || n.Payload != payload {
					t.Fatal("cancellation notification changed or leaked request payload")
				}
			}
			eventBoundary(t, env, clients, expected)
			if decisionRevisions(t, f) != revisions {
				t.Fatal("cancellation changed incorrect revision scopes")
			}
			decisionLiveViews(t, f, server, original, "cancelled", want)
			before = fenceSnapshot(t, f)
			if !reflect.DeepEqual(transferObject(t, f.request(t, 2, "POST", path+"/cancel", "{}"), 200), want) {
				t.Fatal("cancellation retry lost history")
			}
			expectTransferError(t, f.request(t, 1, "POST", path+"/cancel", "{}"), 403, "forbidden")
			if fenceSnapshot(t, f) != before || decisionRevisions(t, f) != revisions {
				t.Fatal("retry/refusal emitted a mutation")
			}
			eventBoundary(t, env, clients, [][]string{nil, nil, nil})
			for _, client := range clients {
				client.close()
			}
			server.Close()
		})
	}
}
