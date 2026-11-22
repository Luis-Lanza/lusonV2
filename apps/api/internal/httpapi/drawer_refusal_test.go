package httpapi

import (
	"fmt"
	"testing"
)

// The refusal of the operational drawer at the HTTP layer (S4, S5), brought in from the
// independent verification of T9 so the answer of the three write routes is pinned by this suite.

// TestDrawerRefusalOnEveryWriteRoute proves S4 on the three routes that write the till: expenses,
// cash-movements and cash-corrections all answer the same 409 body, carrying the balance and the
// requested amount, and the correction's own refusals keep their precedence over the bound. Money
// coming in stays admitted (S3).
func TestDrawerRefusalOnEveryWriteRoute(t *testing.T) {
	f := closingFixture(t)
	f.contribute(t, 2, "5.00", "Fondo de la caja")

	f.refused(t, f.request(2, "POST", "/api/closings/expenses",
		`{"amount":"10.00","description":"Flete de la semana","category_id":1}`), 409,
		`{"balance":"5.00","error":"drawer_insufficient","requested":"10.00"}`)

	// Both directions of the till state the bound, and the expense states its motive: the motive is the
	// last word of the row, so it never answers before the drawer (061, S3).
	for _, body := range []string{
		`{"kind":"gasto","amount":"10.00","description":"Flete de la semana","category_id":1}`,
		`{"kind":"recaudacion","amount":"10.00","description":"Retiro de la caja"}`,
	} {
		f.refused(t, f.request(2, "POST", "/api/closings/cash-movements", body), 409,
			`{"balance":"5.00","error":"drawer_insufficient","requested":"10.00"}`)
	}

	// Fund the till to 25.00 and spend it whole, so correcting the 20.00 aporte would take it to -20.00.
	f.contribute(t, 2, "20.00", "Fondo extra")
	var aporteID, gastoID int64
	if err := f.p.QueryRow(f.ctx, `SELECT id FROM branch_cash_movements
 WHERE branch_location_id=2 AND kind='aporte' AND amount=20.00 ORDER BY id DESC LIMIT 1`).Scan(&aporteID); err != nil {
		t.Fatalf("the aporte id could not be read: %v", err)
	}
	if w := f.serve(t, f.request(2, "POST", "/api/closings/cash-movements",
		`{"kind":"gasto","amount":"25.00","description":"Compra de la tienda","category_id":1}`)); w.Code != 201 {
		t.Fatalf("spending exactly what the till holds must be admitted: %d %s", w.Code, w.Body.String())
	}
	if err := f.p.QueryRow(f.ctx, `SELECT id FROM branch_cash_movements
 WHERE branch_location_id=2 AND kind='gasto' ORDER BY id DESC LIMIT 1`).Scan(&gastoID); err != nil {
		t.Fatalf("the gasto id could not be read: %v", err)
	}

	// The correction route: correcting an aporte takes money out and obeys the same bound.
	f.refused(t, f.request(2, "POST", "/api/closings/cash-corrections",
		fmt.Sprintf(`{"corrects_id":%d,"amount":"20.00","description":"Corrijo el aporte"}`, aporteID)), 409,
		`{"balance":"0.00","error":"drawer_insufficient","requested":"20.00"}`)

	// Precedence of the correction refusals (LC031, LC030) over the bound on the same route.
	f.refused(t, f.request(2, "POST", "/api/closings/cash-corrections",
		fmt.Sprintf(`{"corrects_id":%d,"amount":"25.00","description":"Corrijo el aporte"}`, aporteID)), 409,
		`{"error":"correction_exceeds"}`)
	f.refused(t, f.request(2, "POST", "/api/closings/cash-corrections",
		`{"corrects_id":999999,"amount":"20.00","description":"Corrijo el aporte"}`), 400,
		`{"error":"correction_target_invalid"}`)

	// S3: a correction of the gasto puts money back and is admitted on an empty till.
	if w := f.serve(t, f.request(2, "POST", "/api/closings/cash-corrections",
		fmt.Sprintf(`{"corrects_id":%d,"amount":"5.00","description":"Corrijo el gasto"}`, gastoID))); w.Code != 201 {
		t.Fatalf("money in must never be refused: %d %s", w.Code, w.Body.String())
	}
}

