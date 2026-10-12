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

func c2Receipt(t *testing.T, reverse bool) (context.Context, *pgxpool.Pool, transfers.Request) {
	t.Helper()
	ctx, p, s := fixture(t)
	in := input()
	if reverse {
		in.Kind = transfers.SendToWarehouse
	}
	r := receiptDispatch(t, ctx, s, in)
	tx := a01Begin(t, ctx, p)
	defer tx.Rollback(ctx)
	a01Exec(t, ctx, tx, `INSERT INTO transfer_receipt_lines(request_id,variant_id,expected_quantity,actual_quantity,available_quantity) VALUES($1,1,2,1,1),($1,2,1,1,1),($1,3,0,7,0)`, r.ID)
	a01Exec(t, ctx, tx, `UPDATE transfer_requests SET status='received' WHERE id=$1`, r.ID)
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return ctx, p, r
}

const c2Call = `SELECT revision FROM transfer_count_correct($1,$2,$3::smallint,$4,$5,$6,$7,$8)`

func c2Do(t *testing.T, ctx context.Context, p *pgxpool.Pool, r transfers.Request, variant, actor int, key, action string, revision int64, actual any) int64 {
	t.Helper()
	var got int64
	if err := p.QueryRow(ctx, c2Call, r.ID, variant, actor, key, action, revision, actual, "count verified").Scan(&got); err != nil {
		t.Fatal(err)
	}
	return got
}
func c2Snapshot(t *testing.T, ctx context.Context, p *pgxpool.Pool) string {
	t.Helper()
	var evidence string
	if err := p.QueryRow(ctx, `SELECT jsonb_build_array(
 (SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY operation_key),'[]') FROM transfer_count_operations o),
 (SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY request_id,variant_id,revision),'[]') FROM transfer_count_proposals o),
 (SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY request_id,variant_id,revision),'[]') FROM transfer_count_decisions o),
 (SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY request_id,variant_id,revision),'[]') FROM transfer_count_applications o))::text`).Scan(&evidence); err != nil {
		t.Fatal(err)
	}
	return receiptSnapshot(t, ctx, p) + evidence
}
func c2Refuse(t *testing.T, ctx context.Context, p *pgxpool.Pool, query string, args ...any) {
	t.Helper()
	before := c2Snapshot(t, ctx, p)
	if _, err := p.Exec(ctx, query, args...); err == nil {
		t.Fatal("invalid correction admitted", query)
	}
	if after := c2Snapshot(t, ctx, p); after != before {
		t.Fatal("refusal changed evidence, inventory or revisions")
	}
}
func c2Revision(t *testing.T, ctx context.Context, p *pgxpool.Pool, scope string) int64 {
	t.Helper()
	var n int64
	if err := p.QueryRow(ctx, `SELECT revision FROM realtime_revisions WHERE scope=$1`, scope).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}
func c2Credit(t *testing.T, ctx context.Context, p *pgxpool.Pool, variant int, revision, credit, delta int64) {
	t.Helper()
	var c, d int64
	if err := p.QueryRow(ctx, `SELECT effective_credit,delta FROM transfer_count_applications WHERE variant_id=$1 AND revision=$2`, variant, revision).Scan(&c, &d); err != nil {
		t.Fatal(err)
	}
	if c != credit || d != delta {
		t.Fatalf("credit/delta %d/%d want %d/%d", c, d, credit, delta)
	}
}

