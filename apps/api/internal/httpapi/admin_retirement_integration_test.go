package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
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
const d6Return = `{"kind":"send_to_warehouse","counterparty_location_id":1,"retry_key":"d6-return-create-001","items":[{"variant_id":1,"quantity":"1"}]}`

// seedLegacyCount records one historical count operation through the retained SQL
// writer the retired HTTP handler called. S8 keeps the retirement blocker on the
// legacy proposal tables, so this is the only surviving way to create that pending
// evidence. The account setting is transaction-local and mirrors the store writers,
// so personal activity rows are identical to the retired route's.
func seedLegacyCount(t *testing.T, f *t5Fixture, id string, account, location int, action, key string, revision int, actual any, reason string) {
	t.Helper()
	tx, err := f.p.Begin(f.ctx)
	if err != nil {
		t.Fatal("legacy count transaction", err)
	}
	defer func() { _ = tx.Rollback(f.ctx) }()
	if _, err = tx.Exec(f.ctx, `SELECT set_config('luson.transfer_account_id',$1,true), pg_advisory_xact_lock(714025,1)`, strconv.Itoa(account)); err != nil {
		t.Fatal("legacy count account setting", err)
	}
	if err = tx.QueryRow(f.ctx, `SELECT revision FROM transfer_count_correct($1::bigint,1::integer,$2::smallint,$3,$4,$5::bigint,$6::bigint,$7)`,
		id, location, key, action, revision, actual, reason).Scan(new(int)); err != nil {
		t.Fatalf("legacy count %s seed: %v", action, err)
	}
	if err = tx.Commit(f.ctx); err != nil {
		t.Fatalf("legacy count %s commit: %v", action, err)
	}
}

