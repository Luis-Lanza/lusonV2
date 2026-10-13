package transfers_test

import (
	"context"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/transfers"
)

const r2Call = `SELECT revision FROM transfer_restitute($1,$2,$3::smallint,$4,$5,$6,$7,$8,$9)`

func r2Receipt(t *testing.T, debit, credit int64) (context.Context, *pgxpool.Pool, transfers.Request) {
	t.Helper()
	ctx, p, s := fixture(t)
	in := input()
	in.Items = []transfers.Line{{VariantID: 1, Quantity: debit}}
	r := receiptDispatch(t, ctx, s, in)
	if _, err := s.Receive(ctx, actor(r.Destination.ID), r.ID, transfers.ReceiptInput{Items: []transfers.Line{{VariantID: 1, Quantity: credit}, {VariantID: 3, Quantity: 1}}}); err != nil {
		t.Fatal("synthetic receipt setup", err)
	}
	return ctx, p, r
}
func r2Do(t *testing.T, ctx context.Context, p *pgxpool.Pool, r transfers.Request, actor int, key, action string, rev int64, q any, retained any) int64 {
	t.Helper()
	var got int64
	if err := p.QueryRow(ctx, r2Call, r.ID, 1, actor, key, action, rev, q, retained, "retained at origin verified").Scan(&got); err != nil {
		t.Fatal(err)
	}
	return got
}
func r2Snapshot(t *testing.T, ctx context.Context, p *pgxpool.Pool) string {
	t.Helper()
	var got string
	if err := p.QueryRow(ctx, `SELECT jsonb_build_array(
 (SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY operation_key),'[]') FROM transfer_restitution_operations o),
 (SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY request_id,variant_id,revision),'[]') FROM transfer_restitution_proposals o),
 (SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY request_id,variant_id,revision),'[]') FROM transfer_restitution_decisions o),
 (SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY request_id,variant_id),'[]') FROM transfer_restitution_applications o))::text`).Scan(&got); err != nil {
		t.Fatal(err)
	}
	return c2Snapshot(t, ctx, p) + got
}
func r2Refuse(t *testing.T, ctx context.Context, p *pgxpool.Pool, query string, args ...any) {
	t.Helper()
	before := r2Snapshot(t, ctx, p)
	if _, err := p.Exec(ctx, query, args...); err == nil {
		t.Fatal("unsafe restitution admitted")
	}
	if r2Snapshot(t, ctx, p) != before {
		t.Fatal("refusal leaked stock/evidence/realtime effects")
	}
}
func r2Original(t *testing.T, ctx context.Context, p *pgxpool.Pool) string {
	t.Helper()
	var got string
	if err := p.QueryRow(ctx, `SELECT jsonb_build_array(
 (SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM transfer_requests o),
 (SELECT jsonb_agg(to_jsonb(o) ORDER BY request_id,variant_id) FROM transfer_request_items o),
 (SELECT jsonb_agg(to_jsonb(o) ORDER BY request_id,variant_id) FROM transfer_request_allocations o),
 (SELECT jsonb_agg(to_jsonb(o) ORDER BY request_id,variant_id) FROM transfer_receipt_lines o),
 (SELECT jsonb_agg(to_jsonb(o) ORDER BY request_id,variant_id,kind) FROM transfer_receipt_exceptions o))::text`).Scan(&got); err != nil {
		t.Fatal(err)
	}
	return got
}

