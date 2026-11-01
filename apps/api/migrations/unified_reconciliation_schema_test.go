package migrations_test

import (
	"context"
	"fmt"
	"reflect"
	"testing"
	"time"

	"luson/api/internal/auth"
	"luson/api/internal/bootstrap"
	"luson/api/internal/config"
	"luson/api/internal/testpg"
	"luson/api/internal/transfers"
)

// This probe uses only the admitted fixture and baseline public lifecycle APIs.
func TestUnifiedReconciliationSQLUnit(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	p := testpg.Open(t)
	if err := bootstrap.Initialize(ctx, p, config.LocalTrial); err != nil {
		t.Fatal(err)
	}
	t.Run("accounting", func(t *testing.T) {
		for _, tc := range []struct {
			input string
			want  [7]int64
		}{
			{"10,9,8,1,10,8", [7]int64{9, 8, 1, 0, 0, 1, 0}},
			{"10,9,8,1,9,8", [7]int64{9, 8, 0, 0, 0, 1, 0}},
			{"10,12,14,0,10,8", [7]int64{12, 12, -2, 4, 0, 0, 2}},
			{"10,8,7,1,10,7", [7]int64{9, 7, 1, 0, 1, 1, 0}},
			{"0,0,0,0,0,0", [7]int64{}},
		} {
			var got [7]int64
			err := p.QueryRow(ctx, "SELECT * FROM transfer_unified_accounting("+tc.input+")").Scan(&got[0], &got[1], &got[2], &got[3], &got[4], &got[5], &got[6])
			if err != nil || got != tc.want {
				t.Fatalf("%s: %v %v", tc.input, got, err)
			}
		}
		for _, input := range []string{"10,12,8,1,10,8", "10,9,8,2,10,8", "-1,0,0,0,0,0", "NULL,0,0,0,0,0"} {
			if _, err := p.Exec(ctx, "SELECT * FROM transfer_unified_accounting("+input+")"); err == nil {
				t.Fatal("invalid accounting admitted", input)
			}
		}
	})
	credentials := make([]bootstrap.Credentials, 3)
	for i := range credentials {
		credentials[i] = bootstrap.Credentials{Username: "u" + testpg.Random(t)[:20], Password: testpg.Random(t)}
	}
	if err := bootstrap.Provision(ctx, p, credentials); err != nil {
		t.Fatal(err)
	}
	who := func(id int) auth.Identity { return auth.Identity{AccountID: id, Location: auth.Location{ID: id}} }
	s := transfers.New(p)
	created, err := s.Create(ctx, who(2), transfers.CreateInput{Kind: transfers.RequestStock, CounterpartyID: 1, RetryKey: "sql-unit-create-0001", Items: []transfers.Line{{VariantID: 1, Quantity: 10}}})
	if err != nil {
		t.Fatal(err)
	}
	r := created.Request
	if _, err = s.Approve(ctx, who(1), r.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Dispatch(ctx, who(1), r.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Receive(ctx, who(2), r.ID, transfers.ReceiptInput{Items: []transfers.Line{{VariantID: 1, Quantity: 8}}}); err != nil {
		t.Fatal(err)
	}
	var owned bool
	if err = p.QueryRow(ctx, "SELECT transfer_unified_owned($1)", r.ID).Scan(&owned); err != nil || owned {
		t.Fatal("empty ledger claimed ownership", err)
	}
	// A complete legacy agreement still works before the first unified proposal.
	legacy := `SELECT revision FROM transfer_restitute($1,1,$2::smallint,$3,$4,$5,$6,$7,'SQL unit retention')`
	for _, args := range [][]any{{r.ID, 1, "sql-unit-legacy-propose", "propose", 0, 1, true}, {r.ID, 2, "sql-unit-legacy-accept", "accept", 1, nil, nil}} {
		if _, err = p.Exec(ctx, legacy, args...); err != nil {
			t.Fatal("preownership legacy", err)
		}
	}
	var debit, credit int64
	if err = p.QueryRow(ctx, "SELECT source_debit,credit FROM transfer_unified_line($1,1)", r.ID).Scan(&debit, &credit); err != nil || debit != 9 || credit != 8 {
		t.Fatal("legacy ledger accounting", debit, credit, err)
	}
	snapshot := func() string {
		t.Helper()
		var result string
		if err := p.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(x) ORDER BY table_name)::text FROM (
   SELECT table_name, query_to_xml(format('SELECT * FROM %I ORDER BY 1,2',table_name),false,true,'')::text AS rows
   FROM information_schema.tables WHERE table_schema='public') x`).Scan(&result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	call := `SELECT revision FROM transfer_unified_reconcile($1,1,$2::smallint,$3,$4,$5,$6,$7,$8,$9,'SQL unit agreement')`
	// Prior restoration already supplies the entire source credit: acceptance
	// must preserve every physical balance and the original receipt evidence.
	physical := func() string {
		t.Helper()
		var got string
		if err := p.QueryRow(ctx, `SELECT jsonb_build_array(
   (SELECT jsonb_agg(to_jsonb(b) ORDER BY location_id,variant_id) FROM inventory_balances b),
   (SELECT jsonb_agg(to_jsonb(r) ORDER BY request_id,variant_id) FROM transfer_receipt_lines r))::text`).Scan(&got); err != nil {
			t.Fatal(err)
		}
		return got
	}
	beforePhysical := physical()
	original := snapshot()
	proposal := []any{r.ID, 1, "sql-unit-unified-propose", "propose", 0, 9, 8, 1, true}
	acceptance := []any{r.ID, 2, "sql-unit-unified-accept", "accept", 1, nil, nil, nil, false}
	for _, args := range [][]any{proposal, acceptance} {
		if _, err = p.Exec(ctx, call, args...); err != nil {
			t.Fatal(err)
		}
	}
	if snapshot() == original {
		t.Fatal("agreement missing")
	}
	if physical() != beforePhysical {
		t.Fatal("agreement double-credited stock or changed original receipt")
	}
	if err = p.QueryRow(ctx, "SELECT transfer_unified_owned($1)", r.ID).Scan(&owned); err != nil || !owned {
		t.Fatal("proposal did not claim ownership", err)
	}
	settled := snapshot()
	for _, args := range [][]any{proposal, acceptance} {
		if _, err = p.Exec(ctx, call, args...); err != nil {
			t.Fatal(err)
		}
	}
	if !reflect.DeepEqual(settled, snapshot()) {
		t.Fatal("exact replay changed state")
	}
	for _, table := range []string{"transfer_unified_operations", "transfer_unified_proposals", "transfer_unified_decisions", "transfer_unified_applications"} {
		for _, query := range []string{fmt.Sprintf("UPDATE %s SET request_id=request_id", table), "DELETE FROM " + table, "TRUNCATE " + table + " CASCADE"} {
			if _, err = p.Exec(ctx, query); err == nil {
				t.Fatal("evidence mutation admitted", query)
			}
			if settled != snapshot() {
				t.Fatal("refusal changed data or counters")
			}
		}
	}
}