func TestC2CorrectionAgreement(t *testing.T) {
	for _, reverse := range []bool{false, true} {
		t.Run(fmt.Sprint(reverse), func(t *testing.T) {
			ctx, p, r := c2Receipt(t, reverse)
			original := stocks(t, ctx, p)
			var receipt string
			if err := p.QueryRow(ctx, `SELECT jsonb_build_array((SELECT to_jsonb(h) FROM transfer_requests h WHERE id=$1),(SELECT jsonb_agg(to_jsonb(l) ORDER BY variant_id) FROM transfer_receipt_lines l WHERE request_id=$1),(SELECT jsonb_agg(to_jsonb(e) ORDER BY variant_id,kind) FROM transfer_receipt_exceptions e WHERE request_id=$1),(SELECT jsonb_agg(to_jsonb(a) ORDER BY variant_id) FROM transfer_request_allocations a WHERE request_id=$1))::text`, r.ID).Scan(&receipt); err != nil {
				t.Fatal(err)
			}
			initiator, other := r.Origin.ID, r.Destination.ID
			// Successive corrections use the latest applied credit, not original receipt.
			for i, tc := range []struct{ actual, credit, delta int64 }{{2, 2, 1}, {9, 2, 0}, {0, 0, -2}, {1, 1, 1}, {0, 0, -1}} {
				revision := int64(i + 1)
				key := fmt.Sprintf("proposal-%d", i)
				stockBefore := stocks(t, ctx, p)
				if c2Do(t, ctx, p, r, 1, initiator, key, "propose", revision-1, tc.actual) != revision {
					t.Fatal("proposal revision")
				}
				if !reflect.DeepEqual(stockBefore, stocks(t, ctx, p)) {
					t.Fatal("pending proposal changed inventory")
				}
				before := c2Snapshot(t, ctx, p)
				c2Do(t, ctx, p, r, 1, initiator, key, "propose", revision-1, tc.actual)
				if c2Snapshot(t, ctx, p) != before {
					t.Fatal("proposal replay not silent")
				}
				inventory := c2Revision(t, ctx, p, "inventory")
				c2Do(t, ctx, p, r, 1, other, fmt.Sprintf("accept-%d", i), "accept", revision, nil)
				c2Credit(t, ctx, p, 1, revision, tc.credit, tc.delta)
				for j, row := range stocks(t, ctx, p) {
					want := stockBefore[j]
					if want.Location == r.Destination.ID && want.Variant == 1 {
						want.Existing += tc.delta
						want.Available += tc.delta
					}
					if row != want {
						t.Fatal("incorrect destination delta or unrelated balance mutation")
					}
				}
				wantChange := int64(0)
				if tc.delta != 0 {
					wantChange = 1
				}
				if c2Revision(t, ctx, p, "inventory")-inventory != wantChange {
					t.Fatal("inventory invalidation mismatch")
				}
				settled := c2Snapshot(t, ctx, p)
				c2Do(t, ctx, p, r, 1, other, fmt.Sprintf("accept-%d", i), "accept", revision, nil)
				if c2Snapshot(t, ctx, p) != settled {
					t.Fatal("decision retry reapplied")
				}
				initiator, other = other, initiator
			}
			// Originally matching and unexpected lines are both eligible, independently.
			c2Do(t, ctx, p, r, 2, r.Destination.ID, "matching", "propose", 0, 0)
			c2Do(t, ctx, p, r, 3, r.Origin.ID, "unexpected", "propose", 0, 0)
			c2Do(t, ctx, p, r, 2, r.Origin.ID, "matching-accept", "accept", 1, nil)
			inventory := c2Revision(t, ctx, p, "inventory")
			c2Do(t, ctx, p, r, 3, r.Destination.ID, "unexpected-accept", "accept", 1, nil)
			c2Credit(t, ctx, p, 2, 1, 0, -1)
			c2Credit(t, ctx, p, 3, 1, 0, 0)
			c2Do(t, ctx, p, r, 3, r.Destination.ID, "unexpected-up", "propose", 1, 9223372036854775807)
			c2Do(t, ctx, p, r, 3, r.Origin.ID, "unexpected-up-accept", "accept", 2, nil)
			c2Credit(t, ctx, p, 3, 2, 0, 0)
			if c2Revision(t, ctx, p, "inventory") != inventory {
				t.Fatal("unexpected correction changed inventory")
			}
			for i, row := range stocks(t, ctx, p) {
				if row.Location == r.Origin.ID && row != original[i] {
					t.Fatal("origin stock restored")
				}
			}
			var after string
			if err := p.QueryRow(ctx, `SELECT jsonb_build_array((SELECT to_jsonb(h) FROM transfer_requests h WHERE id=$1),(SELECT jsonb_agg(to_jsonb(l) ORDER BY variant_id) FROM transfer_receipt_lines l WHERE request_id=$1),(SELECT jsonb_agg(to_jsonb(e) ORDER BY variant_id,kind) FROM transfer_receipt_exceptions e WHERE request_id=$1),(SELECT jsonb_agg(to_jsonb(a) ORDER BY variant_id) FROM transfer_request_allocations a WHERE request_id=$1))::text`, r.ID).Scan(&after); err != nil {
				t.Fatal(err)
			}
			if after != receipt {
				t.Fatal("original header, receipt, exception or allocation changed")
			}
		})
	}
}

