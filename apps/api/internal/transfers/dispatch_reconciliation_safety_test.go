package transfers_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/transfers"
)

// Refusals compare public stock, both existing workflow histories, original
// detail/list and private evidence/counters, rather than just row existence.
func dr1Snapshot(t *testing.T, ctx context.Context, p *pgxpool.Pool, r transfers.Request) string {
	t.Helper()
	s := transfers.New(p)
	counts := c2StoreRead(t, ctx, s, r)
	restitutions, err := s.GetRestitutions(ctx, actor(r.Origin.ID), r.ID)
	if err != nil {
		t.Fatal(err)
	}
	detail, err := s.Get(ctx, actor(r.Origin.ID), r.ID)
	if err != nil {
		t.Fatal(err)
	}
	page, err := s.List(ctx, actor(r.Destination.ID), transfers.Query{Status: "received"})
	if err != nil {
		t.Fatal(err)
	}
	public, err := json.Marshal([]any{dr1Inventory(t, ctx, p), counts, restitutions, detail, page})
	if err != nil {
		t.Fatal(err)
	}
	var evidence string
	if err := p.QueryRow(ctx, `SELECT jsonb_build_array(
 (SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY operation_key),'[]') FROM transfer_dispatch_operations o),
 (SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY request_id,variant_id,revision),'[]') FROM transfer_dispatch_proposals o),
 (SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY request_id,variant_id,revision),'[]') FROM transfer_dispatch_decisions o),
 (SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY request_id,variant_id,revision),'[]') FROM transfer_dispatch_applications o),
 (SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY request_id,variant_id,revision),'[]') FROM transfer_count_reconciliation_pins o),
 (SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY request_id,variant_id,revision),'[]') FROM transfer_restitution_reconciliation_pins o))::text`).Scan(&evidence); err != nil {
		t.Fatal(err)
	}
	return string(public) + r2Snapshot(t, ctx, p) + evidence
}

func dr1Refuse(t *testing.T, ctx context.Context, p *pgxpool.Pool, r transfers.Request, code, query string, args ...any) {
	t.Helper()
	before := dr1Snapshot(t, ctx, p, r)
	if _, err := p.Exec(ctx, query, args...); !sqlState(err, code) {
		t.Fatalf("want SQLSTATE %s, got %v", code, err)
	}
	if before != dr1Snapshot(t, ctx, p, r) {
		t.Fatal("rejected operation changed public state, evidence or counters")
	}
}

func TestDR1GuardsReplayAndRejection(t *testing.T) {
	ctx, p, r := r2Receipt(t, 5, 7)
	for i, tc := range []struct {
		variant, who int
		q            any
		code         string
	}{{1, 3, 7, "42501"}, {1, 1, 5, "23514"}, {1, 1, 6, "23514"}, {1, 1, -1, "23514"}, {1, 1, nil, "23514"}, {3, 1, 1, "23514"}, {4, 1, 7, "23514"}} {
		dr1Refuse(t, ctx, p, r, tc.code, dr1Call, r.ID, tc.variant, tc.who, fmt.Sprintf("dr1-invalid-%d", i), "propose", 0, tc.q, "verified")
	}
	stock := dr1Inventory(t, ctx, p)
	inv, other := c2Revision(t, ctx, p, "inventory"), c2Revision(t, ctx, p, "transfers:3")
	a, b := c2Revision(t, ctx, p, "transfers:1"), c2Revision(t, ctx, p, "transfers:2")
	dr1Do(t, ctx, p, r, 2, "dr1-destination-proposal", "propose", 0, 7)
	dr1Refuse(t, ctx, p, r, "42501", dr1Call, r.ID, 1, 2, "dr1-self-accept", "accept", 1, nil, "verified")
	dr1Refuse(t, ctx, p, r, "42501", dr1Call, r.ID, 1, 1, "dr1-other-replace", "propose", 1, 7, "verified")
	dr1Refuse(t, ctx, p, r, "23505", dr1Call, r.ID, 1, 2, "dr1-destination-proposal", "propose", 0, 7, "changed reason")
	dr1Refuse(t, ctx, p, r, "42501", dr1Call, r.ID, 1, 3, "dr1-destination-proposal", "propose", 0, 7, "physical dispatch verified")
	dr1Do(t, ctx, p, r, 2, "dr1-replacement", "propose", 1, 7)
	dr1Refuse(t, ctx, p, r, "23514", dr1Call, r.ID, 1, 1, "dr1-stale-decision", "accept", 1, nil, "verified")
	dr1Do(t, ctx, p, r, 1, "dr1-reject", "reject", 2, nil)
	if !reflect.DeepEqual(stock, dr1Inventory(t, ctx, p)) || c2Revision(t, ctx, p, "inventory") != inv || c2Revision(t, ctx, p, "transfers:3") != other || c2Revision(t, ctx, p, "transfers:1") != a+3 || c2Revision(t, ctx, p, "transfers:2") != b+3 {
		t.Fatal("pending/replacement/rejection stock or participant invalidations")
	}
	before := dr1Snapshot(t, ctx, p, r)
	dr1Do(t, ctx, p, r, 2, "dr1-destination-proposal", "propose", 0, 7)
	dr1Do(t, ctx, p, r, 1, "dr1-reject", "reject", 2, nil)
	if before != dr1Snapshot(t, ctx, p, r) {
		t.Fatal("historical exact replay effects")
	}
	dr1Refuse(t, ctx, p, r, "23514", dr1Call, r.ID, 1, 1, "dr1-terminal-accept", "accept", 2, nil, "verified")
	dr1Do(t, ctx, p, r, 1, "dr1-fresh-proposal", "propose", 2, 7)
	dr1Do(t, ctx, p, r, 2, "dr1-fresh-accept", "accept", 3, nil)
	dr1Refuse(t, ctx, p, r, "23514", dr1Call, r.ID, 1, 1, "dr1-noop", "propose", 3, 7, "verified")
}