func TestR2RestitutionSQLAgreement(t *testing.T) {
	ctx, p, r := r2Receipt(t, 5, 4)
	before := stocks(t, ctx, p)
	original := r2Original(t, ctx, p)
	inv := c2Revision(t, ctx, p, "inventory")
	a, b, other := c2Revision(t, ctx, p, "transfers:1"), c2Revision(t, ctx, p, "transfers:2"), c2Revision(t, ctx, p, "transfers:3")
	if r2Do(t, ctx, p, r, r.Origin.ID, "proposal", "propose", 0, 1, true) != 1 {
		t.Fatal("revision")
	}
	if !reflect.DeepEqual(before, stocks(t, ctx, p)) {
		t.Fatal("proposal credited stock")
	}
	r2Do(t, ctx, p, r, r.Destination.ID, "accept", "accept", 1, nil, nil)
	for i, row := range stocks(t, ctx, p) {
		want := before[i]
		if want.Location == r.Origin.ID && want.Variant == 1 {
			want.Existing++
			want.Available++
		}
		if row != want {
			t.Fatal("credit changed reservation/destination/unrelated stock")
		}
	}
	if original != r2Original(t, ctx, p) {
		t.Fatal("original evidence changed")
	}
	if scalar(t, ctx, p, `SELECT count(*) FROM transfer_restitution_applications WHERE quantity=1`) != 1 {
		t.Fatal("missing application")
	}
	settled := r2Snapshot(t, ctx, p)
	r2Do(t, ctx, p, r, r.Origin.ID, "proposal", "propose", 0, 1, true)
	r2Do(t, ctx, p, r, r.Destination.ID, "accept", "accept", 1, nil, nil)
	if settled != r2Snapshot(t, ctx, p) {
		t.Fatal("replay had effects")
	}
	if c2Revision(t, ctx, p, "inventory") != inv+1 || c2Revision(t, ctx, p, "transfers:1") != a+2 || c2Revision(t, ctx, p, "transfers:2") != b+2 || c2Revision(t, ctx, p, "transfers:3") != other {
		t.Fatal("participant invalidation")
	}
	r2Refuse(t, ctx, p, r2Call, r.ID, 1, r.Origin.ID, "duplicate", "propose", 1, 1, true, "reason")
	r2Refuse(t, ctx, p, r2Call, r.ID, 1, r.Destination.ID, "duplicate-accept", "accept", 1, nil, nil, "reason")
}

func TestR2RestitutionSQLRolesRevisionsAndAttestation(t *testing.T) {
	ctx, p, r := r2Receipt(t, 5, 2)
	for i, tc := range []struct {
		variant, actor int
		q, att         any
		reason         string
	}{
		{1, r.Destination.ID, 1, true, "reason"}, {1, 3, 1, true, "reason"}, {3, r.Origin.ID, 1, true, "reason"}, {4, r.Origin.ID, 1, true, "reason"},
		{1, r.Origin.ID, 0, true, "reason"}, {1, r.Origin.ID, -1, true, "reason"}, {1, r.Origin.ID, 4, true, "reason"}, {1, r.Origin.ID, int64(9223372036854775807), true, "reason"},
		{1, r.Origin.ID, 1, false, "reason"}, {1, r.Origin.ID, 1, nil, "reason"}, {1, r.Origin.ID, nil, true, "reason"}, {1, r.Origin.ID, 1, true, " "},
	} {
		r2Refuse(t, ctx, p, r2Call, r.ID, tc.variant, tc.actor, fmt.Sprint("invalid", i), "propose", 0, tc.q, tc.att, tc.reason)
	}
	r2Do(t, ctx, p, r, r.Origin.ID, "first", "propose", 0, 1, true)
	for _, tc := range []struct {
		actor       int
		key, action string
		rev         int64
		q, att      any
		reason      string
	}{
		{3, "first", "propose", 0, 1, true, "retained at origin verified"},
		{r.Destination.ID, "first", "propose", 0, 1, true, "retained at origin verified"},
		{r.Origin.ID, "first", "propose", 0, 2, true, "retained at origin verified"},
		{r.Origin.ID, "first", "propose", 0, 1, true, "changed"},
		{r.Origin.ID, "first", "propose", 0, 1, false, "retained at origin verified"},
		{r.Origin.ID, "self", "accept", 1, nil, nil, "reason"},
		{r.Destination.ID, "replace", "propose", 1, 1, true, "reason"},
		{r.Destination.ID, "stale", "accept", 0, nil, nil, "reason"},
		{r.Destination.ID, "payload", "accept", 1, 1, true, "reason"},
	} {
		r2Refuse(t, ctx, p, r2Call, r.ID, 1, tc.actor, tc.key, tc.action, tc.rev, tc.q, tc.att, tc.reason)
	}
	r2Do(t, ctx, p, r, r.Origin.ID, "replacement", "propose", 1, 2, true)
	r2Refuse(t, ctx, p, r2Call, r.ID, 1, r.Destination.ID, "old-consent", "accept", 1, nil, nil, "reason")
	r2Do(t, ctx, p, r, r.Destination.ID, "reject", "reject", 2, nil, nil)
	r2Refuse(t, ctx, p, r2Call, r.ID, 1, r.Destination.ID, "terminal", "accept", 2, nil, nil, "reason")
	r2Do(t, ctx, p, r, r.Origin.ID, "fresh", "propose", 2, 1, true)
	r2Do(t, ctx, p, r, r.Destination.ID, "partial", "accept", 3, nil, nil)
	// Even an outstanding debit cannot fund a second partial settlement.
	r2Refuse(t, ctx, p, r2Call, r.ID, 1, r.Origin.ID, "second", "propose", 3, 1, true, "reason")
	historical := r2Snapshot(t, ctx, p)
	r2Do(t, ctx, p, r, r.Origin.ID, "first", "propose", 0, 1, true)
	if historical != r2Snapshot(t, ctx, p) {
		t.Fatal("historical replay")
	}
}