func TestC2CorrectionRevisionAndAuthorization(t *testing.T) {
	// Branch-to-branch flow: the warehouse approver is not a physical endpoint.
	ctx, p, s := fixture(t)
	in := input()
	in.CounterpartyID = 3
	r := receiptDispatch(t, ctx, s, in)
	if _, err := s.Receive(ctx, actor(r.Destination.ID), r.ID, receiptInput(r)); err != nil {
		t.Fatal(err)
	}
	c2Refuse(t, ctx, p, c2Call, r.ID, 1, 1, "warehouse", "propose", 0, 0, "reason")
	c2Do(t, ctx, p, r, 1, r.Destination.ID, "first", "propose", 0, 0)
	for _, tc := range []struct {
		variant, actor int
		key, action    string
		rev            int64
		actual         any
		reason         string
	}{
		{1, 1, "first", "propose", 0, 0, "count verified"},
		{1, r.Origin.ID, "first", "propose", 0, 0, "count verified"},
		{1, r.Destination.ID, "first", "propose", 0, 1, "count verified"},
		{1, r.Destination.ID, "first", "propose", 0, 0, "different"},
		{1, r.Origin.ID, "replace-forged", "propose", 1, 1, "reason"},
		{1, r.Destination.ID, "self", "accept", 1, nil, "reason"},
		{1, r.Origin.ID, "stale", "accept", 0, nil, "reason"},
		{4, r.Origin.ID, "absent", "propose", 0, 1, "reason"},
		{1, r.Destination.ID, "negative", "propose", 1, -1, "reason"},
		{1, r.Destination.ID, "empty", "propose", 1, 1, " "},
		{1, r.Destination.ID, "null-count", "propose", 1, nil, "reason"},
		{1, r.Origin.ID, "decision-count", "accept", 1, 1, "reason"},
	} {
		c2Refuse(t, ctx, p, c2Call, r.ID, tc.variant, tc.actor, tc.key, tc.action, tc.rev, tc.actual, tc.reason)
	}
	c2Do(t, ctx, p, r, 1, r.Destination.ID, "replacement", "propose", 1, 1)
	beforeReplay := c2Snapshot(t, ctx, p)
	c2Do(t, ctx, p, r, 1, r.Destination.ID, "first", "propose", 0, 0)
	if c2Snapshot(t, ctx, p) != beforeReplay {
		t.Fatal("historical retry altered latest revision")
	}
	c2Refuse(t, ctx, p, c2Call, r.ID, 1, r.Origin.ID, "old-consent", "accept", 1, nil, "reason")
	inventory := c2Revision(t, ctx, p, "inventory")
	c2Do(t, ctx, p, r, 1, r.Origin.ID, "reject", "reject", 2, nil)
	if c2Revision(t, ctx, p, "inventory") != inventory || scalar(t, ctx, p, `SELECT count(*) FROM transfer_count_applications`) != 0 {
		t.Fatal("rejection changed effective counts")
	}
	c2Refuse(t, ctx, p, c2Call, r.ID, 1, r.Origin.ID, "terminal", "accept", 2, nil, "reason")
	// New revision after rejection may repeat identical counts from either endpoint.
	c2Do(t, ctx, p, r, 1, r.Origin.ID, "after-reject", "propose", 2, 1)
	c2Do(t, ctx, p, r, 1, r.Destination.ID, "accepted", "accept", 3, nil)
	c2Credit(t, ctx, p, 1, 3, 1, -1)
	if scalar(t, ctx, p, `SELECT count(*) FROM transfer_count_proposals WHERE base_revision=0 AND base_credit=2`) != 3 {
		t.Fatal("pending/rejected revision advanced effective base")
	}
	if scalar(t, ctx, p, `SELECT count(*) FROM transfer_count_operations WHERE reason='' OR recorded_at IS NULL`) != 0 {
		t.Fatal("missing audit metadata")
	}
}

