package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/bootstrap"
	"luson/api/internal/config"
	"luson/api/internal/purchases"
	"luson/api/internal/testpg"
)

const validPurchaseJSON = `{"operation_key":"http-purchase-key-01","note":"","used_lines":[{"model":"ns60zl","quantity":1,"unit_price":"25000.00"}],"scrap_lines":[{"material_id":1,"kg":"12.4","price_per_kg":"8000.00"}],"paid_cash":"124200.00","paid_transfer":"0.00"}`

func TestPurchaseDecoder(t *testing.T) {
	replace := func(old, value string) string { return strings.Replace(validPurchaseJSON, old, value, 1) }
	t.Run("valid", func(t *testing.T) {
		for _, body := range []string{
			validPurchaseJSON,
			" \n" + validPurchaseJSON + " \n",
			// The note is optional and so is either line array, but never both.
			`{"operation_key":"http-purchase-key-02","used_lines":[{"model":"NS60ZL","quantity":1000000,"unit_price":"9999999999.99"}],"paid_cash":"0.00","paid_transfer":"0.00"}`,
			`{"operation_key":"http-purchase-key-03","scrap_lines":[{"material_id":4,"kg":"0.001","price_per_kg":"0.01"}],"paid_cash":"0.00","paid_transfer":"0.00"}`,
			replace(`"124200.00"`, `"124199.00"`),
			replace(`"http-purchase-key-01"`, strconv.Quote(strings.Repeat("a", 128))),
			replace(`"12.4"`, `"12.400"`),
		} {
			r := httptest.NewRequest("POST", "/api/purchases", strings.NewReader(body))
			r.Header.Set("Content-Type", "application/json; charset=UTF-8")
			got, err := decodePurchase(r)
			if err != nil || got.OperationKey == "" || string(got.PaidCash) == "" {
				t.Fatalf("valid framing rejected: %v", err)
			}
		}
	})
	invalid := map[string]string{
		"empty_object":        `{}`,
		"array_root":          `[]`,
		"null_root":           `null`,
		"missing_key":         `{"used_lines":[{"model":"NS60ZL","quantity":1,"unit_price":"1.00"}],"paid_cash":"1.00","paid_transfer":"0.00"}`,
		"missing_cash":        replace(`"paid_cash":"124200.00",`, ``),
		"missing_transfer":    replace(`,"paid_transfer":"0.00"`, ``),
		"unknown_key":         replace(`"note":""`, `"note":"","otra":1`),
		"duplicate_key":       replace(`"note":""`, `"note":"","note":""`),
		"key_number":          replace(`"http-purchase-key-01"`, `7`),
		"note_number":         replace(`"note":""`, `"note":7`),
		"cash_number":         replace(`"124200.00"`, `124200`),
		"transfer_negative":   replace(`"0.00"`, `"-1.00"`),
		"cash_not_canonical":  replace(`"124200.00"`, `"124200"`),
		"used_not_array":      replace(`[{`, `{`),
		"used_unknown_key":    replace(`"model":"ns60zl"`, `"model":"ns60zl","brand":"Yuasa"`),
		"used_duplicate_key":  replace(`"model":"ns60zl"`, `"model":"ns60zl","model":"NS60ZL"`),
		"used_missing_price":  replace(`,"unit_price":"25000.00"`, ``),
		"used_price_number":   replace(`"unit_price":"25000.00"`, `"unit_price":25000`),
		"used_quantity_float": replace(`"quantity":1`, `"quantity":1.5`),
		"used_quantity_text":  replace(`"quantity":1`, `"quantity":"1"`),
		"used_model_bad":      replace(`"model":"ns60zl"`, `"model":"-NS60"`),
		"scrap_missing_kg":    replace(`,"kg":"12.4"`, ``),
		"scrap_kg_number":     replace(`"kg":"12.4"`, `"kg":12.4`),
		"scrap_kg_four_dec":   replace(`"kg":"12.4"`, `"kg":"12.4005"`),
		"scrap_material_text": replace(`"material_id":1`, `"material_id":"1"`),
		"trailing_input":      validPurchaseJSON + `{}`,
		"trailing_token":      validPurchaseJSON + `0`,
		"not_json":            `operation_key=1`,
	}
	for name, body := range invalid {
		r := httptest.NewRequest("POST", "/api/purchases", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		if _, err := decodePurchase(r); !errors.Is(err, purchases.ErrInvalid) {
			t.Errorf("%s must be refused, got %v", name, err)
		}
	}
	// The framing of the body is part of the contract: only one JSON content type with an
	// optional utf-8 charset is admitted.
	for name, contentType := range map[string]string{
		"missing":    "",
		"text":       "text/plain",
		"vendor":     "application/vnd.api+json",
		"charset":    "application/json; charset=latin1",
		"parameter":  "application/json; profile=1",
		"duplicated": "application/json; charset=utf-8; charset=utf-8",
	} {
		r := httptest.NewRequest("POST", "/api/purchases", strings.NewReader(validPurchaseJSON))
		if contentType != "" {
			r.Header.Set("Content-Type", contentType)
		}
		if _, err := decodePurchase(r); !errors.Is(err, purchases.ErrInvalid) {
			t.Errorf("a %s content type must be refused, got %v", name, err)
		}
	}
	// More than one hundred ninety lines of either kind never reach the store.
	many := func(n int, kind string) string {
		line := `{"model":"M%03d","quantity":1,"unit_price":"1.00"}`
		if kind == "scrap" {
			line = `{"material_id":%d,"kg":"1.000","price_per_kg":"1.00"}`
		}
		lines := make([]string, 0, n)
		for i := 0; i < n; i++ {
			if kind == "scrap" {
				lines = append(lines, fmt.Sprintf(line, i+1))
			} else {
				lines = append(lines, fmt.Sprintf(line, i))
			}
		}
		return `{"operation_key":"http-purchase-many-1","` + kind + `_lines":[` +
			strings.Join(lines, ",") + `],"paid_cash":"1.00","paid_transfer":"0.00"}`
	}
	for _, body := range []string{many(191, "used"), many(191, "scrap")} {
		r := httptest.NewRequest("POST", "/api/purchases", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		if _, err := decodePurchase(r); !errors.Is(err, purchases.ErrInvalid) {
			t.Fatalf("more than one hundred ninety lines must be refused, got %v", err)
		}
	}
	if _, err := decodePurchase(nil); !errors.Is(err, purchases.ErrInvalid) {
		t.Fatal("a nil request must be refused")
	}
}

func TestPurchaseReversalDecoder(t *testing.T) {
	for _, body := range []string{
		`{"operation_key":"http-purchase-reverse-1","reason":"pesaje mal tipeado"}`,
		`{"reason":"  pesaje mal tipeado  ","operation_key":"http-purchase-reverse-1"}`,
	} {
		r := httptest.NewRequest("POST", "/api/purchases/7/reverse", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		key, reason, err := decodePurchaseReversal(r)
		if err != nil || key != "http-purchase-reverse-1" || reason != "pesaje mal tipeado" {
			t.Fatalf("valid reversal framing rejected: %q %q %v", key, reason, err)
		}
	}
	for name, body := range map[string]string{
		"empty":       `{}`,
		"no_reason":   `{"operation_key":"http-purchase-reverse-1"}`,
		"blank":       `{"operation_key":"http-purchase-reverse-1","reason":"   "}`,
		"long_reason": `{"operation_key":"http-purchase-reverse-1","reason":"` + strings.Repeat("ñ", 501) + `"}`,
		"lines":       `{"operation_key":"http-purchase-reverse-1","reason":"m","used_lines":[]}`,
		"bad_key":     `{"operation_key":"short","reason":"m"}`,
		"duplicate":   `{"operation_key":"http-purchase-reverse-1","reason":"m","reason":"m"}`,
		"trailing":    `{"operation_key":"http-purchase-reverse-1","reason":"m"}1`,
		"array_root":  `[]`,
	} {
		r := httptest.NewRequest("POST", "/api/purchases/7/reverse", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		if _, _, err := decodePurchaseReversal(r); !errors.Is(err, purchases.ErrInvalid) {
			t.Errorf("%s must be refused, got %v", name, err)
		}
	}
}

func TestPurchasePageQuery(t *testing.T) {
	for raw, want := range map[string][2]int{
		"":                          {1, 25},
		"page=3":                    {3, 25},
		"page_size=10":              {1, 10},
		"page_size=50":              {1, 50},
		"page=7&page_size=25":       {7, 25},
		"page_size=25&page=1000000": {1000000, 25},
	} {
		page, size, err := purchasePageQuery(raw)
		if err != nil || page != want[0] || size != want[1] {
			t.Fatalf("%q reads as %d/%d (want %d/%d): %v", raw, page, size, want[0], want[1], err)
		}
	}
	for name, raw := range map[string]string{
		"page_zero":     "page=0",
		"page_overflow": "page=1000001",
		"page_padded":   "page=01",
		"page_text":     "page=uno",
		"size_one":      "page_size=1",
		"size_hundred":  "page_size=100",
		"unknown":       "search=NS60",
		"empty_value":   "page=",
		"no_equals":     "page",
		"duplicate":     "page=1&page=1",
		"separator":     "&",
	} {
		if _, _, err := purchasePageQuery(raw); !errors.Is(err, purchases.ErrInvalid) {
			t.Errorf("a %s query must be refused, got %v", name, err)
		}
	}
}

func TestPurchaseFailureMapping(t *testing.T) {
	for err, want := range map[error]struct {
		status int
		code   string
	}{
		purchases.ErrInvalid:         {400, "invalid_request"},
		purchases.ErrForbidden:       {403, "forbidden"},
		purchases.ErrNotFound:        {404, "not_found"},
		purchases.ErrRetryConflict:   {409, "retry_conflict"},
		purchases.ErrAlreadyReversed: {409, "already_reversed"},
		purchases.ErrUnavailable:     {503, "service_unavailable"},
		errors.New("unexpected"):     {503, "service_unavailable"},
	} {
		w := httptest.NewRecorder()
		purchaseFailure(w, err)
		expectTransferError(t, w, want.status, want.code)
	}
}

var purchaseMoneyWire = regexp.MustCompile(`^-?[0-9]+\.[0-9]{2}$`)
var purchaseWeightWire = regexp.MustCompile(`^-?[0-9]+\.[0-9]{3}$`)

// purchaseDocumentWire admits only the frozen document shape: exactly the thirteen published
// keys, the lines in their own shape and canonical amounts and weights.
func purchaseDocumentWire(t *testing.T, w *httptest.ResponseRecorder, status int) purchases.Document {
	t.Helper()
	var body map[string]json.RawMessage
	if w.Code != status || json.Unmarshal(w.Body.Bytes(), &body) != nil {
		t.Fatalf("the document answer is not JSON: %d %s", w.Code, w.Body.String())
	}
	want := []string{"id", "location_id", "note", "total", "paid_cash", "paid_transfer",
		"created_by_account_id", "created_at", "reverses_purchase_id", "reversed_by", "reason",
		"used_lines", "scrap_lines"}
	if len(body) != len(want) {
		t.Fatalf("the document answer has %d keys, want %d: %s", len(body), len(want), w.Body.String())
	}
	for _, key := range want {
		if _, ok := body[key]; !ok {
			t.Fatalf("the document answer is missing %q: %s", key, w.Body.String())
		}
	}
	for _, key := range []string{"total", "paid_cash", "paid_transfer"} {
		var text string
		if json.Unmarshal(body[key], &text) != nil || !purchaseMoneyWire.MatchString(text) {
			t.Fatalf("%s is not canonical money: %s", key, body[key])
		}
	}
	var document purchases.Document
	if json.Unmarshal(body["id"], &document.ID) != nil || document.ID < 1 ||
		json.Unmarshal(body["location_id"], &document.LocationID) != nil ||
		json.Unmarshal(body["note"], &document.Note) != nil ||
		json.Unmarshal(body["total"], &document.Total) != nil ||
		json.Unmarshal(body["paid_cash"], &document.PaidCash) != nil ||
		json.Unmarshal(body["paid_transfer"], &document.PaidTransfer) != nil ||
		json.Unmarshal(body["created_by_account_id"], &document.CreatedByAccountID) != nil ||
		json.Unmarshal(body["reverses_purchase_id"], &document.ReversesPurchaseID) != nil ||
		json.Unmarshal(body["reversed_by"], &document.ReversedBy) != nil ||
		json.Unmarshal(body["reason"], &document.Reason) != nil {
		t.Fatalf("the document answer does not decode: %s", w.Body.String())
	}
	var createdAt string
	if json.Unmarshal(body["created_at"], &createdAt) != nil {
		t.Fatalf("created_at is not text: %s", w.Body.String())
	}
	if moment, err := time.Parse(time.RFC3339, createdAt); err != nil || moment.IsZero() {
		t.Fatalf("created_at is not an RFC3339 instant: %q", createdAt)
	}
	var used []map[string]json.RawMessage
	if json.Unmarshal(body["used_lines"], &used) != nil {
		t.Fatalf("used_lines is not an array: %s", body["used_lines"])
	}
	for _, line := range used {
		var decoded purchases.UsedLine
		if len(line) != 4 || json.Unmarshal(line["model"], &decoded.Model) != nil ||
			json.Unmarshal(line["quantity"], &decoded.Quantity) != nil ||
			json.Unmarshal(line["unit_price"], &decoded.UnitPrice) != nil ||
			json.Unmarshal(line["amount"], &decoded.Amount) != nil ||
			!purchaseMoneyWire.MatchString(string(decoded.UnitPrice)) ||
			!purchaseMoneyWire.MatchString(string(decoded.Amount)) ||
			decoded.Quantity == 0 || decoded.Quantity > purchases.MaxQuantity ||
			decoded.Quantity < -purchases.MaxQuantity {
			t.Fatalf("a used line is not the frozen shape: %v", line)
		}
		document.UsedLines = append(document.UsedLines, decoded)
	}
	var scrap []map[string]json.RawMessage
	if json.Unmarshal(body["scrap_lines"], &scrap) != nil {
		t.Fatalf("scrap_lines is not an array: %s", body["scrap_lines"])
	}
	for _, line := range scrap {
		var decoded purchases.ScrapLine
		if len(line) != 5 || json.Unmarshal(line["material_id"], &decoded.MaterialID) != nil ||
			json.Unmarshal(line["name"], &decoded.Name) != nil ||
			json.Unmarshal(line["kg"], &decoded.Kg) != nil ||
			json.Unmarshal(line["price_per_kg"], &decoded.PricePerKg) != nil ||
			json.Unmarshal(line["amount"], &decoded.Amount) != nil ||
			!purchaseWeightWire.MatchString(string(decoded.Kg)) ||
			!purchaseMoneyWire.MatchString(string(decoded.PricePerKg)) ||
			!purchaseMoneyWire.MatchString(string(decoded.Amount)) || decoded.Name == "" {
			t.Fatalf("a scrap line is not the frozen shape: %v", line)
		}
		document.ScrapLines = append(document.ScrapLines, decoded)
	}
	return document
}

func TestPurchaseDocumentRecord(t *testing.T) {
	base := purchases.Document{ID: 7, LocationID: 2, Note: "", Total: "124200.00",
		PaidCash: "124200.00", PaidTransfer: "0.00", CreatedByAccountID: 3,
		CreatedAt: time.Date(2026, 11, 11, 18, 20, 0, 0, time.UTC), Reason: "",
		UsedLines: []purchases.UsedLine{{Model: "NS60ZL", Quantity: 1, UnitPrice: "25000.00", Amount: "25000.00"}},
		ScrapLines: []purchases.ScrapLine{{MaterialID: 1, Name: "Cobre", Kg: "12.400",
			PricePerKg: "8000.00", Amount: "99200.00"}}}
	if record, err := purchaseDocumentRecord(base); err != nil || record.ID != 7 || len(record.UsedLines) != 1 {
		t.Fatalf("a complete document must be published: %+v %v", record, err)
	}
	// A counter-document is published with its negative amounts and its stated reason.
	counter := base
	target := int64(7)
	counter.ID, counter.ReversesPurchaseID = 9, &target
	counter.Total, counter.PaidCash = "-124200.00", "-124200.00"
	counter.Reason = "pesaje mal tipeado"
	counter.UsedLines = []purchases.UsedLine{{Model: "NS60ZL", Quantity: -1, UnitPrice: "25000.00", Amount: "-25000.00"}}
	counter.ScrapLines = []purchases.ScrapLine{{MaterialID: 1, Name: "Cobre", Kg: "-12.400",
		PricePerKg: "8000.00", Amount: "-99200.00"}}
	if record, err := purchaseDocumentRecord(counter); err != nil || record.ReversesPurchaseID == nil ||
		record.Total != "-124200.00" {
		t.Fatalf("a counter-document must be published: %+v %v", record, err)
	}
	broken := map[string]func(*purchases.Document){
		"no_id":               func(d *purchases.Document) { d.ID = 0 },
		"warehouse":           func(d *purchases.Document) { d.LocationID = 1 },
		"no_account":          func(d *purchases.Document) { d.CreatedByAccountID = 0 },
		"no_moment":           func(d *purchases.Document) { d.CreatedAt = time.Time{} },
		"long_note":           func(d *purchases.Document) { d.Note = strings.Repeat("ñ", 501) },
		"no_lines":            func(d *purchases.Document) { d.UsedLines, d.ScrapLines = nil, nil },
		"total_not_canonical": func(d *purchases.Document) { d.Total = "124200" },
		"total_zero":          func(d *purchases.Document) { d.Total = "0.00" },
		"settlement_open":     func(d *purchases.Document) { d.PaidCash = "100000.00" },
		"amount_lied":         func(d *purchases.Document) { d.UsedLines[0].Amount = "24000.00" },
		"quantity_out":        func(d *purchases.Document) { d.UsedLines[0].Quantity = 0 },
		"model_not_canonical": func(d *purchases.Document) { d.UsedLines[0].Model = "ns60zl" },
		"model_order": func(d *purchases.Document) {
			d.UsedLines = append(d.UsedLines, purchases.UsedLine{Model: "55B24L", Quantity: 1,
				UnitPrice: "1.00", Amount: "1.00"})
			d.Total, d.PaidCash = "124201.00", "124201.00"
		},
		"price_zero":         func(d *purchases.Document) { d.UsedLines[0].UnitPrice = "0.00" },
		"scrap_kg_out":       func(d *purchases.Document) { d.ScrapLines[0].Kg = "12.4" },
		"scrap_kg_zero":      func(d *purchases.Document) { d.ScrapLines[0].Kg = "0.000" },
		"scrap_amount_lied":  func(d *purchases.Document) { d.ScrapLines[0].Amount = "99200.01" },
		"scrap_no_name":      func(d *purchases.Document) { d.ScrapLines[0].Name = "" },
		"scrap_material_out": func(d *purchases.Document) { d.ScrapLines[0].MaterialID = 0 },
		"counter_without_reason": func(d *purchases.Document) {
			*d = counter
			d.Reason = ""
		},
		"counter_positive": func(d *purchases.Document) {
			*d = counter
			d.Total, d.PaidCash = "124200.00", "124200.00"
		},
		"original_with_reason": func(d *purchases.Document) { d.Reason = "motivo" },
		"counter_reverses_later": func(d *purchases.Document) {
			*d = counter
			later := int64(12)
			d.ReversesPurchaseID = &later
		},
		"reversed_by_earlier": func(d *purchases.Document) {
			earlier := int64(3)
			d.ReversedBy = &earlier
		},
		"counter_reversed_itself": func(d *purchases.Document) {
			*d = counter
			later := int64(12)
			d.ReversedBy = &later
		},
	}
	for name, transform := range broken {
		document := base
		document.UsedLines = append([]purchases.UsedLine(nil), base.UsedLines...)
		document.ScrapLines = append([]purchases.ScrapLine(nil), base.ScrapLines...)
		transform(&document)
		if _, err := purchaseDocumentRecord(document); !errors.Is(err, purchases.ErrUnavailable) {
			t.Errorf("a %s document must fail closed, got %v", name, err)
		}
	}
}

func TestPurchasePageRecord(t *testing.T) {
	target := int64(4)
	page := purchases.Page{Page: 1, PageSize: 25, TotalPurchases: 2, Purchases: []purchases.Summary{
		{ID: 7, CreatedAt: time.Date(2026, 11, 11, 18, 20, 0, 0, time.UTC), Total: "-124200.00",
			ReversesPurchaseID: &target, UsedUnits: -1, ScrapLines: 1},
		{ID: 6, CreatedAt: time.Date(2026, 11, 10, 14, 2, 0, 0, time.UTC), Total: "27000.00",
			UsedUnits: 3, ScrapLines: 0},
	}}
	if record, err := purchasePageRecord(page); err != nil || len(record.Purchases) != 2 ||
		record.Purchases[0].ReversesPurchaseID == nil || record.TotalPurchases != 2 {
		t.Fatalf("a complete page must be published: %+v %v", record, err)
	}
	broken := map[string]func(*purchases.Page){
		"page_zero":      func(p *purchases.Page) { p.Page = 0 },
		"size":           func(p *purchases.Page) { p.PageSize = 20 },
		"negative_total": func(p *purchases.Page) { p.TotalPurchases = -1 },
		"too_many_rows":  func(p *purchases.Page) { p.Purchases = append(p.Purchases, p.Purchases[0]) },
		"beyond_total": func(p *purchases.Page) {
			p.Page, p.TotalPurchases = 3, 2
		},
		"not_newest_first": func(p *purchases.Page) {
			p.Purchases[0], p.Purchases[1] = p.Purchases[1], p.Purchases[0]
		},
		"total_not_canonical": func(p *purchases.Page) { p.Purchases[1].Total = "27000" },
		"no_moment":           func(p *purchases.Page) { p.Purchases[1].CreatedAt = time.Time{} },
		"units_out":           func(p *purchases.Page) { p.Purchases[1].UsedUnits = 190*1000000 + 1 },
		"scrap_out":           func(p *purchases.Page) { p.Purchases[1].ScrapLines = 191 },
		"sign_lied":           func(p *purchases.Page) { p.Purchases[0].Total = "124200.00" },
		"reversed_by_earlier": func(p *purchases.Page) {
			earlier := int64(2)
			p.Purchases[1].ReversedBy = &earlier
		},
		"counter_reversed": func(p *purchases.Page) {
			later := int64(12)
			p.Purchases[0].ReversedBy = &later
		},
	}
	for name, transform := range broken {
		brokenPage := page
		brokenPage.Purchases = append([]purchases.Summary(nil), page.Purchases...)
		transform(&brokenPage)
		if _, err := purchasePageRecord(brokenPage); !errors.Is(err, purchases.ErrUnavailable) {
			t.Errorf("a %s page must fail closed, got %v", name, err)
		}
	}
}

func TestPurchaseCatalogueRecords(t *testing.T) {
	if record, err := purchaseModelsRecord([]string{"12N5-3B", "NS60ZL"}); err != nil ||
		len(record.Models) != 2 || record.Models[1] != "NS60ZL" {
		t.Fatalf("a model list must be published: %+v %v", record, err)
	}
	// An empty list is published as an empty array, never as null.
	if record, err := purchaseModelsRecord(nil); err != nil || record.Models == nil || len(record.Models) != 0 {
		t.Fatalf("an empty model list must be an empty array: %+v %v", record, err)
	}
	for name, models := range map[string][]string{
		"empty_code": {"NS60ZL", ""},
		"order":      {"NS60ZL", "55B24L"},
		"duplicate":  {"NS60ZL", "NS60ZL"},
		"nul":        {"NS60\000ZL"},
	} {
		if _, err := purchaseModelsRecord(models); !errors.Is(err, purchases.ErrUnavailable) {
			t.Errorf("a %s model list must fail closed, got %v", name, err)
		}
	}
	if record, err := purchaseMaterialsRecord([]purchases.Material{{ID: 1, Name: "Cobre"}}); err != nil ||
		len(record.Materials) != 1 || record.Materials[0].Name != "Cobre" {
		t.Fatalf("a material list must be published: %+v %v", record, err)
	}
	for name, materials := range map[string][]purchases.Material{
		"no_id":   {{ID: 0, Name: "Cobre"}},
		"no_name": {{ID: 1, Name: "  "}},
		"order":   {{ID: 2, Name: "Aluminio"}, {ID: 1, Name: "Cobre"}},
	} {
		if _, err := purchaseMaterialsRecord(materials); !errors.Is(err, purchases.ErrUnavailable) {
			t.Errorf("a %s material list must fail closed, got %v", name, err)
		}
	}
	moment := time.Date(2026, 11, 10, 14, 2, 0, 0, time.UTC)
	prices := purchases.LastPrices{
		Models:    []purchases.ModelPrice{{Model: "NS60ZL", UnitPrice: "25000.00", PurchasedAt: moment}},
		Materials: []purchases.MaterialPrice{{MaterialID: 1, PricePerKg: "8000.00", PurchasedAt: moment}},
	}
	if record, err := purchaseLastPricesRecord(prices); err != nil || len(record.Models) != 1 ||
		record.Models[0].UnitPrice != "25000.00" || len(record.Materials) != 1 {
		t.Fatalf("the last prices must be published: %+v %v", record, err)
	}
	for name, brokenPrices := range map[string]purchases.LastPrices{
		"price_zero":  {Models: []purchases.ModelPrice{{Model: "NS60ZL", UnitPrice: "0.00", PurchasedAt: moment}}},
		"price_shape": {Models: []purchases.ModelPrice{{Model: "NS60ZL", UnitPrice: "25000", PurchasedAt: moment}}},
		"no_moment":   {Models: []purchases.ModelPrice{{Model: "NS60ZL", UnitPrice: "25000.00"}}},
		"model_shape": {Models: []purchases.ModelPrice{{Model: "ns60zl", UnitPrice: "25000.00", PurchasedAt: moment}}},
		"model_order": {Models: []purchases.ModelPrice{
			{Model: "NS60ZL", UnitPrice: "25000.00", PurchasedAt: moment},
			{Model: "55B24L", UnitPrice: "25000.00", PurchasedAt: moment}}},
		"material_out": {Materials: []purchases.MaterialPrice{{MaterialID: 0, PricePerKg: "1.00", PurchasedAt: moment}}},
		"material_order": {Materials: []purchases.MaterialPrice{
			{MaterialID: 2, PricePerKg: "1.00", PurchasedAt: moment},
			{MaterialID: 1, PricePerKg: "1.00", PurchasedAt: moment}}},
	} {
		if _, err := purchaseLastPricesRecord(brokenPrices); !errors.Is(err, purchases.ErrUnavailable) {
			t.Errorf("a %s last-price read must fail closed, got %v", name, err)
		}
	}
	received := purchases.Received{
		Used:  []purchases.ReceivedUsed{{Model: "NS60ZL", Quantity: 12, Value: "300000.00"}},
		Scrap: []purchases.ReceivedScrap{{MaterialID: 1, Name: "Cobre", Kg: "120.500", Value: "964000.00"}},
	}
	if record, err := purchaseReceivedRecord(received); err != nil || len(record.Used) != 1 ||
		record.Scrap[0].Kg != "120.500" {
		t.Fatalf("the received totals must be published: %+v %v", record, err)
	}
	if record, err := purchaseReceivedRecord(purchases.Received{}); err != nil || record.Used == nil || record.Scrap == nil {
		t.Fatalf("empty received totals must be empty arrays: %+v %v", record, err)
	}
	for name, brokenReceived := range map[string]purchases.Received{
		"used_zero":     {Used: []purchases.ReceivedUsed{{Model: "NS60ZL", Quantity: 0, Value: "1.00"}}},
		"used_value":    {Used: []purchases.ReceivedUsed{{Model: "NS60ZL", Quantity: 1, Value: "-1.00"}}},
		"used_model":    {Used: []purchases.ReceivedUsed{{Model: "", Quantity: 1, Value: "1.00"}}},
		"scrap_kg":      {Scrap: []purchases.ReceivedScrap{{MaterialID: 1, Name: "Cobre", Kg: "120.5", Value: "1.00"}}},
		"scrap_value":   {Scrap: []purchases.ReceivedScrap{{MaterialID: 1, Name: "Cobre", Kg: "1.000", Value: "-1.00"}}},
		"scrap_missing": {Scrap: []purchases.ReceivedScrap{{MaterialID: 0, Name: "Cobre"}}},
	} {
		if _, err := purchaseReceivedRecord(brokenReceived); !errors.Is(err, purchases.ErrUnavailable) {
			t.Errorf("a %s received read must fail closed, got %v", name, err)
		}
	}
}

func TestPurchasePathSafety(t *testing.T) {
	cfg := transferConfig(t)
	handler, err := NewWithPurchases(&saleRecorder{}, &auth.Service{}, cfg, purchases.New(&pgxpool.Pool{}))
	if err != nil || handler == nil {
		t.Fatalf("the purchase constructor is unavailable: %v", err)
	}
	for _, target := range []string{
		"/api/purchases/", "/api/purchases//", "/api/purchases/./1", "/api/purchases/../1",
		"/api/purchases/%31", "/api/purchases/1/2", "/api/purchases/1/%2e",
		"/api/purchases/models/1", "/api/purchases/1/reverse/2", "/api/purchases//models",
	} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest("GET", target, nil))
		if w.Code != 404 {
			t.Fatalf("%s must be not found, got %d", target, w.Code)
		}
	}
}

func TestPurchaseConstructor(t *testing.T) {
	cfg := transferConfig(t)
	store := purchases.New(&pgxpool.Pool{})
	base := &saleRecorder{}
	if h, err := NewWithPurchases(nil, &auth.Service{}, cfg, store); err == nil || h != nil {
		t.Fatal("a nil base handler was accepted")
	}
	if h, err := NewWithPurchases(base, nil, cfg, store); err == nil || h != nil {
		t.Fatal("a nil service was accepted")
	}
	if h, err := NewWithPurchases(base, &auth.Service{}, cfg, nil); err == nil || h != nil {
		t.Fatal("a nil purchase store was accepted")
	}
	if h, err := NewWithPurchases(base, &auth.Service{}, config.Auth{}, store); err == nil || h != nil {
		t.Fatal("an invalid auth configuration was accepted")
	}
	h, err := NewWithPurchases(base, &auth.Service{}, cfg, store)
	if err != nil || h == nil {
		t.Fatal("the purchase constructor is unavailable")
	}
	// Every route requires a session, and an unsupported method is refused before any
	// identity work.
	for _, tc := range []struct {
		method, target, allow string
		status                int
		code                  string
	}{
		{"GET", "/api/purchases", "", 401, "unauthenticated"},
		{"POST", "/api/purchases", "", 401, "unauthenticated"},
		{"PUT", "/api/purchases", "GET, POST", 405, "method_not_allowed"},
		{"GET", "/api/purchases/7", "", 401, "unauthenticated"},
		{"POST", "/api/purchases/7", "GET", 405, "method_not_allowed"},
		{"POST", "/api/purchases/7/reverse", "", 401, "unauthenticated"},
		{"GET", "/api/purchases/7/reverse", "POST", 405, "method_not_allowed"},
		{"GET", "/api/purchases/models", "", 401, "unauthenticated"},
		{"GET", "/api/purchases/materials", "", 401, "unauthenticated"},
		{"GET", "/api/purchases/last-prices", "", 401, "unauthenticated"},
		{"GET", "/api/purchases/received", "", 401, "unauthenticated"},
		{"POST", "/api/purchases/received", "GET", 405, "method_not_allowed"},
	} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(tc.method, tc.target, nil))
		expectTransferError(t, w, tc.status, tc.code)
		if w.Header().Get("Allow") != tc.allow {
			t.Fatalf("%s %s must advertise %q", tc.method, tc.target, tc.allow)
		}
		if w.Header().Get("Cache-Control") != "no-store" ||
			w.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Fatal("the purchase wrapper must keep the response headers")
		}
	}
	// Every other request is forwarded to the composed handler unchanged.
	for _, target := range []string{"/api/sales", "/api/inventory", "/api/auth/session"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", target, nil))
		if w.Code != http.StatusNoContent {
			t.Fatalf("%s must be forwarded to the composed handler", target)
		}
	}
}