func TestR2RestitutionSQLCountPinsAndConservation(t *testing.T) {
	for _, mode := range []string{"pending", "replacement", "reject", "equal", "lower"} {
		t.Run(mode, func(t *testing.T) {
			ctx, p, r := r2Receipt(t, 5, 4)
			r2Do(t, ctx, p, r, r.Origin.ID, "retained", "propose", 0, 1, true)
			c2Do(t, ctx, p, r, 1, r.Origin.ID, "count", "propose", 0, 4)
			r2Refuse(t, ctx, p, r2Call, r.ID, 1, r.Origin.ID, "pending-proposal", "propose", 1, 1, true, "reason")
			r2Refuse(t, ctx, p, r2Call, r.ID, 1, r.Destination.ID, "pending-accept", "accept", 1, nil, nil, "reason")
			rev := int64(1)
			if mode == "replacement" {
				c2Do(t, ctx, p, r, 1, r.Origin.ID, "count-replaced", "propose", 1, 4)
				rev = 2
			}
			action := "reject"
			if mode == "equal" || mode == "lower" {
				action = "accept"
			}
			if mode == "lower" {
				c2Do(t, ctx, p, r, 1, r.Origin.ID, "lower", "propose", 1, 3)
				rev = 2
			}
			c2Do(t, ctx, p, r, 1, r.Destination.ID, "count-decision", action, rev, nil)
			r2Refuse(t, ctx, p, r2Call, r.ID, 1, r.Destination.ID, "stale-count", "accept", 1, nil, nil, "reason")
			// Authorization precedes replay, but freshness does not invalidate exact retry.
			before := r2Snapshot(t, ctx, p)
			r2Do(t, ctx, p, r, r.Origin.ID, "retained", "propose", 0, 1, true)
			if before != r2Snapshot(t, ctx, p) {
				t.Fatal("stale exact replay")
			}
			r2Do(t, ctx, p, r, r.Origin.ID, "repin", "propose", 1, 1, true)
			r2Do(t, ctx, p, r, r.Destination.ID, "accept", "accept", 2, nil, nil)
		})
	}
	ctx, p, r := r2Receipt(t, 5, 4)
	r2Do(t, ctx, p, r, r.Origin.ID, "retained", "propose", 0, 1, true)
	r2Do(t, ctx, p, r, r.Destination.ID, "accept", "accept", 1, nil, nil)
	c2Do(t, ctx, p, r, 1, r.Origin.ID, "up", "propose", 0, 5)
	r2Refuse(t, ctx, p, c2Call, r.ID, 1, r.Destination.ID, "up-accept", "accept", 1, nil, "reason")
	r2Refuse(t, ctx, p, `INSERT INTO transfer_count_operations(operation_key,request_id,variant_id,actor_location_id,action,expected_revision,reason) VALUES('raw-up-accept',$1,1,$2,'accept',1,'reason')`, r.ID, r.Destination.ID)
	c2Do(t, ctx, p, r, 1, r.Origin.ID, "equal", "propose", 1, 4)
	c2Do(t, ctx, p, r, 1, r.Destination.ID, "equal-accept", "accept", 2, nil)
	c2Credit(t, ctx, p, 1, 2, 4, 0)
	c2Do(t, ctx, p, r, 1, r.Origin.ID, "down", "propose", 2, 3)
	c2Do(t, ctx, p, r, 1, r.Destination.ID, "down-accept", "accept", 3, nil)
	c2Credit(t, ctx, p, 1, 3, 3, -1)
}

