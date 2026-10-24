package transfers_test

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/transfers"
	"luson/api/migrations"
)

func TestDR1ExistingPendingUpgrade(t *testing.T) {
	ctx, p, s := fixture(t)
	// Provision requires the complete current migration tracker. Keep that
	// invariant and the admitted fixture: use the actual old operation bodies
	// with only the new companion-recording hooks disabled to produce legacy
	// proposals. Original admission/immutability guards remain enabled.
	a01Exec(t, ctx, p, `ALTER TABLE transfer_count_proposals DISABLE TRIGGER record_count_reconciliation_pin; ALTER TABLE transfer_restitution_proposals DISABLE TRIGGER record_restitution_reconciliation_pin`)
	dr1InstallOperation(t, ctx, p, "011_transfer_count_corrections.sql", "apply_transfer_count_operation")
	dr1InstallOperation(t, ctx, p, "012_transfer_restitutions.sql", "apply_restitution_operation")
	a01Exec(t, ctx, p, `UPDATE inventory_balances SET existing=100 WHERE location_id=1 AND variant_id=1`)
	var requests []transfers.Request
	for i := 0; i < 4; i++ {
		in := input()
		in.RetryKey = fmt.Sprintf("dr1-upgrade-create-%d", i)
		in.Items = []transfers.Line{{VariantID: 1, Quantity: 5}}
		r := receiptDispatch(t, ctx, s, in)
		actual := int64(7)
		if i%2 == 1 {
			actual = 4
		}
		var err error
		r, err = s.Receive(ctx, actor(2), r.ID, transfers.ReceiptInput{Items: []transfers.Line{{VariantID: 1, Quantity: actual}}})
		if err != nil {
			t.Fatal(err)
		}
		requests = append(requests, r)
		if i%2 == 0 {
			c2StorePropose(t, ctx, s, r, 1, 1, 0, 8, fmt.Sprintf("dr1-upgrade-count-%d", i))
		} else if _, err := s.ProposeRestitution(ctx, actor(1), r.ID, r3Proposal(fmt.Sprintf("dr1-upgrade-rest-%d", i), 0, 1)); err != nil {
			t.Fatal(err)
		}
	}
	original := r2Original(t, ctx, p)
	dr1InstallOperation(t, ctx, p, "013_transfer_dispatch_reconciliation.sql", "apply_transfer_count_operation")
	dr1InstallOperation(t, ctx, p, "013_transfer_dispatch_reconciliation.sql", "apply_restitution_operation")
	a01Exec(t, ctx, p, `ALTER TABLE transfer_count_proposals ENABLE TRIGGER record_count_reconciliation_pin; ALTER TABLE transfer_restitution_proposals ENABLE TRIGGER record_restitution_reconciliation_pin`)
	var err error
	if original != r2Original(t, ctx, p) {
		t.Fatal("upgrade rewrote original evidence")
	}
	// A legacy proposal's absent pin must not become caller-refreshable via an
	// unrelated nested trigger with the same depth as the legitimate writer.
	a01Exec(t, ctx, p, `CREATE TABLE dr1_pin_outer(id bigint); CREATE TABLE dr1_pin_inner(id bigint);
 CREATE FUNCTION dr1_pin_outer_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO dr1_pin_inner VALUES(NEW.id); RETURN NEW; END $$;
 CREATE FUNCTION dr1_pin_inner_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO transfer_count_reconciliation_pins SELECT p.request_id,p.variant_id,p.revision,s.reconciliation_generation,s.restitution_generation,s.dispatch
 FROM transfer_count_proposals p CROSS JOIN LATERAL transfer_effective_line(p.request_id,p.variant_id) s WHERE p.request_id=NEW.id;
 RETURN NEW; END $$;
 CREATE TRIGGER dr1_pin_outer_write AFTER INSERT ON dr1_pin_outer FOR EACH ROW EXECUTE FUNCTION dr1_pin_outer_write();
 CREATE TRIGGER dr1_pin_inner_write AFTER INSERT ON dr1_pin_inner FOR EACH ROW EXECUTE FUNCTION dr1_pin_inner_write()`)
	dr1Refuse(t, ctx, p, requests[2], "23514", `INSERT INTO dr1_pin_outer VALUES($1)`, requests[2].ID)
	// Unchanged legacy consent remains valid, even with no companion rows.
	c2StoreDecide(t, ctx, s, requests[2], 2, 1, 1, true, "dr1-upgrade-unchanged-count")
	if _, err := s.DecideRestitution(ctx, actor(2), requests[3].ID, r3Decision("dr1-upgrade-unchanged-rest", 1, true)); err != nil {
		t.Fatal("unchanged legacy restitution refused", err)
	}
	for i, r := range requests[:2] {
		quantity := int64(7)
		if i == 1 {
			quantity = 4
		}
		dr1Do(t, ctx, p, r, 1, fmt.Sprintf("dr1-upgrade-propose-%d", i), "propose", 0, quantity)
		dr1Do(t, ctx, p, r, 2, fmt.Sprintf("dr1-upgrade-accept-%d", i), "accept", 1, nil)
		before := dr1Snapshot(t, ctx, p, r)
		if i == 0 {
			_, err = s.DecideCount(ctx, actor(2), r.ID, transfers.CountDecisionInput{VariantID: 1, OperationKey: "dr1-upgrade-stale-count", ExpectedRevision: 1, Accept: true, Reason: "verified"})
		} else {
			_, err = s.DecideRestitution(ctx, actor(2), r.ID, r3Decision("dr1-upgrade-stale-rest", 1, true))
		}
		if !errors.Is(err, transfers.ErrDecisionConflict) || before != dr1Snapshot(t, ctx, p, r) {
			t.Fatal("legacy generation-zero consent not fenced", err)
		}
		if i == 0 {
			c2StoreDecide(t, ctx, s, r, 2, 1, 1, false, "dr1-upgrade-reject-count")
		} else if _, err := s.DecideRestitution(ctx, actor(2), r.ID, r3Decision("dr1-upgrade-reject-rest", 1, false)); err != nil {
			t.Fatal(err)
		}
	}
}