type purchaseHTTPFixture struct {
	ctx     context.Context
	p       *pgxpool.Pool
	cfg     config.Auth
	handler http.Handler
	tokens  []string
}

// purchaseFixture needs the isolated test PostgreSQL. Admission fails closed inside
// testpg.Open, exactly like every other database fixture in this repository.
func purchaseFixture(t *testing.T) *purchaseHTTPFixture {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	if bootstrap.Initialize(ctx, p, config.LocalTrial) != nil {
		t.Fatal("purchase HTTP fixture initialization failed")
	}
	credentials := make([]bootstrap.Credentials, 3)
	for i := range credentials {
		credentials[i] = bootstrap.Credentials{Username: "u" + testpg.Random(t)[:20],
			Password: testpg.Random(t)}
	}
	if bootstrap.Provision(ctx, p, credentials) != nil {
		t.Fatal("purchase HTTP test provisioning failed")
	}
	if _, err := p.Exec(ctx, `UPDATE auth_accounts SET must_change_password=false`); err != nil {
		t.Fatal("purchase HTTP operational fixture setup failed")
	}
	svc, err := auth.New(p, nil)
	if err != nil {
		t.Fatal("purchase HTTP auth fixture failed")
	}
	f := &purchaseHTTPFixture{ctx: ctx, p: p, cfg: transferConfig(t), tokens: make([]string, 3)}
	for i, c := range credentials {
		_, token, err := svc.Login(ctx, c.Username, c.Password, fmt.Sprintf("127.0.0.1%d", i), "")
		if err != nil {
			t.Fatal("purchase HTTP login failed")
		}
		f.tokens[i] = token
	}
	f.handler, err = NewWithPurchases(&saleRecorder{}, svc, f.cfg, purchases.New(p))
	if err != nil {
		t.Fatal("purchase HTTP constructor failed")
	}
	return f
}