func TestC2CorrectionSQLGuards(t *testing.T) {
	ctx, p, r := c2Receipt(t, false)
	c2Do(t, ctx, p, r, 1, r.Origin.ID, "proposal", "propose", 0, 2)
	for _, q := range []string{
		`INSERT INTO transfer_count_proposals SELECT * FROM transfer_count_proposals`,
		`INSERT INTO transfer_count_decisions VALUES($1,1,1,'forged',2,true,'reason',statement_timestamp())`,
		`INSERT INTO transfer_count_applications VALUES($1,1,1,2,1,statement_timestamp())`,
		`UPDATE transfer_receipt_lines SET actual_quantity=2 WHERE request_id=$1`,
		`DELETE FROM transfer_receipt_exceptions WHERE request_id=$1`,
		`UPDATE transfer_requests SET received_at=statement_timestamp() WHERE id=$1`,
		`INSERT INTO transfer_count_operations(operation_key,request_id,variant_id,actor_location_id,action,expected_revision,actual_quantity,reason,revision,recorded_at) VALUES('forged-actor',$1,1,3,'propose',1,0,'reason',99,now())`,
	} {
		if q == `INSERT INTO transfer_count_proposals SELECT * FROM transfer_count_proposals` {
			c2Refuse(t, ctx, p, q)
		} else {
			c2Refuse(t, ctx, p, q, r.ID)
		}
	}
	c2Do(t, ctx, p, r, 1, r.Destination.ID, "accept", "accept", 1, nil)
	c2Refuse(t, ctx, p, `INSERT INTO transfer_count_operations(operation_key,request_id,variant_id,actor_location_id,action,expected_revision,actual_quantity,reason) VALUES('accept',$1,2,2,'propose',0,0,'forged reuse') ON CONFLICT DO NOTHING`, r.ID)
	for _, table := range []string{"transfer_count_operations", "transfer_count_proposals", "transfer_count_decisions", "transfer_count_applications"} {
		c2Refuse(t, ctx, p, "UPDATE "+table+" SET request_id=request_id")
		c2Refuse(t, ctx, p, "DELETE FROM "+table)
		c2Refuse(t, ctx, p, "TRUNCATE "+table+" CASCADE")
	}
	// Bare SQL operation insertion is also a complete workflow, never a partial audit.
	a01Exec(t, ctx, p, `INSERT INTO transfer_count_operations(operation_key,request_id,variant_id,actor_location_id,action,expected_revision,actual_quantity,reason,revision,recorded_at) VALUES('raw',$1,2,2,'propose',0,0,'raw count',999,'2000-01-01')`, r.ID)
	if scalar(t, ctx, p, `SELECT count(*) FROM transfer_count_operations WHERE operation_key='raw' AND revision=1 AND recorded_at>'2000-01-01'`) != 1 {
		t.Fatal("caller forged server metadata")
	}
	if scalar(t, ctx, p, `SELECT count(*) FROM transfer_count_proposals WHERE operation_key='raw'`) != 1 {
		t.Fatal("partial raw operation")
	}
	before := c2Snapshot(t, ctx, p)
	tx := a01Begin(t, ctx, p)
	a01Exec(t, ctx, tx, `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`)
	if _, err := tx.Exec(ctx, c2Call, r.ID, 2, 1, "isolation", "accept", 1, nil, "reason"); err == nil {
		t.Fatal("stale isolation admitted")
	}
	_ = tx.Rollback(ctx)
	if c2Snapshot(t, ctx, p) != before {
		t.Fatal("isolation refusal leaked effects")
	}
}

