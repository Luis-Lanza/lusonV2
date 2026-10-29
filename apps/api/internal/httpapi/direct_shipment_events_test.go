package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"reflect"
	"sync"
	"testing"
)

func w01HTTPBody(destination int) string {
	return fmt.Sprintf(`{"kind":"direct_shipment","counterparty_location_id":%d,"retry_key":"w01-live-direct-create","items":[{"variant_id":2,"quantity":"1"},{"variant_id":1,"quantity":"2"}]}`, destination)
}

// Prove every balance and the exact active ownership before changing the old
// fixture baseline. This helper never substitutes an approval for creation.
func w01HTTPProof(t *testing.T, f *transferHTTPFixture, destination int) func(*httptest.ResponseRecorder) transferDTO {
	t.Helper()
	var expected string
	if f.p.QueryRow(f.ctx, `SELECT jsonb_agg(to_jsonb(b)||jsonb_build_object(
 'reserved',b.reserved+coalesce(i.quantity,0),'available',b.available-coalesce(i.quantity,0))
 ORDER BY b.location_id,b.variant_id)::text FROM inventory_balances b
 LEFT JOIN (VALUES(1,2::bigint),(2,1::bigint)) i(variant_id,quantity)
 ON i.variant_id=b.variant_id AND b.location_id=1`).Scan(&expected) != nil {
		t.Fatal("direct expected stock unavailable")
	}
	return func(w *httptest.ResponseRecorder) transferDTO {
		obj := transferObject(t, w, 201)
		var dto transferDTO
		if transferBusinessFieldCount(t, obj) != 16 || json.Unmarshal(w.Body.Bytes(), &dto) != nil || dto.Kind != "direct_shipment" || dto.Status != "approved" || dto.CreatorLocationID != 1 || dto.OriginLocationID != 1 || dto.ApproverLocationID != 1 || dto.DestinationLocationID != destination || dto.DecisionLocationID == nil || *dto.DecisionLocationID != 1 || dto.DecidedAt == nil || *dto.DecidedAt != dto.CreatedAt || len(dto.Items) != 2 {
			t.Fatal("direct initial response does not retain creation authorization")
		}
		if len(dto.Activity) != 1 || dto.Activity[0].Action != "create" || dto.Activity[0].Actor.AccountID != "1" || dto.Activity[0].LocationID != 1 {
			t.Fatal("direct creation actor missing")
		}
		if dto.Items[0].VariantID != 1 || dto.Items[0].Quantity != "2" || dto.Items[1].VariantID != 2 || dto.Items[1].Quantity != "1" {
			t.Fatal("direct live cart changed")
		}
		var exact bool
		if f.p.QueryRow(f.ctx, `SELECT
 (SELECT count(*) FROM transfer_request_items WHERE request_id=$1)=2
 AND (SELECT count(*) FROM transfer_request_allocations)=2
 AND NOT EXISTS(SELECT 1 FROM transfer_request_items i LEFT JOIN transfer_request_allocations a USING(request_id,variant_id)
 WHERE i.request_id=$1 AND (a.request_id IS NULL OR a.quantity<>i.quantity OR a.origin_location_id<>1 OR a.consumed_at IS NOT NULL OR a.released_at IS NOT NULL))
 AND NOT EXISTS(SELECT 1 FROM transfer_request_allocations WHERE request_id<>$1)`, dto.ID).Scan(&exact) != nil || !exact || f.stock(t) != expected {
			t.Fatal("direct live creation omitted owned allocations or changed unexpected stock")
		}
		f.baseline = expected
		return dto
	}
}

func TestW01DirectShipmentUncommittedEvents(t *testing.T) {
	env := eventFixture(t)
	f := env.f
	server := eventServer(t, env)
	clients := []*eventClient{openEvents(t, env, server, 1, ""), openEvents(t, env, server, 2, ""), openEvents(t, env, server, 3, "")}
	t.Cleanup(func() {
		for _, c := range clients {
			c.close()
		}
		server.Close()
	})
	for _, c := range clients {
		expectHTTPEvent(t, c, "resync")
	}
	eventBoundary(t, env, clients, [][]string{nil, nil, nil})
	before, revisions := fenceSnapshot(t, f), decisionRevisions(t, f)
	g := &decisionTrace{match: "INSERT INTO transfer_request_allocations", end: true, arrived: make(chan uint32, 1), release: make(chan struct{})}
	h := decisionTraced(t, f, g)
	ctx, cancel := context.WithCancel(f.ctx)
	var once sync.Once
	release := func() { once.Do(func() { close(g.release) }) }
	done := make(chan *httptest.ResponseRecorder, 1)
	read := false
	t.Cleanup(func() {
		cancel()
		release()
		if !read {
			<-done
		}
	})
	go func() {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, f.newRequest(1, "POST", "/api/transfers", w01HTTPBody(2)).WithContext(ctx))
		done <- w
	}()
	decisionArrived(t, f, g) // Header, first reservation and owned allocation exist only inside the open transaction.
	if fenceSnapshot(t, f) != before || decisionRevisions(t, f) != revisions {
		t.Fatal("uncommitted creation became externally visible")
	}
	eventBoundary(t, env, clients, [][]string{nil, nil, nil})
	cancel()
	release()
	w := <-done
	read = true
	expectTransferError(t, w, 503, "service_unavailable")
	if fenceSnapshot(t, f) != before || decisionRevisions(t, f) != revisions {
		t.Fatal("cancelled open creation leaked partial history or revisions")
	}
	eventBoundary(t, env, clients, [][]string{nil, nil, nil})
	for _, c := range clients {
		c.close()
	}
	server.Close()
}