// request builds one authenticated request of the frozen mutation framing.
func (f *purchaseHTTPFixture) request(actor int, verb, path, body string) *http.Request {
	r := httptest.NewRequest(verb, path, strings.NewReader(body))
	r.RemoteAddr = "127.0.0.1:1234"
	r.Header.Set("Content-Type", "application/json")
	if actor > 0 {
		r.AddCookie(&http.Cookie{Name: sessionCookie, Value: f.tokens[actor-1]})
		r.Header.Set("X-CSRF-Token", auth.CSRF(f.tokens[actor-1]))
	}
	r.Header.Set("Origin", f.cfg.Origin)
	r.Header.Set("Sec-Fetch-Site", "same-origin")
	return r
}

func (f *purchaseHTTPFixture) serve(t *testing.T, r *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	if w.Header().Get("Cache-Control") != "no-store" ||
		w.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("purchase security headers changed")
	}
	return w
}

// snapshot captures every table this domain writes, so a refused request is proven to
// leave nothing behind.
func (f *purchaseHTTPFixture) snapshot(t *testing.T) string {
	t.Helper()
	var data string
	err := f.p.QueryRow(f.ctx, `SELECT jsonb_build_object(
  'purchases',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]'::jsonb) FROM purchases p),
  'used',(SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.purchase_id,l.model),'[]'::jsonb) FROM purchase_used_lines l),
  'scrap',(SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.purchase_id,l.material_id),'[]'::jsonb) FROM purchase_scrap_lines l))::text`).Scan(&data)
	if err != nil {
		t.Fatal("purchase snapshot failed")
	}
	return data
}