func TestR2RestitutionSQLDirectWritesAndEvidence(t *testing.T) {
	ctx, p, r := r2Receipt(t, 5, 4)
	a01Exec(t, ctx, p, `INSERT INTO transfer_restitution_operations(operation_key,request_id,variant_id,actor_location_id,action,expected_revision,retained_quantity,retained_at_origin,reason,revision,recorded_at) VALUES('raw',$1,1,$2,'propose',0,1,true,'retained',999,'2000-01-01')`, r.ID, r.Origin.ID)
	if scalar(t, ctx, p, `SELECT count(*) FROM transfer_restitution_operations WHERE operation_key='raw' AND revision=1 AND recorded_at>'2000-01-01'`) != 1 {
		t.Fatal("forged server metadata")
	}
	for _, query := range []string{
		`INSERT INTO transfer_restitution_proposals SELECT * FROM transfer_restitution_proposals`,
		`INSERT INTO transfer_restitution_decisions VALUES($1,1,1,'forged',2,true,'reason',now())`,
		`INSERT INTO transfer_restitution_applications VALUES($1,1,1,'forged',1,1,now())`,
		`INSERT INTO transfer_restitution_operations(operation_key,request_id,variant_id,actor_location_id,action,expected_revision,retained_quantity,retained_at_origin,reason) VALUES('wrong',$1,1,3,'propose',1,1,true,'retained')`,
	} {
		if query == `INSERT INTO transfer_restitution_proposals SELECT * FROM transfer_restitution_proposals` {
			r2Refuse(t, ctx, p, query)
		} else {
			r2Refuse(t, ctx, p, query, r.ID)
		}
	}
	a01Exec(t, ctx, p, `INSERT INTO transfer_restitution_operations(operation_key,request_id,variant_id,actor_location_id,action,expected_revision,reason) VALUES('raw-accept',$1,1,$2,'accept',1,'confirmed')`, r.ID, r.Destination.ID)
	r2Refuse(t, ctx, p, `INSERT INTO transfer_restitution_operations(operation_key,request_id,variant_id,actor_location_id,action,expected_revision,reason) VALUES('raw-accept',$1,1,$2,'accept',1,'confirmed') ON CONFLICT DO NOTHING`, r.ID, r.Destination.ID)
	for _, table := range []string{"transfer_restitution_operations", "transfer_restitution_proposals", "transfer_restitution_decisions", "transfer_restitution_applications"} {
		r2Refuse(t, ctx, p, "UPDATE "+table+" SET request_id=request_id")
		r2Refuse(t, ctx, p, "DELETE FROM "+table)
		r2Refuse(t, ctx, p, "TRUNCATE "+table+" CASCADE")
	}
	for _, entry := range []bool{true, false} {
		before := r2Snapshot(t, ctx, p)
		tx := a01Begin(t, ctx, p)
		a01Exec(t, ctx, tx, `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`)
		query := r2Call
		args := []any{r.ID, 1, r.Origin.ID, "isolation", "propose", 1, 1, true, "reason"}
		if !entry {
			query = `INSERT INTO transfer_restitution_operations(operation_key,request_id,variant_id,actor_location_id,action,expected_revision,retained_quantity,retained_at_origin,reason) VALUES('isolation',$1,1,$2,'propose',1,1,true,'reason')`
			args = []any{r.ID, r.Origin.ID}
		}
		if _, err := tx.Exec(ctx, query, args...); err == nil {
			t.Fatal("isolation admitted")
		}
		_ = tx.Rollback(ctx)
		if r2Snapshot(t, ctx, p) != before {
			t.Fatal("isolation leaked effects")
		}
	}
}

