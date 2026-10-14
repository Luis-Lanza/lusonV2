package httpapi

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestD01DispatchEvents(t *testing.T) {
	env := eventFixture(t)
	f := env.f
	original := decisionCreate(t, f, "request_stock", 1, "dispatch-events-key-0001")
	path := "/api/transfers/" + original.ID
	w := decisionServe(t, f, f.newRequest(1, "POST", path+"/approve", "{}"), original)
	var approved transferDTO
	if json.Unmarshal(w.Body.Bytes(), &approved) != nil {
		t.Fatal("approval DTO unavailable")
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
	// A real successful transition is canceled before commit, after deduction.
	decisionHTTPRollback(t, f, approved, "dispatch")
	if fenceSnapshot(t, f) != before || decisionRevisions(t, f) != revisions {
		t.Fatal("dispatch rollback leaked state/revisions")
	}
	eventBoundary(t, env, clients, [][]string{nil, nil, nil})
	metadata := decisionListen(t, f)
	proof := dispatchProof(t, f, approved)
	w = decisionNetwork(t, f, server, f.newRequest(1, "POST", path+"/dispatch", "{}"))
	proof(w)
	want := transferObject(t, w, 200)
	revisions[0] += 2
	revisions[1]++
	revisions[2]++
	for _, payload := range []string{"inventory:0", "transfers:1", "transfers:2"} {
		n, err := metadata.WaitForNotification(f.ctx)
		if err != nil || n.Channel != "luson_realtime" || n.Payload != payload {
			t.Fatal("dispatch leaked/changed notification metadata", err)
		}
	}
	eventBoundary(t, env, clients, [][]string{{"inventory", "transfers"}, {"inventory", "transfers"}, {"inventory"}})
	if decisionRevisions(t, f) != revisions {
		t.Fatal("dispatch revisions did not match exact changed scopes")
	}
	before = fenceSnapshot(t, f)
	for _, action := range []string{"dispatch", "approve"} {
		w = decisionNetwork(t, f, server, f.newRequest(1, "POST", path+"/"+action, "{}"))
		if !reflect.DeepEqual(transferObject(t, w, 200), want) {
			t.Fatal("retry changed complete dispatch payload")
		}
	}
	expectTransferError(t, decisionNetwork(t, f, server, f.newRequest(1, "POST", path+"/reject", "{}")), 409, "decision_conflict")
	if fenceSnapshot(t, f) != before || decisionRevisions(t, f) != revisions {
		t.Fatal("retry/conflict emitted mutation")
	}
	eventBoundary(t, env, clients, [][]string{nil, nil, nil})
	for _, client := range clients {
		client.close()
	}
	server.Close()
}