func (f *purchaseHTTPFixture) rejected(t *testing.T, r *http.Request, status int, code string) {
	t.Helper()
	before := f.snapshot(t)
	w := f.serve(t, r)
	expectTransferError(t, w, status, code)
	if f.snapshot(t) != before {
		t.Fatal("a rejected purchase request changed stored state")
	}
}

// TestPurchaseHTTPDocument proves create, replay, detail and reversal on the wire, with the
// exact frozen shape and status codes.
func TestPurchaseHTTPDocument(t *testing.T) {
	f := purchaseFixture(t)
	w := f.serve(t, f.request(2, "POST", "/api/purchases", validPurchaseJSON))
	created := purchaseDocumentWire(t, w, 201)
	if created.LocationID != 2 || created.CreatedByAccountID != 2 || created.Total != "124200.00" ||
		created.PaidCash != "124200.00" || created.PaidTransfer != "0.00" ||
		created.ReversesPurchaseID != nil || created.ReversedBy != nil || created.Reason != "" {
		t.Fatalf("the created document is wrong: %+v", created)
	}
	if len(created.UsedLines) != 1 || created.UsedLines[0].Model != "NS60ZL" ||
		created.UsedLines[0].Quantity != 1 || created.UsedLines[0].UnitPrice != "25000.00" ||
		created.UsedLines[0].Amount != "25000.00" {
		t.Fatalf("the created used line is wrong: %+v", created.UsedLines)
	}
	if len(created.ScrapLines) != 1 || created.ScrapLines[0].MaterialID != 1 ||
		created.ScrapLines[0].Name != "Cobre" || created.ScrapLines[0].Kg != "12.400" ||
		created.ScrapLines[0].PricePerKg != "8000.00" || created.ScrapLines[0].Amount != "99200.00" {
		t.Fatalf("the created scrap line is wrong: %+v", created.ScrapLines)
	}
	var count int
	if err := f.p.QueryRow(f.ctx, "SELECT count(*) FROM purchases").Scan(&count); err != nil || count != 1 {
		t.Fatalf("the document was not persisted once: %d %v", count, err)
	}
	// The same operation key with the same payload answers the persisted document, and the
	// frozen contract answers it with 201.
	replay := purchaseDocumentWire(t, f.serve(t, f.request(2, "POST", "/api/purchases", validPurchaseJSON)), 201)
	if replay.ID != created.ID {
		t.Fatalf("a replay must answer the persisted document: %+v", replay)
	}
	// A different payload under the same key is a conflict and never a second document.
	conflict := strings.Replace(validPurchaseJSON, `"note":""`, `"note":"otra"`, 1)
	f.rejected(t, f.request(2, "POST", "/api/purchases", conflict), 409, "retry_conflict")
	// The detail answers the persisted document exactly as creation did.
	detail := purchaseDocumentWire(t, f.serve(t, f.request(2, "GET",
		"/api/purchases/"+strconv.FormatInt(created.ID, 10), "")), 200)
	if detail.ID != created.ID || detail.Total != created.Total ||
		len(detail.UsedLines) != 1 || len(detail.ScrapLines) != 1 {
		t.Fatalf("the detail disagrees with the created document: %+v", detail)
	}
	// The counter-document mirrors it and both stay visible.
	counter := purchaseDocumentWire(t, f.serve(t, f.request(2, "POST",
		"/api/purchases/"+strconv.FormatInt(created.ID, 10)+"/reverse",
		`{"operation_key":"http-purchase-reverse-1","reason":"pesaje mal tipeado"}`)), 201)
	if counter.ReversesPurchaseID == nil || *counter.ReversesPurchaseID != created.ID ||
		counter.Reason != "pesaje mal tipeado" || counter.Total != "-124200.00" ||
		counter.PaidCash != "-124200.00" || len(counter.UsedLines) != 1 ||
		counter.UsedLines[0].Quantity != -1 || counter.UsedLines[0].Amount != "-25000.00" ||
		len(counter.ScrapLines) != 1 || counter.ScrapLines[0].Kg != "-12.400" ||
		counter.ScrapLines[0].Amount != "-99200.00" {
		t.Fatalf("the counter-document is wrong: %+v", counter)
	}
	original := purchaseDocumentWire(t, f.serve(t, f.request(2, "GET",
		"/api/purchases/"+strconv.FormatInt(created.ID, 10), "")), 200)
	if original.ReversedBy == nil || *original.ReversedBy != counter.ID || original.Total != "124200.00" {
		t.Fatalf("the original must name its counter-document: %+v", original)
	}
	// The same operation key with the same target and reason is a replay, with 201.
	replayCounter := purchaseDocumentWire(t, f.serve(t, f.request(2, "POST",
		"/api/purchases/"+strconv.FormatInt(created.ID, 10)+"/reverse",
		`{"operation_key":"http-purchase-reverse-1","reason":"pesaje mal tipeado"}`)), 201)
	if replayCounter.ID != counter.ID {
		t.Fatalf("a reversal replay must answer the persisted counter-document: %+v", replayCounter)
	}
	// A second counter-document, a counter-document of a counter-document and a foreign
	// target are refused with the contract's own tokens.
	f.rejected(t, f.request(2, "POST", "/api/purchases/"+strconv.FormatInt(created.ID, 10)+"/reverse",
		`{"operation_key":"http-purchase-reverse-2","reason":"otra vez"}`), 409, "already_reversed")
	f.rejected(t, f.request(2, "POST", "/api/purchases/"+strconv.FormatInt(counter.ID, 10)+"/reverse",
		`{"operation_key":"http-purchase-reverse-3","reason":"revertir la reversa"}`), 409, "already_reversed")
	f.rejected(t, f.request(3, "GET", "/api/purchases/"+strconv.FormatInt(created.ID, 10), ""), 404, "not_found")
	f.rejected(t, f.request(3, "POST", "/api/purchases/"+strconv.FormatInt(created.ID, 10)+"/reverse",
		`{"operation_key":"http-purchase-reverse-4","reason":"ajeno"}`), 404, "not_found")
	// An id that is not a positive integer is not a document path at all.
	for _, path := range []string{"/api/purchases/0", "/api/purchases/-1", "/api/purchases/abc",
		"/api/purchases/1.5", "/api/purchases/0" + strconv.FormatInt(created.ID, 10)} {
		w := f.serve(t, f.request(2, "GET", path, ""))
		expectTransferError(t, w, 404, "not_found")
	}
}