// This is test-only administrative setup within the helper-owned random DB;
// bodies come from embedded migrations, never git history or external files.
func dr1InstallOperation(t *testing.T, ctx context.Context, p *pgxpool.Pool, file, name string) {
	t.Helper()
	raw, err := migrations.Files.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	sql := strings.ReplaceAll(string(raw), "CREATE FUNCTION ", "CREATE OR REPLACE FUNCTION ")
	start := strings.Index(sql, "CREATE OR REPLACE FUNCTION "+name+"()")
	if start < 0 {
		t.Fatal("operation body not found")
	}
	sql = sql[start:]
	end := strings.Index(sql, "$$;")
	if end < 0 {
		t.Fatal("operation body terminator not found")
	}
	a01Exec(t, ctx, p, sql[:end+3])
}

func TestDR1ZeroDispatchAndProtectedPins(t *testing.T) {
	ctx, p, r := r2Receipt(t, 5, 0)
	s := transfers.New(p)
	c2StorePropose(t, ctx, s, r, 1, 1, 0, 0, "dr1-zero-count-proposal")
	c2StoreDecide(t, ctx, s, r, 2, 1, 1, false, "dr1-zero-count-reject")
	if _, err := s.ProposeRestitution(ctx, actor(1), r.ID, r3Proposal("dr1-zero-rest-proposal", 0, 1)); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"transfer_count_reconciliation_pins", "transfer_restitution_reconciliation_pins"} {
		for _, query := range []string{"UPDATE " + table + " SET effective_dispatch=effective_dispatch", "DELETE FROM " + table, "TRUNCATE " + table + " CASCADE"} {
			dr1Refuse(t, ctx, p, r, "P0001", query)
		}
		dr1Refuse(t, ctx, p, r, "23514", "INSERT INTO "+table+" SELECT * FROM "+table)
	}
	stock := dr1Inventory(t, ctx, p)
	dr1Do(t, ctx, p, r, 2, "dr1-zero-proposal", "propose", 0, 0)
	dr1Do(t, ctx, p, r, 1, "dr1-zero-accept", "accept", 1, nil)
	stock[0].Items[0].Existing += 5
	stock[0].Items[0].Available += 5
	if got := dr1Inventory(t, ctx, p); !reflect.DeepEqual(stock, got) {
		t.Fatal("zero reconciliation did not restore original debit exactly")
	}
	if _, err := s.GetRestitutions(ctx, actor(2), r.ID); err != nil {
		t.Fatal("zero effective dispatch history is unreadable", err)
	}
	if _, err := s.DecideRestitution(ctx, actor(2), r.ID, r3Decision("dr1-zero-rest-reject", 1, false)); err != nil {
		t.Fatal("zero-dispatch stale proposal cannot be rejected", err)
	}
}