func TestW01DirectShipmentEvents(t *testing.T) {
	for _, destination := range []int{2, 3} {
		t.Run(fmt.Sprintf("destination_%d", destination), func(t *testing.T) {
			env := eventFixture(t)
			f := env.f
			server := eventServer(t, env)
			clients := []*eventClient{openEvents(t, env, server, 1, ""), openEvents(t, env, server, 2, ""), openEvents(t, env, server, 3, "")}
			t.Cleanup(func() {
				for _, c := range clients {
					c.close()
				}
				server.Close()
			})
			for _, c := range clients {
				expectHTTPEvent(t, c, "resync")
			}
			eventBoundary(t, env, clients, [][]string{nil, nil, nil})
			before, revisions := fenceSnapshot(t, f), decisionRevisions(t, f)
			body := w01HTTPBody(destination)
			// Fail at commit after header, both allocations and reservations. The
			// sequence proves the deferred failure was reached, without raw errors.
			decisionExec(t, f, `CREATE SEQUENCE w01_event_commit_seen;
 CREATE FUNCTION w01_event_fail() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN PERFORM nextval('w01_event_commit_seen'); RAISE EXCEPTION 'injected direct commit failure'; END $$;
 CREATE CONSTRAINT TRIGGER w01_event_fail AFTER INSERT ON transfer_requests DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION w01_event_fail()`)
			expectTransferError(t, f.request(t, 1, "POST", "/api/transfers", body), 503, "service_unavailable")
			var reached bool
			if f.p.QueryRow(f.ctx, "SELECT is_called FROM w01_event_commit_seen").Scan(&reached) != nil || !reached || fenceSnapshot(t, f) != before || decisionRevisions(t, f) != revisions {
				t.Fatal("rolled-back direct creation leaked state/revisions or missed commit")
			}
			eventBoundary(t, env, clients, [][]string{nil, nil, nil})
			decisionExec(t, f, "DROP TRIGGER w01_event_fail ON transfer_requests")
			metadata := decisionListen(t, f)
			proof := w01HTTPProof(t, f, destination)
			w := decisionNetwork(t, f, server, f.newRequest(1, "POST", "/api/transfers", body))
			original := proof(w)
			want := transferObject(t, w, 201)
			revisions[0] += 2
			revisions[1]++
			revisions[destination]++
			payloads := map[string]bool{"inventory:0": true, "transfers:1": true, fmt.Sprintf("transfers:%d", destination): true}
			for i := 0; i < 3; i++ {
				n, err := metadata.WaitForNotification(f.ctx)
				if err != nil || n.Channel != "luson_realtime" || !payloads[n.Payload] {
					t.Fatal("creation hint leaked payload or wrong participant")
				}
				delete(payloads, n.Payload)
			}
			// Creation inserts its header before reserving balances, so its
			// commit delivers transfer hints before the coalesced inventory hint.
			expected := [][]string{{"transfers", "inventory"}, {"inventory"}, {"inventory"}}
			expected[destination-1] = []string{"transfers", "inventory"}
			eventBoundary(t, env, clients, expected)
			if decisionRevisions(t, f) != revisions {
				t.Fatal("creation did not invalidate exactly its owned scopes")
			}
			before = fenceSnapshot(t, f)
			decisionLiveViews(t, f, server, original, "approved", want)
			replay := f.request(t, 1, "POST", "/api/transfers", body)
			if !reflect.DeepEqual(transferObject(t, replay, 200), want) {
				t.Fatal("live creation replay changed history")
			}
			for _, action := range []string{"approve", "reject"} {
				expectTransferError(t, f.request(t, 1, "POST", "/api/transfers/"+original.ID+"/"+action, "{}"), 409, "decision_conflict")
			}
			if fenceSnapshot(t, f) != before || decisionRevisions(t, f) != revisions {
				t.Fatal("direct reads/replay/decision conflicts emitted mutations")
			}
			eventBoundary(t, env, clients, [][]string{nil, nil, nil})
			for _, c := range clients {
				c.close()
			}
			server.Close()
		})
	}
}