func TestDR1CrossWorkflowPins(t *testing.T) {
	t.Run("count_pending_before_reconciliation", func(t *testing.T) {
		ctx, p, r := r2Receipt(t, 5, 7)
		s := transfers.New(p)
		proposal := c2StorePropose(t, ctx, s, r, 1, 1, 0, 8, "dr1-old-count-proposal")
		dr1Do(t, ctx, p, r, 1, "dr1-pin-propose", "propose", 0, 7)
		dr1Do(t, ctx, p, r, 2, "dr1-pin-accept", "accept", 1, nil)
		before := dr1Snapshot(t, ctx, p, r)
		_, err := s.DecideCount(ctx, actor(2), r.ID, transfers.CountDecisionInput{VariantID: 1, OperationKey: "dr1-old-count-accept", ExpectedRevision: 1, Accept: true, Reason: "verified"})
		if !errors.Is(err, transfers.ErrDecisionConflict) || before != dr1Snapshot(t, ctx, p, r) {
			t.Fatal("count acceptance failed to fence changed reconciliation", err)
		}
		if retry := c2StorePropose(t, ctx, s, r, 1, 1, 0, 8, "dr1-old-count-proposal"); !reflect.DeepEqual(retry, proposal) {
			t.Fatal("stale exact proposal replay changed")
		}
		c2StoreDecide(t, ctx, s, r, 2, 1, 1, false, "dr1-old-count-reject")
	})
	t.Run("count_changed_away_and_back", func(t *testing.T) {
		ctx, p, r := r2Receipt(t, 5, 7)
		s := transfers.New(p)
		dr1Do(t, ctx, p, r, 1, "dr1-before-count", "propose", 0, 7)
		for i, actual := range []int64{8, 7} {
			c2StorePropose(t, ctx, s, r, 1, 1, int64(i), actual, fmt.Sprintf("dr1-away-propose-%d", i))
			c2StoreDecide(t, ctx, s, r, 2, 1, int64(i+1), true, fmt.Sprintf("dr1-away-accept-%d", i))
		}
		dr1Refuse(t, ctx, p, r, "23514", dr1Call, r.ID, 1, 2, "dr1-after-count", "accept", 1, nil, "verified")
		dr1Do(t, ctx, p, r, 2, "dr1-reject-stale", "reject", 1, nil)
	})
	t.Run("restitution_pending_before_reconciliation", func(t *testing.T) {
		ctx, p, r := r2Receipt(t, 5, 4)
		s := transfers.New(p)
		if _, err := s.ProposeRestitution(ctx, actor(1), r.ID, r3Proposal("dr1-old-restitution", 0, 1)); err != nil {
			t.Fatal(err)
		}
		dr1Do(t, ctx, p, r, 2, "dr1-rest-pin-propose", "propose", 0, 4)
		dr1Do(t, ctx, p, r, 1, "dr1-rest-pin-accept", "accept", 1, nil)
		before := dr1Snapshot(t, ctx, p, r)
		if _, err := s.DecideRestitution(ctx, actor(2), r.ID, r3Decision("dr1-old-rest-accept", 1, true)); !errors.Is(err, transfers.ErrDecisionConflict) || before != dr1Snapshot(t, ctx, p, r) {
			t.Fatal("restitution accepted stale reconciliation pins", err)
		}
		if _, err := s.DecideRestitution(ctx, actor(2), r.ID, r3Decision("dr1-old-rest-reject", 1, false)); err != nil {
			t.Fatal("cannot reject stale restitution", err)
		}
	})
}