// TestPurchaseHTTPList proves the page contract: the newest first, the row shape and the
// frozen page sizes.
func TestPurchaseHTTPList(t *testing.T) {
	f := purchaseFixture(t)
	first := purchaseDocumentWire(t, f.serve(t, f.request(2, "POST", "/api/purchases", validPurchaseJSON)), 201)
	secondBody := `{"operation_key":"http-purchase-key-02","used_lines":[{"model":"55B24L","quantity":3,"unit_price":"9000.00"}],"paid_cash":"27000.00","paid_transfer":"0.00"}`
	second := purchaseDocumentWire(t, f.serve(t, f.request(2, "POST", "/api/purchases", secondBody)), 201)
	// A scrap-only purchase is a legal document: no used units, one scrap line, and it must
	// appear in the page instead of failing it closed — the counter sells kilograms too.
	scrapOnly := purchaseDocumentWire(t, f.serve(t, f.request(2, "POST", "/api/purchases",
		`{"operation_key":"http-purchase-key-03","scrap_lines":[{"material_id":1,"kg":"2.500","price_per_kg":"8000.00"}],"paid_cash":"20000.00","paid_transfer":"0.00"}`)), 201)
	counter := purchaseDocumentWire(t, f.serve(t, f.request(2, "POST",
		"/api/purchases/"+strconv.FormatInt(first.ID, 10)+"/reverse",
		`{"operation_key":"http-purchase-reverse-1","reason":"pesaje mal tipeado"}`)), 201)
	w := f.serve(t, f.request(2, "GET", "/api/purchases?page=1&page_size=10", ""))
	var page struct {
		Page           int                          `json:"page"`
		PageSize       int                          `json:"page_size"`
		TotalPurchases int64                        `json:"total_purchases"`
		Purchases      []map[string]json.RawMessage `json:"purchases"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &page) != nil {
		t.Fatalf("the page answer is not JSON: %d %s", w.Code, w.Body.String())
	}
	if page.Page != 1 || page.PageSize != 10 || page.TotalPurchases != 4 || len(page.Purchases) != 4 {
		t.Fatalf("the page is wrong: %s", w.Body.String())
	}
	for _, row := range page.Purchases {
		if len(row) != 7 {
			t.Fatalf("a history row has %d keys, want 7: %v", len(row), row)
		}
		for _, key := range []string{"id", "created_at", "total", "reverses_purchase_id",
			"reversed_by", "used_units", "scrap_lines"} {
			if _, ok := row[key]; !ok {
				t.Fatalf("a history row is missing %q: %v", key, row)
			}
		}
	}
	// The counter-document leads the page and names its original; the original names it.
	var leadID, leadReverses, leadUnits, leadScrap int64
	var leadTotal string
	if json.Unmarshal(page.Purchases[0]["id"], &leadID) != nil || leadID != counter.ID ||
		json.Unmarshal(page.Purchases[0]["reverses_purchase_id"], &leadReverses) != nil ||
		leadReverses != first.ID ||
		json.Unmarshal(page.Purchases[0]["used_units"], &leadUnits) != nil || leadUnits != -1 ||
		json.Unmarshal(page.Purchases[0]["scrap_lines"], &leadScrap) != nil || leadScrap != 1 {
		t.Fatalf("the counter-document row is wrong: %s", w.Body.String())
	}
	if json.Unmarshal(page.Purchases[0]["total"], &leadTotal) != nil || leadTotal != "-124200.00" {
		t.Fatalf("the counter total must be published as canonical text: %s", page.Purchases[0]["total"])
	}
	var reversedBy int64
	if json.Unmarshal(page.Purchases[3]["id"], &leadID) != nil || leadID != first.ID ||
		json.Unmarshal(page.Purchases[3]["reversed_by"], &reversedBy) != nil || reversedBy != counter.ID {
		t.Fatalf("the reversed original row is wrong: %s", w.Body.String())
	}
	// The scrap-only document is listed with zero used units and its one scrap line: it is
	// not a counter-document, and it is the case that used to fail the whole page closed.
	if json.Unmarshal(page.Purchases[1]["id"], &leadID) != nil || leadID != scrapOnly.ID ||
		json.Unmarshal(page.Purchases[1]["used_units"], &leadUnits) != nil || leadUnits != 0 ||
		json.Unmarshal(page.Purchases[1]["scrap_lines"], &leadScrap) != nil || leadScrap != 1 ||
		json.Unmarshal(page.Purchases[1]["total"], &leadTotal) != nil || leadTotal != "20000.00" {
		t.Fatalf("the scrap-only row is wrong: %s", w.Body.String())
	}
	if json.Unmarshal(page.Purchases[2]["id"], &leadID) != nil || leadID != second.ID {
		t.Fatalf("the page is not newest first: %s", w.Body.String())
	}
	// The frozen page contract is enforced before the page is read.
	for _, query := range []string{"?page=0", "?page_size=20", "?page_size=1", "?search=NS60",
		"?page=", "?page=1&page=1", "?page=1000001"} {
		f.rejected(t, f.request(2, "GET", "/api/purchases"+query, ""), 400, "invalid_request")
	}
	// A bare separator is an ambiguous framing, not the default page.
	f.rejected(t, f.request(2, "GET", "/api/purchases?", ""), 400, "invalid_request")
	// A page beyond the last one is legitimately empty.
	w = f.serve(t, f.request(2, "GET", "/api/purchases?page=2&page_size=10", ""))
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &page) != nil || len(page.Purchases) != 0 ||
		page.TotalPurchases != 4 {
		t.Fatalf("a page beyond the last one must be empty: %s", w.Body.String())
	}
	// The warehouse is forbidden on every route of this contract.
	for _, tc := range []struct{ method, path, body string }{
		{"POST", "/api/purchases", validPurchaseJSON},
		{"GET", "/api/purchases", ""},
		{"GET", "/api/purchases/1", ""},
		{"POST", "/api/purchases/1/reverse", `{"operation_key":"http-purchase-reverse-9","reason":"m"}`},
		{"GET", "/api/purchases/models", ""},
		{"GET", "/api/purchases/materials", ""},
		{"GET", "/api/purchases/last-prices", ""},
		{"GET", "/api/purchases/received", ""},
	} {
		f.rejected(t, f.request(1, tc.method, tc.path, tc.body), 403, "forbidden")
	}
}

// TestPurchaseHTTPCatalogue proves the four read-only routes and the derived totals.
func TestPurchaseHTTPCatalogue(t *testing.T) {
	f := purchaseFixture(t)
	// An empty branch publishes empty arrays and no last price at all.
	var models struct {
		Models []string `json:"models"`
	}
	w := f.serve(t, f.request(2, "GET", "/api/purchases/models", ""))
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &models) != nil || len(models.Models) == 0 {
		t.Fatalf("the catalogue models must be listed: %d %s", w.Code, w.Body.String())
	}
	for i := 1; i < len(models.Models); i++ {
		if models.Models[i] <= models.Models[i-1] {
			t.Fatalf("the model list must be ascending and deduplicated: %v", models.Models)
		}
	}
	var materials struct {
		Materials []struct {
			ID   int64  `json:"id"`
			Name string `json:"name"`
		} `json:"materials"`
	}
	w = f.serve(t, f.request(2, "GET", "/api/purchases/materials", ""))
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &materials) != nil || len(materials.Materials) != 4 ||
		materials.Materials[0].Name != "Cobre" || materials.Materials[3].Name != "Bronce" {
		t.Fatalf("the reference materials must be listed: %d %s", w.Code, w.Body.String())
	}
	var emptyPrices struct {
		Models    []json.RawMessage `json:"models"`
		Materials []json.RawMessage `json:"materials"`
	}
	w = f.serve(t, f.request(2, "GET", "/api/purchases/last-prices", ""))
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &emptyPrices) != nil ||
		len(emptyPrices.Models) != 0 || len(emptyPrices.Materials) != 0 {
		t.Fatalf("an empty branch reports no last price: %d %s", w.Code, w.Body.String())
	}
	var emptyReceived struct {
		Used  []json.RawMessage `json:"used"`
		Scrap []json.RawMessage `json:"scrap"`
	}
	w = f.serve(t, f.request(2, "GET", "/api/purchases/received", ""))
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &emptyReceived) != nil ||
		len(emptyReceived.Used) != 0 || len(emptyReceived.Scrap) != 0 {
		t.Fatalf("an empty branch received nothing: %d %s", w.Code, w.Body.String())
	}
	created := purchaseDocumentWire(t, f.serve(t, f.request(2, "POST", "/api/purchases", validPurchaseJSON)), 201)
	var prices struct {
		Models []struct {
			Model       string `json:"model"`
			UnitPrice   string `json:"unit_price"`
			PurchasedAt string `json:"purchased_at"`
		} `json:"models"`
		Materials []struct {
			MaterialID  int64  `json:"material_id"`
			PricePerKg  string `json:"price_per_kg"`
			PurchasedAt string `json:"purchased_at"`
		} `json:"materials"`
	}
	w = f.serve(t, f.request(2, "GET", "/api/purchases/last-prices", ""))
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &prices) != nil || len(prices.Models) != 1 ||
		prices.Models[0].Model != "NS60ZL" || prices.Models[0].UnitPrice != "25000.00" ||
		len(prices.Materials) != 1 || prices.Materials[0].MaterialID != 1 ||
		prices.Materials[0].PricePerKg != "8000.00" {
		t.Fatalf("the last prices are wrong: %s", w.Body.String())
	}
	if _, err := time.Parse(time.RFC3339, prices.Models[0].PurchasedAt); err != nil {
		t.Fatalf("purchased_at is not an RFC3339 instant: %q", prices.Models[0].PurchasedAt)
	}
	var received struct {
		Used []struct {
			Model    string `json:"model"`
			Quantity int64  `json:"quantity"`
			Value    string `json:"value"`
		} `json:"used"`
		Scrap []struct {
			MaterialID int64  `json:"material_id"`
			Name       string `json:"name"`
			Kg         string `json:"kg"`
			Value      string `json:"value"`
		} `json:"scrap"`
	}
	w = f.serve(t, f.request(2, "GET", "/api/purchases/received", ""))
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &received) != nil || len(received.Used) != 1 ||
		received.Used[0].Model != "NS60ZL" || received.Used[0].Quantity != 1 ||
		received.Used[0].Value != "25000.00" || len(received.Scrap) != 1 ||
		received.Scrap[0].Kg != "12.400" || received.Scrap[0].Value != "99200.00" {
		t.Fatalf("the received totals are wrong: %s", w.Body.String())
	}
	// A counter-document nets the received totals out and the anchor stays on the document
	// that is not a counter-document.
	if _, err := purchases.New(f.p).Reverse(f.ctx,
		auth.Identity{AccountID: 2, Location: auth.Location{ID: 2}}, created.ID,
		"http-purchase-reverse-7", "pesaje mal tipeado"); err != nil {
		t.Fatalf("the document must be reversible: %v", err)
	}
	w = f.serve(t, f.request(2, "GET", "/api/purchases/received", ""))
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &received) != nil ||
		len(received.Used) != 0 || len(received.Scrap) != 0 {
		t.Fatalf("a counter-document must net the received totals: %s", w.Body.String())
	}
	w = f.serve(t, f.request(2, "GET", "/api/purchases/last-prices", ""))
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &prices) != nil || len(prices.Models) != 1 ||
		prices.Models[0].UnitPrice != "25000.00" {
		t.Fatalf("a counter-document must not become the anchor: %s", w.Body.String())
	}
	// A query string is not part of these contracts: it is a framing error, never a
	// silently ignored parameter.
	for _, path := range []string{"/api/purchases/models?page=1", "/api/purchases/materials?x=1",
		"/api/purchases/last-prices?x=1", "/api/purchases/received?x=1", "/api/purchases/1?x=1"} {
		f.rejected(t, f.request(2, "GET", path, ""), 400, "invalid_request")
	}
}

// TestPurchaseHTTPRefusals proves the framing guards and that a refused document writes
// nothing: unknown and duplicate keys, wrong types, a broken rule, a missing CSRF token and
// a cross-origin request.
func TestPurchaseHTTPRefusals(t *testing.T) {
	f := purchaseFixture(t)
	for name, body := range map[string]string{
		"unknown_key":     strings.Replace(validPurchaseJSON, `"note":""`, `"note":"","otra":1`, 1),
		"duplicate_key":   strings.Replace(validPurchaseJSON, `"note":""`, `"note":"","note":""`, 1),
		"wrong_type":      strings.Replace(validPurchaseJSON, `"quantity":1`, `"quantity":"1"`, 1),
		"money_shape":     strings.Replace(validPurchaseJSON, `"25000.00"`, `"25000"`, 1),
		"model_shape":     strings.Replace(validPurchaseJSON, `"ns60zl"`, `"-NS60"`, 1),
		"no_lines":        `{"operation_key":"http-purchase-key-09","paid_cash":"1.00","paid_transfer":"0.00"}`,
		"open_settlement": strings.Replace(validPurchaseJSON, `"124200.00"`, `"124199.00"`, 1),
		"material_unknown": strings.Replace(validPurchaseJSON,
			`"material_id":1`, `"material_id":9`, 1),
		"trailing_input": validPurchaseJSON + `{}`,
	} {
		t.Run(name, func(t *testing.T) {
			f.rejected(t, f.request(2, "POST", "/api/purchases", body), 400, "invalid_request")
		})
	}
	// The mutation framing is the house one: same-origin, CSRF token and no query string.
	noToken := f.request(0, "POST", "/api/purchases", validPurchaseJSON)
	noToken.AddCookie(&http.Cookie{Name: sessionCookie, Value: f.tokens[1]})
	f.rejected(t, noToken, 403, "forbidden")
	crossSite := f.request(2, "POST", "/api/purchases", validPurchaseJSON)
	crossSite.Header.Set("Sec-Fetch-Site", "cross-site")
	f.rejected(t, crossSite, 403, "forbidden")
	withQuery := f.request(2, "POST", "/api/purchases?page=1", validPurchaseJSON)
	f.rejected(t, withQuery, 400, "invalid_request")
	wrongContent := f.request(2, "POST", "/api/purchases", validPurchaseJSON)
	wrongContent.Header.Set("Content-Type", "text/plain")
	f.rejected(t, wrongContent, 400, "invalid_request")
	// A document that does not add up is refused and nothing is written.
	f.rejected(t, f.request(2, "POST", "/api/purchases",
		`{"operation_key":"http-purchase-key-08","used_lines":[{"model":"NS60ZL","quantity":1,"unit_price":"100.00"}],"paid_cash":"50.00","paid_transfer":"0.00"}`),
		400, "invalid_request")
	var count int
	if err := f.p.QueryRow(f.ctx, "SELECT count(*) FROM purchases").Scan(&count); err != nil || count != 0 {
		t.Fatalf("a refused document was persisted: %d %v", count, err)
	}
	// The same document is admitted once the settlement closes.
	admitted := purchaseDocumentWire(t, f.serve(t, f.request(2, "POST", "/api/purchases",
		`{"operation_key":"http-purchase-key-08","used_lines":[{"model":"NS60ZL","quantity":1,"unit_price":"100.00"}],"paid_cash":"50.00","paid_transfer":"50.00"}`)), 201)
	if admitted.Total != "100.00" || admitted.PaidTransfer != "50.00" {
		t.Fatalf("the admitted document is wrong: %+v", admitted)
	}
	if err := f.p.QueryRow(f.ctx, "SELECT count(*) FROM purchases").Scan(&count); err != nil || count != 1 {
		t.Fatalf("the admitted document must be the only one: %d %v", count, err)
	}
}

// TestPurchaseHTTPBound proves the decoded bounds: a body above the limit and a document
// with too many lines are both an invalid request, never a partial document.
func TestPurchaseHTTPBound(t *testing.T) {
	f := purchaseFixture(t)
	lines := make([]string, 0, purchases.MaxLines+1)
	for i := 0; i <= purchases.MaxLines; i++ {
		lines = append(lines, fmt.Sprintf(`{"model":"M%03d","quantity":1,"unit_price":"1.00"}`, i))
	}
	body := `{"operation_key":"http-purchase-bound-1","used_lines":[` +
		strings.Join(lines, ",") + `],"paid_cash":"191.00","paid_transfer":"0.00"}`
	f.rejected(t, f.request(2, "POST", "/api/purchases", body), 400, "invalid_request")
	// A body above the admitted size is refused before it is decoded.
	wide := `{"operation_key":"http-purchase-bound-2","note":"` + strings.Repeat("a", purchaseBodyLimit) +
		`","paid_cash":"1.00","paid_transfer":"0.00"}`
	f.rejected(t, f.request(2, "POST", "/api/purchases", wide), 400, "invalid_request")
}

// TestPurchaseMoneyAndWeightRoundTrip proves the published formats: a weight typed as
// "12.4" is answered as "12.400" and money is always canonical two-decimal text.
func TestPurchaseMoneyAndWeightRoundTrip(t *testing.T) {
	f := purchaseFixture(t)
	body := `{"operation_key":"http-purchase-key-11","scrap_lines":[{"material_id":3,"kg":"7","price_per_kg":"1500.50"}],"paid_cash":"10503.50","paid_transfer":"0.00"}`
	document := purchaseDocumentWire(t, f.serve(t, f.request(2, "POST", "/api/purchases", body)), 201)
	if len(document.ScrapLines) != 1 || document.ScrapLines[0].Kg != "7.000" ||
		document.ScrapLines[0].Amount != "10503.50" || document.Total != "10503.50" {
		t.Fatalf("the weight and the amount are not canonical: %+v", document)
	}
}