func TestC2CorrectionReleasedAllocationHistory(t *testing.T) {
	ctx, p, r := c2Receipt(t, false)
	s := transfers.New(p)
	initial := stocks(t, ctx, p)
	var destinationStock int64
	if err := p.QueryRow(ctx, `SELECT existing FROM inventory_balances WHERE location_id=$1 AND variant_id=1`, r.Destination.ID).Scan(&destinationStock); err != nil {
		t.Fatal(err)
	}
	// Cancel a real approved outbound transfer. Its released allocation remains
	// durable history, but it must no longer contribute to active coverage.
	outbound := input()
	outbound.Kind = transfers.SendToWarehouse
	outbound.RetryKey = "c2-released-outbound-key"
	outbound.Items = []transfers.Line{{VariantID: 1, Quantity: destinationStock}}
	cancelled := create(t, ctx, s, r.Destination.ID, outbound).Request
	if _, err := s.Approve(ctx, actor(cancelled.Approver.ID), cancelled.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Cancel(ctx, actor(cancelled.Creator.ID), cancelled.ID); err != nil {
		t.Fatal(err)
	}
	var releasedEvidence string
	if err := p.QueryRow(ctx, `SELECT to_jsonb(a)::text FROM transfer_request_allocations a
		WHERE request_id=$1 AND variant_id=1 AND consumed_at IS NULL AND released_at IS NOT NULL AND quantity=$2`, cancelled.ID, destinationStock).Scan(&releasedEvidence); err != nil {
		t.Fatal("cancelled allocation evidence missing", err)
	}
	if !reflect.DeepEqual(initial, stocks(t, ctx, p)) {
		t.Fatal("cancellation did not release reservation without consuming stock")
	}
	// Keep one genuine live reservation alongside the released history.
	outbound.RetryKey = "c2-live-outbound-key"
	outbound.Items = []transfers.Line{{VariantID: 1, Quantity: 1}}
	live := create(t, ctx, s, r.Destination.ID, outbound).Request
	if _, err := s.Approve(ctx, actor(live.Approver.ID), live.ID); err != nil {
		t.Fatal(err)
	}
	var active, reserved int64
	if err := p.QueryRow(ctx, `SELECT
		(SELECT coalesce(sum(quantity),0) FROM transfer_request_allocations
		 WHERE origin_location_id=$1 AND variant_id=1 AND consumed_at IS NULL AND released_at IS NULL),
		reserved FROM inventory_balances WHERE location_id=$1 AND variant_id=1`, r.Destination.ID).Scan(&active, &reserved); err != nil {
		t.Fatal(err)
	}
	if active != 1 || reserved != active {
		t.Fatalf("live coverage %d, reserved %d", active, reserved)
	}
	for i, tc := range []struct{ actual, credit, delta int64 }{{2, 2, 1}, {0, 0, -2}} {
		revision := int64(i + 1)
		before := stocks(t, ctx, p)
		proposalKey := fmt.Sprintf("released-proposal-%d", i)
		decisionKey := fmt.Sprintf("released-accept-%d", i)
		c2Do(t, ctx, p, r, 1, r.Origin.ID, proposalKey, "propose", revision-1, tc.actual)
		if !reflect.DeepEqual(before, stocks(t, ctx, p)) {
			t.Fatal("proposal changed inventory")
		}
		// Both nonzero corrections are safe despite durable released history.
		c2Do(t, ctx, p, r, 1, r.Destination.ID, decisionKey, "accept", revision, nil)
		c2Credit(t, ctx, p, 1, revision, tc.credit, tc.delta)
		for j, row := range stocks(t, ctx, p) {
			want := before[j]
			if want.Location == r.Destination.ID && want.Variant == 1 {
				want.Existing += tc.delta
				want.Available += tc.delta
			}
			if row != want {
				t.Fatal("correction changed reserved, origin or unrelated stock")
			}
		}
		var audited int
		if err := p.QueryRow(ctx, `SELECT count(*) FROM transfer_count_proposals p
			JOIN transfer_count_decisions d USING(request_id,variant_id,revision)
			JOIN transfer_count_applications a USING(request_id,variant_id,revision)
			JOIN transfer_count_operations o ON o.operation_key=d.operation_key
			WHERE p.request_id=$1 AND p.variant_id=1 AND p.revision=$2 AND d.accepted
			AND o.action='accept' AND o.revision=p.revision AND o.recorded_at=d.recorded_at
			AND d.recorded_at=a.recorded_at`, r.ID, revision).Scan(&audited); err != nil || audited != 1 {
			t.Fatal("acceptance did not persist atomic linked audit", err)
		}
		settled := c2Snapshot(t, ctx, p)
		c2Do(t, ctx, p, r, 1, r.Destination.ID, decisionKey, "accept", revision, nil)
		if c2Snapshot(t, ctx, p) != settled {
			t.Fatal("decision retry duplicated correction or audit")
		}
	}
	var baseRevision, baseCredit int64
	if err := p.QueryRow(ctx, `SELECT base_revision,base_credit FROM transfer_count_proposals
		WHERE request_id=$1 AND variant_id=1 AND revision=2`, r.ID).Scan(&baseRevision, &baseCredit); err != nil {
		t.Fatal(err)
	}
	if baseRevision != 1 || baseCredit != 2 {
		t.Fatal("downward correction did not use latest applied credit")
	}
	var finalReleased string
	if err := p.QueryRow(ctx, `SELECT to_jsonb(a)::text FROM transfer_request_allocations a
		WHERE request_id=$1 AND variant_id=1`, cancelled.ID).Scan(&finalReleased); err != nil {
		t.Fatal(err)
	}
	if finalReleased != releasedEvidence {
		t.Fatal("correction rewrote released allocation history")
	}
	// The genuine live allocation remains covered after both corrections.
	var existing int64
	if err := p.QueryRow(ctx, `SELECT existing FROM inventory_balances WHERE location_id=$1 AND variant_id=1`, r.Destination.ID).Scan(&existing); err != nil {
		t.Fatal(err)
	}
	if existing < active {
		t.Fatal("correction violated live allocation coverage")
	}
}

func TestC2CorrectionCoverageRollbackAndInvalidation(t *testing.T) {
	for _, mode := range []string{"reserved", "active_allocation", "overflow", "balance_failure", "deferred_failure", "explicit_rollback"} {
		t.Run(mode, func(t *testing.T) {
			ctx, p, r := c2Receipt(t, false)
			actual := int64(0)
			if mode == "overflow" {
				actual = 2
				a01Exec(t, ctx, p, `UPDATE inventory_balances SET existing=9223372036854775807 WHERE location_id=2 AND variant_id=1`)
			}
			if mode == "reserved" {
				a01Exec(t, ctx, p, `UPDATE inventory_balances SET reserved=existing WHERE location_id=2 AND variant_id=1`)
			}
			if mode == "active_allocation" {
				// An independently approved outbound request owns all available destination stock.
				s := transfers.New(p)
				in := input()
				in.Kind = transfers.SendToWarehouse
				in.RetryKey = "c2-outbound-reservation-key"
				var held int64
				if err := p.QueryRow(ctx, `SELECT existing FROM inventory_balances WHERE location_id=2 AND variant_id=1`).Scan(&held); err != nil {
					t.Fatal(err)
				}
				in.Items = []transfers.Line{{VariantID: 1, Quantity: held}}
				outgoing := create(t, ctx, s, 2, in).Request
				if _, err := s.Approve(ctx, actor(outgoing.Approver.ID), outgoing.ID); err != nil {
					t.Fatal(err)
				}
			}
			c2Do(t, ctx, p, r, 1, r.Origin.ID, "proposal", "propose", 0, actual)
			if mode == "balance_failure" {
				a01Exec(t, ctx, p, `CREATE FUNCTION c2_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected balance failure'; END $$; CREATE TRIGGER c2_fail BEFORE UPDATE ON inventory_balances FOR EACH ROW EXECUTE FUNCTION c2_fail()`)
			}
			if mode == "deferred_failure" {
				a01Exec(t, ctx, p, `CREATE FUNCTION c2_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected commit failure'; END $$; CREATE CONSTRAINT TRIGGER c2_fail AFTER INSERT ON transfer_count_applications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION c2_fail()`)
			}
			before := c2Snapshot(t, ctx, p)
			tx := a01Begin(t, ctx, p)
			_, err := tx.Exec(ctx, c2Call, r.ID, 1, r.Destination.ID, "accept", "accept", 1, nil, "count verified")
			if mode == "explicit_rollback" {
				if err != nil {
					t.Fatal(err)
				}
				_ = tx.Rollback(ctx)
			} else {
				if err == nil {
					err = tx.Commit(ctx)
				}
				if err == nil {
					t.Fatal("unsafe correction accepted")
				}
				_ = tx.Rollback(ctx)
			}
			if c2Snapshot(t, ctx, p) != before {
				t.Fatal("rollback leaked decision, application, balance or invalidation")
			}
		})
	}
	ctx, p, r := c2Receipt(t, false)
	listener, err := p.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Release()
	if _, err := listener.Exec(ctx, "LISTEN luson_realtime"); err != nil {
		t.Fatal(err)
	}
	inv := c2Revision(t, ctx, p, "inventory")
	a := c2Revision(t, ctx, p, "transfers:1")
	b := c2Revision(t, ctx, p, "transfers:2")
	other := c2Revision(t, ctx, p, "transfers:3")
	c2Do(t, ctx, p, r, 3, 1, "audit", "propose", 0, 0)
	c2Do(t, ctx, p, r, 3, 2, "reject", "reject", 1, nil)
	if c2Revision(t, ctx, p, "inventory") != inv || c2Revision(t, ctx, p, "transfers:1") != a+2 || c2Revision(t, ctx, p, "transfers:2") != b+2 || c2Revision(t, ctx, p, "transfers:3") != other {
		t.Fatal("participant-only invalidation mismatch")
	}
	hints := map[string]int{}
	for i := 0; i < 4; i++ {
		wait, cancel := context.WithTimeout(ctx, time.Second)
		n, err := listener.Conn().WaitForNotification(wait)
		cancel()
		if err != nil {
			t.Fatal("missing committed participant hint", err)
		}
		hints[n.Payload]++
	}
	if hints["transfers:1"] != 2 || hints["transfers:2"] != 2 || len(hints) != 2 {
		t.Fatal("incorrect hint audience", hints)
	}
	c2Do(t, ctx, p, r, 3, 2, "reject", "reject", 1, nil)
	tx := a01Begin(t, ctx, p)
	if _, err := tx.Exec(ctx, c2Call, r.ID, 3, 2, "rolled-back", "propose", 1, 7, "reason"); err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	wait, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
	defer cancel()
	if n, err := listener.Conn().WaitForNotification(wait); err == nil || n != nil {
		t.Fatal("retry or rollback emitted committed hint")
	}
}