func TestDR1RestitutionEffectiveCapacityAndExclusion(t *testing.T) {
	ctx, p, r := r2Receipt(t, 5, 7)
	s := transfers.New(p)
	dr1Do(t, ctx, p, r, 1, "dr1-cap-propose", "propose", 0, 7)
	dr1Do(t, ctx, p, r, 2, "dr1-cap-accept", "accept", 1, nil)
	c2StorePropose(t, ctx, s, r, 1, 1, 0, 4, "dr1-cap-count-propose")
	c2StoreDecide(t, ctx, s, r, 2, 1, 1, true, "dr1-cap-count-accept")
	before := dr1Inventory(t, ctx, p)
	if _, err := s.ProposeRestitution(ctx, actor(1), r.ID, r3Proposal("dr1-cap-rest-propose", 0, 3)); err != nil {
		t.Fatal("capacity must use effective D=7, C=4, not original D=5", err)
	}
	if _, err := s.DecideRestitution(ctx, actor(2), r.ID, r3Decision("dr1-cap-rest-accept", 1, true)); err != nil {
		t.Fatal(err)
	}
	after := dr1Inventory(t, ctx, p)
	before[0].Items[0].Existing += 3
	before[0].Items[0].Available += 3
	if !reflect.DeepEqual(before, after) {
		t.Fatal("restitution did not credit exactly effective remaining debit")
	}
	dr1Refuse(t, ctx, p, r, "23514", dr1Call, r.ID, 1, 1, "dr1-excluded-after-rest", "propose", 1, 4, "verified")
	c2StorePropose(t, ctx, s, r, 1, 1, 1, 5, "dr1-conservation-propose")
	state := dr1Snapshot(t, ctx, p, r)
	if _, err := s.DecideCount(ctx, actor(2), r.ID, transfers.CountDecisionInput{VariantID: 1, OperationKey: "dr1-conservation-accept", ExpectedRevision: 2, Accept: true, Reason: "verified"}); !errors.Is(err, transfers.ErrDecisionConflict) || state != dr1Snapshot(t, ctx, p, r) {
		t.Fatal("effective D-C-R conservation failed", err)
	}
}

func TestDR1AtomicBalanceGuards(t *testing.T) {
	for _, mode := range []string{"reserved", "overflow", "source_overflow", "missing_source", "missing_destination", "second_update", "suppressed_update", "deferred"} {
		t.Run(mode, func(t *testing.T) {
			actual := int64(7)
			if mode == "source_overflow" {
				actual = 4
			}
			ctx, p, r := r2Receipt(t, 5, actual)
			dr1Do(t, ctx, p, r, 1, "dr1-atomic-propose", "propose", 0, actual)
			switch mode {
			case "reserved":
				a01Exec(t, ctx, p, `UPDATE inventory_balances SET reserved=existing WHERE location_id=1 AND variant_id=1`)
			case "overflow":
				a01Exec(t, ctx, p, `UPDATE inventory_balances SET existing=9223372036854775807 WHERE location_id=2 AND variant_id=1`)
			case "source_overflow":
				a01Exec(t, ctx, p, `UPDATE inventory_balances SET existing=9223372036854775807 WHERE location_id=1 AND variant_id=1`)
			case "missing_source", "missing_destination":
				location := 1
				if mode == "missing_destination" {
					location = 2
				}
				a01Exec(t, ctx, p, `DELETE FROM inventory_balances WHERE location_id=$1 AND variant_id=1`, location)
			case "second_update":
				a01Exec(t, ctx, p, `CREATE FUNCTION dr1_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.location_id=2 THEN RAISE EXCEPTION 'second update failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER dr1_fail BEFORE UPDATE ON inventory_balances FOR EACH ROW EXECUTE FUNCTION dr1_fail()`)
			case "suppressed_update":
				a01Exec(t, ctx, p, `CREATE FUNCTION dr1_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.location_id=2 THEN RETURN NULL; END IF; RETURN NEW; END $$; CREATE TRIGGER dr1_fail BEFORE UPDATE ON inventory_balances FOR EACH ROW EXECUTE FUNCTION dr1_fail()`)
			case "deferred":
				a01Exec(t, ctx, p, `CREATE FUNCTION dr1_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'deferred failure'; END $$; CREATE CONSTRAINT TRIGGER dr1_fail AFTER INSERT ON transfer_dispatch_applications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dr1_fail()`)
			}
			before := dr1Snapshot(t, ctx, p, r)
			tx := a01Begin(t, ctx, p)
			_, err := tx.Exec(ctx, dr1Call, r.ID, 1, 2, "dr1-atomic-accept", "accept", 1, nil, "verified")
			if mode == "deferred" && err != nil {
				t.Fatal("deferred failure occurred before commit", err)
			}
			if err == nil {
				err = tx.Commit(ctx)
			}
			if err == nil {
				t.Fatal("unsafe or injected acceptance committed")
			}
			_ = tx.Rollback(ctx)
			if before != dr1Snapshot(t, ctx, p, r) {
				t.Fatal("failed acceptance leaked stock, history or counters")
			}
		})
	}
}