func TestR2RestitutionSQLLatestEffectiveCredit(t *testing.T) {
	ctx, p, r := r2Receipt(t, 5, 4)
	c2Do(t, ctx, p, r, 1, r.Origin.ID, "lower", "propose", 0, 2)
	c2Do(t, ctx, p, r, 1, r.Destination.ID, "lower-accept", "accept", 1, nil)
	// Receipt C=4 would refuse q=3. The latest applied C=2 admits it.
	r2Do(t, ctx, p, r, r.Origin.ID, "retained", "propose", 0, 3, true)
	if scalar(t, ctx, p, `SELECT count(*) FROM transfer_restitution_proposals WHERE count_generation=2 AND count_applied_revision=1 AND base_credit=2 AND base_restitution=0 AND base_revision=0 AND retained_at_origin`) != 1 {
		t.Fatal("incorrect evidence pins")
	}
	r2Do(t, ctx, p, r, r.Destination.ID, "accept", "accept", 1, nil, nil)
	if scalar(t, ctx, p, `SELECT count(*) FROM transfer_restitution_applications WHERE quantity=3`) != 1 {
		t.Fatal("latest effective credit ignored")
	}
}

func TestR2RestitutionSQLAllocationCoverage(t *testing.T) {
	ctx, p, r := r2Receipt(t, 5, 4)
	s := transfers.New(p)
	var existing int64
	if err := p.QueryRow(ctx, `SELECT existing FROM inventory_balances WHERE location_id=$1 AND variant_id=1`, r.Origin.ID).Scan(&existing); err != nil {
		t.Fatal(err)
	}
	in := input()
	in.Items = []transfers.Line{{VariantID: 1, Quantity: existing}}
	in.RetryKey = "released-origin-hold"
	released := create(t, ctx, s, r.Destination.ID, in).Request
	if _, err := s.Approve(ctx, actor(released.Approver.ID), released.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Cancel(ctx, actor(released.Creator.ID), released.ID); err != nil {
		t.Fatal(err)
	}
	in.Items = []transfers.Line{{VariantID: 1, Quantity: 1}}
	in.RetryKey = "active-origin-hold"
	live := create(t, ctx, s, r.Destination.ID, in).Request
	if _, err := s.Approve(ctx, actor(live.Approver.ID), live.ID); err != nil {
		t.Fatal(err)
	}
	original := r2Original(t, ctx, p)
	before := stocks(t, ctx, p)
	r2Do(t, ctx, p, r, r.Origin.ID, "retained", "propose", 0, 1, true)
	covered := r2Snapshot(t, ctx, p)
	tx := a01Begin(t, ctx, p)
	// Coverage constraints are deferred; the restitution guard must still
	// refuse an uncovered balance before it can persist application evidence.
	a01Exec(t, ctx, tx, `UPDATE inventory_balances SET reserved=0 WHERE location_id=$1 AND variant_id=1`, r.Origin.ID)
	if _, err := tx.Exec(ctx, r2Call, r.ID, 1, r.Destination.ID, "uncovered", "accept", 1, nil, nil, "reason"); err == nil {
		t.Fatal("uncovered source accepted")
	}
	_ = tx.Rollback(ctx)
	if r2Snapshot(t, ctx, p) != covered {
		t.Fatal("coverage refusal leaked effects")
	}
	r2Do(t, ctx, p, r, r.Destination.ID, "confirmed", "accept", 1, nil, nil)
	for i, row := range stocks(t, ctx, p) {
		want := before[i]
		if want.Location == r.Origin.ID && want.Variant == 1 {
			want.Existing++
			want.Available++
		}
		if row != want {
			t.Fatal("active/released coverage or reserved mutation")
		}
	}
	if original != r2Original(t, ctx, p) {
		t.Fatal("allocation history changed")
	}
}

func TestR2RestitutionSQLPhysicalAuthorization(t *testing.T) {
	ctx, p, s := fixture(t)
	in := input()
	in.CounterpartyID = 3
	in.Items = []transfers.Line{{VariantID: 1, Quantity: 5}}
	r := receiptDispatch(t, ctx, s, in)
	if _, err := s.Receive(ctx, actor(r.Destination.ID), r.ID, transfers.ReceiptInput{Items: []transfers.Line{{VariantID: 1, Quantity: 4}}}); err != nil {
		t.Fatal(err)
	}
	r2Do(t, ctx, p, r, r.Origin.ID, "physical", "propose", 0, 1, true)
	r2Refuse(t, ctx, p, r2Call, r.ID, 1, 1, "physical", "propose", 0, 1, true, "retained at origin verified")
	r2Refuse(t, ctx, p, r2Call, r.ID, 1, 1, "warehouse", "accept", 1, nil, nil, "reason")
	r2Do(t, ctx, p, r, r.Destination.ID, "physical-accept", "accept", 1, nil, nil)
	// Persisted receipt membership is checked before operation identity replay.
	r2Refuse(t, ctx, p, r2Call, r.ID, 4, r.Origin.ID, "physical", "propose", 0, 1, true, "retained at origin verified")
}

func TestR2RestitutionSQLCountRollback(t *testing.T) {
	for _, mode := range []string{"zero_explicit", "zero_deferred", "lower_deferred"} {
		t.Run(mode, func(t *testing.T) {
			ctx, p, r := r2Receipt(t, 5, 4)
			r2Do(t, ctx, p, r, r.Origin.ID, "retained", "propose", 0, 1, true)
			r2Do(t, ctx, p, r, r.Destination.ID, "confirmed", "accept", 1, nil, nil)
			actual := int64(4)
			if mode == "lower_deferred" {
				actual = 3
			}
			c2Do(t, ctx, p, r, 1, r.Origin.ID, "count", "propose", 0, actual)
			if mode != "zero_explicit" {
				a01Exec(t, ctx, p, `CREATE FUNCTION r2_count_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$; CREATE CONSTRAINT TRIGGER r2_count_fail AFTER INSERT ON transfer_count_applications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION r2_count_fail()`)
			}
			before := r2Snapshot(t, ctx, p)
			tx := a01Begin(t, ctx, p)
			_, err := tx.Exec(ctx, c2Call, r.ID, 1, r.Destination.ID, "decision", "accept", 1, nil, "count verified")
			if err != nil {
				t.Fatal(err)
			}
			if mode != "zero_explicit" && tx.Commit(ctx) == nil {
				t.Fatal("deferred failure ignored")
			}
			_ = tx.Rollback(ctx)
			if r2Snapshot(t, ctx, p) != before {
				t.Fatal("count rollback leaked zero/nonzero evidence or invalidation")
			}
		})
	}
}

func TestR2RestitutionSQLNotifications(t *testing.T) {
	ctx, p, r := r2Receipt(t, 5, 4)
	listener, err := p.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Release()
	if _, err := listener.Exec(ctx, "LISTEN luson_realtime"); err != nil {
		t.Fatal(err)
	}
	a, b, other, inv := c2Revision(t, ctx, p, "transfers:1"), c2Revision(t, ctx, p, "transfers:2"), c2Revision(t, ctx, p, "transfers:3"), c2Revision(t, ctx, p, "inventory")
	r2Do(t, ctx, p, r, r.Origin.ID, "notify", "propose", 0, 1, true)
	r2Do(t, ctx, p, r, r.Destination.ID, "reject", "reject", 1, nil, nil)
	if c2Revision(t, ctx, p, "transfers:1") != a+2 || c2Revision(t, ctx, p, "transfers:2") != b+2 || c2Revision(t, ctx, p, "transfers:3") != other || c2Revision(t, ctx, p, "inventory") != inv {
		t.Fatal("reject/pending audience")
	}
	hints := map[string]int{}
	for i := 0; i < 4; i++ {
		wait, cancel := context.WithTimeout(ctx, time.Second)
		n, err := listener.Conn().WaitForNotification(wait)
		cancel()
		if err != nil {
			t.Fatal("missing committed participant notification")
		}
		hints[n.Payload]++
	}
	if hints["transfers:1"] != 2 || hints["transfers:2"] != 2 || len(hints) != 2 {
		t.Fatal("notification audience")
	}
	r2Do(t, ctx, p, r, r.Destination.ID, "reject", "reject", 1, nil, nil)
	tx := a01Begin(t, ctx, p)
	if _, err := tx.Exec(ctx, r2Call, r.ID, 1, r.Origin.ID, "rollback", "propose", 1, 1, true, "retained"); err != nil {
		t.Fatal(err)
	}
	_ = tx.Rollback(ctx)
	wait, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
	defer cancel()
	if n, err := listener.Conn().WaitForNotification(wait); err == nil || n != nil {
		t.Fatal("replay/rollback emitted hint")
	}
}

func TestR2RestitutionSQLRollback(t *testing.T) {
	for _, mode := range []string{"overflow", "balance_failure", "suppressed_credit", "application_failure", "deferred_failure", "explicit_rollback"} {
		t.Run(mode, func(t *testing.T) {
			ctx, p, r := r2Receipt(t, 5, 4)
			if mode == "overflow" {
				a01Exec(t, ctx, p, `UPDATE inventory_balances SET existing=9223372036854775807 WHERE location_id=$1 AND variant_id=1`, r.Origin.ID)
			}
			r2Do(t, ctx, p, r, r.Origin.ID, "proposal", "propose", 0, 1, true)
			switch mode {
			case "balance_failure":
				a01Exec(t, ctx, p, `CREATE FUNCTION r2_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$; CREATE TRIGGER r2_fail BEFORE UPDATE ON inventory_balances FOR EACH ROW EXECUTE FUNCTION r2_fail()`)
			case "suppressed_credit":
				a01Exec(t, ctx, p, `CREATE FUNCTION r2_suppress() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; CREATE TRIGGER r2_suppress BEFORE UPDATE ON inventory_balances FOR EACH ROW EXECUTE FUNCTION r2_suppress()`)
			case "application_failure":
				a01Exec(t, ctx, p, `CREATE FUNCTION r2_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$; CREATE TRIGGER r2_fail BEFORE INSERT ON transfer_restitution_applications FOR EACH ROW EXECUTE FUNCTION r2_fail()`)
			case "deferred_failure":
				a01Exec(t, ctx, p, `CREATE FUNCTION r2_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$; CREATE CONSTRAINT TRIGGER r2_fail AFTER INSERT ON transfer_restitution_applications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION r2_fail()`)
			}
			before := r2Snapshot(t, ctx, p)
			tx := a01Begin(t, ctx, p)
			_, err := tx.Exec(ctx, r2Call, r.ID, 1, r.Destination.ID, "accept", "accept", 1, nil, nil, "reason")
			if mode == "explicit_rollback" {
				if err != nil {
					t.Fatal(err)
				}
			} else {
				if err == nil {
					err = tx.Commit(ctx)
				}
				if err == nil {
					t.Fatal("failure not atomic")
				}
			}
			_ = tx.Rollback(ctx)
			if r2Snapshot(t, ctx, p) != before {
				t.Fatal("rollback leaked effects")
			}
		})
	}
}
