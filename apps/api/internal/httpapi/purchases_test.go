package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
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
	"luson/api/internal/closings"
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
		page, size, selection, err := purchasePageQuery(raw)
		if err != nil || page != want[0] || size != want[1] ||
			selection != (purchases.PeriodSelection{Kind: purchases.PeriodAll}) {
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
		if _, _, _, err := purchasePageQuery(raw); !errors.Is(err, purchases.ErrInvalid) {
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

// openSettlement walks one settlement of branch 2 to the moment the warehouse holds it: the
// count sheet is counted as the system expects it and the material sheet as the test states, so
// the period a listing reads is a fact the database decided.
func (f *purchaseHTTPFixture) openSettlement(t *testing.T, counted []closings.MaterialCounted) int64 {
	t.Helper()
	settlements := closings.New(f.p)
	warehouse := auth.Identity{AccountID: 1, Location: auth.Location{ID: 1}}
	if _, err := settlements.ConfigureCommission(f.ctx, warehouse, 2, "10.00"); err != nil {
		t.Fatalf("the branch commission could not be configured: %v", err)
	}
	opened, err := settlements.Open(f.ctx, warehouse, 2)
	if err != nil {
		t.Fatalf("the settlement could not be opened: %v", err)
	}
	read, err := settlements.Read(f.ctx, warehouse, opened.ID)
	if err != nil {
		t.Fatalf("the settlement could not be read: %v", err)
	}
	stock := make([]closings.Counted, 0, len(read.CountLines))
	for _, line := range read.CountLines {
		stock = append(stock, closings.Counted{VariantID: line.VariantID, Quantity: line.ExpectedQuantity})
	}
	if len(stock) > 0 {
		if _, err := settlements.Count(f.ctx, warehouse, opened.ID, stock); err != nil {
			t.Fatalf("the count sheet could not be counted: %v", err)
		}
	}
	if len(counted) > 0 {
		if _, err := settlements.CountMaterials(f.ctx, warehouse, opened.ID, counted); err != nil {
			t.Fatalf("the material sheet could not be counted: %v", err)
		}
	}
	zero, contribution := closings.Money("0.00"), closings.Money("500.00")
	if _, err := settlements.SaveCash(f.ctx, warehouse, opened.ID, closings.CashDraft{
		CountedCash: &zero, ContributedCash: contribution, ClosingCash: &contribution,
	}); err != nil {
		t.Fatalf("the cash draft could not be saved: %v", err)
	}
	return opened.ID
}

// closeSettlement opens a settlement and closes it the way the branch does, so the closed period
// exists only through the database's own state machine.
func (f *purchaseHTTPFixture) closeSettlement(t *testing.T, counted []closings.MaterialCounted) int64 {
	t.Helper()
	settlements := closings.New(f.p)
	warehouse := auth.Identity{AccountID: 1, Location: auth.Location{ID: 1}}
	branch := auth.Identity{AccountID: 2, Location: auth.Location{ID: 2}}
	id := f.openSettlement(t, counted)
	if _, err := settlements.Propose(f.ctx, warehouse, id); err != nil {
		t.Fatalf("the settlement could not be proposed: %v", err)
	}
	if _, err := settlements.Decide(f.ctx, branch, id, closings.DecisionAccepted, ""); err != nil {
		t.Fatalf("the branch could not accept the settlement: %v", err)
	}
	return id
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
	// The same document is admitted once the settlement closes, and it is paid whole in cash
	// because a branch purchase is never paid by transfer: the fund is cash.
	admitted := purchaseDocumentWire(t, f.serve(t, f.request(2, "POST", "/api/purchases",
		`{"operation_key":"http-purchase-key-08","used_lines":[{"model":"NS60ZL","quantity":1,"unit_price":"100.00"}],"paid_cash":"100.00","paid_transfer":"0.00"}`)), 201)
	if admitted.Total != "100.00" || admitted.PaidCash != "100.00" || admitted.PaidTransfer != "0.00" {
		t.Fatalf("the admitted document is wrong: %+v", admitted)
	}
	if err := f.p.QueryRow(f.ctx, "SELECT count(*) FROM purchases").Scan(&count); err != nil || count != 1 {
		t.Fatalf("the admitted document must be the only one: %d %v", count, err)
	}
}

// TestPurchaseHTTPRefusesTransferPayment proves the published refusal of a purchase paid by
// transfer: the fund is cash, so the endpoint answers the token this contract already
// publishes for a document that cannot be admitted as it stands, and it writes nothing and
// never leaks a SQLSTATE or the database's own text.
func TestPurchaseHTTPRefusesTransferPayment(t *testing.T) {
	f := purchaseFixture(t)
	for name, body := range map[string]string{
		"whole": `{"operation_key":"http-purchase-fund-01","used_lines":[{"model":"NS60ZL","quantity":1,"unit_price":"25000.00"}],"paid_cash":"0.00","paid_transfer":"25000.00"}`,
		"part":  `{"operation_key":"http-purchase-fund-02","used_lines":[{"model":"NS60ZL","quantity":1,"unit_price":"25000.00"}],"paid_cash":"24999.99","paid_transfer":"0.01"}`,
	} {
		t.Run(name, func(t *testing.T) {
			f.rejected(t, f.request(2, "POST", "/api/purchases", body), 400, "invalid_request")
		})
	}
	var count int
	if err := f.p.QueryRow(f.ctx, "SELECT count(*) FROM purchases").Scan(&count); err != nil || count != 0 {
		t.Fatalf("a refused transfer purchase was persisted: %d %v", count, err)
	}
	// The same document paid in cash is admitted: the fund refuses the method, not the
	// purchase.
	admitted := purchaseDocumentWire(t, f.serve(t, f.request(2, "POST", "/api/purchases",
		`{"operation_key":"http-purchase-fund-03","used_lines":[{"model":"NS60ZL","quantity":1,"unit_price":"25000.00"}],"paid_cash":"25000.00","paid_transfer":"0.00"}`)), 201)
	if admitted.Total != "25000.00" || admitted.PaidCash != "25000.00" || admitted.PaidTransfer != "0.00" {
		t.Fatalf("the cash document is wrong: %+v", admitted)
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

// TestPurchasePeriodQuery pins the period token of the wire: the two literals the selector
// publishes beside the closing id of a closed settlement, and nothing else. A query without a
// period reads the whole history, so a client that does not know the selector keeps its answer.
func TestPurchasePeriodQuery(t *testing.T) {
	for raw, want := range map[string]struct {
		page, size int
		selection  purchases.PeriodSelection
	}{
		"":                           {1, 25, purchases.PeriodSelection{Kind: purchases.PeriodAll}},
		"period=all":                 {1, 25, purchases.PeriodSelection{Kind: purchases.PeriodAll}},
		"period=pending":             {1, 25, purchases.PeriodSelection{Kind: purchases.PeriodPending}},
		"period=7":                   {1, 25, purchases.PeriodSelection{Kind: purchases.PeriodSettlement, ClosingID: 7}},
		"page=2&period=pending":      {2, 25, purchases.PeriodSelection{Kind: purchases.PeriodPending}},
		"period=7&page_size=10":      {1, 10, purchases.PeriodSelection{Kind: purchases.PeriodSettlement, ClosingID: 7}},
		"period=9223372036854775807": {1, 25, purchases.PeriodSelection{Kind: purchases.PeriodSettlement, ClosingID: math.MaxInt64}},
	} {
		page, size, selection, err := purchasePageQuery(raw)
		if err != nil || page != want.page || size != want.size || selection != want.selection {
			t.Fatalf("%q reads as %d/%d %+v (want %d/%d %+v): %v", raw, page, size, selection,
				want.page, want.size, want.selection, err)
		}
	}
	for name, raw := range map[string]string{
		"empty_value":     "period=",
		"zero":            "period=0",
		"negative":        "period=-1",
		"padded":          "period=07",
		"text":            "period=abierta",
		"open_literal":    "period=open",
		"settlement":      "period=settlement",
		"duplicate":       "period=1&period=1",
		"overflow":        "period=9223372036854775808",
		"unknown_key":     "period=pending&search=NS60",
		"empty_with_page": "page=1&period=",
	} {
		if _, _, _, err := purchasePageQuery(raw); !errors.Is(err, purchases.ErrInvalid) {
			t.Fatalf("a %s period query must be refused, got %v", name, err)
		}
	}
}

type purchasePeriodWire struct {
	Kind      string  `json:"kind"`
	ClosingID *int64  `json:"closing_id"`
	From      *string `json:"from"`
	To        *string `json:"to"`
	Label     string  `json:"label"`
}

type purchaseTotalsWire struct {
	Money     *string `json:"money"`
	UsedUnits string  `json:"used_units"`
	ScrapKg   string  `json:"scrap_kg"`
}

type purchaseListingWire struct {
	Page           int                  `json:"page"`
	PageSize       int                  `json:"page_size"`
	TotalPurchases int64                `json:"total_purchases"`
	Purchases      []map[string]any     `json:"purchases"`
	Periods        []purchasePeriodWire `json:"periods"`
	Period         purchasePeriodWire   `json:"period"`
	Totals         purchaseTotalsWire   `json:"totals"`
	Balance        *purchaseBalanceWire `json:"balance"`
}

type purchaseBalanceUsedWire struct {
	Model     string `json:"model"`
	Bought    string `json:"bought"`
	Delivered string `json:"delivered"`
	Balance   string `json:"balance"`
}

type purchaseBalanceScrapWire struct {
	MaterialID int64  `json:"material_id"`
	Bought     string `json:"bought"`
	Delivered  string `json:"delivered"`
	Balance    string `json:"balance"`
}

type purchaseBalanceWire struct {
	Used  []purchaseBalanceUsedWire  `json:"used"`
	Scrap []purchaseBalanceScrapWire `json:"scrap"`
}

// TestPurchaseListingRecord proves the published answer of the listing: the page keeps its
// frozen shape, and the selector, the chosen period and the balance obey the contract. Anything
// this server could not have produced fails closed instead of being described to the screen.
func TestPurchaseListingRecord(t *testing.T) {
	moment := time.Date(2026, 11, 10, 14, 2, 0, 0, time.UTC)
	later := moment.Add(2 * time.Hour)
	closedID := int64(7)
	periods := []purchases.Period{
		{Kind: purchases.PeriodPending, Label: "Pendiente"},
		{Kind: purchases.PeriodSettlement, ClosingID: &closedID, From: &moment, To: &later,
			Label: "Rendición #7"},
		{Kind: purchases.PeriodAll, Label: "Todo el historial"},
	}
	page := purchases.Page{Page: 1, PageSize: 25, TotalPurchases: 1, Purchases: []purchases.Summary{
		{ID: 6, CreatedAt: moment, Total: "27000.00", UsedUnits: 3, ScrapLines: 0},
	}}
	balance := &purchases.Balance{
		Used: []purchases.BalanceUsed{{Model: "NS60ZL", Bought: 3, Delivered: 2, Balance: 1}},
		Scrap: []purchases.BalanceScrap{{MaterialID: 1, Bought: "10.000", Delivered: "4.000",
			Balance: "6.000"}},
	}
	listing := purchases.Listing{Page: page, Periods: periods, Period: periods[0], Balance: balance,
		Totals: purchases.Totals{UsedUnits: 1, ScrapKg: "6.000"}}
	record, err := purchaseListingRecord(listing)
	if err != nil || record.Balance == nil || len(record.Periods) != 3 ||
		record.Period.Kind != "pending" || record.Balance.Used[0].Bought != "3" ||
		record.Balance.Scrap[0].Balance != "6.000" {
		t.Fatalf("a complete pending listing must be published: %+v %v", record, err)
	}
	// The pending header numbers carry no money at all and repeat the balance, in the published
	// formats.
	if record.Totals.Money != nil || record.Totals.UsedUnits != "1" || record.Totals.ScrapKg != "6.000" {
		t.Fatalf("the pending totals must be the balance and no money: %+v", record.Totals)
	}
	// The whole history carries no balance at all, its windows are null and it states the money that
	// left the cash box beside the units and the kilos it received.
	history := listing
	history.Period, history.Balance = periods[2], nil
	history.Totals = purchases.Totals{Money: "36400.00", UsedUnits: 3, ScrapKg: "15.400"}
	record, err = purchaseListingRecord(history)
	if err != nil || record.Balance != nil || record.Period.ClosingID != nil ||
		record.Period.From != nil || record.Period.To != nil {
		t.Fatalf("the whole history must be published without a balance: %+v %v", record, err)
	}
	if record.Totals.Money == nil || *record.Totals.Money != "36400.00" ||
		record.Totals.UsedUnits != "3" || record.Totals.ScrapKg != "15.400" {
		t.Fatalf("the whole history must state its own totals: %+v", record.Totals)
	}
	// A closed settlement publishes its window as RFC3339 instants.
	closed := history
	closed.Period = periods[1]
	record, err = purchaseListingRecord(closed)
	if err != nil || record.Period.ClosingID == nil || *record.Period.ClosingID != closedID ||
		record.Period.From == nil || record.Period.To == nil {
		t.Fatalf("a closed settlement must publish its window: %+v %v", record, err)
	}
	if _, err := time.Parse(time.RFC3339, *record.Period.From); err != nil {
		t.Fatalf("from is not an RFC3339 instant: %q", *record.Period.From)
	}
	// A window total is the net of every document in it: a period whose only document is a
	// counter-document publishes a negative amount, unit count and weight.
	signed := history
	signed.Totals = purchases.Totals{Money: "-36400.00", UsedUnits: -3, ScrapKg: "-15.400"}
	record, err = purchaseListingRecord(signed)
	if err != nil || record.Totals.Money == nil || *record.Totals.Money != "-36400.00" ||
		record.Totals.UsedUnits != "-3" || record.Totals.ScrapKg != "-15.400" {
		t.Fatalf("a window must publish its negative net: %+v %v", record, err)
	}
	// The pending period is a balance and not a window: the same signed reading is still refused.
	signed.Period, signed.Balance = periods[0], balance
	if _, err := purchaseListingRecord(signed); !errors.Is(err, purchases.ErrUnavailable) {
		t.Fatalf("a pending period must refuse a signed reading: %v", err)
	}
	broken := map[string]func(*purchases.Listing){
		"no_selector": func(l *purchases.Listing) { l.Periods = nil },
		"first_not_pending": func(l *purchases.Listing) {
			l.Periods[0] = l.Periods[1]
		},
		"last_not_all": func(l *purchases.Listing) {
			l.Periods[2] = l.Periods[1]
		},
		"ascending_settlements": func(l *purchases.Listing) {
			second := int64(9)
			l.Periods = append(append([]purchases.Period{l.Periods[0], l.Periods[1]}, purchases.Period{
				Kind: purchases.PeriodSettlement, ClosingID: &second, From: &moment, To: &later,
				Label: "Rendición #9"}), l.Periods[2])
		},
		"settlement_after_open": func(l *purchases.Listing) {
			l.Periods[1].Kind, l.Periods[1].Label = purchases.PeriodOpen, "En curso"
			l.Periods = append(append([]purchases.Period{l.Periods[0], l.Periods[1]}, purchases.Period{
				Kind: purchases.PeriodSettlement, ClosingID: &closedID, From: &moment, To: &later,
				Label: "Rendición #7"}), l.Periods[2])
		},
		"open_without_closing": func(l *purchases.Listing) {
			l.Periods[1].Kind, l.Periods[1].Label = purchases.PeriodOpen, "En curso"
			l.Periods[1].ClosingID = nil
		},
		"settlement_without_window": func(l *purchases.Listing) { l.Periods[1].From = nil },
		"reversed_window": func(l *purchases.Listing) {
			l.Periods[1].From, l.Periods[1].To = &later, &moment
		},
		"pending_with_window": func(l *purchases.Listing) { l.Periods[0].From = &moment },
		"no_label":            func(l *purchases.Listing) { l.Periods[0].Label = "" },
		"long_label":          func(l *purchases.Listing) { l.Periods[0].Label = strings.Repeat("ñ", 201) },
		"period_not_offered": func(l *purchases.Listing) {
			other := int64(8)
			l.Period = purchases.Period{Kind: purchases.PeriodSettlement, ClosingID: &other,
				From: &moment, To: &later, Label: "Rendición #8"}
		},
		"pending_without_balance": func(l *purchases.Listing) { l.Balance = nil },
		// The totals are part of the answer: a pending period that states money, a window that states
		// none and a pending reading that is not the balance's own sum are all refused whole, never half
		// rendered.
		"pending_with_money": func(l *purchases.Listing) { l.Totals.Money = "100.00" },
		"window_without_money": func(l *purchases.Listing) {
			l.Period = l.Periods[2]
			l.Balance = nil
		},
		"pending_units_not_the_balance": func(l *purchases.Listing) { l.Totals.UsedUnits = 2 },
		"pending_kg_not_the_balance":    func(l *purchases.Listing) { l.Totals.ScrapKg = "5.000" },
		"pending_kg_unpadded":           func(l *purchases.Listing) { l.Totals.ScrapKg = "6.00" },
		"pending_kg_negative_zero":      func(l *purchases.Listing) { l.Totals.ScrapKg = "-0.000" },
		"window_unpadded_money": func(l *purchases.Listing) {
			l.Period, l.Balance = l.Periods[2], nil
			l.Totals = purchases.Totals{Money: "1.0", UsedUnits: 1, ScrapKg: "0.000"}
		},
		"balance_under_window": func(l *purchases.Listing) {
			l.Period = l.Periods[2]
		},
		"used_negative": func(l *purchases.Listing) {
			l.Balance.Used[0].Bought, l.Balance.Used[0].Balance = -1, -3
		},
		"used_lied": func(l *purchases.Listing) { l.Balance.Used[0].Balance = 0 },
		"used_order": func(l *purchases.Listing) {
			l.Balance.Used = append([]purchases.BalanceUsed{{Model: "ZZ", Bought: 1}}, l.Balance.Used...)
		},
		"used_zero_row": func(l *purchases.Listing) {
			l.Balance.Used[0] = purchases.BalanceUsed{Model: "NS60ZL"}
		},
		"scrap_negative_bought": func(l *purchases.Listing) { l.Balance.Scrap[0].Bought = "-1.000" },
		"scrap_unpadded":        func(l *purchases.Listing) { l.Balance.Scrap[0].Balance = "6.00" },
		"scrap_lied":            func(l *purchases.Listing) { l.Balance.Scrap[0].Balance = "5.000" },
		"scrap_negative_zero": func(l *purchases.Listing) {
			l.Balance.Scrap[0].Bought = "0.000"
			l.Balance.Scrap[0].Balance = "-0.000"
		},
		"scrap_order": func(l *purchases.Listing) {
			l.Balance.Scrap = append([]purchases.BalanceScrap{{MaterialID: 2, Bought: "1.000",
				Delivered: "0.000", Balance: "1.000"}}, l.Balance.Scrap...)
		},
		"scrap_material_out": func(l *purchases.Listing) { l.Balance.Scrap[0].MaterialID = 0 },
	}
	for name, transform := range broken {
		brokenListing := listing
		brokenListing.Periods = append([]purchases.Period(nil), periods...)
		brokenListing.Period = periods[0]
		brokenListing.Totals = purchases.Totals{UsedUnits: 1, ScrapKg: "6.000"}
		brokenBalance := *balance
		brokenBalance.Used = append([]purchases.BalanceUsed(nil), balance.Used...)
		brokenBalance.Scrap = append([]purchases.BalanceScrap(nil), balance.Scrap...)
		brokenListing.Balance = &brokenBalance
		transform(&brokenListing)
		if _, err := purchaseListingRecord(brokenListing); !errors.Is(err, purchases.ErrUnavailable) {
			t.Errorf("a %s listing must fail closed, got %v", name, err)
		}
	}
}

// TestPurchaseHTTPPeriods proves the listing on the wire: the selector, the chosen period and the
// balance, with the documents filtered by the period's window and the balance derived only from
// the closed settlements.
func TestPurchaseHTTPPeriods(t *testing.T) {
	f := purchaseFixture(t)
	decode := func(w *httptest.ResponseRecorder) (map[string]json.RawMessage, purchaseListingWire) {
		t.Helper()
		var body map[string]json.RawMessage
		var wire purchaseListingWire
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &body) != nil ||
			json.Unmarshal(w.Body.Bytes(), &wire) != nil {
			t.Fatalf("the listing answer is not JSON: %d %s", w.Code, w.Body.String())
		}
		if len(body) != 8 {
			t.Fatalf("the listing answer has %d keys, want 8: %s", len(body), w.Body.String())
		}
		for _, key := range []string{"page", "page_size", "total_purchases", "purchases",
			"periods", "period", "totals", "balance"} {
			if _, ok := body[key]; !ok {
				t.Fatalf("the listing answer is missing %q: %s", key, w.Body.String())
			}
		}
		return body, wire
	}
	// Every period entry is exactly the five published keys, whatever its kind.
	periodKeys := func(t *testing.T, raw map[string]json.RawMessage) {
		t.Helper()
		var entries []map[string]json.RawMessage
		if json.Unmarshal(raw["periods"], &entries) != nil || len(entries) == 0 {
			t.Fatalf("the selector is not an array: %s", raw["periods"])
		}
		for _, entry := range entries {
			if len(entry) != 5 {
				t.Fatalf("a period entry is not the frozen shape: %v", entry)
			}
			for _, key := range []string{"kind", "closing_id", "from", "to", "label"} {
				if _, ok := entry[key]; !ok {
					t.Fatalf("a period entry is missing %q: %v", key, entry)
				}
			}
		}
		var chosen map[string]json.RawMessage
		if json.Unmarshal(raw["period"], &chosen) != nil || len(chosen) != 5 {
			t.Fatalf("the chosen period is not the frozen shape: %s", raw["period"])
		}
	}

	// The totals of a period are exactly the three published keys, whatever the period.
	totalsKeys := func(t *testing.T, raw map[string]json.RawMessage) map[string]json.RawMessage {
		t.Helper()
		var totals map[string]json.RawMessage
		if json.Unmarshal(raw["totals"], &totals) != nil || len(totals) != 3 {
			t.Fatalf("the totals are not the frozen shape: %s", raw["totals"])
		}
		for _, key := range []string{"money", "used_units", "scrap_kg"} {
			if _, ok := totals[key]; !ok {
				t.Fatalf("the totals are missing %q: %v", key, totals)
			}
		}
		return totals
	}

	// An empty branch publishes its two periods, an empty balance and no documents.
	body, wire := decode(f.serve(t, f.request(2, "GET", "/api/purchases?period=pending", "")))
	periodKeys(t, body)
	if len(wire.Periods) != 2 || wire.Periods[0].Kind != "pending" || wire.Periods[0].Label != "Pendiente" ||
		wire.Periods[0].ClosingID != nil || wire.Periods[0].From != nil || wire.Periods[0].To != nil ||
		wire.Periods[1].Kind != "all" || wire.Periods[1].Label != "Todo el historial" ||
		wire.Period.Kind != "pending" || wire.TotalPurchases != 0 {
		t.Fatalf("an empty branch must publish its two periods: %s", body)
	}
	if wire.Balance == nil || len(wire.Balance.Used) != 0 || len(wire.Balance.Scrap) != 0 {
		t.Fatalf("an empty balance must be an empty reading: %s", body["balance"])
	}
	// An empty branch states three zeros and no money: the pending period is a balance, not a window.
	totals := totalsKeys(t, body)
	if string(totals["money"]) != "null" || string(totals["used_units"]) != `"0"` ||
		string(totals["scrap_kg"]) != `"0.000"` {
		t.Fatalf("an empty branch must state three zeros: %s", body["totals"])
	}
	// The query without a period is the whole history, exactly as before periods existed.
	beforeBody, before := decode(f.serve(t, f.request(2, "GET", "/api/purchases", "")))
	periodKeys(t, beforeBody)
	if before.Period.Kind != "all" || before.Balance != nil {
		t.Fatalf("a query without a period must read the whole history: %s", beforeBody)
	}
	// The whole history of an empty branch is a window, so it states a canonical amount and never a
	// null one.
	if before.Totals.Money == nil || *before.Totals.Money != "0.00" || before.Totals.UsedUnits != "0" ||
		before.Totals.ScrapKg != "0.000" {
		t.Fatalf("an empty window must state three zeros: %s", beforeBody["totals"])
	}

	// The first settlement of a branch opens with a window of its own, so it takes nothing and
	// the period that follows starts with the purchase below (S5).
	firstClosed := f.closeSettlement(t, nil)
	// The period buys one battery and twelve kilos of copper.
	first := purchaseDocumentWire(t, f.serve(t, f.request(2, "POST", "/api/purchases", validPurchaseJSON)), 201)
	body, wire = decode(f.serve(t, f.request(2, "GET", "/api/purchases?period=pending", "")))
	if wire.TotalPurchases != 1 || len(wire.Purchases) != 1 ||
		string(body["balance"]) == "null" || len(wire.Balance.Used) != 1 ||
		wire.Balance.Used[0].Model != "NS60ZL" || wire.Balance.Used[0].Bought != "1" ||
		wire.Balance.Used[0].Delivered != "0" || wire.Balance.Used[0].Balance != "1" ||
		len(wire.Balance.Scrap) != 1 || wire.Balance.Scrap[0].Bought != "12.400" ||
		wire.Balance.Scrap[0].Delivered != "0.000" || wire.Balance.Scrap[0].Balance != "12.400" {
		t.Fatalf("the pending balance must be what the branch bought: %s", body)
	}
	// A settlement that counted everything takes it to the warehouse: the balance reads zero and
	// the documents stay listed.
	closedID := f.closeSettlement(t, []closings.MaterialCounted{
		{Kind: closings.MaterialKindUsed, Model: "NS60ZL", Quantity: "1"},
		{Kind: closings.MaterialKindScrap, MaterialID: 1, Quantity: "12.400"},
	})
	body, wire = decode(f.serve(t, f.request(2, "GET", "/api/purchases?period=pending", "")))
	if wire.TotalPurchases != 1 || wire.Balance == nil || len(wire.Balance.Used) != 1 ||
		wire.Balance.Used[0].Delivered != "1" || wire.Balance.Used[0].Balance != "0" ||
		wire.Balance.Scrap[0].Balance != "0.000" {
		t.Fatalf("a settlement that counted everything must read zero: %s", body)
	}

	// The branch buys again after the closure, and the settlement period keeps its own documents.
	after := purchaseDocumentWire(t, f.serve(t, f.request(2, "POST", "/api/purchases",
		`{"operation_key":"http-purchase-key-periods","used_lines":[{"model":"NS60ZL","quantity":2,"unit_price":"10000.00"}],"scrap_lines":[{"material_id":1,"kg":"3.000","price_per_kg":"1000.00"}],"paid_cash":"23000.00","paid_transfer":"0.00"}`)), 201)
	body, wire = decode(f.serve(t, f.request(2, "GET", "/api/purchases?period=pending", "")))
	if wire.TotalPurchases != 2 || len(wire.Purchases) != 2 ||
		wire.Balance.Used[0].Bought != "3" || wire.Balance.Used[0].Delivered != "1" ||
		wire.Balance.Used[0].Balance != "2" || wire.Balance.Scrap[0].Bought != "15.400" ||
		wire.Balance.Scrap[0].Delivered != "12.400" || wire.Balance.Scrap[0].Balance != "3.000" {
		t.Fatalf("a purchase after the closure must raise the balance again: %s", body)
	}
	// The pending header states the balance and no money: one window's money is not a position.
	if wire.Totals.Money != nil || wire.Totals.UsedUnits != "2" || wire.Totals.ScrapKg != "3.000" {
		t.Fatalf("the pending totals must be the balance: %s", body["totals"])
	}
	body, wire = decode(f.serve(t, f.request(2, "GET",
		"/api/purchases?period="+strconv.FormatInt(closedID, 10), "")))
	periodKeys(t, body)
	if wire.Period.Kind != "settlement" || wire.Period.ClosingID == nil ||
		*wire.Period.ClosingID != closedID || wire.Period.From == nil || wire.Period.To == nil ||
		wire.Balance != nil || string(body["balance"]) != "null" {
		t.Fatalf("a closed settlement must publish its window and no balance: %s", body)
	}
	if _, err := time.Parse(time.RFC3339, *wire.Period.From); err != nil {
		t.Fatalf("from is not an RFC3339 instant: %q", *wire.Period.From)
	}
	if len(wire.Periods) != 4 || wire.Periods[1].Kind != "settlement" ||
		wire.Periods[1].Label != "Rendición #"+strconv.FormatInt(closedID, 10) ||
		wire.Periods[2].Label != "Rendición #"+strconv.FormatInt(firstClosed, 10) {
		t.Fatalf("the closed settlement must be its own period: %s", body["periods"])
	}
	if wire.TotalPurchases != 1 || len(wire.Purchases) != 1 ||
		jsonNumber(t, wire.Purchases[0]["id"]) != first.ID {
		t.Fatalf("a closed period must list only its own documents: %s", body["purchases"])
	}
	// The closed period states its own window and never the accumulated history: the document it
	// contains is one battery at 25000.00 and 12.400 kilos of copper at 8000.00.
	if wire.Totals.Money == nil || *wire.Totals.Money != "124200.00" ||
		wire.Totals.UsedUnits != "1" || wire.Totals.ScrapKg != "12.400" {
		t.Fatalf("a closed period must state its own totals: %s", body["totals"])
	}
	// The whole history states every document, and it is exactly what the received route publishes for
	// the same history: the two routes can never disagree about the same documents.
	body, wire = decode(f.serve(t, f.request(2, "GET", "/api/purchases?period=all", "")))
	if wire.Period.Kind != "all" || wire.Balance != nil || wire.TotalPurchases != 2 ||
		len(wire.Purchases) != 2 || jsonNumber(t, wire.Purchases[0]["id"]) != after.ID {
		t.Fatalf("the whole history must list every document: %s", body)
	}
	var received struct {
		Used []struct {
			Quantity int64  `json:"quantity"`
			Value    string `json:"value"`
		} `json:"used"`
		Scrap []struct {
			Kg    string `json:"kg"`
			Value string `json:"value"`
		} `json:"scrap"`
	}
	reply := f.serve(t, f.request(2, "GET", "/api/purchases/received", ""))
	if reply.Code != 200 || json.Unmarshal(reply.Body.Bytes(), &received) != nil {
		t.Fatalf("the received route must stay readable: %d %s", reply.Code, reply.Body.String())
	}
	wantCents, wantUnits := int64(0), int64(0)
	for _, row := range received.Used {
		wantCents += centsOfWire(t, row.Value)
		wantUnits += row.Quantity
	}
	wantMilli := int64(0)
	for _, row := range received.Scrap {
		wantCents += centsOfWire(t, row.Value)
		wantMilli += milliOfWire(t, row.Kg)
	}
	if wire.Totals.Money == nil || centsOfWire(t, *wire.Totals.Money) != wantCents ||
		wire.Totals.UsedUnits != strconv.FormatInt(wantUnits, 10) || milliOfWire(t, wire.Totals.ScrapKg) != wantMilli {
		t.Fatalf("the whole history must agree with the received route: %s %s", body["totals"], reply.Body.String())
	}
	if wantUnits != 3 || wantMilli != 15400 || wantCents != 14_720_000 {
		t.Fatalf("the published history is not the one the fixture wrote: %d %d %d",
			wantUnits, wantMilli, wantCents)
	}

	// The live settlement is a period the selector publishes, and the client opens it by its
	// closing id: it lists the documents of its own window and never a balance.
	live := f.openSettlement(t, nil)
	body, wire = decode(f.serve(t, f.request(2, "GET", "/api/purchases?period="+strconv.FormatInt(live, 10), "")))
	if wire.Period.Kind != "open" || wire.Period.ClosingID == nil || *wire.Period.ClosingID != live ||
		wire.Period.Label != "En curso" || wire.Balance != nil || len(wire.Periods) != 5 {
		t.Fatalf("the period in progress must be selectable by its closing id: %s", body)
	}
	if wire.TotalPurchases != 1 || len(wire.Purchases) != 1 ||
		jsonNumber(t, wire.Purchases[0]["id"]) != after.ID {
		t.Fatalf("the period in progress must list the documents of its window: %s", body["purchases"])
	}

	// A period this branch does not have is an invalid request, never an empty list.
	for _, period := range []string{"0", "-1", "07", "abc", "open", "settlement", "999999",
		strconv.FormatInt(closedID, 10) + "0"} {
		f.rejected(t, f.request(2, "GET", "/api/purchases?period="+period, ""), 400, "invalid_request")
	}
	f.rejected(t, f.request(2, "GET", "/api/purchases?period=", ""), 400, "invalid_request")
	f.rejected(t, f.request(2, "GET", "/api/purchases?period=1&period=1", ""), 400, "invalid_request")
}

// centsOfWire reads one published amount as integer cents.
func centsOfWire(t *testing.T, text string) int64 {
	t.Helper()
	negative := strings.HasPrefix(text, "-")
	whole, fraction, ok := strings.Cut(strings.TrimPrefix(text, "-"), ".")
	if !ok || len(fraction) != 2 {
		t.Fatalf("a published amount is not canonical: %q", text)
	}
	value, err := strconv.ParseInt(whole+fraction, 10, 64)
	if err != nil {
		t.Fatalf("a published amount is not a number: %q", text)
	}
	if negative {
		value = -value
	}
	return value
}

// milliOfWire reads one published weight as integer thousandths.
func milliOfWire(t *testing.T, text string) int64 {
	t.Helper()
	negative := strings.HasPrefix(text, "-")
	whole, fraction, ok := strings.Cut(strings.TrimPrefix(text, "-"), ".")
	if !ok || len(fraction) != 3 {
		t.Fatalf("a published weight is not canonical: %q", text)
	}
	value, err := strconv.ParseInt(whole+fraction, 10, 64)
	if err != nil {
		t.Fatalf("a published weight is not a number: %q", text)
	}
	if negative {
		value = -value
	}
	return value
}

// jsonNumber reads one integer of a decoded answer.
func jsonNumber(t *testing.T, raw any) int64 {
	t.Helper()
	number, ok := raw.(float64)
	if !ok || number != math.Trunc(number) {
		t.Fatalf("a published number is not an integer: %v", raw)
	}
	return int64(number)
}
