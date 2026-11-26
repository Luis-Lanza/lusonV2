package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
)

// The used battery has a stock per location and per model, and the Warehouse is who mostly holds it
// (S24, S29), so the warehouse reads it over the wire (S26 is about identity and not about a screen).
// The read is one route of the case collection: the numbers are the derived ones and this contract
// recomposes none of them.

// warrantyUsedStockWire is the stock as this contract publishes it: one row per location and model,
// with the terms of the formula and their signed sum.
type warrantyUsedStockWire struct {
	Stock []struct {
		LocationID     int64  `json:"location_id"`
		Model          string `json:"model"`
		Purchased      string `json:"purchased"`
		FactoryReturns string `json:"factory_returns"`
		LoansReturned  string `json:"loans_returned"`
		Delivered      string `json:"delivered"`
		LoansGiven     string `json:"loans_given"`
		Available      string `json:"available"`
	} `json:"stock"`
}

// TestUsedStockOverPostgreSQL proves the read on the admitted fixture: a branch that bought four used
// batteries of a model sees them as its stock, the warehouse sees the same row after the branch
// settles, and the route is one read with no body and no query.
func TestUsedStockOverPostgreSQL(t *testing.T) {
	f := warrantyFixture(t)
	// The branch bought four used batteries of one model, through the purchase documents this
	// installation admits: the fund first, then the document and its line.
	if _, err := f.p.Exec(f.ctx, `INSERT INTO branch_fund_movements(branch_location_id,kind,amount,
 description,created_by_account_id) VALUES(2,'aporte',1000.00,'Fondo de compras del fixture',2)`); err != nil {
		t.Fatalf("the fund of the branch could not be stated: %v", err)
	}
	// The document and its line are one transaction: a purchase is judged whole at commit.
	buy, err := f.p.Begin(f.ctx)
	if err != nil {
		t.Fatal("the purchase transaction could not start")
	}
	defer func() { _ = buy.Rollback(context.Background()) }()
	var purchase int64
	if err := buy.QueryRow(f.ctx, `INSERT INTO purchases(operation_key,location_id,total,paid_cash,
 paid_transfer,created_by_account_id) VALUES('used-stock-http-00001',2,40.00,40.00,0.00,2)
 RETURNING id`).Scan(&purchase); err != nil {
		t.Fatalf("the purchase must be admitted: %v", err)
	}
	if _, err := buy.Exec(f.ctx, `INSERT INTO purchase_used_lines(purchase_id,model,quantity,
 unit_price) VALUES($1,'NS60ZL',4,10.00)`, purchase); err != nil {
		t.Fatalf("the used line must be admitted: %v", err)
	}
	if err := buy.Commit(f.ctx); err != nil {
		t.Fatalf("the purchase must commit: %v", err)
	}
	stock := func(actor int) warrantyUsedStockWire {
		t.Helper()
		w := f.serve(t, f.request(actor, "GET", "/api/warranty-cases/used-stock", ""))
		if w.Code != 200 {
			t.Fatalf("the used stock must answer 200: %d %s", w.Code, w.Body.String())
		}
		var record warrantyUsedStockWire
		if err := json.Unmarshal(w.Body.Bytes(), &record); err != nil {
			t.Fatalf("the used stock is not decodable: %s", w.Body.String())
		}
		return record
	}
	// The branch reads its own row: bought four, nothing returned, nothing delivered, four held.
	row := stock(2)
	if len(row.Stock) != 1 {
		t.Fatalf("one model of one branch is one row: %+v", row)
	}
	got := row.Stock[0]
	if got.LocationID != 2 || got.Model != "NS60ZL" || got.Purchased != "4" ||
		got.FactoryReturns != "0" || got.LoansReturned != "0" || got.Delivered != "0" ||
		got.LoansGiven != "0" || got.Available != "4" {
		t.Fatalf("the row states the terms and their sum: %+v", got)
	}
	// The warehouse reads the same table: it holds nothing yet, and the row is still the branch's.
	for _, held := range stock(1).Stock {
		if held.LocationID == 1 {
			t.Fatalf("the warehouse bought nothing and got nothing back: %+v", held)
		}
	}
	// A loan takes one unit out of its origin, and the refusal of the second one is the code of
	// S25 on the wire.
	if w := f.serve(t, f.request(2, "POST", "/api/sales", saleBody(f.variant, 1, "96000.00", 12))); w.Code != 201 {
		t.Fatalf("the sale of the fixture must be admitted: %d %s", w.Code, w.Body.String())
	}
	claim := f.caseWire(t, f.serve(t, f.request(2, "POST", "/api/warranty-cases/claims",
		`{"serial_number":"`+f.lastSerial(t)+`","declared_failure":"No arranca el motor"}`)), 201)
	loan := func(body string) int {
		t.Helper()
		return f.serve(t, f.request(2, "POST",
			fmt.Sprintf("/api/warranty-cases/%d/loans", claim.ID), body)).Code
	}
	if code := loan(`{"model":" ns60zl ","quantity":1,"serial_number":"","source_location_id":2}`); code != 201 {
		t.Fatalf("the loan of a unit the branch holds must be admitted, got %d", code)
	}
	if got := stock(2).Stock[0]; got.LoansGiven != "1" || got.Available != "3" || got.Model != "NS60ZL" {
		t.Fatalf("the loan of one unit leaves three, under the same model: %+v", got)
	}
	f.refused(t, f.request(2, "POST", fmt.Sprintf("/api/warranty-cases/%d/loans", claim.ID),
		`{"model":"NS60ZL","quantity":4,"serial_number":"","source_location_id":2}`),
		409, "loan_source_stock")
	// The route is one read: a query and another method are refused before the store.
	f.refused(t, f.request(2, "GET", "/api/warranty-cases/used-stock?location=1", ""), 400, "invalid_request")
	f.refused(t, f.request(2, "POST", "/api/warranty-cases/used-stock", "{}"), 405, "method_not_allowed")
	f.refused(t, f.request(0, "GET", "/api/warranty-cases/used-stock", ""), 401, "unauthenticated")
}
