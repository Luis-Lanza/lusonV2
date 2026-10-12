package httpapi

import (
	"testing"
)

func TestC3CountEvents(t *testing.T) {
	for _, mode := range []string{"expected_delta", "unexpected_zero"} {
		t.Run(mode, func(t *testing.T) {
			env := eventFixture(t)
			f := env.f
			received := countHTTPReceived(t, f)
			path := "/api/transfers/" + received.ID + "/count-corrections"
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
			metadata := decisionListen(t, f)
			revisions := decisionRevisions(t, f)
			changed := func(inventory bool) {
				t.Helper()
				payloads := []string{"transfers:1", "transfers:2"}
				audiences := [][]string{{"transfers"}, {"transfers"}, nil}
				if inventory {
					payloads = append([]string{"inventory:0"}, payloads...)
					audiences = [][]string{{"inventory", "transfers"}, {"inventory", "transfers"}, {"inventory"}}
					revisions[0]++
				}
				revisions[1]++
				revisions[2]++
				for _, payload := range payloads {
					n, err := metadata.WaitForNotification(f.ctx)
					if err != nil || n.Channel != "luson_realtime" || n.Payload != payload {
						t.Fatal("correction notification leaked identity/history or duplicated SQL hints", err)
					}
				}
				eventBoundary(t, env, clients, audiences)
				barrier, err := metadata.WaitForNotification(f.ctx)
				if err != nil || barrier.Channel != "luson_realtime" || barrier.Payload != "inventory:0" {
					t.Fatal("ordered event barrier metadata missing", err)
				}
				if decisionRevisions(t, f) != revisions {
					t.Fatal("correction revision scopes mismatch")
				}
			}
			variant, actual, delta := 1, "0", int64(-1)
			if mode == "unexpected_zero" {
				variant, actual, delta = 3, "9007199254740993", 0
			}
			proposal := countHTTPBody(variant, "count-events-propose-001", "0", actual, "event evidence")
			proposed := decisionNetwork(t, f, server, f.newRequest(2, "POST", path+"/propose", proposal))
			countHTTPOperation(t, proposed)
			changed(false)
			reject := countHTTPBody(variant, "count-events-reject-001", "1", "", "not agreed")
			rejected := decisionNetwork(t, f, server, f.newRequest(1, "POST", path+"/reject", reject))
			countHTTPOperation(t, rejected)
			changed(false)
			secondBody := countHTTPBody(variant, "count-events-propose-002", "1", actual, "fresh evidence")
			second := decisionNetwork(t, f, server, f.newRequest(1, "POST", path+"/propose", secondBody))
			countHTTPOperation(t, second)
			changed(false)
			accept := countHTTPBody(variant, "count-events-accept-002", "2", "", "agreed")
			proof := countHTTPProof(t, f, 2, variant, delta)
			accepted := decisionNetwork(t, f, server, f.newRequest(2, "POST", path+"/accept", accept))
			proof(accepted)
			changed(delta != 0)

			// Boundary markers expose any extra hints from reads, historical retries,
			// changed-key payload, stale decisions, or nonparticipant access failures.
			for _, replay := range []struct {
				actor               int
				action, body, prior string
			}{
				{2, "propose", proposal, proposed.Body.String()}, {1, "reject", reject, rejected.Body.String()}, {1, "propose", secondBody, second.Body.String()}, {2, "accept", accept, accepted.Body.String()},
			} {
				w := decisionNetwork(t, f, server, f.newRequest(replay.actor, "POST", path+"/"+replay.action, replay.body))
				if w.Code != 200 || w.Body.String() != replay.prior {
					t.Fatal("event HTTP historical replay mismatch")
				}
			}
			expectTransferError(t, decisionNetwork(t, f, server, f.newRequest(2, "POST", path+"/propose", countHTTPBody(variant, "count-events-propose-001", "0", "1", "changed"))), 409, "retry_conflict")
			expectTransferError(t, decisionNetwork(t, f, server, f.newRequest(2, "POST", path+"/accept", countHTTPBody(variant, "count-events-stale-001", "1", "", "stale"))), 409, "decision_conflict")
			expectTransferError(t, decisionNetwork(t, f, server, f.newRequest(3, "GET", path, "")), 404, "not_found")
			countHTTPSnapshot(t, f, received.ID)
			eventBoundary(t, env, clients, [][]string{nil, nil, nil})
			if decisionRevisions(t, f) != revisions {
				t.Fatal("retry/failure emitted mutation hints")
			}
			for _, client := range clients {
				client.close()
			}
			server.Close()
		})
	}
}
