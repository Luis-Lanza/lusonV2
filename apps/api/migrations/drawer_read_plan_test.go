package migrations_test

import (
	"strings"
	"testing"
)

// TestDrawerReadKeepsTheIndexQual is the plan-level half of S4: the guard's read of the sales
// window must keep `created_at` as an index qual once its plan goes generic, which is what
// `coalesce(since,'-infinity')` buys over the `(since IS NULL OR created_at >= since)` form.
func TestDrawerReadKeepsTheIndexQual(t *testing.T) {
	ctx, p := drawerDB(t)
	conn, err := p.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	for _, stmt := range []string{
		"SET plan_cache_mode = force_generic_plan",
		"SET enable_seqscan = off",
		"PREPARE drawer_window_in(smallint,timestamptz) AS SELECT coalesce(sum(cash_amount),0) FROM sales" +
			" WHERE branch_location_id=$1 AND created_at >= coalesce($2,'-infinity'::timestamptz)",
		"PREPARE drawer_window_or(smallint,timestamptz) AS SELECT coalesce(sum(cash_amount),0) FROM sales" +
			" WHERE branch_location_id=$1 AND ($2 IS NULL OR created_at >= $2)",
	} {
		if _, err := conn.Exec(ctx, stmt); err != nil {
			t.Fatalf("%s: %v", stmt, err)
		}
	}
	plan := func(name string) string {
		rows, err := conn.Query(ctx, "EXPLAIN (COSTS OFF) EXECUTE "+name+"(2, NULL)")
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		defer rows.Close()
		var lines []string
		for rows.Next() {
			var line string
			if err := rows.Scan(&line); err != nil {
				t.Fatal(err)
			}
			lines = append(lines, line)
		}
		return strings.Join(lines, "\n")
	}
	indexCond := func(p string) string {
		for _, line := range strings.Split(p, "\n") {
			if strings.Contains(line, "Index Cond:") {
				return line
			}
		}
		return ""
	}
	coalesced, disjunction := plan("drawer_window_in"), plan("drawer_window_or")
	t.Logf("coalesce plan:\n%s", coalesced)
	t.Logf("disjunction plan:\n%s", disjunction)
	if got := indexCond(coalesced); !strings.Contains(got, "created_at >=") {
		t.Fatalf("the drawer's window must stay an index qual under a generic plan: %q\n%s", got, coalesced)
	}
	if got := indexCond(disjunction); strings.Contains(got, "created_at") {
		t.Fatalf("the disjunction form must not be an index qual: %q", got)
	}
	// The open side of a branch that closed nothing counts its whole history, the oldest row included.
	for _, stmt := range []string{
		"ALTER TABLE branch_cash_movements DISABLE TRIGGER admit_branch_cash_movement",
		`INSERT INTO branch_cash_movements(branch_location_id,kind,amount,description,
 created_by_account_id,occurred_at) VALUES(2,'gasto',50.00,'Gasto anterior a la regla',2,'2020-01-01T10:00:00Z')`,
		"ALTER TABLE branch_cash_movements ENABLE TRIGGER admit_branch_cash_movement",
	} {
		if _, err := conn.Exec(ctx, stmt); err != nil {
			t.Fatalf("the pre-rule row (%s): %v", stmt, err)
		}
	}
	var expected string
	if err := conn.QueryRow(ctx, "SELECT branch_drawer_expected(2::smallint)::text").Scan(&expected); err != nil || expected != "-50.00" {
		t.Fatalf("the whole history must be counted when nothing was closed: %q %v", expected, err)
	}
}