func TestD6RetirementOverlappedWinners(t *testing.T) {
	// Fresh creation genuinely overlaps retirement: whichever wins, the other is
	// refused and public evidence stays consistent.
	for _, retireFirst := range []bool{true, false} {
		t.Run(fmt.Sprintf("creation/retire_first_%t", retireFirst), func(t *testing.T) {
			f := t5Setup(t)
			branchRetirementCreate(t, f)
			d6Empty(t, f)
			t8Stock(t, f, 1, 18, 0)
			before := d6Observe(t, f, "")
			retirement, write := d6Overlap(t, f, retireFirst, "/api/transfers", d6Create)
			if retireFirst {
				t5Exact(t, retirement, 204, "")
				t5Error(t, write, 409, "decision_conflict")
				after := d6Observe(t, f, "")
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
			r := t8Decode(t, write, 201)
			if r.Status != "approved" || r.Origin != 1 || r.Destination != 4 || len(r.Activity) != 1 {
				t.Fatal("winning creation state")
			}
			path := "/api/transfers/" + r.ID
			t5Exact(t, f.request(f.tokens[0], "GET", path, ""), 200, write.Body.String())
			var list struct {
				Total   string     `json:"total_count"`
				Records []t8Record `json:"records"`
			}
			if json.Unmarshal([]byte(d6Get(t, f, "/api/transfers?status=all")), &list) != nil || list.Total != "1" || len(list.Records) != 1 {
				t.Fatal("winning history membership")
			}
			if path != "/api/transfers/"+list.Records[0].ID {
				t.Fatal("winning transfer missing from history")
			}
			t5Exact(t, f.request(f.tokens[0], "GET", "/api/transfers/counts", ""), 200, `{"pending_total":"0","action_count":"1","actions":{"approve":"0","dispatch":"1","receive":"0","review_unified_reconciliation":"0"}}`+"\n")
			t8Stock(t, f, 1, 18, 1)
			d6Empty(t, f)
		})
	}
	// A historical legacy count proposal blocks retirement until it is rejected.
	// S8 keeps the blocker on the legacy proposal tables while the legacy HTTP
	// routes are gone, so the pending evidence is recorded with the retained SQL
	// writer that the retired handler called; nothing is fabricated with INSERT.
	t.Run("received/legacy_pending_blocks", func(t *testing.T) {
		f := t5Setup(t)
		path, _ := d6Received(t, f)
		t5Exact(t, f.request(f.tokens[0], "DELETE", "/api/admin/accounts/2", ""), 204, "")
		d6Empty(t, f)
		t8Stock(t, f, 1, 18, 0)
		seedLegacyCount(t, f, strings.TrimPrefix(path, "/api/transfers/"), 1, 1, "propose", "d6-recorded-proposal", 0, int64(1), "recount")
		before := d6Observe(t, f, path)
		t5Error(t, f.request(f.tokens[0], "DELETE", "/api/admin/branches/4", ""), 409, "branch_has_pending_operations")
		if !strings.Contains(branchRetirementDirectory(t, f), `"id":4`) {
			t.Fatal("blocked retirement hid branch")
		}
		if !reflect.DeepEqual(d6Observe(t, f, path), before) {
			t.Fatal("blocked retirement changed public evidence")
		}
		d6Pending(t, f, path, before[3])
		// S7 removed the legacy categories: pending legacy evidence is history, not work.
		t5Exact(t, f.request(f.tokens[0], "GET", "/api/transfers/counts", ""), 200, `{"pending_total":"0","action_count":"0","actions":{"approve":"0","dispatch":"0","receive":"0","review_unified_reconciliation":"0"}}`+"\n")
	})
}

// d6Pending proves the seeded historical proposal is still pending, applied
// nothing and is exposed only as legacy evidence inside the unified snapshot.
func d6Pending(t *testing.T, f *t5Fixture, path, unified string) {
	t.Helper()
	var snapshot struct {
		Legacy struct {
			Count struct {
				Operations []struct {
					Key      string  `json:"operation_key"`
					Request  string  `json:"request_id"`
					Revision string  `json:"revision"`
					Expected string  `json:"expected_revision"`
					Actual   *string `json:"actual_quantity"`
					Actor    int     `json:"actor_location_id"`
					Action   string  `json:"action"`
				} `json:"operations"`
				Lines []struct {
					Revision  string `json:"workflow_revision"`
					Applied   string `json:"applied_revision"`
					Credit    string `json:"effective_credit"`
					Proposals []struct {
						State string `json:"state"`
					} `json:"proposals"`
				} `json:"lines"`
			} `json:"count"`
		} `json:"legacy"`
	}
	if json.Unmarshal([]byte(unified), &snapshot) != nil {
		t.Fatal("unified snapshot decode")
	}
	count := snapshot.Legacy.Count
	// The received fixture dispatched, received and returned exactly one variant.
	if len(count.Operations) != 1 || len(count.Lines) != 1 {
		t.Fatal("winning proposal membership")
	}
	op := count.Operations[0]
	if op.Key != "d6-recorded-proposal" || path != "/api/transfers/"+op.Request || op.Revision != "1" || op.Expected != "0" || op.Actual == nil || *op.Actual != "1" || op.Actor != 1 || op.Action != "propose" {
		t.Fatal("persisted operation contract")
	}
	line := count.Lines[0]
	// The pending proposal applies nothing: revision 1 exists, nothing is applied
	// and the original credit of the received unit is untouched.
	if line.Revision != "1" || line.Applied != "0" || line.Credit != "1" || len(line.Proposals) != 1 || line.Proposals[0].State != "pending" {
		t.Fatal("winning proposal must block retirement without credit")
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

// Same public receipt/return arithmetic as TestRetiredBranchReceivedFreshWork.
// S1 refuses a receipt line for a variant that was never dispatched, so the
// received unit is real and returns to the warehouse through the lifecycle.
func d6Received(t *testing.T, f *t5Fixture) (string, string) {
	t.Helper()
	branchRetirementCreate(t, f)
	t5Exact(t, f.request(f.tokens[0], "PATCH", "/api/admin/accounts/2", `{"location_id":4}`), 204, "")
	operator := retirementLogin(t, f, 1)
	r := t8Decode(t, f.request(f.tokens[0], "POST", "/api/transfers", d6Create), 201)
	path := "/api/transfers/" + r.ID
	t8Decode(t, f.request(f.tokens[0], "POST", path+"/dispatch", "{}"), 200)
	r = t8Decode(t, f.request(operator, "POST", path+"/receive", `{"items":[{"variant_id":1,"actual_quantity":"1"}]}`), 200)
	if r.Status != "received" || len(r.Activity) != 3 {
		t.Fatal("received fixture")
	}
	a := r.Activity[2]
	if a.Actor.AccountID != "2" || a.Actor.Username != f.creds[1].Username || a.Actor.DisplayName != "Persona" || a.LocationID != 4 || a.LocationName != "Sucursal Retiro" || a.Action != "receive" {
		t.Fatal("personal receipt snapshot")
	}
	// The credited unit goes back through the real lifecycle: retirement requires
	// a branch without stock, and nothing here is reset by SQL.
	returned := t8Decode(t, f.request(operator, "POST", "/api/transfers", d6Return), 201)
	returnPath := "/api/transfers/" + returned.ID
	if returned.Status != "pending" || returned.Origin != 4 || returned.Destination != 1 {
		t.Fatal("return fixture direction/status")
	}
	t8Decode(t, f.request(f.tokens[0], "POST", returnPath+"/approve", "{}"), 200)
	t8Decode(t, f.request(operator, "POST", returnPath+"/dispatch", "{}"), 200)
	if back := t8Decode(t, f.request(f.tokens[0], "POST", returnPath+"/receive", `{"items":[{"variant_id":1,"actual_quantity":"1"}]}`), 200); back.Status != "received" || len(back.Activity) != 4 {
		t.Fatal("return receipt fixture")
	}
	d6Empty(t, f)
	t8Stock(t, f, 1, 18, 0)
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
		// The unified snapshot embeds the retired count/restitution/dispatch
		// evidence and is participant-private, so it is the surviving read that
		// must not change.
		out = append(out, d6Get(t, f, path+"/unified-reconciliations"))
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
	path, _ := d6Received(t, f)
	id := strings.TrimPrefix(path, "/api/transfers/")
	original := t8Decode(t, f.request(f.tokens[0], "GET", path, ""), 200)
	// The retirement blocker keeps referencing the legacy proposal tables (S8)
	// while the legacy routes are gone, so pending legacy evidence is recorded with
	// the retained SQL writer the retired handler called.
	seedLegacyCount(t, f, id, 1, 1, "propose", "d6-recorded-proposal", 0, int64(1), "recount")
	d6Empty(t, f)
	t8Stock(t, f, 1, 18, 0)
	// Branch retirement requires a branch without users, so the target account is
	// retired before the blocked attempt; the pending proposal is what remains.
	t5Exact(t, f.request(f.tokens[0], "DELETE", "/api/admin/accounts/2", ""), 204, "")
	pending := d6Observe(t, f, path)
	d6Pending(t, f, path, pending[3])
	// One immutable personal activity entry is recorded, after the existing prefix.
	seeded := t8Decode(t, f.request(f.tokens[0], "GET", path, ""), 200)
	if len(seeded.Activity) != len(original.Activity)+1 || !reflect.DeepEqual(seeded.Activity[:len(original.Activity)], original.Activity) {
		t.Fatal("seeded proposal lost immutable activity prefix")
	}
	t5Error(t, f.request(f.tokens[0], "DELETE", "/api/admin/branches/4", ""), 409, "branch_has_pending_operations")
	// Rejection closes the revision without credit; only then may the branch retire.
	seedLegacyCount(t, f, id, 2, 4, "reject", "d6-counterparty-reject", 1, nil, "not confirmed")
	d6Empty(t, f)
	t8Stock(t, f, 1, 18, 0)
	var recorded struct {
		Legacy struct {
			Count struct {
				Operations []struct {
					Action string `json:"action"`
				} `json:"operations"`
				Lines []struct {
					Credit    string `json:"effective_credit"`
					Proposals []struct {
						State string `json:"state"`
					} `json:"proposals"`
				} `json:"lines"`
			} `json:"count"`
		} `json:"legacy"`
	}
	if json.Unmarshal([]byte(d6Get(t, f, path+"/unified-reconciliations")), &recorded) != nil || len(recorded.Legacy.Count.Operations) != 2 || recorded.Legacy.Count.Operations[0].Action != "propose" || recorded.Legacy.Count.Operations[1].Action != "reject" || len(recorded.Legacy.Count.Lines) != 1 || recorded.Legacy.Count.Lines[0].Credit != "1" || len(recorded.Legacy.Count.Lines[0].Proposals) != 1 || recorded.Legacy.Count.Lines[0].Proposals[0].State != "rejected" {
		t.Fatal("recorded rejection evidence")
	}
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
	if !reflect.DeepEqual(d6Observe(t, f, path), before) {
		t.Fatal("recorded replay repeated a mutation")
	}
}
