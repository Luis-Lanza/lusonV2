package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"luson/api/internal/auth"
	"luson/api/internal/inventory"
)

// d6Overlap queues two real HTTP transactions behind the native pair-key fence.
// The held connection also observes pg_locks, leaving pool slots for both calls.
func d6Overlap(t *testing.T, f *t5Fixture, retireFirst bool, route, body string) (*httptest.ResponseRecorder, *httptest.ResponseRecorder) {
	t.Helper()
	live, sibling := retirementLogin(t, f, 0), retirementLogin(t, f, 0)
	if live == sibling {
		t.Fatal("distinct warehouse sessions required")
	}
	t8Identity(t, f, live)
	t8Identity(t, f, sibling)
	f.tokens[0] = live
	ctx, cancel := context.WithTimeout(f.ctx, 8*time.Second)
	conn, err := f.p.Acquire(ctx)
	if err != nil {
		cancel()
		t.Fatal("fence connection unavailable")
	}
	tx, err := conn.Begin(ctx)
	if err != nil {
		conn.Release()
		cancel()
		t.Fatal("fence transaction unavailable")
	}
	var wg sync.WaitGroup
	defer func() {
		cancel()
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
		wg.Wait()
		conn.Release()
	}()
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(714025,1)`); err != nil {
		t.Fatal("fence hold failed")
	}
	results := [2]chan *httptest.ResponseRecorder{make(chan *httptest.ResponseRecorder, 1), make(chan *httptest.ResponseRecorder, 1)}
	start := func(index int) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			token, verb, path, input := sibling, "POST", route, body
			if index == 0 {
				token, verb, path, input = live, "DELETE", "/api/admin/branches/4", ""
			}
			r := httptest.NewRequest(verb, path, strings.NewReader(input)).WithContext(ctx)
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Origin", "http://localhost:8080")
			r.Header.Set("X-CSRF-Token", auth.CSRF(token))
			r.AddCookie(&http.Cookie{Name: "luson_session", Value: token})
			w := httptest.NewRecorder()
			f.h.ServeHTTP(w, r)
			results[index] <- w
		}()
	}
	wait := func(want int) {
		deadline := time.NewTimer(2 * time.Second)
		defer deadline.Stop()
		tick := time.NewTicker(5 * time.Millisecond)
		defer tick.Stop()
		for {
			var n int
			err := tx.QueryRow(ctx, `SELECT count(*) FROM pg_locks WHERE locktype='advisory'
    AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
    AND classid=714025 AND objid=1 AND objsubid=2 AND NOT granted`).Scan(&n)
			if err != nil {
				t.Fatal("native waiter observation failed")
			}
			if n == want {
				return
			}
			select {
			case <-deadline.C:
				t.Fatalf("native fence waiters: got %d want %d", n, want)
			case <-ctx.Done():
				t.Fatal("overlap deadline")
			case <-tick.C:
			}
		}
	}
	first := 1
	if retireFirst {
		first = 0
	}
	start(first)
	wait(1)
	start(1 - first)
	wait(2)
	if err = tx.Rollback(ctx); err != nil {
		t.Fatal("fence release failed")
	}
	var out [2]*httptest.ResponseRecorder
	for i := range out {
		select {
		case out[i] = <-results[i]:
		case <-ctx.Done():
			t.Fatal("HTTP overlap completion deadline")
		}
	}
	return out[0], out[1]
}

const d6Create = `{"kind":"direct_shipment","counterparty_location_id":4,"retry_key":"d6-zero-credit-create","items":[{"variant_id":1,"quantity":"1"}]}`
const d6Propose = `{"variant_id":1,"operation_key":"d6-recorded-proposal","expected_revision":"0","actual_quantity":"1","reason":"recount"}`

func TestD6RetirementOverlappedWinners(t *testing.T) {
	for _, received := range []bool{false, true} {
		for _, retireFirst := range []bool{true, false} {
			t.Run(fmt.Sprintf("received_%t/retire_first_%t", received, retireFirst), func(t *testing.T) {
				f := t5Setup(t)
				path, route, body := "", "/api/transfers", d6Create
				existing := int64(18)
				if received {
					path, _ = d6Received(t, f)
					route, body, existing = path+"/count-corrections/propose", d6Propose, 17
					t5Exact(t, f.request(f.tokens[0], "DELETE", "/api/admin/accounts/2", ""), 204, "")
				} else {
					branchRetirementCreate(t, f)
				}
				d6Empty(t, f)
				t8Stock(t, f, 1, existing, 0)
				before := d6Observe(t, f, path)
				retirement, write := d6Overlap(t, f, retireFirst, route, body)
				if retireFirst {
					t5Exact(t, retirement, 204, "")
					t5Error(t, write, 409, "decision_conflict")
					after := d6Observe(t, f, path)
					if !reflect.DeepEqual(after[1:], before[1:]) {
						t.Fatal("losing fresh write created public evidence")
					}
					if strings.Contains(branchRetirementDirectory(t, f), `"id":4`) {
						t.Fatal("retired branch remains selectable")
					}
					t5Error(t, f.request(f.tokens[0], "GET", "/api/inventory?location_id=4", ""), 404, "not_found")
					return
				}
				t5Error(t, retirement, 409, "branch_has_pending_operations")
				if !strings.Contains(branchRetirementDirectory(t, f), `"id":4`) {
					t.Fatal("blocked retirement hid branch")
				}
				actions, reserved := "1", int64(1)
				if received {
					t5Exact(t, write, 200, d6Operation(t, write, path))
					actions, reserved = "0", 0
					d6Pending(t, f, path, write.Body.String(), before[3])
				} else {
					r := t8Decode(t, write, 201)
					if r.Status != "approved" || r.Origin != 1 || r.Destination != 4 || len(r.Activity) != 1 {
						t.Fatal("winning creation state")
					}
					path = "/api/transfers/" + r.ID
					t5Exact(t, f.request(f.tokens[0], "GET", path, ""), 200, write.Body.String())
				}
				var list struct {
					Total   string     `json:"total_count"`
					Records []t8Record `json:"records"`
				}
				if json.Unmarshal([]byte(d6Get(t, f, "/api/transfers?status=all")), &list) != nil || list.Total != "1" || len(list.Records) != 1 || path != "/api/transfers/"+list.Records[0].ID {
					t.Fatal("winning history membership")
				}
				t5Exact(t, f.request(f.tokens[0], "GET", "/api/transfers/counts", ""), 200, `{"pending_total":"0","action_count":"`+actions+`","actions":{"approve":"0","dispatch":"`+actions+`","receive":"0","review_count":"0","review_dispatch_reconciliation":"0","review_restitution":"0"}}`+"\n")
				t8Stock(t, f, 1, existing, reserved)
				d6Empty(t, f)
			})
		}
	}
}

func d6Operation(t *testing.T, w *httptest.ResponseRecorder, path string) string {
	t.Helper()
	var fields map[string]json.RawMessage
	var op struct {
		Key      string `json:"operation_key"`
		Request  string `json:"request_id"`
		Revision string `json:"revision"`
		Expected string `json:"expected_revision"`
		Actual   string `json:"actual_quantity"`
		Actor    int    `json:"actor_location_id"`
		Action   string `json:"action"`
	}
	if json.Unmarshal(w.Body.Bytes(), &fields) != nil || len(fields) != 10 || json.Unmarshal(w.Body.Bytes(), &op) != nil || op.Key != "d6-recorded-proposal" || path != "/api/transfers/"+op.Request || op.Revision != "1" || op.Expected != "0" || op.Actual != "1" || op.Actor != 1 || op.Action != "propose" {
		t.Fatal("persisted operation contract")
	}
	return w.Body.String()
}

func d6Pending(t *testing.T, f *t5Fixture, path, operation, original string) {
	t.Helper()
	var workflow struct {
		Operations []json.RawMessage `json:"operations"`
		Lines      []struct {
			Revision  string `json:"workflow_revision"`
			Applied   string `json:"applied_revision"`
			Credit    string `json:"effective_credit"`
			Proposals []struct {
				State string `json:"state"`
			} `json:"proposals"`
		} `json:"lines"`
	}
	if json.Unmarshal([]byte(d6Get(t, f, path+"/count-corrections")), &workflow) != nil || len(workflow.Operations) != 1 || len(workflow.Lines) != 2 {
		t.Fatal("winning proposal membership")
	}
	var got, want any
	if json.Unmarshal(workflow.Operations[0], &got) != nil || json.Unmarshal([]byte(operation), &want) != nil || !reflect.DeepEqual(got, want) {
		t.Fatal("workflow operation mismatch")
	}
	line := workflow.Lines[0]
	if line.Revision != "1" || line.Applied != "0" || line.Credit != "0" || len(line.Proposals) != 1 || line.Proposals[0].State != "pending" {
		t.Fatal("winning proposal must block retirement without credit")
	}
	var old t8Record
	if json.Unmarshal([]byte(original), &old) != nil {
		t.Fatal("original detail decode")
	}
	current := t8Decode(t, f.request(f.tokens[0], "GET", path, ""), 200)
	if len(current.Activity) != len(old.Activity)+1 || !reflect.DeepEqual(current.Activity[:len(old.Activity)], old.Activity) {
		t.Fatal("winning proposal lost immutable activity prefix")
	}
}

func d6Get(t *testing.T, f *t5Fixture, route string) string {
	t.Helper()
	w := f.request(f.tokens[0], "GET", route, "")
	if w.Code != 200 || len(w.Result().Cookies()) != 0 {
		t.Fatalf("public read %s: status %d", route, w.Code)
	}
	return w.Body.String()
}

// Same public zero-credit arithmetic as TestRetiredBranchReceivedFreshWork.
func d6Received(t *testing.T, f *t5Fixture) (string, string) {
	t.Helper()
	branchRetirementCreate(t, f)
	t5Exact(t, f.request(f.tokens[0], "PATCH", "/api/admin/accounts/2", `{"location_id":4}`), 204, "")
	operator := retirementLogin(t, f, 1)
	r := t8Decode(t, f.request(f.tokens[0], "POST", "/api/transfers", d6Create), 201)
	path := "/api/transfers/" + r.ID
	t8Decode(t, f.request(f.tokens[0], "POST", path+"/dispatch", "{}"), 200)
	r = t8Decode(t, f.request(operator, "POST", path+"/receive", `{"items":[{"variant_id":1,"actual_quantity":"0"},{"variant_id":2,"actual_quantity":"1"}]}`), 200)
	if r.Status != "received" || len(r.Activity) != 3 {
		t.Fatal("received fixture")
	}
	a := r.Activity[2]
	if a.Actor.AccountID != "2" || a.Actor.Username != f.creds[1].Username || a.Actor.DisplayName != "Persona" || a.LocationID != 4 || a.LocationName != "Sucursal Retiro" || a.Action != "receive" {
		t.Fatal("personal receipt snapshot")
	}
	d6Empty(t, f)
	t8Stock(t, f, 1, 17, 0)
	return path, operator
}

func d6Empty(t *testing.T, f *t5Fixture) {
	t.Helper()
	for page := 1; page <= 4; page++ {
		var p inventory.Page
		body := d6Get(t, f, fmt.Sprintf("/api/inventory?location_id=4&page_size=50&page=%d", page))
		if json.Unmarshal([]byte(body), &p) != nil || p.TotalVariants != 190 {
			t.Fatal("empty branch catalog")
		}
		for _, row := range p.Items {
			if row.Existing != 0 || row.Reserved != 0 || row.Available != 0 {
				t.Fatal("branch must have zero stock")
			}
		}
	}
}

func d6Observe(t *testing.T, f *t5Fixture, path string) []string {
	t.Helper()
	out := []string{f.snapshot(), f.oldInventory(), d6Get(t, f, "/api/transfers?status=all")}
	if path != "" {
		for _, suffix := range []string{"", "/count-corrections", "/restitutions", "/dispatch-reconciliations"} {
			out = append(out, d6Get(t, f, path+suffix))
		}
	}
	return append(out, d6Get(t, f, "/api/transfers/counts"))
}

func TestD6RetirementFailureAtomicity(t *testing.T) {
	f := t5Setup(t)
	before := d6Observe(t, f, "")
	oldSession := f.request(f.tokens[1], "GET", "/api/auth/session", "")
	oldInventory := f.request(f.tokens[1], "GET", "/api/inventory?location_id=2", "")
	t8Identity(t, f, f.tokens[1])
	if oldInventory.Code != 200 {
		t.Fatal("target inventory fixture")
	}
	// Owned fresh DB only. RetireOperator updates the account before this UPDATE.
	// No app rows are fabricated or inspected; the hook fails session revocation.
	_, err := f.p.Exec(f.ctx, `CREATE FUNCTION d6_fail_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION 'd6 injected revocation failure'; END; $$;
 CREATE TRIGGER d6_fail_revocation BEFORE UPDATE OF revoked_at ON auth_sessions
 FOR EACH ROW WHEN (OLD.account_id=2 AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
 EXECUTE FUNCTION d6_fail_revocation()`)
	if err != nil {
		t.Fatal("owned revocation hook setup failed")
	}
	t5Error(t, f.request(f.tokens[0], "DELETE", "/api/admin/accounts/2", ""), 503, "service_unavailable")
	if !reflect.DeepEqual(d6Observe(t, f, ""), before) {
		t.Fatal("failed retirement changed public state")
	}
	t5Exact(t, f.request(f.tokens[1], "GET", "/api/auth/session", ""), 200, oldSession.Body.String())
	t5Exact(t, f.request(f.tokens[1], "GET", "/api/inventory?location_id=2", ""), 200, oldInventory.Body.String())
	t8Identity(t, f, f.tokens[1])
	retirementSurvivors(t, f)
	// No fresh login while hook is installed. Helper owns whole-DB teardown.
}

func TestD6RetirementRecordedReplay(t *testing.T) {
	f := t5Setup(t)
	path, operator := d6Received(t, f)
	proposal := f.request(f.tokens[0], "POST", path+"/count-corrections/propose", d6Propose)
	t5Exact(t, proposal, 200, d6Operation(t, proposal, path))
	reject := `{"variant_id":1,"operation_key":"d6-counterparty-reject","expected_revision":"1","reason":"not confirmed"}`
	decision := f.request(operator, "POST", path+"/count-corrections/reject", reject)
	if decision.Code != 200 || len(decision.Result().Cookies()) != 0 {
		t.Fatal("counterparty rejection fixture")
	}
	d6Empty(t, f)
	t5Exact(t, f.request(f.tokens[0], "DELETE", "/api/admin/accounts/2", ""), 204, "")
	beforeRetire := d6Observe(t, f, path)
	t5Exact(t, f.request(f.tokens[0], "DELETE", "/api/admin/branches/4", ""), 204, "")
	before := d6Observe(t, f, path)
	// Retirement changes directories, not detail, workflows or list evidence.
	if !reflect.DeepEqual(before[2:], beforeRetire[2:]) {
		t.Fatal("retirement rewrote history")
	}
	current := d6Get(t, f, path)
	// Creation replay returns current request, not the original approved response.
	t5Exact(t, f.request(f.tokens[0], "POST", "/api/transfers", d6Create), 200, current)
	// Count replay returns the immutable original operation, not today's head.
	t5Exact(t, f.request(f.tokens[0], "POST", path+"/count-corrections/propose", d6Propose), 200, proposal.Body.String())
	if !reflect.DeepEqual(d6Observe(t, f, path), before) {
		t.Fatal("recorded replay repeated a mutation")
	}
}