func TestDR1DirectEvidenceAndIsolation(t *testing.T) {
	ctx, p, r := r2Receipt(t, 5, 7)
	a01Exec(t, ctx, p, `INSERT INTO transfer_dispatch_operations(operation_key,request_id,variant_id,actor_location_id,action,expected_revision,dispatch_quantity,reason,revision,recorded_at) VALUES('dr1-raw',$1,1,1,'propose',0,7,'verified',99,'2000-01-01')`, r.ID)
	dr1Do(t, ctx, p, r, 2, "dr1-raw-accept", "accept", 1, nil)
	if scalar(t, ctx, p, `SELECT count(*) FROM transfer_dispatch_operations WHERE operation_key='dr1-raw' AND revision=1 AND recorded_at>'2000-01-01'`) != 1 {
		t.Fatal("server metadata was caller controlled")
	}
	for _, table := range []string{"transfer_dispatch_operations", "transfer_dispatch_proposals", "transfer_dispatch_decisions", "transfer_dispatch_applications", "transfer_count_reconciliation_pins", "transfer_restitution_reconciliation_pins"} {
		// Statement TRUNCATE protection also applies to empty companion tables.
		dr1Refuse(t, ctx, p, r, "P0001", "TRUNCATE "+table+" CASCADE")
		if table == "transfer_count_reconciliation_pins" || table == "transfer_restitution_reconciliation_pins" {
			continue
		}
		for _, query := range []string{"UPDATE " + table + " SET request_id=request_id", "DELETE FROM " + table} {
			dr1Refuse(t, ctx, p, r, "P0001", query)
		}
		if table != "transfer_dispatch_operations" {
			dr1Refuse(t, ctx, p, r, "23514", "INSERT INTO "+table+" SELECT * FROM "+table)
		}
	}
	dr1Refuse(t, ctx, p, r, "23505", `INSERT INTO transfer_dispatch_operations(operation_key,request_id,variant_id,actor_location_id,action,expected_revision,reason) VALUES('dr1-raw-accept',$1,1,2,'accept',1,'physical dispatch verified') ON CONFLICT DO NOTHING`, r.ID)
	for _, direct := range []bool{false, true} {
		before := dr1Snapshot(t, ctx, p, r)
		tx := a01Begin(t, ctx, p)
		a01Exec(t, ctx, tx, `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`)
		query := dr1Call
		args := []any{r.ID, 1, 1, "dr1-isolation", "propose", 1, 7, "verified"}
		if direct {
			query = `INSERT INTO transfer_dispatch_operations(operation_key,request_id,variant_id,actor_location_id,action,expected_revision,dispatch_quantity,reason) VALUES('dr1-isolation',$1,1,1,'propose',1,7,'verified')`
			args = []any{r.ID}
		}
		if _, err := tx.Exec(ctx, query, args...); !sqlState(err, "25000") {
			t.Fatal("non-READ-COMMITTED operation admitted", err)
		}
		_ = tx.Rollback(ctx)
		if before != dr1Snapshot(t, ctx, p, r) {
			t.Fatal("isolation refusal effects")
		}
	}
}