// TestDrawerFreezeAndScopeAnswerBeforeTheBound proves S5: the freeze and the scope of the operator
// still answer before the balance rule, on the routes that now carry it.
func TestDrawerFreezeAndScopeAnswerBeforeTheBound(t *testing.T) {
	f := closingFixture(t)
	f.open(t, 2)
	f.refused(t, f.request(2, "POST", "/api/closings/expenses",
		`{"amount":"999999.00","description":"Flete de la semana","category_id":1}`), 409, `{"error":"branch_frozen"}`)
	f.refused(t, f.request(2, "POST", "/api/closings/cash-movements",
		`{"kind":"gasto","amount":"999999.00","description":"Flete de la semana","category_id":1}`), 409,
		`{"error":"branch_frozen"}`)
	// The warehouse writes no till of a branch (LC011 class), unchanged on both writers.
	f.refused(t, f.request(1, "POST", "/api/closings/expenses",
		`{"amount":"1.00","description":"Flete","category_id":1}`), 403, `{"error":"forbidden"}`)
	f.refused(t, f.request(1, "POST", "/api/closings/cash-movements",
		`{"kind":"gasto","amount":"1.00","description":"Flete","category_id":1}`), 403, `{"error":"forbidden"}`)
}

// TestDrawerNegativeFromPreRuleRows proves the answer on a till the rule did not govern: a branch
// that inherits nothing reads its whole history, so a row recorded before the rule answers a
// negative balance, the refusal carries it, and money coming in still moves the till (S1, S3).
func TestDrawerNegativeFromPreRuleRows(t *testing.T) {
	f := closingFixture(t)
	for _, stmt := range []string{
		"ALTER TABLE branch_cash_movements DISABLE TRIGGER admit_branch_cash_movement",
		`INSERT INTO branch_cash_movements(branch_location_id,kind,amount,description,category_id,
 created_by_account_id,occurred_at) VALUES(2,'gasto',50.00,'Gasto anterior a la regla',1,2,'2020-01-01T10:00:00Z')`,
		"ALTER TABLE branch_cash_movements ENABLE TRIGGER admit_branch_cash_movement",
	} {
		if _, err := f.p.Exec(f.ctx, stmt); err != nil {
			t.Fatalf("%q: %v", stmt, err)
		}
	}
	// No closed settlement: the branch reads its whole history, the 2020 row included.
	var expected string
	if err := f.p.QueryRow(f.ctx, "SELECT branch_drawer_expected(2::smallint)::text").Scan(&expected); err != nil || expected != "-50.00" {
		t.Fatalf("the drawer's whole history must be counted: %q %v", expected, err)
	}
	f.refused(t, f.request(2, "POST", "/api/closings/expenses",
		`{"amount":"10.00","description":"Detergente y escobas","category_id":1}`), 409,
		`{"balance":"-50.00","error":"drawer_insufficient","requested":"10.00"}`)
	f.refused(t, f.request(2, "POST", "/api/closings/cash-movements",
		`{"kind":"recaudacion","amount":"10.00","description":"Retiro de la caja"}`), 409,
		`{"balance":"-50.00","error":"drawer_insufficient","requested":"10.00"}`)
	// S3 on the same negative till.
	if w := f.serve(t, f.request(2, "POST", "/api/closings/cash-movements",
		`{"kind":"aporte","amount":"10.00","description":"Reposición de la caja"}`)); w.Code != 201 {
		t.Fatalf("money in on a negative till must be admitted: %d %s", w.Code, w.Body.String())
	}
	if err := f.p.QueryRow(f.ctx, "SELECT branch_drawer_expected(2::smallint)::text").Scan(&expected); err != nil || expected != "-40.00" {
		t.Fatalf("the aporte must move the drawer to -40.00: %q %v", expected, err)
	}
	// A correction of the same pre-rule gasto is money in, so it is admitted as well.
	var preRule int64
	if err := f.p.QueryRow(f.ctx, `SELECT id FROM branch_cash_movements
 WHERE branch_location_id=2 AND kind='gasto' ORDER BY id LIMIT 1`).Scan(&preRule); err != nil {
		t.Fatalf("the pre-rule id could not be read: %v", err)
	}
	if w := f.serve(t, f.request(2, "POST", "/api/closings/cash-corrections",
		fmt.Sprintf(`{"corrects_id":%d,"amount":"5.00","description":"Corrijo el gasto anterior"}`, preRule))); w.Code != 201 {
		t.Fatalf("a correction that adds money must be admitted on a negative till: %d %s", w.Code, w.Body.String())
	}
}
