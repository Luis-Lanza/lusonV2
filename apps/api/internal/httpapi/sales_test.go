package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
	"luson/api/internal/bootstrap"
	"luson/api/internal/catalog"
	"luson/api/internal/config"
	"luson/api/internal/inventory"
	"luson/api/internal/pricing"
	"luson/api/internal/sales"
	"luson/api/internal/stockadjustments"
	"luson/api/internal/stockentries"
	"luson/api/internal/testpg"
	"luson/api/internal/transfers"
)

// saleSerialSeq numbers every fixture serial: one physical battery is sold once per
// installation, and one test database is one installation.
var saleSerialSeq atomic.Int64

// saleUnitsJSON renders the units of one fixture line: one unit per sold piece, each with
// its own serial and the stated term. A zero term is the explicit absence of warranty, which
// the wire carries as JSON null and never as zero.
func saleUnitsJSON(quantity int64, warrantyMonths int) string {
	units := make([]string, 0, quantity)
	for i := int64(0); i < quantity; i++ {
		term := strconv.Itoa(warrantyMonths)
		if warrantyMonths == 0 {
			term = "null"
		}
		units = append(units, fmt.Sprintf(`{"serial_number":%q,"warranty_months":%s}`,
			fmt.Sprintf("SN-%d", saleSerialSeq.Add(1)), term))
	}
	return "[" + strings.Join(units, ",") + "]"
}

// saleBody is one admitted sale body: how the total was settled, the client of the
// warranty and one line with the price the counter charges and one unit per sold piece.
// The cash payment pays exactly the total of the line, so the fixture body is a document
// that closes; a body whose price is deliberately not canonical keeps a canonical amount,
// because the refusal being pinned there is the price's and not the settlement's.
func saleBody(variantID, quantity int64, unit string, warrantyMonths int) string {
	amount := "0.00"
	if total, err := sales.LineTotal(sales.Money(unit), quantity); err == nil {
		amount = string(total)
	}
	return fmt.Sprintf(`{"payments":[{"method":"cash","amount":%q}],`+
		`"customer":{"name":"Cliente Mostrador","phone":"700-00000","document":"V-123","address":"Av. Colón 1234"},`+
		`"lines":[{"variant_id":%d,"quantity":%d,"unit_price":%q,"units":%s}]}`,
		amount, variantID, quantity, unit, saleUnitsJSON(quantity, warrantyMonths))
}

const validSaleJSON = `{"payments":[{"method":"card","amount":"192000.00"}],"customer":{"name":"Ana Pérez","phone":"700-00000","document":"V-123","address":"Barrio Norte"},"lines":[{"variant_id":1,"quantity":2,"unit_price":"96000.00","units":[{"serial_number":"ABC123","warranty_months":6},{"serial_number":"ABC124","warranty_months":null}]}]}`

func TestSaleDecoder(t *testing.T) {
	replace := func(old, value string) string { return strings.Replace(validSaleJSON, old, value, 1) }
	t.Run("valid", func(t *testing.T) {
		for _, body := range []string{
			validSaleJSON,
			" \n" + validSaleJSON + " \n",
			`{"payments":[{"method":"cash","amount":"1.00"}],"customer":{"name":"C","phone":"","document":"","address":""},"lines":[{"variant_id":1,"quantity":1,"unit_price":"1.00","units":[{"serial_number":"A1","warranty_months":1}]}]}`,
			`{"payments":[{"method":"transfer","amount":"85000.00"}],"customer":{"document":"V-1","name":"C","phone":"7","address":""},"lines":[{"units":[{"warranty_months":120,"serial_number":"A2"}],"unit_price":"85000.00","quantity":1,"variant_id":1}]}`,
			// The term may be the explicit absence of warranty: JSON null, never absent and
			// never zero.
			`{"payments":[{"method":"cash","amount":"1.00"}],"customer":{"name":"C","phone":"","document":"","address":""},"lines":[{"variant_id":1,"quantity":1,"unit_price":"1.00","units":[{"serial_number":"A3","warranty_months":null}]}]}`,
			`{"lines":[{"variant_id":1,"quantity":1,"unit_price":"1.00","units":[{"serial_number":"A4","warranty_months":6}]}],"customer":{"name":"C","phone":"","document":"","address":""},"payments":[{"amount":"1.00","method":"cash"}]}`,
			// One document settled with two methods, stated in either order: the shape is
			// admitted here and the store decides whether the amounts close.
			`{"payments":[{"method":"cash","amount":"40000.00"},{"method":"transfer","amount":"56000.00"}],"customer":{"name":"C","phone":"","document":"","address":""},"lines":[{"variant_id":1,"quantity":1,"unit_price":"96000.00","units":[{"serial_number":"A5","warranty_months":6}]}]}`,
			`{"payments":[{"method":"transfer","amount":"56000.00"},{"method":"cash","amount":"40000.00"}],"customer":{"name":"C","phone":"","document":"","address":""},"lines":[{"variant_id":1,"quantity":1,"unit_price":"96000.00","units":[{"serial_number":"A6","warranty_months":6}]}]}`,
			// The four admitted methods, each paying once, is the widest settlement: QR is the
			// fourth payment of a sale, so the decode admits the whole range.
			`{"payments":[{"method":"cash","amount":"24000.00"},{"method":"card","amount":"24000.00"},{"method":"transfer","amount":"24000.00"},{"method":"qr","amount":"24000.00"}],"customer":{"name":"C","phone":"","document":"","address":""},"lines":[{"variant_id":1,"quantity":1,"unit_price":"96000.00","units":[{"serial_number":"A7","warranty_months":6}]}]}`,
			// The settlement may be stated in any order: the frozen one is the store's.
			`{"payments":[{"method":"qr","amount":"24000.00"},{"method":"transfer","amount":"24000.00"},{"method":"card","amount":"24000.00"},{"method":"cash","amount":"24000.00"}],"customer":{"name":"C","phone":"","document":"","address":""},"lines":[{"variant_id":1,"quantity":1,"unit_price":"96000.00","units":[{"serial_number":"A8","warranty_months":6}]}]}`,
			// The two admitted polarities of one battery are two lines of one document,
			// each with the units the seller registers for it.
			`{"payments":[{"method":"cash","amount":"351000.50"}],"customer":{"name":"C","phone":"","document":"","address":""},"lines":[` +
				`{"variant_id":2,"quantity":1,"unit_price":"96000.00","units":[{"serial_number":"A8","warranty_months":6}]},` +
				`{"variant_id":1,"quantity":3,"unit_price":"85000.50","units":[{"serial_number":"A9","warranty_months":12},{"serial_number":"A10","warranty_months":null},{"serial_number":"A11","warranty_months":120}]}]}`,
		} {
			r := httptest.NewRequest("POST", "/api/sales", strings.NewReader(body))
			r.Header.Set("Content-Type", "application/json; charset=UTF-8")
			got, err := decodeSale(r)
			if err != nil || len(got.Lines) == 0 || got.Customer.Name == "" || len(got.Payments) == 0 {
				t.Fatalf("valid framing rejected: %v", err)
			}
			for _, payment := range got.Payments {
				if !payment.Method.Valid() {
					t.Fatalf("an admitted payment must name one real method: %+v", payment)
				}
			}
			for _, line := range got.Lines {
				if int64(len(line.Units)) != line.Quantity {
					t.Fatalf("an admitted line must carry one unit per sold piece: %+v", line)
				}
			}
		}
	})
	// A full-width document is admitted: the body limit exists because a sale admits
	// MaxLines lines.
	lines := make([]string, 0, sales.MaxLines)
	for i := 0; i < sales.MaxLines; i++ {
		lines = append(lines, fmt.Sprintf(`{"variant_id":%d,"quantity":1,"unit_price":"1.00","units":[{"serial_number":"FULL-%d","warranty_months":6}]}`, i+1, i))
	}
	full := `{"payments":[{"method":"cash","amount":"190.00"}],"customer":{"name":"C","phone":"","document":"","address":""},"lines":[` +
		strings.Join(lines, ",") + `]}`
	r := httptest.NewRequest("POST", "/api/sales", strings.NewReader(full))
	r.Header.Set("Content-Type", "application/json")
	if got, err := decodeSale(r); err != nil || len(got.Lines) != sales.MaxLines {
		t.Fatalf("a full-width sale must be admitted: %v", err)
	}
	// The widest sale is one line of one thousand batteries, each with the longest admitted
	// serial in the widest admitted encoding: sixty-four characters of four-byte UTF-8, so
	// the document is the largest one the contract can ask for and the limit must hold it.
	// An ASCII serial would measure a quarter of that and prove nothing about the bound.
	widest := make([]string, 0, sales.MaxUnits)
	for i := 0; i < sales.MaxUnits; i++ {
		widest = append(widest, fmt.Sprintf(`{"serial_number":%q,"warranty_months":120}`,
			fmt.Sprintf("%s-%03d", strings.Repeat("\U0001F600", sales.MaxSerialLength-4), i)))
	}
	wide := fmt.Sprintf(`{"payments":[{"method":"cash","amount":"1000.00"}],`+
		`"customer":{"name":"C","phone":"","document":"","address":""},`+
		`"lines":[{"variant_id":1,"quantity":%d,"unit_price":"1.00","units":[%s]}]}`,
		sales.MaxUnits, strings.Join(widest, ","))
	if len(wide) <= 64<<10 {
		t.Fatalf("the widest admitted sale must exceed the old 64 KiB limit, got %d bytes", len(wide))
	}
	if len(wide) > saleBodyLimit {
		t.Fatalf("the widest admitted sale must fit the new body limit, got %d bytes", len(wide))
	}
	r = httptest.NewRequest("POST", "/api/sales", strings.NewReader(wide))
	r.Header.Set("Content-Type", "application/json")
	if got, err := decodeSale(r); err != nil || len(got.Lines) != 1 || len(got.Lines[0].Units) != sales.MaxUnits {
		t.Fatalf("the widest admitted sale must be decoded: %v", err)
	}
	invalid := map[string]string{
		"empty_object":     `{}`,
		"array_root":       `[]`,
		"null_root":        `null`,
		"truncated":        validSaleJSON[:len(validSaleJSON)-1],
		"trailing":         validSaleJSON + `{}`,
		"trailing_scalar":  validSaleJSON + `true`,
		"oversized":        validSaleJSON + strings.Repeat(" ", saleBodyLimit),
		"unknown_key":      replace(`"payments":`, `"actor_id":2,"payments":`),
		"location_key":     replace(`"payments":`, `"branch_location_id":2,"payments":`),
		"warranty_key":     replace(`"payments":`, `"warranty_months":6,"payments":`),
		"total_key":        replace(`"payments":`, `"total":"1.00","payments":`),
		"method_key":       replace(`"payments":`, `"payment_method":"cash","payments":`),
		"casefold":         replace(`"payments":`, `"Payments":`),
		"duplicate":        replace(`"payments":`, `"payments":[{"method":"cash","amount":"1.00"}],"payments":`),
		"escaped_dup":      replace(`"payments":`, `"\u0070ayments":[{"method":"cash","amount":"1.00"}],"payments":`),
		"missing_payments": replace(`"payments":[{"method":"card","amount":"192000.00"}],`, ``),
		"missing_customer": replace(`"customer":{"name":"Ana Pérez","phone":"700-00000","document":"V-123","address":"Barrio Norte"},`, ``),
		"missing_lines":    replace(`,"lines":[{"variant_id":1,"quantity":2,"unit_price":"96000.00","units":[{"serial_number":"ABC123","warranty_months":6},{"serial_number":"ABC124","warranty_months":null}]}]`, ``),
		// The settlement itself is exact: at most one payment per admitted method, each method
		// once, and the amounts canonical two-decimal text. A fifth payment is refused because
		// there is no fifth method to pay with, which is the real bound of the shape.
		"payments_null":          replace(`[{"method":"card","amount":"192000.00"}]`, `null`),
		"payments_not_array":     replace(`[{"method":"card","amount":"192000.00"}]`, `{"method":"card","amount":"192000.00"}`),
		"payments_empty":         replace(`[{"method":"card","amount":"192000.00"}]`, `[]`),
		"payments_five":          replace(`[{"method":"card","amount":"192000.00"}]`, `[{"method":"cash","amount":"1.00"},{"method":"card","amount":"1.00"},{"method":"transfer","amount":"1.00"},{"method":"qr","amount":"1.00"},{"method":"cash","amount":"1.00"}]`),
		"payment_null":           replace(`{"method":"card","amount":"192000.00"}`, `null`),
		"payment_not_object":     replace(`{"method":"card","amount":"192000.00"}`, `[]`),
		"payment_unknown":        replace(`"method":"card"`, `"method":"card","change":"0.00"`),
		"payment_duplicate":      replace(`"amount":"192000.00"`, `"amount":"192000.00","amount":"192000.00"`),
		"payment_missing":        replace(`,"amount":"192000.00"`, ``),
		"payment_no_method":      replace(`{"method":"card","amount":"192000.00"}`, `{"amount":"192000.00"}`),
		"payment_repeated":       replace(`[{"method":"card","amount":"192000.00"}]`, `[{"method":"cash","amount":"100000.00"},{"method":"cash","amount":"92000.00"}]`),
		"unknown_method":         replace(`"card"`, `"cheque"`),
		"empty_method":           replace(`"card"`, `""`),
		"method_case":            replace(`"card"`, `"CARD"`),
		"numeric_method":         replace(`"card"`, `2`),
		"mixed_input":            replace(`"card"`, `"mixed"`),
		"payment_amount_numeric": replace(`"192000.00"`, `192000`),
		"payment_amount_null":    replace(`"192000.00"`, `null`),
		"payment_no_fraction":    replace(`"192000.00"`, `"192000"`),
		"payment_one_decimal":    replace(`"192000.00"`, `"192000.5"`),
		"payment_three_decimal":  replace(`"192000.00"`, `"192000.001"`),
		"payment_padded":         replace(`"192000.00"`, `"0192000.00"`),
		"payment_negative":       replace(`"192000.00"`, `"-192000.00"`),
		"payment_comma":          replace(`"192000.00"`, `"192000,00"`),
		"payment_exponent":       replace(`"192000.00"`, `"1.92e5"`),
		"null_customer":          replace(`{"name":"Ana Pérez","phone":"700-00000","document":"V-123","address":"Barrio Norte"}`, `null`),
		"array_customer":         replace(`{"name":"Ana Pérez","phone":"700-00000","document":"V-123","address":"Barrio Norte"}`, `[]`),
		// S1: the client carries exactly four keys, so the address is mandatory in the wire
		// shape even when it is empty, and an unknown fifth key is refused.
		"customer_no_address":      replace(`,"address":"Barrio Norte"`, ``),
		"customer_address_unknown": replace(`"address":"Barrio Norte"`, `"address":"Barrio Norte","neighbourhood":"Norte"`),
		"customer_address_numeric": replace(`"address":"Barrio Norte"`, `"address":7`),
		"customer_unknown":         replace(`"phone":"700-00000"`, `"email":"a@b.c","phone":"700-00000"`),
		"customer_dup":             replace(`"phone":`, `"name":"Otra","phone":`),
		"customer_esc_dup":         replace(`"phone":`, `"\u006eame":"Otra","phone":`),
		"customer_missing":         replace(`,"document":"V-123"`, ``),
		"customer_numeric":         replace(`"Ana Pérez"`, `7`),
		"null_lines":               replace(`[{"variant_id":1,"quantity":2,"unit_price":"96000.00","units":[{"serial_number":"ABC123","warranty_months":6},{"serial_number":"ABC124","warranty_months":null}]}]`, `null`),
		"empty_lines":              replace(`[{"variant_id":1,"quantity":2,"unit_price":"96000.00","units":[{"serial_number":"ABC123","warranty_months":6},{"serial_number":"ABC124","warranty_months":null}]}]`, `[]`),
		"line_root":                replace(`[{"variant_id":1,"quantity":2,"unit_price":"96000.00","units":[{"serial_number":"ABC123","warranty_months":6},{"serial_number":"ABC124","warranty_months":null}]}]`, `[[]]`),
		"line_unknown":             replace(`"quantity":2`, `"min_price":"1.00","quantity":2`),
		"line_duplicate":           replace(`"quantity":`, `"variant_id":1,"quantity":`),
		"line_missing":             replace(`,"units":[{"serial_number":"ABC123","warranty_months":6},{"serial_number":"ABC124","warranty_months":null}]`, ``),
		"line_empty_obj":           replace(`{"variant_id":1,"quantity":2,"unit_price":"96000.00","units":[{"serial_number":"ABC123","warranty_months":6},{"serial_number":"ABC124","warranty_months":null}]}`, `{}`),
		"zero_variant":             replace(`"variant_id":1`, `"variant_id":0`),
		"padded_variant":           replace(`"variant_id":1`, `"variant_id":01`),
		"negative_variant":         replace(`"variant_id":1`, `"variant_id":-1`),
		"variant_bound":            replace(`"variant_id":1`, `"variant_id":2147483648`),
		"string_variant":           replace(`"variant_id":1`, `"variant_id":"1"`),
		"float_variant":            replace(`"variant_id":1`, `"variant_id":1.0`),
		"zero_quantity":            replace(`"quantity":2`, `"quantity":0`),
		"negative_qty":             replace(`"quantity":2`, `"quantity":-2`),
		"quantity_bound":           replace(`"quantity":2`, fmt.Sprintf(`"quantity":%d`, sales.MaxQuantity+1)),
		"string_quantity":          replace(`"quantity":2`, `"quantity":"2"`),
		// The money of this contract is canonical two-decimal text: a JSON number, a
		// missing fraction, three decimals and a zero amount are all refusals.
		"numeric_price":  replace(`"96000.00"`, `96000`),
		"null_price":     replace(`"unit_price":"96000.00"`, `"unit_price":null`),
		"empty_price":    replace(`"96000.00"`, `""`),
		"no_fraction":    replace(`"96000.00"`, `"96000"`),
		"one_decimal":    replace(`"96000.00"`, `"96000.5"`),
		"three_decimals": replace(`"96000.00"`, `"96000.001"`),
		"exponent_price": replace(`"96000.00"`, `"9.6e4"`),
		"negative_price": replace(`"96000.00"`, `"-96000.00"`),
		"zero_price":     replace(`"96000.00"`, `"0.00"`),
		"padded_price":   replace(`"96000.00"`, `"096000.00"`),
		"comma_price":    replace(`"96000.00"`, `"96000,00"`),
		"missing_price":  replace(`,"unit_price":"96000.00"`, ``),
		// The term of a unit is a canonical integer 1..120 or JSON null: never zero, never
		// absent and never a string or a float.
		"zero_warranty":     replace(`"warranty_months":6`, `"warranty_months":0`),
		"negative_warranty": replace(`"warranty_months":6`, `"warranty_months":-6`),
		"warranty_bound":    replace(`"warranty_months":6`, fmt.Sprintf(`"warranty_months":%d`, sales.MaxWarrantyMonths+1)),
		"string_warranty":   replace(`"warranty_months":6`, `"warranty_months":"6"`),
		"float_warranty":    replace(`"warranty_months":6`, `"warranty_months":6.0`),
		"padded_warranty":   replace(`"warranty_months":6`, `"warranty_months":06`),
		"warranty_absent":   replace(`,"warranty_months":6`, ``),
		"warranty_true":     replace(`"warranty_months":6`, `"warranty_months":true`),
		// The unit itself is exactly serial_number and warranty_months.
		"units_null":     replace(`"units":[{"serial_number":"ABC123","warranty_months":6},{"serial_number":"ABC124","warranty_months":null}]`, `"units":null`),
		"units_object":   replace(`"units":[{"serial_number":"ABC123","warranty_months":6},{"serial_number":"ABC124","warranty_months":null}]`, `"units":{}`),
		"units_empty":    replace(`"units":[{"serial_number":"ABC123","warranty_months":6},{"serial_number":"ABC124","warranty_months":null}]`, `"units":[]`),
		"unit_root":      replace(`"units":[{"serial_number":"ABC123","warranty_months":6},{"serial_number":"ABC124","warranty_months":null}]`, `"units":[[]]`),
		"unit_unknown":   replace(`"serial_number":"ABC123"`, `"serial_number":"ABC123","brand":"CAR"`),
		"unit_duplicate": replace(`"serial_number":"ABC124"`, `"serial_number":"ABC124","serial_number":"ABC125"`),
		"unit_empty":     replace(`{"serial_number":"ABC123","warranty_months":6}`, `{}`),
		"serial_missing": replace(`"serial_number":"ABC124",`, ``),
		"serial_null":    replace(`"serial_number":"ABC124"`, `"serial_number":null`),
		"serial_numeric": replace(`"serial_number":"ABC124"`, `"serial_number":124`),
		"invalid_utf8":   replace("Ana Pérez", "Ana P\xe9rez"),
		"repeated_variant": `{"payments":[{"method":"cash","amount":"2.00"}],"customer":{"name":"C","phone":"","document":"","address":""},"lines":[` +
			`{"variant_id":1,"quantity":1,"unit_price":"1.00","units":[{"serial_number":"R1","warranty_months":6}]},` +
			`{"variant_id":1,"quantity":1,"unit_price":"1.00","units":[{"serial_number":"R2","warranty_months":6}]}]}`,
		"too_many_lines": `{"payments":[{"method":"cash","amount":"191.00"}],"customer":{"name":"C","phone":"","document":"","address":""},"lines":[` +
			strings.Join(append(append([]string{}, lines...), `{"variant_id":191,"quantity":1,"unit_price":"1.00","units":[{"serial_number":"R191","warranty_months":6}]}`), ",") + `]}`,
		// D6: one sale carries at most one thousand units, so the decode refuses the next
		// one before any store work.
		"too_many_units": func() string {
			batteries := make([]string, 0, sales.MaxUnits+1)
			for i := 0; i <= sales.MaxUnits; i++ {
				batteries = append(batteries, fmt.Sprintf(`{"serial_number":"W-%d","warranty_months":null}`, i))
			}
			return fmt.Sprintf(`{"payments":[{"method":"cash","amount":"1001.00"}],`+
				`"customer":{"name":"C","phone":"","document":"","address":""},`+
				`"lines":[{"variant_id":1,"quantity":%d,"unit_price":"1.00","units":[%s]}]}`,
				sales.MaxUnits+1, strings.Join(batteries, ","))
		}(),
	}
	for name, body := range invalid {
		t.Run(name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "/api/sales", strings.NewReader(body))
			r.Header.Set("Content-Type", "application/json")
			if _, err := decodeSale(r); !errors.Is(err, sales.ErrInvalid) {
				t.Fatal("invalid framing accepted or unsanitized")
			}
		})
	}
	for i, headers := range [][]string{nil, {"text/json"}, {"application/json; charset=latin1"}, {"application/json; x=y"}, {"application/json", "application/json"}, {"application/json; charset=utf-8; charset=utf-8"}, {"application/json;"}} {
		t.Run(fmt.Sprintf("content_type_%d", i), func(t *testing.T) {
			r := httptest.NewRequest("POST", "/api/sales", strings.NewReader(validSaleJSON))
			for _, h := range headers {
				r.Header.Add("Content-Type", h)
			}
			if _, err := decodeSale(r); !errors.Is(err, sales.ErrInvalid) {
				t.Fatal("invalid media framing accepted")
			}
		})
	}
	r = httptest.NewRequest("POST", "/api/sales", nil)
	r.Header.Set("Content-Type", "application/json")
	r.Body = io.NopCloser(transferErrorReader{})
	if _, err := decodeSale(r); !errors.Is(err, sales.ErrInvalid) {
		t.Fatal("body read error exposed")
	}
	if _, err := decodeSale(nil); !errors.Is(err, sales.ErrInvalid) {
		t.Fatal("nil request accepted")
	}
}

func TestSaleListQuery(t *testing.T) {
	for name, tc := range map[string]struct {
		raw  string
		want sales.ListQuery
		ok   bool
	}{
		"defaults":   {"", sales.ListQuery{Page: 1, PageSize: 25}, true},
		"all":        {"search=2-000001&payment_method=card&page=2&page_size=10", sales.ListQuery{Search: "2-000001", PaymentMethod: "card", Page: 2, PageSize: 10}, true},
		"mixed":      {"payment_method=mixed", sales.ListQuery{PaymentMethod: "mixed", Page: 1, PageSize: 25}, true},
		"transfer":   {"payment_method=transfer&page_size=50", sales.ListQuery{PaymentMethod: "transfer", Page: 1, PageSize: 50}, true},
		"decoded":    {"search=Ana%20P%C3%A9rez", sales.ListQuery{Search: "Ana Pérez", Page: 1, PageSize: 25}, true},
		"fifty":      {"page_size=50", sales.ListQuery{Page: 1, PageSize: 50}, true},
		"bound_page": {"page=1000000", sales.ListQuery{Page: 1000000, PageSize: 25}, true},
		// Only the frozen page sizes are admitted.
		"page_size_15":   {"page_size=15", sales.ListQuery{}, false},
		"page_size_20":   {"page_size=20", sales.ListQuery{}, false},
		"page_size_0":    {"page_size=0", sales.ListQuery{}, false},
		"page_size_100":  {"page_size=100", sales.ListQuery{}, false},
		"page_zero":      {"page=0", sales.ListQuery{}, false},
		"page_bound":     {"page=1000001", sales.ListQuery{}, false},
		"padded_page":    {"page=01", sales.ListQuery{}, false},
		"encoded_page":   {"page=%31", sales.ListQuery{}, false},
		"bad_method":     {"payment_method=cheque", sales.ListQuery{}, false},
		"empty_method":   {"payment_method=", sales.ListQuery{}, false},
		"empty_search":   {"search=", sales.ListQuery{}, false},
		"long_search":    {"search=" + strings.Repeat("a", 129), sales.ListQuery{}, false},
		"unknown":        {"branch_location_id=2", sales.ListQuery{}, false},
		"duplicate":      {"page=1&page=1", sales.ListQuery{}, false},
		"no_equals":      {"page", sales.ListQuery{}, false},
		"trailing":       {"page=1&", sales.ListQuery{}, false},
		"bad_escape":     {"search=%ZZ", sales.ListQuery{}, false},
		"nul":            {"search=a%00b", sales.ListQuery{}, false},
		"query_separat":  {"&&", sales.ListQuery{}, false},
		"warranty_month": {"warranty_months=6", sales.ListQuery{}, false},
	} {
		t.Run(name, func(t *testing.T) {
			got, err := saleListQuery(tc.raw)
			if tc.ok {
				if err != nil || got != tc.want {
					t.Fatalf("an admitted history query was refused: %v", err)
				}
				return
			}
			if !errors.Is(err, sales.ErrInvalid) {
				t.Fatal("an inadmissible history query was accepted")
			}
		})
	}
}

func TestSaleSellableQuery(t *testing.T) {
	for name, tc := range map[string]struct {
		raw  string
		want sales.SellableQuery
		ok   bool
	}{
		"defaults": {"", sales.SellableQuery{Page: 1, PageSize: 25}, true},
		"all": {"search=ns40&brand=CAR&capacity=35&polarity=L&page=2&page_size=10", sales.SellableQuery{Search: "ns40",
			Brand: "CAR", Capacity: "35", Polarity: "L", Page: 2, PageSize: 10}, true},
		"fractional":   {"capacity=6.5", sales.SellableQuery{Capacity: "6.5", Page: 1, PageSize: 25}, true},
		"polarity_r":   {"polarity=R", sales.SellableQuery{Polarity: "R", Page: 1, PageSize: 25}, true},
		"page_size_50": {"page_size=50", sales.SellableQuery{Page: 1, PageSize: 50}, true},
		// The term is the seller's datum of the sale, so the catalogue never filters it.
		"warranty_month": {"warranty_months=6", sales.SellableQuery{}, false},
		"polarity":       {"polarity=X", sales.SellableQuery{}, false},
		"capacity":       {"capacity=6,5", sales.SellableQuery{}, false},
		"page_size":      {"page_size=20", sales.SellableQuery{}, false},
		"page_zero":      {"page=0", sales.SellableQuery{}, false},
		"unknown":        {"min_price=1.00", sales.SellableQuery{}, false},
		"duplicate":      {"brand=CAR&brand=CAR", sales.SellableQuery{}, false},
		"empty_brand":    {"brand=", sales.SellableQuery{}, false},
		"long_brand":     {"brand=" + strings.Repeat("a", 129), sales.SellableQuery{}, false},
	} {
		t.Run(name, func(t *testing.T) {
			got, err := saleSellableQuery(tc.raw)
			if tc.ok {
				if err != nil || got != tc.want {
					t.Fatalf("an admitted catalogue query was refused: %v", err)
				}
				return
			}
			if !errors.Is(err, sales.ErrInvalid) {
				t.Fatal("an inadmissible catalogue query was accepted")
			}
		})
	}
}

// TestSaleFailureMapping pins the published refusals: the three stock and price
// refusals name the offending variant, an impossible id fails closed, and no driver
// error is ever described.
func TestSaleFailureMapping(t *testing.T) {
	for _, tc := range []struct {
		err    error
		status int
		code   string
	}{
		{sales.ErrInvalid, 400, "invalid_request"},
		{sales.ErrForbidden, 403, "forbidden"},
		{sales.ErrNotFound, 404, "not_found"},
		{sales.ErrUnavailable, 503, "service_unavailable"},
		{fmt.Errorf("opaque failure"), 503, "service_unavailable"},
		{fmt.Errorf("driver: %w", errors.New(`failed to connect to host=private`)), 503, "service_unavailable"},
	} {
		w := httptest.NewRecorder()
		saleFailure(w, fmt.Errorf("wrapped: %w", tc.err))
		expectTransferError(t, w, tc.status, tc.code)
	}
	for _, tc := range []struct {
		err     error
		code    string
		variant int64
	}{
		{&sales.NotSellable{VariantID: 3}, "variant_not_sellable", 3},
		{&sales.BelowMinimum{VariantID: 7}, "below_minimum", 7},
		{&sales.InsufficientStock{VariantID: 12}, "insufficient_stock", 12},
	} {
		w := httptest.NewRecorder()
		saleFailure(w, fmt.Errorf("wrapped: %w", tc.err))
		var body map[string]json.RawMessage
		if w.Code != 409 || json.Unmarshal(w.Body.Bytes(), &body) != nil || len(body) != 2 ||
			string(body["error"]) != `"`+tc.code+`"` ||
			string(body["variant_id"]) != fmt.Sprintf("%d", tc.variant) {
			t.Fatalf("%s must name the offending variant: %d %s", tc.code, w.Code, w.Body.String())
		}
	}
	// A settlement that does not close is its own refusal: it names the open side with the
	// canonical amount, so the counter can say how much is left to pay or was charged too
	// much. A refusal that carries no side, both sides or an unpublishable amount is not
	// evidence of anything, so it fails closed.
	for _, tc := range []struct {
		err  error
		body string
	}{
		{&sales.PaymentsMismatch{Missing: "15000.00"}, `{"error":"payments_mismatch","missing":"15000.00"}` + "\n"},
		{&sales.PaymentsMismatch{Excess: "5000.00"}, `{"error":"payments_mismatch","excess":"5000.00"}` + "\n"},
	} {
		for _, wrapped := range []error{tc.err, fmt.Errorf("wrapped: %w", tc.err)} {
			w := httptest.NewRecorder()
			saleFailure(w, wrapped)
			if w.Code != 400 || w.Body.String() != tc.body ||
				w.Header().Get("Content-Type") != "application/json" {
				t.Fatalf("an open settlement must name its side: %d %s", w.Code, w.Body.String())
			}
		}
		if !errors.Is(tc.err, sales.ErrInvalid) {
			t.Fatal("an open settlement must stay the invalid-document refusal")
		}
	}
	for _, err := range []error{
		&sales.PaymentsMismatch{},
		&sales.PaymentsMismatch{Missing: "1.00", Excess: "1.00"},
		&sales.PaymentsMismatch{Missing: "1.0"},
	} {
		w := httptest.NewRecorder()
		saleFailure(w, err)
		expectTransferError(t, w, 503, "service_unavailable")
	}
	// A serial that was already sold is its own refusal, and it names the battery when the
	// database named it: the counter must point at the exact serial it has to fix.
	for _, tc := range []struct {
		err  error
		body string
	}{
		{&sales.SerialAlreadySold{Serial: "ABC123"}, `{"error":"serial_already_sold","serial_number":"ABC123"}` + "\n"},
		// A refusal that lost the serial is still the same refusal, answered with the house
		// envelope instead of an invented serial.
		{&sales.SerialAlreadySold{}, `{"error":"serial_already_sold"}` + "\n"},
		{&sales.SerialAlreadySold{Serial: " padded "}, `{"error":"serial_already_sold"}` + "\n"},
	} {
		w := httptest.NewRecorder()
		saleFailure(w, fmt.Errorf("wrapped: %w", tc.err))
		if w.Code != 409 || w.Body.String() != tc.body ||
			w.Header().Get("Content-Type") != "application/json" {
			t.Fatalf("an already-sold serial must name its battery: %d %s", w.Code, w.Body.String())
		}
		if !errors.Is(tc.err, sales.ErrSerialAlreadySold) {
			t.Fatal("an already-sold serial must stay its own domain refusal")
		}
	}
	// A refusal that lost its variant fails closed instead of publishing variant zero.
	for _, err := range []error{&sales.NotSellable{}, &sales.BelowMinimum{VariantID: -1}, &sales.InsufficientStock{VariantID: math.MaxInt32 + 1}} {
		w := httptest.NewRecorder()
		saleFailure(w, err)
		expectTransferError(t, w, 503, "service_unavailable")
	}
	// The typed refusals are still their own domain errors.
	if !errors.Is(&sales.NotSellable{VariantID: 1}, sales.ErrNotSellable) ||
		!errors.Is(&sales.BelowMinimum{VariantID: 1}, sales.ErrBelowMinimum) ||
		!errors.Is(&sales.InsufficientStock{VariantID: 1}, sales.ErrInsufficientStock) {
		t.Fatal("a refusal must stay recognizable as its own domain error")
	}
}

func saleDocumentValue() sales.Sale {
	term := 6
	return sales.Sale{
		ID: 7, BranchLocationID: 2, BranchSequence: 1, WarrantyNumber: "2-000001",
		PaymentMethod: sales.PaymentCash,
		Payments:      []sales.Payment{{Method: sales.PaymentCash, Amount: "192000.00"}},
		Customer:      sales.Customer{Name: "Cliente Mostrador", Phone: "700-00000", Document: "V-123", Address: "Av. Colón 1234"},
		Total:         "192000.00", CreatedByAccountID: 2,
		CreatedAt: time.Date(2026, 11, 20, 14, 30, 0, 0, time.UTC),
		Lines: []sales.SaleLine{{VariantID: 1, Quantity: 2, UnitPrice: "96000.00",
			MinPrice: "85000.00", Subtotal: "192000.00", Units: []sales.Unit{
				{SerialNumber: "ABC123", WarrantyMonths: &term},
				{SerialNumber: "ABC124"},
			}}},
	}
}

func TestSaleDocumentRecord(t *testing.T) {
	record, err := saleDocument(saleDocumentValue())
	if err != nil {
		t.Fatalf("a complete sale must be described: %v", err)
	}
	if record.ID != 7 || record.BranchLocationID != 2 || record.BranchSequence != 1 ||
		record.WarrantyNumber != "2-000001" || record.PaymentMethod != "cash" ||
		record.Customer.Name != "Cliente Mostrador" || record.Customer.Document != "V-123" ||
		record.Total != "192000.00" || record.CreatedByAccountID != 2 ||
		record.CreatedAt != "2026-11-20T14:30:00Z" || len(record.Lines) != 1 {
		t.Fatalf("the created sale does not match the frozen contract: %+v", record)
	}
	if line := record.Lines[0]; line.VariantID != 1 || line.Quantity != 2 ||
		line.UnitPrice != "96000.00" || line.MinPrice != "85000.00" ||
		line.Subtotal != "192000.00" || len(line.Units) != 2 {
		t.Fatalf("the created line does not freeze the pair: %+v", line)
	}
	// The answered document replaces the line's term with its units: one per sold piece,
	// with the serial and the term or its explicit absence.
	if unit := record.Lines[0].Units[0]; unit.SerialNumber != "ABC123" || unit.WarrantyMonths == nil ||
		*unit.WarrantyMonths != 6 {
		t.Fatalf("the first unit does not carry its serial and term: %+v", unit)
	}
	if unit := record.Lines[0].Units[1]; unit.SerialNumber != "ABC124" || unit.WarrantyMonths != nil {
		t.Fatalf("a unit without warranty must answer a null term: %+v", unit)
	}
	if record.Customer.Address != "Av. Colón 1234" {
		t.Fatalf("the document must carry the address of the sale: %q", record.Customer.Address)
	}
	if len(record.Payments) != 1 || record.Payments[0].Method != "cash" ||
		record.Payments[0].Amount != "192000.00" {
		t.Fatalf("the created sale must publish its settlement: %+v", record.Payments)
	}
	// A sale settled with two methods publishes both, in the frozen order cash, card,
	// transfer, under the label the amounts derive.
	mixed := saleDocumentValue()
	mixed.PaymentMethod = sales.PaymentMixed
	mixed.Payments = []sales.Payment{{Method: sales.PaymentCash, Amount: "100000.00"},
		{Method: sales.PaymentTransfer, Amount: "92000.00"}}
	mixedRecord, err := saleDocument(mixed)
	if err != nil || len(mixedRecord.Payments) != 2 ||
		mixedRecord.Payments[0].Method != "cash" || mixedRecord.Payments[0].Amount != "100000.00" ||
		mixedRecord.Payments[1].Method != "transfer" || mixedRecord.Payments[1].Amount != "92000.00" ||
		mixedRecord.PaymentMethod != "mixed" {
		t.Fatalf("a mixed settlement must publish both amounts in order: %+v %v", mixedRecord.Payments, err)
	}
	// The widest settlement a document can carry is all four methods paying at once: the label the
	// database derives from four positive amounts is 'mixed', and every amount is published in the
	// frozen order, QR last. This is exactly the combination a three-method label published as an
	// unavailable document.
	four := saleDocumentValue()
	four.PaymentMethod = sales.PaymentMixed
	four.Payments = []sales.Payment{{Method: sales.PaymentCash, Amount: "80000.00"},
		{Method: sales.PaymentCard, Amount: "40000.00"},
		{Method: sales.PaymentTransfer, Amount: "40000.00"},
		{Method: sales.PaymentQR, Amount: "32000.00"}}
	fourRecord, err := saleDocument(four)
	if err != nil || fourRecord.PaymentMethod != "mixed" || len(fourRecord.Payments) != 4 ||
		fourRecord.Payments[0].Method != "cash" || fourRecord.Payments[1].Method != "card" ||
		fourRecord.Payments[2].Method != "transfer" || fourRecord.Payments[3].Method != "qr" ||
		fourRecord.Payments[3].Amount != "32000.00" {
		t.Fatalf("a four-method sale must publish all four payments under mixed: %+v %v",
			fourRecord.Payments, err)
	}
	// The number format is the frozen <branch id>-<sequence padded to 6 digits>.
	for _, tc := range []struct {
		branch, sequence int64
		want             string
	}{
		{2, 1, "2-000001"},
		{12, 999999, "12-999999"},
		{3, 1000000, "3-1000000"},
	} {
		if got := saleWarrantyNumber(tc.branch, tc.sequence); got != tc.want {
			t.Fatalf("warranty number mismatch: %q want %q", got, tc.want)
		}
	}
	for _, tc := range []struct{ branch, sequence int64 }{{1, 1}, {0, 1}, {32768, 1}, {2, 0}, {2, 1000000000}} {
		if got := saleWarrantyNumber(tc.branch, tc.sequence); got != "" {
			t.Fatalf("an impossible number must be empty: %q", got)
		}
	}
	mutate := func(change func(*sales.Sale)) sales.Sale {
		value := saleDocumentValue()
		change(&value)
		return value
	}
	for name, value := range map[string]sales.Sale{
		"zero_id":         mutate(func(v *sales.Sale) { v.ID = 0 }),
		"warehouse":       mutate(func(v *sales.Sale) { v.BranchLocationID = 1 }),
		"branch_bound":    mutate(func(v *sales.Sale) { v.BranchLocationID = 32768 }),
		"zero_sequence":   mutate(func(v *sales.Sale) { v.BranchSequence = 0 }),
		"number_branch":   mutate(func(v *sales.Sale) { v.WarrantyNumber = "3-000001" }),
		"number_sequence": mutate(func(v *sales.Sale) { v.WarrantyNumber = "2-000002" }),
		"number_padding":  mutate(func(v *sales.Sale) { v.WarrantyNumber = "2-1" }),
		"empty_number":    mutate(func(v *sales.Sale) { v.WarrantyNumber = "" }),
		"zero_account":    mutate(func(v *sales.Sale) { v.CreatedByAccountID = 0 }),
		"zero_created":    mutate(func(v *sales.Sale) { v.CreatedAt = time.Time{} }),
		"empty_customer":  mutate(func(v *sales.Sale) { v.Customer.Name = "" }),
		"padded_customer": mutate(func(v *sales.Sale) { v.Customer.Name = " Cliente" }),
		"nul_customer":    mutate(func(v *sales.Sale) { v.Customer.Name = "a\x00b" }),
		"long_phone":      mutate(func(v *sales.Sale) { v.Customer.Phone = strings.Repeat("7", sales.MaxCustomerPhone+1) }),
		"unknown_method":  mutate(func(v *sales.Sale) { v.PaymentMethod = "cheque" }),
		"no_payments":     mutate(func(v *sales.Sale) { v.Payments = nil }),
		"label_disagrees": mutate(func(v *sales.Sale) { v.PaymentMethod = sales.PaymentMixed }),
		"label_other":     mutate(func(v *sales.Sale) { v.PaymentMethod = sales.PaymentCard }),
		"payment_unknown": mutate(func(v *sales.Sale) {
			v.Payments = []sales.Payment{{Method: "cheque", Amount: "192000.00"}}
		}),
		"payment_mixed": mutate(func(v *sales.Sale) {
			v.Payments = []sales.Payment{{Method: sales.PaymentMixed, Amount: "192000.00"}}
		}),
		"payment_zero": mutate(func(v *sales.Sale) {
			v.Payments = []sales.Payment{{Method: sales.PaymentCash, Amount: "0.00"}}
		}),
		"payment_open": mutate(func(v *sales.Sale) {
			v.Payments = []sales.Payment{{Method: sales.PaymentCash, Amount: "100000.00"}}
		}),
		"payments_unordered": mutate(func(v *sales.Sale) {
			v.PaymentMethod = sales.PaymentMixed
			v.Payments = []sales.Payment{{Method: sales.PaymentTransfer, Amount: "92000.00"},
				{Method: sales.PaymentCash, Amount: "100000.00"}}
		}),
		"payment_repeated": mutate(func(v *sales.Sale) {
			v.PaymentMethod = sales.PaymentMixed
			v.Payments = []sales.Payment{{Method: sales.PaymentCash, Amount: "96000.00"},
				{Method: sales.PaymentCash, Amount: "96000.00"}}
		}),
		// A settlement cannot carry more payments than admitted methods: the fifth one has no
		// method to pay with, so the document is a stored shape this domain never wrote.
		"payments_five": mutate(func(v *sales.Sale) {
			v.PaymentMethod = sales.PaymentMixed
			v.Payments = []sales.Payment{{Method: sales.PaymentCash, Amount: "40000.00"},
				{Method: sales.PaymentCard, Amount: "40000.00"},
				{Method: sales.PaymentTransfer, Amount: "40000.00"},
				{Method: sales.PaymentQR, Amount: "40000.00"},
				{Method: sales.PaymentCash, Amount: "32000.00"}}
		}),
		"money_digits":   mutate(func(v *sales.Sale) { v.Total = "192000" }),
		"money_float":    mutate(func(v *sales.Sale) { v.Total = "192000.5" }),
		"total_mismatch": mutate(func(v *sales.Sale) { v.Total = "190000.00" }),
		"no_lines":       mutate(func(v *sales.Sale) { v.Lines = []sales.SaleLine{} }),
		"floor_above":    mutate(func(v *sales.Sale) { v.Lines[0].MinPrice = "97000.00" }),
		"floor_digits":   mutate(func(v *sales.Sale) { v.Lines[0].MinPrice = "85000" }),
		"subtotal_changed": mutate(func(v *sales.Sale) {
			v.Lines[0].Subtotal = "190000.00"
			v.Total = "190000.00"
		}),
		"unit_changed":  mutate(func(v *sales.Sale) { v.Lines[0].UnitPrice = "95000.00" }),
		"zero_quantity": mutate(func(v *sales.Sale) { v.Lines[0].Quantity = 0 }),
		"zero_term": mutate(func(v *sales.Sale) {
			term := 0
			v.Lines[0].Units[0].WarrantyMonths = &term
		}),
		"term_above": mutate(func(v *sales.Sale) {
			term := sales.MaxWarrantyMonths + 1
			v.Lines[0].Units[0].WarrantyMonths = &term
		}),
		"no_units":         mutate(func(v *sales.Sale) { v.Lines[0].Units = nil }),
		"unit_short":       mutate(func(v *sales.Sale) { v.Lines[0].Units = v.Lines[0].Units[:1] }),
		"unit_long":        mutate(func(v *sales.Sale) { v.Lines[0].Units = append(v.Lines[0].Units, v.Lines[0].Units[0]) }),
		"unit_padded":      mutate(func(v *sales.Sale) { v.Lines[0].Units[1].SerialNumber = " ABC124 " }),
		"unit_serial_nul":  mutate(func(v *sales.Sale) { v.Lines[0].Units[1].SerialNumber = "a\x00b" }),
		"long_address":     mutate(func(v *sales.Sale) { v.Customer.Address = strings.Repeat("ñ", sales.MaxCustomerAddress+1) }),
		"nul_address":      mutate(func(v *sales.Sale) { v.Customer.Address = "a\x00b" }),
		"repeated_variant": mutate(func(v *sales.Sale) { v.Lines = append(v.Lines, v.Lines[0]) }),
		"unordered_lines": mutate(func(v *sales.Sale) {
			v.Lines = []sales.SaleLine{
				{VariantID: 2, Quantity: 1, UnitPrice: "96000.00", MinPrice: "85000.00", Subtotal: "96000.00",
					Units: []sales.Unit{{SerialNumber: "ORDER-2"}}},
				{VariantID: 1, Quantity: 1, UnitPrice: "96000.00", MinPrice: "85000.00", Subtotal: "96000.00",
					Units: []sales.Unit{{SerialNumber: "ORDER-1"}}},
			}
			v.Total = "192000.00"
		}),
	} {
		if _, err := saleDocument(value); !errors.Is(err, sales.ErrUnavailable) {
			t.Fatalf("%s must fail closed", name)
		}
	}
}

func salePageValue() sales.Page {
	return sales.Page{Page: 1, PageSize: 25, TotalSales: 1, Sales: []sales.Summary{{
		ID: 7, BranchSequence: 1, WarrantyNumber: "2-000001", PaymentMethod: sales.PaymentCard,
		CustomerName: "Cliente Mostrador", Total: "192000.00",
		CreatedAt: time.Date(2026, 11, 20, 14, 30, 0, 0, time.UTC), Lines: 1,
		UnitsTotal: 2, UnitsWithWarranty: 1,
	}}}
}

func TestSalePageRecord(t *testing.T) {
	record, err := salePageRecord(salePageValue())
	if err != nil {
		t.Fatalf("a complete history page must be described: %v", err)
	}
	if record.Page != 1 || record.PageSize != 25 || record.TotalSales != 1 || len(record.Sales) != 1 {
		t.Fatalf("the history page does not match the frozen contract: %+v", record)
	}
	row := record.Sales[0]
	if row.ID != 7 || row.BranchSequence != 1 || row.WarrantyNumber != "2-000001" ||
		row.PaymentMethod != "card" || row.CustomerName != "Cliente Mostrador" ||
		row.Total != "192000.00" || row.CreatedAt != "2026-11-20T14:30:00Z" || row.Lines != 1 {
		t.Fatalf("the history row does not match the frozen contract: %+v", row)
	}
	// S5: the row tells the sale's position without unfolding it.
	if row.UnitsTotal != 2 || row.UnitsWithWarranty != 1 {
		t.Fatalf("the history row must count the units and their warranties: %+v", row)
	}
	// A sale settled with more than one method is a legible row: its derived label is
	// published, so the branch can filter by it.
	mixed := salePageValue()
	mixed.Sales[0].PaymentMethod = sales.PaymentMixed
	if mixedRecord, err := salePageRecord(mixed); err != nil || mixedRecord.Sales[0].PaymentMethod != "mixed" {
		t.Fatalf("a mixed sale must be a legible history row: %+v %v", mixedRecord.Sales, err)
	}
	// T12/S7: a sale issued before the sold unit existed carries no unit at all. It is
	// recoverable history, so the page names it with zero units and nothing warranted
	// instead of failing the whole branch closed.
	preVertical := salePageValue()
	preVertical.Sales[0].UnitsTotal = 0
	preVertical.Sales[0].UnitsWithWarranty = 0
	if record, err := salePageRecord(preVertical); err != nil ||
		record.Sales[0].UnitsTotal != 0 || record.Sales[0].UnitsWithWarranty != 0 {
		t.Fatalf("a pre-vertical row must be a legible history row: %+v %v", record.Sales, err)
	}
	// A page beyond the last one is legitimately empty.
	value, err := salePageRecord(sales.Page{Page: 3, PageSize: 10, TotalSales: 2, Sales: []sales.Summary{}})
	if err != nil || value.Sales == nil || len(value.Sales) != 0 {
		t.Fatalf("an empty page must report an empty list: %v", err)
	}
	mutate := func(change func(*sales.Page)) sales.Page {
		value := salePageValue()
		change(&value)
		return value
	}
	for name, page := range map[string]sales.Page{
		"bad_page":          mutate(func(v *sales.Page) { v.Page = 0 }),
		"bad_size":          mutate(func(v *sales.Page) { v.PageSize = 15 }),
		"negative_total":    mutate(func(v *sales.Page) { v.TotalSales = -1 }),
		"overflow":          mutate(func(v *sales.Page) { v.TotalSales = 0 }),
		"too_many_rows":     mutate(func(v *sales.Page) { v.PageSize = 10; v.Sales = append(v.Sales, v.Sales[0]) }),
		"zero_id":           mutate(func(v *sales.Page) { v.Sales[0].ID = 0 }),
		"unordered":         mutate(func(v *sales.Page) { v.Sales = append(v.Sales, v.Sales[0]) }),
		"zero_sequence":     mutate(func(v *sales.Page) { v.Sales[0].BranchSequence = 0 }),
		"empty_number":      mutate(func(v *sales.Page) { v.Sales[0].WarrantyNumber = "" }),
		"unknown_method":    mutate(func(v *sales.Page) { v.Sales[0].PaymentMethod = "cheque" }),
		"empty_customer":    mutate(func(v *sales.Page) { v.Sales[0].CustomerName = "" }),
		"money_digits":      mutate(func(v *sales.Page) { v.Sales[0].Total = "192000" }),
		"zero_created":      mutate(func(v *sales.Page) { v.Sales[0].CreatedAt = time.Time{} }),
		"zero_lines":        mutate(func(v *sales.Page) { v.Sales[0].Lines = 0 }),
		"lines_above":       mutate(func(v *sales.Page) { v.Sales[0].Lines = sales.MaxLines + 1 }),
		"units_below_lines": mutate(func(v *sales.Page) { v.Sales[0].UnitsTotal = v.Sales[0].Lines - 1 }),
		"units_above":       mutate(func(v *sales.Page) { v.Sales[0].UnitsTotal = sales.MaxUnits + 1 }),
		"warranted_without_units": mutate(func(v *sales.Page) {
			v.Sales[0].UnitsTotal = 0
			v.Sales[0].UnitsWithWarranty = 1
		}),
		"warranted_above": mutate(func(v *sales.Page) { v.Sales[0].UnitsWithWarranty = v.Sales[0].UnitsTotal + 1 }),
		"warranted_negative": mutate(func(v *sales.Page) {
			v.Sales[0].UnitsWithWarranty = -1
		}),
	} {
		if _, err := salePageRecord(page); !errors.Is(err, sales.ErrUnavailable) {
			t.Fatalf("%s must fail closed", name)
		}
	}
}

func saleDetailValue() sales.Detail {
	term := 6
	return sales.Detail{
		ID: 7, BranchLocationID: 2, BranchName: "Sucursal A", BranchSequence: 1,
		WarrantyNumber: "2-000001",
		PaymentMethod:  sales.PaymentCash,
		Payments:       []sales.Payment{{Method: sales.PaymentCash, Amount: "192000.00"}},
		Customer:       sales.Customer{Name: "Cliente Mostrador", Phone: "700-00000", Document: "V-123", Address: "Av. Colón 1234"},
		Total:          "192000.00", CreatedByAccountID: 2,
		CreatedAt: time.Date(2026, 11, 20, 14, 30, 0, 0, time.UTC),
		Lines: []sales.DetailLine{{
			SaleLine: sales.SaleLine{VariantID: 1, Quantity: 2, UnitPrice: "96000.00",
				MinPrice: "85000.00", Subtotal: "192000.00", Units: []sales.Unit{
					{SerialNumber: "ABC123", WarrantyMonths: &term},
					{SerialNumber: "ABC124"},
				}},
			CatalogEntryID: 1, Brand: "CAR", Model: "NS40ZL", Capacity: catalog.Decimal("35"), Polarity: "L",
		}},
	}
}

func TestSaleDetailRecord(t *testing.T) {
	record, err := saleDetailRecord(saleDetailValue())
	if err != nil {
		t.Fatalf("a complete sale document must be described: %v", err)
	}
	if record.ID != 7 || record.BranchSequence != 1 || record.WarrantyNumber != "2-000001" ||
		record.PaymentMethod != "cash" || record.CustomerName != "Cliente Mostrador" ||
		record.Total != "192000.00" || record.CreatedAt != "2026-11-20T14:30:00Z" || len(record.Lines) != 1 {
		t.Fatalf("the document does not match the frozen contract: %+v", record)
	}
	// The client of the warranty and the settlement are published beside the header, so the
	// detail screen and the warranty need no second read.
	if record.Customer.Name != "Cliente Mostrador" || record.Customer.Phone != "700-00000" ||
		record.Customer.Document != "V-123" {
		t.Fatalf("the document must carry its client: %+v", record.Customer)
	}
	if len(record.Payments) != 1 || record.Payments[0].Method != "cash" ||
		record.Payments[0].Amount != "192000.00" {
		t.Fatalf("the document must carry its settlement: %+v", record.Payments)
	}
	line := record.Lines[0]
	if line.VariantID != 1 || line.CatalogEntryID != 1 || line.Brand != "CAR" ||
		line.Model != "NS40ZL" || line.Capacity != "35" || line.Polarity != "L" ||
		line.Quantity != 2 || line.UnitPrice != "96000.00" || line.MinPrice != "85000.00" ||
		line.Subtotal != "192000.00" || len(line.Units) != 2 {
		t.Fatalf("the document line does not keep the prices of the sale: %+v", line)
	}
	// The detail names each unit with its serial and its term, or its explicit absence.
	if unit := line.Units[0]; unit.SerialNumber != "ABC123" || unit.WarrantyMonths == nil ||
		*unit.WarrantyMonths != 6 {
		t.Fatalf("the detail must carry the serial and term of each unit: %+v", unit)
	}
	if unit := line.Units[1]; unit.SerialNumber != "ABC124" || unit.WarrantyMonths != nil {
		t.Fatalf("a battery sold without warranty must answer a null term: %+v", unit)
	}
	if record.Customer.Address != "Av. Colón 1234" {
		t.Fatalf("the detail must carry the address of the sale: %q", record.Customer.Address)
	}
	mutate := func(change func(*sales.Detail)) sales.Detail {
		value := saleDetailValue()
		change(&value)
		return value
	}
	for name, detail := range map[string]sales.Detail{
		"zero_entry":      mutate(func(v *sales.Detail) { v.Lines[0].CatalogEntryID = 0 }),
		"empty_brand":     mutate(func(v *sales.Detail) { v.Lines[0].Brand = "" }),
		"empty_model":     mutate(func(v *sales.Detail) { v.Lines[0].Model = "" }),
		"nul_model":       mutate(func(v *sales.Detail) { v.Lines[0].Model = "a\x00b" }),
		"capacity":        mutate(func(v *sales.Detail) { v.Lines[0].Capacity = "0" }),
		"polarity":        mutate(func(v *sales.Detail) { v.Lines[0].Polarity = "X" }),
		"no_lines":        mutate(func(v *sales.Detail) { v.Lines = []sales.DetailLine{} }),
		"floor_above":     mutate(func(v *sales.Detail) { v.Lines[0].MinPrice = "97000.00" }),
		"number_mismatch": mutate(func(v *sales.Detail) { v.WarrantyNumber = "2-000009" }),
		"no_payments":     mutate(func(v *sales.Detail) { v.Payments = nil }),
		"open_payment": mutate(func(v *sales.Detail) {
			v.Payments = []sales.Payment{{Method: sales.PaymentCash, Amount: "100000.00"}}
		}),
	} {
		if _, err := saleDetailRecord(detail); !errors.Is(err, sales.ErrUnavailable) {
			t.Fatalf("%s must fail closed", name)
		}
	}
	// T12/S7: a document issued before the sold unit existed carries no unit at all. It is
	// recoverable history, so its detail is described with an empty units array per line
	// instead of failing closed, and its header, its prices and its client stay the same.
	preVertical := saleDetailValue()
	preVertical.Lines[0].Units = nil
	old, err := saleDetailRecord(preVertical)
	if err != nil {
		t.Fatalf("a pre-vertical document must be described: %v", err)
	}
	if len(old.Lines) != 1 || old.Lines[0].Units == nil || len(old.Lines[0].Units) != 0 ||
		old.Lines[0].Quantity != 2 || old.Total != "192000.00" || old.Customer.Name != "Cliente Mostrador" {
		t.Fatalf("a pre-vertical document keeps its lines and states no unit: %+v", old)
	}
	// A document whose units are short of its sold pieces is corrupt and still fails closed.
	short := saleDetailValue()
	short.Lines[0].Units = short.Lines[0].Units[:1]
	if _, err := saleDetailRecord(short); !errors.Is(err, sales.ErrUnavailable) {
		t.Fatalf("a partially united document must fail closed: %v", err)
	}
	// A mixed sale publishes both of its payments in the frozen order.
	mixed := saleDetailValue()
	mixed.PaymentMethod = sales.PaymentMixed
	mixed.Payments = []sales.Payment{{Method: sales.PaymentCash, Amount: "100000.00"},
		{Method: sales.PaymentTransfer, Amount: "92000.00"}}
	mixedRecord, err := saleDetailRecord(mixed)
	if err != nil || len(mixedRecord.Payments) != 2 || mixedRecord.PaymentMethod != "mixed" ||
		mixedRecord.Payments[0].Method != "cash" || mixedRecord.Payments[1].Method != "transfer" {
		t.Fatalf("a mixed document must carry both payments: %+v %v", mixedRecord.Payments, err)
	}
}

func saleSellableValue() sales.SellablePage {
	return sales.SellablePage{Page: 1, PageSize: 25, TotalVariants: 3, Items: []sales.SellableItem{
		{VariantID: 1, CatalogEntryID: 1, Brand: "CAR", Model: "NS40ZL", Capacity: "35", Polarity: "L",
			Sellable: true, SuggestedPrice: "96000.00", MinPrice: "85000.00",
			Existing: 12, Reserved: 2, Available: 10},
		{VariantID: 2, CatalogEntryID: 1, Brand: "CAR", Model: "NS40ZL", Capacity: "35", Polarity: "R",
			Sellable: true, SuggestedPrice: "96000.00", MinPrice: "85000.00",
			Existing: 4, Reserved: 0, Available: 4},
		// A variant the branch cannot sell is still a row: the counter shows it blocked.
		{VariantID: 3, CatalogEntryID: 2, Brand: "CAR", Model: "NS60L", Capacity: "45", Polarity: "L",
			Sellable: false, Existing: 7, Reserved: 1, Available: 6},
	}}
}

func TestSaleSellableRecord(t *testing.T) {
	record, err := saleSellableRecord(saleSellableValue())
	if err != nil {
		t.Fatalf("a complete sellable page must be described: %v", err)
	}
	if record.Page != 1 || record.PageSize != 25 || record.TotalVariants != 3 || len(record.Items) != 3 {
		t.Fatalf("the catalogue page does not match the frozen contract: %+v", record)
	}
	for i, item := range record.Items {
		if item.VariantID != int64(i+1) || item.CatalogEntryID != []int64{1, 1, 2}[i] ||
			item.Brand != "CAR" || item.Capacity != []string{"35", "35", "45"}[i] ||
			item.Polarity != []string{"L", "R", "L"}[i] || item.Sellable != (i < 2) {
			t.Fatalf("the catalogue item does not match the frozen contract: %+v", item)
		}
	}
	if first := record.Items[0]; first.SuggestedPrice == nil || *first.SuggestedPrice != "96000.00" ||
		first.MinPrice == nil || *first.MinPrice != "85000.00" ||
		first.Existing != 12 || first.Reserved != 2 || first.Available != 10 {
		t.Fatalf("a sellable variant must carry its pair and its availability: %+v", first)
	}
	// The variant the branch cannot sell is published with null prices, so the counter can
	// block the row instead of hiding it, and its availability is still the branch's own.
	blocked := record.Items[2]
	if blocked.Sellable || blocked.SuggestedPrice != nil || blocked.MinPrice != nil ||
		blocked.Existing != 7 || blocked.Reserved != 1 || blocked.Available != 6 {
		t.Fatalf("an unsellable variant must be published blocked: %+v", blocked)
	}
	mutate := func(change func(*sales.SellablePage)) sales.SellablePage {
		value := saleSellableValue()
		change(&value)
		return value
	}
	for name, page := range map[string]sales.SellablePage{
		"bad_page":       mutate(func(v *sales.SellablePage) { v.Page = 0 }),
		"bad_size":       mutate(func(v *sales.SellablePage) { v.PageSize = 20 }),
		"negative_total": mutate(func(v *sales.SellablePage) { v.TotalVariants = -1 }),
		"overflow":       mutate(func(v *sales.SellablePage) { v.TotalVariants = 2 }),
		"zero_variant":   mutate(func(v *sales.SellablePage) { v.Items[0].VariantID = 0 }),
		"unordered":      mutate(func(v *sales.SellablePage) { v.Items[1].VariantID = 1 }),
		"zero_entry":     mutate(func(v *sales.SellablePage) { v.Items[0].CatalogEntryID = 0 }),
		"empty_brand":    mutate(func(v *sales.SellablePage) { v.Items[0].Brand = "" }),
		"polarity":       mutate(func(v *sales.SellablePage) { v.Items[0].Polarity = "X" }),
		"capacity":       mutate(func(v *sales.SellablePage) { v.Items[0].Capacity = "0" }),
		"money_digits":   mutate(func(v *sales.SellablePage) { v.Items[0].MinPrice = "85000" }),
		"under_floor":    mutate(func(v *sales.SellablePage) { v.Items[0].SuggestedPrice = "84000.00" }),
		// A blocked variant never carries a pair, and a sellable one always does.
		"blocked_price": mutate(func(v *sales.SellablePage) {
			v.Items[2].SuggestedPrice = "96000.00"
			v.Items[2].MinPrice = "85000.00"
		}),
		"missing_price": mutate(func(v *sales.SellablePage) {
			v.Items[0].SuggestedPrice = ""
			v.Items[0].MinPrice = ""
		}),
		// The availability is the ledger's own arithmetic, never a number invented here.
		"negative_existing": mutate(func(v *sales.SellablePage) {
			v.Items[0].Existing = -1
			v.Items[0].Available = -3
		}),
		"reserved_above": mutate(func(v *sales.SellablePage) {
			v.Items[0].Reserved = v.Items[0].Existing + 1
			v.Items[0].Available = -1
		}),
		"available_off": mutate(func(v *sales.SellablePage) { v.Items[0].Available = 9 }),
	} {
		if _, err := saleSellableRecord(page); !errors.Is(err, sales.ErrUnavailable) {
			t.Fatalf("%s must fail closed", name)
		}
	}
}

// saleRecorder is a base handler that only records the request it received, so
// forwarding stays provable without a database.
type saleRecorder struct {
	calls int
	path  string
}

func (h *saleRecorder) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.calls++
	h.path = r.URL.Path
	w.WriteHeader(http.StatusNoContent)
}

func TestSalePathSafety(t *testing.T) {
	// Every ambiguous sale path is refused, before any handler work and without a
	// database: a doubled slash, a dot segment, a backslash or an encoded alias.
	for _, target := range []string{
		"/api/sales//", "/api/sales/./1", "/api/sales/..", "/api/sales/../sales",
		"/api/sales/a\\b", "/api/sales//sellable", "/api/sales/%31",
		"/api/sales/%70ellable", "/api/sales/1%2F2",
	} {
		if salePath(httptest.NewRequest("GET", target, nil)) {
			t.Fatalf("%s must be refused as an ambiguous sale path", target)
		}
	}
	// A NUL never reaches a handler either.
	if salePath(&http.Request{URL: &url.URL{Path: "/api/sales/a\x00b"}}) {
		t.Fatal("a NUL in the path must be refused")
	}
	// Every other path is admitted here so it can be forwarded or answered as an
	// unknown route; a bare trailing separator is routed, never cleaned.
	for _, target := range []string{"/api/inventory", "/api/catalog/prices", "/api/salesx",
		"/api/sales", "/api/sales/7", "/api/sales/sellable", "/api/sales/"} {
		if !salePath(httptest.NewRequest("GET", target, nil)) {
			t.Fatalf("%s must be admitted here", target)
		}
	}
}

func TestSaleConstructor(t *testing.T) {
	cfg := transferConfig(t)
	store := sales.New(&pgxpool.Pool{})
	base := &saleRecorder{}
	if h, err := NewWithSales(nil, &auth.Service{}, cfg, store); err == nil || h != nil {
		t.Fatal("a nil base handler was accepted")
	}
	if h, err := NewWithSales(base, nil, cfg, store); err == nil || h != nil {
		t.Fatal("a nil service was accepted")
	}
	if h, err := NewWithSales(base, &auth.Service{}, cfg, nil); err == nil || h != nil {
		t.Fatal("a nil sale store was accepted")
	}
	if h, err := NewWithSales(base, &auth.Service{}, config.Auth{}, store); err == nil || h != nil {
		t.Fatal("an invalid auth configuration was accepted")
	}
	h, err := NewWithSales(base, &auth.Service{}, cfg, store)
	if err != nil || h == nil {
		t.Fatal("the sale constructor is unavailable")
	}
	// Every route requires a session, and an unsupported method is refused before any
	// identity work.
	for _, tc := range []struct {
		method, target, allow string
		status                int
		code                  string
	}{
		{"GET", "/api/sales", "", 401, "unauthenticated"},
		{"POST", "/api/sales", "", 401, "unauthenticated"},
		{"PUT", "/api/sales", "GET, POST", 405, "method_not_allowed"},
		{"DELETE", "/api/sales", "GET, POST", 405, "method_not_allowed"},
		{"GET", "/api/sales/sellable", "", 401, "unauthenticated"},
		{"POST", "/api/sales/sellable", "GET", 405, "method_not_allowed"},
		{"GET", "/api/sales/7", "", 401, "unauthenticated"},
		{"POST", "/api/sales/7", "GET", 405, "method_not_allowed"},
		{"GET", "/api/sales/7/warranty.pdf", "", 401, "unauthenticated"},
		{"POST", "/api/sales/7/warranty.pdf", "GET", 405, "method_not_allowed"},
	} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(tc.method, tc.target, nil))
		expectTransferError(t, w, tc.status, tc.code)
		if w.Header().Get("Allow") != tc.allow {
			t.Fatalf("%s %s must advertise %q", tc.method, tc.target, tc.allow)
		}
		if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Fatal("the sale wrapper must keep the response headers")
		}
	}
	// An ambiguous or unknown path below the collection never reaches a handler.
	for _, target := range []string{
		"/api/sales/", "/api/sales//", "/api/sales/./1", "/api/sales/%31",
		"/api/sales/1/2", "/api/sales/sellable/1", "/api/sales/1/warranty.pdf/x",
		"/api/sales/1/Warranty.pdf", "/api/sales/1/detail",
	} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", target, nil))
		expectTransferError(t, w, 404, "not_found")
	}
	// Every other request is forwarded to the composed handler unchanged.
	for _, target := range []string{"/api/inventory", "/api/stock-adjustments", "/api/auth/session",
		"/api/catalog/prices", "/api/catalog"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", target, nil))
		if w.Code != http.StatusNoContent {
			t.Fatalf("%s must be forwarded to the composed handler", target)
		}
	}
	if base.calls != 5 || base.path != "/api/catalog" {
		t.Fatalf("forwarding changed: %d %q", base.calls, base.path)
	}
	// Without the sale wrapper the routes stay unregistered, exactly like the price
	// list on the stock entry factory.
	legacy, err := NewWithStockEntries(&auth.Service{}, cfg, inventory.New(&pgxpool.Pool{}), transfers.New(&pgxpool.Pool{}), stockentries.New(&pgxpool.Pool{}), nil, stockadjustments.New(&pgxpool.Pool{}))
	if err != nil || legacy == nil {
		t.Fatal("stock entry constructor unavailable")
	}
	for _, target := range []string{"/api/sales", "/api/sales/sellable", "/api/sales/1"} {
		w := httptest.NewRecorder()
		legacy.ServeHTTP(w, httptest.NewRequest("GET", target, nil))
		if w.Code != 404 {
			t.Fatalf("a factory without the sale store must not serve %s", target)
		}
	}
}

type saleHTTPFixture struct {
	ctx     context.Context
	p       *pgxpool.Pool
	cfg     config.Auth
	handler http.Handler
	tokens  []string
	prices  *pricing.Store
}

// saleFixture needs the isolated test PostgreSQL. Admission fails closed inside
// testpg.Open, exactly like every other database fixture in this repository: without an
// admitted manifest the test fails instead of passing with a skip.
func saleFixture(t *testing.T) *saleHTTPFixture {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	t.Cleanup(cancel)
	p := testpg.Open(t)
	if bootstrap.Initialize(ctx, p, config.LocalTrial) != nil {
		t.Fatal("sale HTTP fixture initialization failed")
	}
	credentials := make([]bootstrap.Credentials, 3)
	for i := range credentials {
		credentials[i] = bootstrap.Credentials{Username: "u" + testpg.Random(t)[:20], Password: testpg.Random(t)}
	}
	if bootstrap.Provision(ctx, p, credentials) != nil {
		t.Fatal("sale HTTP test provisioning failed")
	}
	// These fixtures model operators who completed their initial password change.
	if _, err := p.Exec(ctx, `UPDATE auth_accounts SET must_change_password=false`); err != nil {
		t.Fatal("sale HTTP operational fixture setup failed")
	}
	svc, err := auth.New(p, nil)
	if err != nil {
		t.Fatal("sale HTTP auth fixture failed")
	}
	f := &saleHTTPFixture{ctx: ctx, p: p, cfg: transferConfig(t), tokens: make([]string, 3),
		prices: pricing.New(p)}
	for i, c := range credentials {
		_, token, err := svc.Login(ctx, c.Username, c.Password, fmt.Sprintf("127.0.0.%d", i+1), "")
		if err != nil {
			t.Fatal("sale HTTP login failed")
		}
		f.tokens[i] = token
	}
	base, err := NewWithStockEntries(svc, f.cfg, inventory.New(p), transfers.New(p), stockentries.New(p), nil, stockadjustments.New(p))
	if err != nil {
		t.Fatal("sale HTTP base constructor failed")
	}
	f.handler, err = NewWithSales(base, svc, f.cfg, sales.New(p))
	if err != nil {
		t.Fatal("sale HTTP constructor failed")
	}
	return f
}

// price writes one branch pair through the price store, so the fixture prices exactly
// what the Catálogo prices: the battery, and therefore both of its polarities.
func (f *saleHTTPFixture) price(t *testing.T, entryID int64, min, suggested string, branches ...int64) {
	t.Helper()
	if _, err := f.prices.Write(f.ctx, auth.Identity{AccountID: 1, Location: auth.Location{ID: 1}},
		pricing.WriteInput{CatalogEntryID: entryID, MinPrice: pricing.Money(min),
			SuggestedPrice: pricing.Money(suggested), BranchIDs: branches}); err != nil {
		t.Fatalf("price fixture for battery %d failed: %v", entryID, err)
	}
}

// entryOf reads the battery of a variant from the catalogue, so a test never guesses
// which entry a polarity belongs to.
func (f *saleHTTPFixture) entryOf(t *testing.T, variantID int64) int64 {
	t.Helper()
	var entry int64
	if f.p.QueryRow(f.ctx, "SELECT catalog_entry_id FROM catalog_variants WHERE id=$1",
		int32(variantID)).Scan(&entry) != nil {
		t.Fatal("catalogue entry read failed")
	}
	return entry
}

func (f *saleHTTPFixture) stock(t *testing.T, locationID, variantID int64) (existing, reserved int64) {
	t.Helper()
	if f.p.QueryRow(f.ctx, `SELECT existing,reserved FROM inventory_balances
 WHERE location_id=$1 AND variant_id=$2`, int16(locationID), int32(variantID)).Scan(&existing, &reserved) != nil {
		t.Fatal("balance read failed")
	}
	return existing, reserved
}

// availability reads the branch balance of one variant the way the catalogue publishes it:
// a missing row is the honest zero and not a failure, because the counter must still show
// the variant with nothing to sell.
func (f *saleHTTPFixture) availability(t *testing.T, locationID, variantID int64) (existing, reserved, available int64) {
	t.Helper()
	if f.p.QueryRow(f.ctx, `SELECT coalesce(max(existing),0),coalesce(max(reserved),0),
  coalesce(max(available),0) FROM inventory_balances WHERE location_id=$1 AND variant_id=$2`,
		int16(locationID), int32(variantID)).Scan(&existing, &reserved, &available) != nil {
		t.Fatal("balance read failed")
	}
	return existing, reserved, available
}

// zeroStockVariant is a variant the branch holds no stock of, so an exhausted sale is
// proven against the seed rather than against an invented number.
func (f *saleHTTPFixture) zeroStockVariant(t *testing.T, locationID int64) int64 {
	t.Helper()
	var variant int64
	if f.p.QueryRow(f.ctx, `SELECT variant_id FROM inventory_balances
 WHERE location_id=$1 AND existing=0 ORDER BY variant_id LIMIT 1`, int16(locationID)).Scan(&variant) != nil {
		t.Fatal("no zero-stock variant in this branch")
	}
	return variant
}

// snapshot captures every table this domain writes, so a refused request is proven to
// leave nothing behind, stock included.
func (f *saleHTTPFixture) snapshot(t *testing.T) string {
	t.Helper()
	var data string
	err := f.p.QueryRow(f.ctx, `SELECT jsonb_build_object(
  'sales',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]'::jsonb) FROM sales s),
  'lines',(SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.sale_id,l.variant_id),'[]'::jsonb) FROM sale_lines l),
  'balances',(SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.location_id,b.variant_id),'[]'::jsonb) FROM inventory_balances b))::text`).Scan(&data)
	if err != nil {
		t.Fatal("sale snapshot failed")
	}
	return data
}

func (f *saleHTTPFixture) request(actor int, verb, path, body string) *http.Request {
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

func (f *saleHTTPFixture) serve(t *testing.T, r *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("sale security headers changed")
	}
	return w
}

// rejected proves a refused request wrote nothing anywhere.
func (f *saleHTTPFixture) rejected(t *testing.T, r *http.Request, status int, code string) {
	t.Helper()
	before := f.snapshot(t)
	w := f.serve(t, r)
	expectTransferError(t, w, status, code)
	if f.snapshot(t) != before {
		t.Fatal("a rejected sale request changed stored state")
	}
}

// rejectedLine proves a refused line names its variant and wrote nothing anywhere.
func (f *saleHTTPFixture) rejectedLine(t *testing.T, r *http.Request, code string, variantID int64) {
	t.Helper()
	before := f.snapshot(t)
	w := f.serve(t, r)
	var body map[string]json.RawMessage
	if w.Code != 409 || json.Unmarshal(w.Body.Bytes(), &body) != nil || len(body) != 2 ||
		string(body["error"]) != `"`+code+`"` ||
		string(body["variant_id"]) != fmt.Sprintf("%d", variantID) {
		t.Fatalf("%s must name variant %d: %d %s", code, variantID, w.Code, w.Body.String())
	}
	if f.snapshot(t) != before {
		t.Fatal("a refused sale request changed stored state")
	}
}

var saleMoneyWire = regexp.MustCompile(`^"[0-9]+\.[0-9]{2}"$`)
var saleCapacityWire = regexp.MustCompile(`^"[1-9][0-9]*(\.[0-9]*[1-9])?"$`)

// saleCreatedWire admits only the frozen creation shape: one key holding ten document
// keys, a three-key client, six-key lines and canonical money.
// salePaymentsWire admits only the published settlement: one payment per admitted method at
// most, each admitted method once, in the frozen order cash, card, transfer, QR, with canonical
// money. The order and the count are read from the domain, so the fourth method is legible here
// without restating it.
func salePaymentsWire(t *testing.T, raw json.RawMessage) []salePaymentDTO {
	t.Helper()
	var rows []map[string]json.RawMessage
	if json.Unmarshal(raw, &rows) != nil || len(rows) < 1 || len(rows) > len(sales.PaymentMethods()) {
		t.Fatalf("settlement must be an array of at most one payment per admitted method: %s", raw)
	}
	frozen := make(map[string]int, len(sales.PaymentMethods()))
	for rank, method := range sales.PaymentMethods() {
		frozen[string(method)] = rank
	}
	previous := -1
	for _, row := range rows {
		if len(row) != 2 {
			t.Fatalf("payment whitelist changed: %s", raw)
		}
		var method string
		if json.Unmarshal(row["method"], &method) != nil {
			t.Fatalf("payment method must be text: %s", raw)
		}
		rank, ok := frozen[method]
		if !ok || rank <= previous {
			t.Fatalf("payment method must be one admitted method once, in order: %s", raw)
		}
		if !saleMoneyWire.MatchString(string(row["amount"])) {
			t.Fatalf("payment amount must be canonical money text: %s", raw)
		}
		previous = rank
	}
	var payments []salePaymentDTO
	if json.Unmarshal(raw, &payments) != nil || len(payments) != len(rows) {
		t.Fatalf("settlement is not decodable: %s", raw)
	}
	return payments
}

// saleCustomerWire admits only the client of the warranty: exactly name, phone, document
// and the free-text address of the sale.
func saleCustomerWire(t *testing.T, raw json.RawMessage) saleCustomerDTO {
	t.Helper()
	var customer map[string]json.RawMessage
	if json.Unmarshal(raw, &customer) != nil || len(customer) != 4 {
		t.Fatalf("client whitelist changed: %s", raw)
	}
	for _, key := range []string{"name", "phone", "document", "address"} {
		if _, ok := customer[key]; !ok {
			t.Fatalf("client whitelist incomplete: %s", key)
		}
	}
	var address string
	if json.Unmarshal(customer["address"], &address) != nil {
		t.Fatalf("client address must be text: %s", raw)
	}
	if len([]rune(address)) > sales.MaxCustomerAddress {
		t.Fatalf("client address is outside its bound: %q", address)
	}
	var client saleCustomerDTO
	if json.Unmarshal(raw, &client) != nil || client.Name == "" {
		t.Fatalf("client is not decodable: %s", raw)
	}
	return client
}

// saleUnitsWire admits only the published units of one line: exactly serial_number and
// warranty_months per unit, one unit per sold piece, a bounded serial and a term that is
// either an integer 1..120 or JSON null. Zero months is never the absence of warranty.
func saleUnitsWire(t *testing.T, raw json.RawMessage, quantity int64) []saleUnitDTO {
	t.Helper()
	var rows []map[string]json.RawMessage
	if json.Unmarshal(raw, &rows) != nil || rows == nil {
		t.Fatalf("units are not an array: %s", raw)
	}
	if int64(len(rows)) != quantity {
		t.Fatalf("one unit per sold piece required, got %d of %d: %s", len(rows), quantity, raw)
	}
	for _, row := range rows {
		if len(row) != 2 {
			t.Fatalf("unit whitelist changed: %s", raw)
		}
		var serial string
		if json.Unmarshal(row["serial_number"], &serial) != nil {
			t.Fatalf("serial_number must be text: %s", raw)
		}
		if trimmed := strings.TrimSpace(serial); trimmed == "" || len([]rune(trimmed)) > sales.MaxSerialLength {
			t.Fatalf("serial_number is outside its bounds: %q", serial)
		}
		term, present := row["warranty_months"]
		if !present {
			t.Fatalf("warranty_months must always be present: %s", raw)
		}
		if string(term) == "null" {
			continue
		}
		var months int
		if json.Unmarshal(term, &months) != nil || months < sales.MinWarrantyMonths ||
			months > sales.MaxWarrantyMonths {
			t.Fatalf("warranty_months must be 1..120 or null: %s", term)
		}
	}
	var units []saleUnitDTO
	if json.Unmarshal(raw, &units) != nil || len(units) != len(rows) {
		t.Fatalf("units are not decodable: %s", raw)
	}
	return units
}

func saleCreatedWire(t *testing.T, w *httptest.ResponseRecorder) saleDTO {
	t.Helper()
	if w.Code != 201 || w.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("creation response mismatch: status=%d body=%s", w.Code, w.Body.String())
	}
	var top map[string]json.RawMessage
	if json.Unmarshal(w.Body.Bytes(), &top) != nil || len(top) != 1 {
		t.Fatal("creation whitelist changed")
	}
	var document map[string]json.RawMessage
	if json.Unmarshal(top["sale"], &document) != nil || len(document) != 11 {
		t.Fatal("document whitelist changed")
	}
	for _, key := range []string{"id", "branch_location_id", "branch_sequence", "warranty_number",
		"payment_method", "payments", "customer", "total", "created_by_account_id", "created_at", "lines"} {
		if _, ok := document[key]; !ok {
			t.Fatalf("document whitelist incomplete: %s", key)
		}
	}
	for _, key := range []string{"total"} {
		if !saleMoneyWire.MatchString(string(document[key])) {
			t.Fatalf("%s must be canonical money text", key)
		}
	}
	payments := salePaymentsWire(t, document["payments"])
	saleCustomerWire(t, document["customer"])
	var lines []map[string]json.RawMessage
	if json.Unmarshal(document["lines"], &lines) != nil || lines == nil {
		t.Fatal("document lines are not an array")
	}
	for _, line := range lines {
		if len(line) != 6 {
			t.Fatal("line whitelist changed")
		}
		for _, key := range []string{"variant_id", "quantity", "unit_price", "min_price",
			"units", "subtotal"} {
			if _, ok := line[key]; !ok {
				t.Fatalf("line whitelist incomplete: %s", key)
			}
		}
		for _, key := range []string{"unit_price", "min_price", "subtotal"} {
			if !saleMoneyWire.MatchString(string(line[key])) {
				t.Fatalf("%s must be canonical money text", key)
			}
		}
		// The answered line no longer carries a term of its own: the units do.
		if _, ok := line["warranty_months"]; ok {
			t.Fatal("the answered line must not carry a line-level warranty term")
		}
		var quantity int64
		if json.Unmarshal(line["quantity"], &quantity) != nil {
			t.Fatal("quantity must be a number")
		}
		saleUnitsWire(t, line["units"], quantity)
	}
	var record saleDTO
	if json.Unmarshal(top["sale"], &record) != nil || len(record.Payments) != len(payments) {
		t.Fatal("created sale is not decodable")
	}
	return record
}

// salePageWire admits only the frozen history shape: four page keys and eight row keys.
func salePageWire(t *testing.T, w *httptest.ResponseRecorder) salePageDTO {
	t.Helper()
	if w.Code != 200 || w.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("history response mismatch: status=%d body=%s", w.Code, w.Body.String())
	}
	var top map[string]json.RawMessage
	if json.Unmarshal(w.Body.Bytes(), &top) != nil || len(top) != 4 {
		t.Fatal("history whitelist changed")
	}
	for _, key := range []string{"page", "page_size", "total_sales", "sales"} {
		if _, ok := top[key]; !ok {
			t.Fatalf("history whitelist incomplete: %s", key)
		}
	}
	var rows []map[string]json.RawMessage
	if json.Unmarshal(top["sales"], &rows) != nil || rows == nil {
		t.Fatal("history rows are not an array")
	}
	for _, row := range rows {
		if len(row) != 10 {
			t.Fatal("history row whitelist changed")
		}
		for _, key := range []string{"id", "branch_sequence", "warranty_number", "payment_method",
			"customer_name", "total", "created_at", "lines", "units_total", "units_with_warranty"} {
			if _, ok := row[key]; !ok {
				t.Fatalf("history row whitelist incomplete: %s", key)
			}
		}
		if !saleMoneyWire.MatchString(string(row["total"])) {
			t.Fatal("total must be canonical money text")
		}
		// The history never carries prices of its own: the counts are numbers.
		for _, key := range []string{"lines", "units_total", "units_with_warranty"} {
			if !regexp.MustCompile(`^[0-9]+$`).MatchString(string(row[key])) {
				t.Fatalf("%s must be a count in the history", key)
			}
		}
		// S5: the counts tell the sale's position without unfolding it, and the warranted
		// units are a subset of all of them. A sale issued before the sold unit existed
		// (T12) is a legible row with zero units; a row with some units but fewer than its
		// lines is not.
		var lines, total, warranted int64
		if json.Unmarshal(row["lines"], &lines) != nil ||
			json.Unmarshal(row["units_total"], &total) != nil ||
			json.Unmarshal(row["units_with_warranty"], &warranted) != nil ||
			lines < 1 || total > sales.MaxUnits || (total != 0 && total < lines) ||
			warranted > total {
			t.Fatalf("the unit counts are not a legible row: %s", row["units_total"])
		}
	}
	var page salePageDTO
	if json.Unmarshal(w.Body.Bytes(), &page) != nil || len(page.Sales) != len(rows) {
		t.Fatal("history response is not decodable")
	}
	return page
}

// saleDetailWire admits only the frozen document shape: ten header keys and eleven line
// keys, with canonical money and capacity as text.
func saleDetailWire(t *testing.T, w *httptest.ResponseRecorder) saleDetailDTO {
	t.Helper()
	if w.Code != 200 || w.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("document response mismatch: status=%d body=%s", w.Code, w.Body.String())
	}
	var top map[string]json.RawMessage
	if json.Unmarshal(w.Body.Bytes(), &top) != nil || len(top) != 10 {
		t.Fatal("document whitelist changed")
	}
	for _, key := range []string{"id", "branch_sequence", "warranty_number", "payment_method",
		"payments", "customer_name", "customer", "total", "created_at", "lines"} {
		if _, ok := top[key]; !ok {
			t.Fatalf("document whitelist incomplete: %s", key)
		}
	}
	if !saleMoneyWire.MatchString(string(top["total"])) {
		t.Fatal("total must be canonical money text")
	}
	payments := salePaymentsWire(t, top["payments"])
	saleCustomerWire(t, top["customer"])
	var lines []map[string]json.RawMessage
	if json.Unmarshal(top["lines"], &lines) != nil || lines == nil {
		t.Fatal("document lines are not an array")
	}
	for _, line := range lines {
		if len(line) != 11 {
			t.Fatal("document line whitelist changed")
		}
		for _, key := range []string{"variant_id", "catalog_entry_id", "brand", "model",
			"capacity_ah", "polarity", "quantity", "unit_price", "min_price",
			"units", "subtotal"} {
			if _, ok := line[key]; !ok {
				t.Fatalf("document line whitelist incomplete: %s", key)
			}
		}
		for _, key := range []string{"unit_price", "min_price", "subtotal"} {
			if !saleMoneyWire.MatchString(string(line[key])) {
				t.Fatalf("%s must be canonical money text", key)
			}
		}
		if !saleCapacityWire.MatchString(string(line["capacity_ah"])) {
			t.Fatal("capacity_ah must be the canonical capacity as a string")
		}
		var quantity int64
		if json.Unmarshal(line["quantity"], &quantity) != nil {
			t.Fatal("quantity must be a number")
		}
		saleUnitsWire(t, line["units"], quantity)
	}
	var detail saleDetailDTO
	if json.Unmarshal(w.Body.Bytes(), &detail) != nil || len(detail.Lines) != len(lines) ||
		len(detail.Payments) != len(payments) {
		t.Fatal("document response is not decodable")
	}
	return detail
}

// saleSellableWire admits only the frozen catalogue shape: four page keys and twelve item
// keys. A variant the branch cannot sell is a row too: `sellable` is false and both prices
// are JSON null, because the counter shows the blocked row instead of hiding it.
func saleSellableWire(t *testing.T, w *httptest.ResponseRecorder) saleSellablePageDTO {
	t.Helper()
	if w.Code != 200 || w.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("catalogue response mismatch: status=%d body=%s", w.Code, w.Body.String())
	}
	var top map[string]json.RawMessage
	if json.Unmarshal(w.Body.Bytes(), &top) != nil || len(top) != 4 {
		t.Fatal("catalogue whitelist changed")
	}
	for _, key := range []string{"page", "page_size", "total_variants", "items"} {
		if _, ok := top[key]; !ok {
			t.Fatalf("catalogue whitelist incomplete: %s", key)
		}
	}
	var items []map[string]json.RawMessage
	if json.Unmarshal(top["items"], &items) != nil || items == nil {
		t.Fatal("catalogue items are not an array")
	}
	for _, item := range items {
		if len(item) != 12 {
			t.Fatal("catalogue item whitelist changed")
		}
		for _, key := range []string{"variant_id", "catalog_entry_id", "brand", "model",
			"capacity_ah", "polarity", "sellable", "suggested_price", "min_price",
			"existing", "reserved", "available"} {
			if _, ok := item[key]; !ok {
				t.Fatalf("catalogue item whitelist incomplete: %s", key)
			}
		}
		var sellable bool
		if json.Unmarshal(item["sellable"], &sellable) != nil {
			t.Fatal("sellable must be a boolean")
		}
		for _, key := range []string{"suggested_price", "min_price"} {
			if string(item[key]) == "null" {
				if sellable {
					t.Fatalf("a sellable variant must publish %s: %s", key, item[key])
				}
				continue
			}
			if !saleMoneyWire.MatchString(string(item[key])) {
				t.Fatalf("%s must be canonical money text or null", key)
			}
		}
		// The availability is the ledger's own numbers, published as the inventory does.
		var existing, reserved, available int64
		if json.Unmarshal(item["existing"], &existing) != nil ||
			json.Unmarshal(item["reserved"], &reserved) != nil ||
			json.Unmarshal(item["available"], &available) != nil ||
			existing < 0 || reserved < 0 || reserved > existing || available != existing-reserved {
			t.Fatalf("availability must be the branch balance: %s", item["available"])
		}
		if !saleCapacityWire.MatchString(string(item["capacity_ah"])) {
			t.Fatal("capacity_ah must be the canonical capacity as a string")
		}
		// The warranty term is the seller's datum of the sale, never a catalogue one.
		if _, ok := item["warranty_months"]; ok {
			t.Fatal("the catalogue must not carry a warranty term")
		}
	}
	var page saleSellablePageDTO
	if json.Unmarshal(w.Body.Bytes(), &page) != nil || len(page.Items) != len(items) {
		t.Fatal("catalogue response is not decodable")
	}
	return page
}

// TestSaleHTTPCreateAndDetail pins S9 and S10 over a real sale: the created document
// freezes the charged price and the branch minimum, the branch correlative and the
// warranty number are the database's own, and changing the price afterwards does not
// alter the emitted document.
func TestSaleHTTPCreateAndDetail(t *testing.T) {
	f := saleFixture(t)
	entry := f.entryOf(t, 1)
	// Two branches hold a pair, so the numbering of each one is proven to be its own.
	f.price(t, entry, "85000", "96000", 2, 3)
	existing, reserved := f.stock(t, 2, 1)
	if existing < 2 {
		t.Fatalf("fixture expects stock to sell, got %d", existing)
	}
	created := saleCreatedWire(t, f.serve(t, f.request(2, "POST", "/api/sales", saleBody(1, 2, "96000.00", 6))))
	if created.ID < 1 || created.BranchLocationID != 2 || created.BranchSequence != 1 ||
		created.WarrantyNumber != "2-000001" || created.PaymentMethod != "cash" ||
		created.Customer.Name != "Cliente Mostrador" || created.Customer.Phone != "700-00000" ||
		created.Customer.Document != "V-123" || created.Total != "192000.00" ||
		created.CreatedByAccountID != 2 || created.CreatedAt == "" {
		t.Fatalf("the created sale does not match the frozen contract: %+v", created)
	}
	if len(created.Payments) != 1 || created.Payments[0].Method != "cash" ||
		created.Payments[0].Amount != "192000.00" {
		t.Fatalf("the created sale must publish its settlement: %+v", created.Payments)
	}
	if len(created.Lines) != 1 {
		t.Fatalf("the created sale must keep its line: %+v", created.Lines)
	}
	line := created.Lines[0]
	// S9: the charged price and the branch minimum are frozen at write time.
	if line.VariantID != 1 || line.Quantity != 2 || line.UnitPrice != "96000.00" ||
		line.MinPrice != "85000.00" || line.Subtotal != "192000.00" || len(line.Units) != 2 {
		t.Fatalf("the created line does not freeze the pair: %+v", line)
	}
	// S2-S4: each sold piece is its own unit, with the serial the seller read and the same
	// term the counter stated for the line.
	if unit := line.Units[0]; unit.WarrantyMonths == nil || *unit.WarrantyMonths != 6 {
		t.Fatalf("the created unit must carry its term: %+v", unit)
	}
	if line.Units[0].SerialNumber == line.Units[1].SerialNumber || line.Units[0].SerialNumber == "" {
		t.Fatalf("each unit must carry its own serial: %+v", line.Units)
	}
	// S1: the address of the sale comes back with the client of the warranty.
	if created.Customer.Address != "Av. Colón 1234" {
		t.Fatalf("the created sale must carry its address: %+v", created.Customer)
	}
	if got, gotReserved := f.stock(t, 2, 1); got != existing-2 || gotReserved != reserved {
		t.Fatalf("the sale must decrement existing stock only: %d/%d", got, gotReserved)
	}
	// The next sale of the branch takes the next correlative, and another branch starts
	// its own numbering (S10).
	second := saleCreatedWire(t, f.serve(t, f.request(2, "POST", "/api/sales", saleBody(1, 1, "96000.00", 3))))
	if second.BranchSequence != 2 || second.WarrantyNumber != "2-000002" {
		t.Fatalf("the branch correlative must advance: %+v", second)
	}
	other := saleCreatedWire(t, f.serve(t, f.request(3, "POST", "/api/sales", saleBody(1, 1, "96000.00", 12))))
	if other.BranchLocationID != 3 || other.BranchSequence != 1 || other.WarrantyNumber != "3-000001" {
		t.Fatalf("a branch never shares another branch's numbering: %+v", other)
	}
	// S9: the detail reads the document with the catalogue identity of its line and the
	// prices of the sale, and a later price change does not alter it.
	detail := saleDetailWire(t, f.serve(t, f.request(2, "GET", fmt.Sprintf("/api/sales/%d", created.ID), "")))
	if detail.ID != created.ID || detail.BranchSequence != 1 || detail.WarrantyNumber != "2-000001" ||
		detail.PaymentMethod != "cash" || detail.CustomerName != "Cliente Mostrador" ||
		detail.Total != "192000.00" || detail.CreatedAt != created.CreatedAt || len(detail.Lines) != 1 {
		t.Fatalf("the document does not match the frozen contract: %+v", detail)
	}
	// The detail carries the client of the warranty and the settlement of the document.
	if detail.Customer.Name != "Cliente Mostrador" || detail.Customer.Phone != "700-00000" ||
		detail.Customer.Document != "V-123" || len(detail.Payments) != 1 ||
		detail.Payments[0].Method != "cash" || detail.Payments[0].Amount != "192000.00" {
		t.Fatalf("the document must carry its client and its settlement: %+v", detail)
	}
	resolved := detail.Lines[0]
	if resolved.VariantID != 1 || resolved.CatalogEntryID != entry || resolved.Brand != "CAR" ||
		resolved.Model != "NS40ZL" || resolved.Capacity != "35" || resolved.Polarity != "L" ||
		resolved.Quantity != 2 || resolved.UnitPrice != "96000.00" || resolved.MinPrice != "85000.00" ||
		resolved.Subtotal != "192000.00" || len(resolved.Units) != 2 {
		t.Fatalf("the document line must stay legible with the prices of the sale: %+v", resolved)
	}
	// The detail keeps the same units the creation answered, serial and term included.
	for i, unit := range resolved.Units {
		sold := created.Lines[0].Units[i]
		if unit.SerialNumber != sold.SerialNumber ||
			(unit.WarrantyMonths == nil) != (sold.WarrantyMonths == nil) ||
			(unit.WarrantyMonths != nil && *unit.WarrantyMonths != *sold.WarrantyMonths) {
			t.Fatalf("the detail must carry the units of the sale: %+v want %+v", resolved.Units, created.Lines[0].Units)
		}
	}
	f.price(t, entry, "99000", "100000", 2)
	after := saleDetailWire(t, f.serve(t, f.request(2, "GET", fmt.Sprintf("/api/sales/%d", created.ID), "")))
	if after.Total != "192000.00" || after.Lines[0].UnitPrice != "96000.00" || after.Lines[0].MinPrice != "85000.00" {
		t.Fatalf("a price change must not alter an emitted document: %+v", after)
	}
	// The history of the branch is newest first and carries the line count.
	page := salePageWire(t, f.serve(t, f.request(2, "GET", "/api/sales", "")))
	if page.Page != 1 || page.PageSize != 25 || page.TotalSales != 2 || len(page.Sales) != 2 {
		t.Fatalf("the history of the branch must hold its two sales: %+v", page)
	}
	if page.Sales[0].ID != second.ID || page.Sales[1].ID != created.ID ||
		page.Sales[1].WarrantyNumber != "2-000001" || page.Sales[1].Lines != 1 ||
		page.Sales[1].Total != "192000.00" || page.Sales[1].CustomerName != "Cliente Mostrador" {
		t.Fatalf("the history rows do not match the frozen contract: %+v", page.Sales)
	}
	// S5: the row counts the physical units of the sale, so the history tells a sale without
	// warranty without unfolding it.
	if page.Sales[1].UnitsTotal != 2 || page.Sales[1].UnitsWithWarranty != 2 ||
		page.Sales[0].UnitsTotal != 1 || page.Sales[0].UnitsWithWarranty != 1 {
		t.Fatalf("the history rows must count the units of the sale: %+v", page.Sales)
	}
}

// TestSaleHTTPRefusals pins S1, S6, S7 and S8 on the counter: the warehouse never
// sells, a pending password change never sells, a variant without a price, a price
// under the floor and an uncovered stock all refuse the whole document without writing
// anything.
func TestSaleHTTPRefusals(t *testing.T) {
	f := saleFixture(t)
	f.price(t, f.entryOf(t, 1), "85000", "96000", 2)
	// S1: the warehouse has no point of sale.
	f.rejected(t, f.request(1, "POST", "/api/sales", saleBody(1, 1, "96000.00", 6)), 403, "forbidden")
	f.rejected(t, f.request(1, "GET", "/api/sales", ""), 403, "forbidden")
	// A session that still must change its password never sells.
	if _, err := f.p.Exec(f.ctx, "UPDATE auth_accounts SET must_change_password=true WHERE id=3"); err != nil {
		t.Fatal("pending password fixture failed")
	}
	f.rejected(t, f.request(3, "POST", "/api/sales", saleBody(1, 1, "96000.00", 6)), 403, "forbidden")
	if _, err := f.p.Exec(f.ctx, "UPDATE auth_accounts SET must_change_password=false WHERE id=3"); err != nil {
		t.Fatal("pending password fixture reset failed")
	}
	// S7: a variant whose battery has no price in this branch is not sellable, and the
	// refusal names it.
	unpriced := int64(3)
	if f.entryOf(t, unpriced) == f.entryOf(t, 1) {
		t.Fatal("the fixture needs two different batteries")
	}
	f.rejectedLine(t, f.request(2, "POST", "/api/sales", saleBody(unpriced, 1, "96000.00", 6)),
		"variant_not_sellable", unpriced)
	// S6: the branch minimum is a floor.
	f.rejectedLine(t, f.request(2, "POST", "/api/sales", saleBody(1, 1, "84999.99", 6)),
		"below_minimum", 1)
	// S8: a branch can only sell what it holds.
	exhausted := f.zeroStockVariant(t, 2)
	f.price(t, f.entryOf(t, exhausted), "1000", "1200", 2)
	f.rejectedLine(t, f.request(2, "POST", "/api/sales", saleBody(exhausted, 1, "1200.00", 6)),
		"insufficient_stock", exhausted)
	// A document with one valid and one refused line writes nothing at all: the valid
	// line is the last word of the atomicity check.
	f.rejectedLine(t, f.request(2, "POST", "/api/sales",
		`{"payments":[{"method":"cash","amount":"97200.00"}],"customer":{"name":"C","phone":"","document":"","address":""},"lines":[`+
			`{"variant_id":1,"quantity":1,"unit_price":"96000.00","units":[{"serial_number":"ATOM-1","warranty_months":6}]},`+
			fmt.Sprintf(`{"variant_id":%d,"quantity":1,"unit_price":"1200.00","units":[{"serial_number":"ATOM-2","warranty_months":6}]}]}`, exhausted)),
		"insufficient_stock", exhausted)
	// The framing of a mutation is exact: no query string, no unknown key, no
	// non-canonical price and no term outside 1..120.
	f.rejected(t, f.request(2, "POST", "/api/sales?confirm=1", saleBody(1, 1, "96000.00", 6)), 400, "invalid_request")
	f.rejected(t, f.request(2, "POST", "/api/sales?",
		saleBody(1, 1, "96000.00", 6)), 400, "invalid_request")
	f.rejected(t, f.request(2, "POST", "/api/sales",
		`{"payments":[{"method":"cash","amount":"96000.00"}],"customer":{"name":"C","phone":"","document":"","address":""},"total":"1.00","lines":[{"variant_id":1,"quantity":1,"unit_price":"96000.00","units":[{"serial_number":"ATOM-4","warranty_months":6}]}]}`),
		400, "invalid_request")
	// The label is not an input anymore: the settlement is.
	f.rejected(t, f.request(2, "POST", "/api/sales",
		`{"payment_method":"cash","customer":{"name":"C","phone":"","document":"","address":""},"lines":[{"variant_id":1,"quantity":1,"unit_price":"96000.00","units":[{"serial_number":"ATOM-5","warranty_months":6}]}]}`),
		400, "invalid_request")
	// The derived label is never an input either, and a settlement cannot pay nothing.
	f.rejected(t, f.request(2, "POST", "/api/sales",
		`{"payments":[{"method":"mixed","amount":"96000.00"}],"customer":{"name":"C","phone":"","document":"","address":""},"lines":[{"variant_id":1,"quantity":1,"unit_price":"96000.00","units":[{"serial_number":"ATOM-6","warranty_months":6}]}]}`),
		400, "invalid_request")
	f.rejected(t, f.request(2, "POST", "/api/sales",
		`{"payments":[{"method":"cash","amount":"0.00"},{"method":"transfer","amount":"96000.00"}],"customer":{"name":"C","phone":"","document":"","address":""},"lines":[{"variant_id":1,"quantity":1,"unit_price":"96000.00","units":[{"serial_number":"ATOM-7","warranty_months":6}]}]}`),
		400, "invalid_request")
	f.rejected(t, f.request(2, "POST", "/api/sales", saleBody(1, 1, "96000", 6)), 400, "invalid_request")
	f.rejected(t, f.request(2, "POST", "/api/sales", saleBody(1, 1, "96000.00", 121)), 400, "invalid_request")
	// D3: the units are exactly as many as the quantity, and a sale whose units do not match
	// writes nothing at all.
	for name, body := range map[string]string{
		"units_short": `{"payments":[{"method":"cash","amount":"192000.00"}],"customer":{"name":"C","phone":"","document":"","address":""},"lines":[{"variant_id":1,"quantity":2,"unit_price":"96000.00","units":[{"serial_number":"REF-1","warranty_months":6}]}]}`,
		"units_long":  `{"payments":[{"method":"cash","amount":"192000.00"}],"customer":{"name":"C","phone":"","document":"","address":""},"lines":[{"variant_id":1,"quantity":2,"unit_price":"96000.00","units":[{"serial_number":"REF-2","warranty_months":6},{"serial_number":"REF-3","warranty_months":6},{"serial_number":"REF-4","warranty_months":6}]}]}`,
		// S2: a serial is mandatory, at most sixty-four characters and never a NUL.
		"blank_serial": `{"payments":[{"method":"cash","amount":"96000.00"}],"customer":{"name":"C","phone":"","document":"","address":""},"lines":[{"variant_id":1,"quantity":1,"unit_price":"96000.00","units":[{"serial_number":"   ","warranty_months":6}]}]}`,
		"long_serial":  fmt.Sprintf(`{"payments":[{"method":"cash","amount":"96000.00"}],"customer":{"name":"C","phone":"","document":"","address":""},"lines":[{"variant_id":1,"quantity":1,"unit_price":"96000.00","units":[{"serial_number":%q,"warranty_months":6}]}]}`, strings.Repeat("S", 65)),
		"nul_serial":   `{"payments":[{"method":"cash","amount":"96000.00"}],"customer":{"name":"C","phone":"","document":"","address":""},"lines":[{"variant_id":1,"quantity":1,"unit_price":"96000.00","units":[{"serial_number":"a\u0000b","warranty_months":6}]}]}`,
		// S3: the term is 1..120 or null, and there is no zero months.
		"zero_term":    `{"payments":[{"method":"cash","amount":"96000.00"}],"customer":{"name":"C","phone":"","document":"","address":""},"lines":[{"variant_id":1,"quantity":1,"unit_price":"96000.00","units":[{"serial_number":"REF-5","warranty_months":0}]}]}`,
		"absent_term":  `{"payments":[{"method":"cash","amount":"96000.00"}],"customer":{"name":"C","phone":"","document":"","address":""},"lines":[{"variant_id":1,"quantity":1,"unit_price":"96000.00","units":[{"serial_number":"REF-6"}]}]}`,
		"unit_unknown": `{"payments":[{"method":"cash","amount":"96000.00"}],"customer":{"name":"C","phone":"","document":"","address":""},"lines":[{"variant_id":1,"quantity":1,"unit_price":"96000.00","units":[{"serial_number":"REF-7","warranty_months":6,"price":"1.00"}]}]}`,
		"units_absent": `{"payments":[{"method":"cash","amount":"96000.00"}],"customer":{"name":"C","phone":"","document":"","address":""},"lines":[{"variant_id":1,"quantity":1,"unit_price":"96000.00"}]}`,
		// S1: the address is one bounded free field of the sale header.
		"long_address": fmt.Sprintf(`{"payments":[{"method":"cash","amount":"96000.00"}],"customer":{"name":"C","phone":"","document":"","address":%q},"lines":[{"variant_id":1,"quantity":1,"unit_price":"96000.00","units":[{"serial_number":"REF-8","warranty_months":6}]}]}`, strings.Repeat("ñ", sales.MaxCustomerAddress+1)),
		"no_address":   `{"payments":[{"method":"cash","amount":"96000.00"}],"customer":{"name":"C","phone":"","document":""},"lines":[{"variant_id":1,"quantity":1,"unit_price":"96000.00","units":[{"serial_number":"REF-9","warranty_months":6}]}]}`,
	} {
		t.Run(name, func(t *testing.T) {
			f.rejected(t, f.request(2, "POST", "/api/sales", body), 400, "invalid_request")
		})
	}
	// D2: one physical battery is sold once. The second sale of the same serial, spelled with
	// the padding the counter may type, is refused with its own code and names the battery.
	sold := saleCreatedWire(t, f.serve(t, f.request(2, "POST", "/api/sales", saleBody(1, 1, "96000.00", 6))))
	serial := sold.Lines[0].Units[0].SerialNumber
	repeated := fmt.Sprintf(`{"payments":[{"method":"cash","amount":"96000.00"}],`+
		`"customer":{"name":"C","phone":"","document":"","address":""},`+
		`"lines":[{"variant_id":1,"quantity":1,"unit_price":"96000.00","units":[{"serial_number":%q,"warranty_months":6}]}]}`,
		"  "+serial+"  ")
	before := f.snapshot(t)
	w := f.serve(t, f.request(2, "POST", "/api/sales", repeated))
	if w.Code != 409 || w.Body.String() != fmt.Sprintf(`{"error":"serial_already_sold","serial_number":%q}`+"\n", serial) {
		t.Fatalf("a repeated serial must name its battery: %d %s", w.Code, w.Body.String())
	}
	if f.snapshot(t) != before {
		t.Fatal("a repeated serial must not write a sale, a unit nor touch stock")
	}
	f.rejected(t, f.request(2, "POST", "/api/sales",
		`{"payments":[{"method":"cash","amount":"96000.00"}],"customer":{"name":"C","phone":"","document":"","address":""},"lines":[{"variant_id":1,"quantity":1,"unit_price":"96000.00"}]}`),
		400, "invalid_request")
	// The mutation guards are the house ones.
	for _, mutate := range []func(*http.Request){
		func(r *http.Request) { r.Header.Del("X-CSRF-Token") },
		func(r *http.Request) { r.Header.Set("Origin", "https://elsewhere.example") },
		func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") },
	} {
		r := f.request(2, "POST", "/api/sales", saleBody(1, 1, "96000.00", 6))
		mutate(r)
		f.rejected(t, r, 403, "forbidden")
	}
	f.rejected(t, f.request(0, "POST", "/api/sales", saleBody(1, 1, "96000.00", 6)), 401, "unauthenticated")
	// The reads are exact too.
	f.rejected(t, f.request(2, "GET", "/api/sales?page_size=15", ""), 400, "invalid_request")
	f.rejected(t, f.request(2, "GET", "/api/sales?payment_method=cheque", ""), 400, "invalid_request")
	f.rejected(t, f.request(2, "GET", "/api/sales/sellable?page_size=20", ""), 400, "invalid_request")
	f.rejected(t, f.request(2, "GET", "/api/sales/sellable?warranty_months=6", ""), 400, "invalid_request")
}

// TestSaleHTTPIsolation pins S1 and S10 on the read side: a branch never sees another
// branch's sale, neither in the history nor by document id.
func TestSaleHTTPIsolation(t *testing.T) {
	f := saleFixture(t)
	f.price(t, f.entryOf(t, 1), "85000", "96000", 2)
	created := saleCreatedWire(t, f.serve(t, f.request(2, "POST", "/api/sales", saleBody(1, 1, "96000.00", 6))))
	// The selling branch reads its own document.
	if detail := saleDetailWire(t, f.serve(t, f.request(2, "GET", fmt.Sprintf("/api/sales/%d", created.ID), ""))); detail.ID != created.ID {
		t.Fatalf("the selling branch must read its own document: %+v", detail)
	}
	// Another branch does not, by id and in its history.
	f.rejected(t, f.request(3, "GET", fmt.Sprintf("/api/sales/%d", created.ID), ""), 404, "not_found")
	other := salePageWire(t, f.serve(t, f.request(3, "GET", "/api/sales", "")))
	if other.TotalSales != 0 || len(other.Sales) != 0 {
		t.Fatalf("a branch must not see another branch's history: %+v", other)
	}
	// An unknown and an impossible id are not found, never described.
	f.rejected(t, f.request(2, "GET", "/api/sales/999999", ""), 404, "not_found")
	f.rejected(t, f.request(2, "GET", "/api/sales/0", ""), 404, "not_found")
	f.rejected(t, f.request(2, "GET", "/api/sales/abc", ""), 404, "not_found")
	// So is the warranty of another branch's sale: a document is not readable, neither
	// through its detail nor through its PDF.
	f.rejected(t, f.request(3, "GET", fmt.Sprintf("/api/sales/%d", created.ID)+"/warranty.pdf", ""), 404, "not_found")
	// A query string on the document read is a framing error.
	f.rejected(t, f.request(2, "GET", fmt.Sprintf("/api/sales/%d?page=1", created.ID), ""), 400, "invalid_request")
}

// TestSaleHTTPHistoryPagination pins the frozen page sizes and the newest-first page.
func TestSaleHTTPHistoryPagination(t *testing.T) {
	f := saleFixture(t)
	f.price(t, f.entryOf(t, 1), "85000", "96000", 2)
	ids := make([]int64, 0, 3)
	for i := 0; i < 3; i++ {
		ids = append(ids, saleCreatedWire(t, f.serve(t, f.request(2, "POST", "/api/sales", saleBody(1, 1, "96000.00", 6)))).ID)
	}
	first := salePageWire(t, f.serve(t, f.request(2, "GET", "/api/sales?page=1&page_size=10", "")))
	if first.Page != 1 || first.PageSize != 10 || first.TotalSales != 3 || len(first.Sales) != 3 {
		t.Fatalf("the first page does not match the frozen contract: %+v", first)
	}
	for i := 0; i < 3; i++ {
		if first.Sales[i].ID != ids[2-i] {
			t.Fatalf("the history must be newest first: %+v", first.Sales)
		}
	}
	if first.Sales[0].WarrantyNumber != "2-000003" || first.Sales[0].Lines != 1 {
		t.Fatalf("the newest row must be the last sale: %+v", first.Sales[0])
	}
	// A page beyond the last one is legitimately empty, and every admitted size works.
	for _, size := range []string{"10", "25", "50"} {
		page := salePageWire(t, f.serve(t, f.request(2, "GET", "/api/sales?page_size="+size, "")))
		if page.PageSize != map[string]int{"10": 10, "25": 25, "50": 50}[size] || page.TotalSales != 3 {
			t.Fatalf("page size %s was not admitted: %+v", size, page)
		}
	}
	empty := salePageWire(t, f.serve(t, f.request(2, "GET", "/api/sales?page=2&page_size=10", "")))
	if empty.TotalSales != 3 || len(empty.Sales) != 0 || empty.Sales == nil {
		t.Fatalf("a page beyond the last one must be empty: %+v", empty)
	}
	// The search is literal and the payment method is a filter, both scoped to the
	// branch.
	if page := salePageWire(t, f.serve(t, f.request(2, "GET", "/api/sales?search=2-000002", ""))); page.TotalSales != 1 {
		t.Fatalf("the literal search must find the warranty number: %+v", page)
	}
	if page := salePageWire(t, f.serve(t, f.request(2, "GET", "/api/sales?payment_method=card", ""))); page.TotalSales != 0 {
		t.Fatalf("the payment filter must exclude cash sales: %+v", page)
	}
}

// TestSaleHTTPSellable pins S7 on the catalogue: every variant of the catalogue comes back
// once with the stock of the branch and whether the branch can sell it right now, so the
// counter can show a blocked row with its action disabled instead of hiding it, and the
// two polarities of one battery always carry the same pair.
func TestSaleHTTPSellable(t *testing.T) {
	f := saleFixture(t)
	entry := f.entryOf(t, 1)
	f.price(t, entry, "85000", "96000", 2)
	const variants = 190 // every battery of the catalogue has two polarities
	page := saleSellableWire(t, f.serve(t, f.request(2, "GET", "/api/sales/sellable?page_size=10", "")))
	if page.Page != 1 || page.PageSize != 10 || page.TotalVariants != variants || len(page.Items) != 10 {
		t.Fatalf("the catalogue must page every variant and count them all: %+v", page)
	}
	// The first two rows are the two polarities of the priced battery, both sellable at
	// the same pair.
	for i, item := range page.Items[:2] {
		if item.VariantID != int64(i+1) || item.CatalogEntryID != entry || !item.Sellable ||
			item.Brand != "CAR" || item.Model != "NS40ZL" || item.Capacity != "35" ||
			item.Polarity != []string{"L", "R"}[i] ||
			item.SuggestedPrice == nil || *item.SuggestedPrice != "96000.00" ||
			item.MinPrice == nil || *item.MinPrice != "85000.00" {
			t.Fatalf("both polarities must be offered at the battery pair: %+v", item)
		}
	}
	// The availability of a row is the branch's own balance, never a number invented here.
	existing, reserved, available := f.availability(t, 2, 1)
	if first := page.Items[0]; first.Existing != existing || first.Reserved != reserved ||
		first.Available != available {
		t.Fatalf("the row must carry the branch balance: %+v want %d/%d/%d", first, existing, reserved, available)
	}
	// A battery without a price is present and blocked: `sellable: false`, both prices null
	// and its real availability, which is what lets the counter disable the row.
	unpriced := f.entryOf(t, 3)
	wide := saleSellableWire(t, f.serve(t, f.request(2, "GET", "/api/sales/sellable?page_size=50", "")))
	blocked := 0
	for _, item := range wide.Items {
		if item.CatalogEntryID != unpriced {
			continue
		}
		blocked++
		gotExisting, gotReserved, gotAvailable := f.availability(t, 2, item.VariantID)
		if item.Sellable || item.SuggestedPrice != nil || item.MinPrice != nil ||
			item.Existing != gotExisting || item.Reserved != gotReserved ||
			item.Available != gotAvailable {
			t.Fatalf("an unpriced variant must be published blocked: %+v", item)
		}
	}
	if blocked != 2 {
		t.Fatalf("both polarities of the unpriced battery must be present, got %d", blocked)
	}
	// The polarity filter and the literal search are the frozen ones, and the total counts
	// every matching variant, priced or not.
	one := saleSellableWire(t, f.serve(t, f.request(2, "GET", "/api/sales/sellable?polarity=L&search=ns40zl&brand=CAR&capacity=35", "")))
	if one.TotalVariants != 1 || len(one.Items) != 1 || one.Items[0].VariantID != 1 {
		t.Fatalf("the catalogue filters must name one variant: %+v", one)
	}
	if left := saleSellableWire(t, f.serve(t, f.request(2, "GET", "/api/sales/sellable?polarity=R", ""))); left.TotalVariants != 95 {
		t.Fatalf("one polarity of every battery must be counted: %+v", left)
	}
	if none := saleSellableWire(t, f.serve(t, f.request(2, "GET", "/api/sales/sellable?search=zzz", ""))); none.TotalVariants != 0 || len(none.Items) != 0 {
		t.Fatalf("a search with no match must be empty: %+v", none)
	}
	// A branch without prices can sell nothing, but every row is still served blocked, and
	// the warehouse is not a point of sale.
	empty := saleSellableWire(t, f.serve(t, f.request(3, "GET", "/api/sales/sellable?page_size=50", "")))
	if empty.TotalVariants != variants || len(empty.Items) != 50 {
		t.Fatalf("a branch without prices still sees the whole catalogue: %+v", empty)
	}
	for _, item := range empty.Items {
		if item.Sellable || item.SuggestedPrice != nil || item.MinPrice != nil {
			t.Fatalf("a branch without prices sells nothing: %+v", item)
		}
	}
	f.rejected(t, f.request(1, "GET", "/api/sales/sellable", ""), 403, "forbidden")
	f.rejected(t, f.request(0, "GET", "/api/sales/sellable", ""), 401, "unauthenticated")
}

// saleMixedBody is one document settled with cash and transfer, stated transfer first so
// the frozen order of the answer is proven to be the store's and not the client's.
func saleMixedBody(variantID, quantity int64, cash, transfer string) string {
	return fmt.Sprintf(`{"payments":[{"method":"transfer","amount":%q},`+
		`{"method":"cash","amount":%q}],`+
		`"customer":{"name":"Cliente Mostrador","phone":"700-00000","document":"V-123","address":"Barrio Norte"},`+
		`"lines":[{"variant_id":%d,"quantity":%d,"unit_price":"96000.00","units":%s}]}`,
		transfer, cash, variantID, quantity, saleUnitsJSON(quantity, 6))
}

// saleSettlementBody is one document settled exactly as `payments` states it, so a QR sale and
// a cash-and-QR sale need no other fixture helper.
func saleSettlementBody(variantID, quantity int64, payments string) string {
	return fmt.Sprintf(`{"payments":%s,`+
		`"customer":{"name":"Cliente Mostrador","phone":"700-00000","document":"V-123","address":"Barrio Norte"},`+
		`"lines":[{"variant_id":%d,"quantity":%d,"unit_price":"96000.00","units":%s}]}`,
		payments, variantID, quantity, saleUnitsJSON(quantity, 6))
}

// rejectedMismatch proves a settlement that does not close is answered with the open side
// and writes nothing at all.
func (f *saleHTTPFixture) rejectedMismatch(t *testing.T, r *http.Request, want string) {
	t.Helper()
	before := f.snapshot(t)
	w := f.serve(t, r)
	if w.Code != 400 || w.Body.String() != want+"\n" ||
		w.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("an open settlement must name its side: %d %s", w.Code, w.Body.String())
	}
	if f.snapshot(t) != before {
		t.Fatal("a refused settlement changed stored state")
	}
}

// TestSaleHTTPMixedPayment pins S16 over HTTP: one document can be settled partly in cash
// and partly by transfer, both amounts come back in the frozen order under the label the
// amounts derive, the history filters that label, and a settlement that does not close is
// refused with the amount that is missing or over.
func TestSaleHTTPMixedPayment(t *testing.T) {
	f := saleFixture(t)
	f.price(t, f.entryOf(t, 1), "85000", "96000", 2)
	// One unit at 96000.00, paid as 40000.00 in cash and 56000.00 by transfer.
	created := saleCreatedWire(t, f.serve(t, f.request(2, "POST", "/api/sales",
		saleMixedBody(1, 1, "40000.00", "56000.00"))))
	if created.PaymentMethod != "mixed" || created.Total != "96000.00" || len(created.Payments) != 2 ||
		created.Payments[0] != (salePaymentDTO{Method: "cash", Amount: "40000.00"}) ||
		created.Payments[1] != (salePaymentDTO{Method: "transfer", Amount: "56000.00"}) {
		t.Fatalf("a mixed sale must publish both amounts in the frozen order: %+v", created)
	}
	// The detail carries the same settlement, so the warranty can print one row per method.
	detail := saleDetailWire(t, f.serve(t, f.request(2, "GET", fmt.Sprintf("/api/sales/%d", created.ID), "")))
	if detail.PaymentMethod != "mixed" || len(detail.Payments) != 2 ||
		detail.Payments[0] != created.Payments[0] || detail.Payments[1] != created.Payments[1] {
		t.Fatalf("the detail must carry the settlement of the sale: %+v", detail.Payments)
	}
	// The history filter accepts the derived label, and only that label selects the row.
	if mixed := salePageWire(t, f.serve(t, f.request(2, "GET", "/api/sales?payment_method=mixed", ""))); mixed.TotalSales != 1 || len(mixed.Sales) != 1 || mixed.Sales[0].PaymentMethod != "mixed" ||
		mixed.Sales[0].ID != created.ID {
		t.Fatalf("the history must filter a mixed sale by its label: %+v", mixed)
	}
	for _, method := range []string{"cash", "card", "transfer"} {
		if other := salePageWire(t, f.serve(t, f.request(2, "GET", "/api/sales?payment_method="+method, ""))); other.TotalSales != 0 {
			t.Fatalf("a %s filter must not select a mixed sale: %+v", method, other)
		}
	}
	// Below the total the refusal names what is missing, above it what was charged too
	// much; neither writes a sale nor touches the stock.
	f.rejectedMismatch(t, f.request(2, "POST", "/api/sales",
		saleMixedBody(1, 1, "40000.00", "10000.00")),
		`{"error":"payments_mismatch","missing":"46000.00"}`)
	f.rejectedMismatch(t, f.request(2, "POST", "/api/sales",
		saleMixedBody(1, 1, "40000.00", "60000.00")),
		`{"error":"payments_mismatch","excess":"4000.00"}`)
}

// saleFourMethodBody is one document settled with all four admitted methods, stated QR first so
// the frozen order of the answer is proven to be the store's and not the client's.
func saleFourMethodBody(variantID, quantity int64, cash, card, transfer, qr string) string {
	return fmt.Sprintf(`{"payments":[{"method":"qr","amount":%q},{"method":"transfer","amount":%q},`+
		`{"method":"card","amount":%q},{"method":"cash","amount":%q}],`+
		`"customer":{"name":"Cliente Mostrador","phone":"700-00000","document":"V-123","address":"Barrio Norte"},`+
		`"lines":[{"variant_id":%d,"quantity":%d,"unit_price":"96000.00","units":%s}]}`,
		qr, transfer, card, cash, variantID, quantity, saleUnitsJSON(quantity, 6))
}

// TestSaleHTTPFourMethods pins S13 over HTTP: a sale can pay with all four admitted methods at
// once, the published label is the 'mixed' the four amounts derive, all four amounts come back in
// the frozen order cash, card, transfer, QR, and the same settlement is read back from the detail
// and filtered from the history. The label used to be derived for one, two and three payments
// only, so this reachable document was published as unavailable.
func TestSaleHTTPFourMethods(t *testing.T) {
	f := saleFixture(t)
	f.price(t, f.entryOf(t, 1), "85000", "96000", 2)
	body := saleFourMethodBody(1, 1, "20000.00", "20000.00", "28000.00", "28000.00")
	created := saleCreatedWire(t, f.serve(t, f.request(2, "POST", "/api/sales", body)))
	want := []salePaymentDTO{{Method: "cash", Amount: "20000.00"}, {Method: "card", Amount: "20000.00"},
		{Method: "transfer", Amount: "28000.00"}, {Method: "qr", Amount: "28000.00"}}
	if created.PaymentMethod != "mixed" || created.Total != "96000.00" || len(created.Payments) != len(want) {
		t.Fatalf("a four-method sale must publish what it was paid with: %+v", created)
	}
	for i, payment := range want {
		if created.Payments[i] != payment {
			t.Fatalf("payment %d must be %+v, got %+v", i, payment, created.Payments[i])
		}
	}
	// The detail carries the same settlement, so the warranty prints one row per method.
	detail := saleDetailWire(t, f.serve(t, f.request(2, "GET", fmt.Sprintf("/api/sales/%d", created.ID), "")))
	if detail.PaymentMethod != "mixed" || len(detail.Payments) != len(want) {
		t.Fatalf("the detail must carry the settlement of the sale: %+v", detail.Payments)
	}
	for i, payment := range want {
		if detail.Payments[i] != payment {
			t.Fatalf("detail payment %d must be %+v, got %+v", i, payment, detail.Payments[i])
		}
	}
	// The history filters the derived label, and no single method selects the row: the label of
	// the document is 'mixed' and its money is four amounts.
	if mixed := salePageWire(t, f.serve(t, f.request(2, "GET", "/api/sales?payment_method=mixed", ""))); mixed.TotalSales != 1 ||
		len(mixed.Sales) != 1 || mixed.Sales[0].PaymentMethod != "mixed" || mixed.Sales[0].ID != created.ID {
		t.Fatalf("the history must filter a four-method sale by its label: %+v", mixed)
	}
	for _, method := range []string{"cash", "card", "transfer", "qr"} {
		if other := salePageWire(t, f.serve(t, f.request(2, "GET", "/api/sales?payment_method="+method, ""))); other.TotalSales != 0 {
			t.Fatalf("a %s filter must not select a mixed sale: %+v", method, other)
		}
	}
	// The exact sum still holds with four sides: the same document one cent short is refused and
	// writes nothing.
	f.rejectedMismatch(t, f.request(2, "POST", "/api/sales",
		saleFourMethodBody(1, 1, "20000.00", "20000.00", "28000.00", "27999.99")),
		`{"error":"payments_mismatch","missing":"0.01"}`)
}

// TestSaleHTTPWarrantyPDF pins S10 and S11 over HTTP: the warranty of one sale downloads as
// a PDF with a stable ASCII file name, the settlement rows of the sale are in the bytes,
// and the guards are the detail read's.
func TestSaleHTTPWarrantyPDF(t *testing.T) {
	f := saleFixture(t)
	f.price(t, f.entryOf(t, 1), "85000", "96000", 2, 3)
	created := saleCreatedWire(t, f.serve(t, f.request(2, "POST", "/api/sales",
		saleMixedBody(1, 1, "40000.00", "56000.00"))))
	target := fmt.Sprintf("/api/sales/%d/warranty.pdf", created.ID)
	w := f.serve(t, f.request(2, "GET", target, ""))
	body := w.Body.Bytes()
	if w.Code != 200 {
		t.Fatalf("the warranty must download: %d %s", w.Code, w.Body.String())
	}
	if w.Header().Get("Content-Type") != "application/pdf" {
		t.Fatalf("the warranty must be a PDF: %q", w.Header().Get("Content-Type"))
	}
	// The file name is stable and derived from the number the database allocated.
	if got, want := w.Header().Get("Content-Disposition"), `attachment; filename="garantia-2-000001.pdf"`; got != want {
		t.Fatalf("the download name must be stable: %q want %q", got, want)
	}
	if got, want := w.Header().Get("Content-Length"), fmt.Sprint(len(body)); got != want {
		t.Fatalf("the length must be the document's own: %q want %q", got, want)
	}
	if !bytes.HasPrefix(body, []byte("%PDF-")) || len(body) < 1024 {
		t.Fatalf("the warranty must be a PDF document: %q", body[:min(len(body), 16)])
	}
	// The document prints the persisted facts: the branch it belongs to, its number, the unit
	// with the serial the seller read and one row per payment method with its amount, never a
	// recomputed total.
	unit := created.Lines[0].Units[0]
	for _, want := range []string{"Sucursal A", "2-000001", "NS40ZL", "Efectivo", "Transferencia",
		"Bs 40.000,00", "Bs 56.000,00", "Bs 96.000,00", unit.SerialNumber, "6 meses"} {
		if !bytes.Contains(body, []byte(want)) {
			t.Fatalf("the warranty must print %q", want)
		}
	}
	// Two reads of one document are the same document.
	again := f.serve(t, f.request(2, "GET", target, ""))
	if !bytes.Equal(again.Body.Bytes(), body) {
		t.Fatal("the same sale must always render the same warranty")
	}
	// The isolation rule is the detail read's: another branch does not find the document.
	f.rejected(t, f.request(3, "GET", target, ""), 404, "not_found")
	// Neither does an unknown or an impossible id.
	f.rejected(t, f.request(2, "GET", "/api/sales/999999/warranty.pdf", ""), 404, "not_found")
	f.rejected(t, f.request(2, "GET", "/api/sales/abc/warranty.pdf", ""), 404, "not_found")
	// A query string is a framing error and the warehouse has no point of sale at all.
	f.rejected(t, f.request(2, "GET", target+"?copy=1", ""), 400, "invalid_request")
	f.rejected(t, f.request(1, "GET", target, ""), 403, "forbidden")
	f.rejected(t, f.request(0, "GET", target, ""), 401, "unauthenticated")
	// A session that still must change its password never downloads a warranty.
	if _, err := f.p.Exec(f.ctx, "UPDATE auth_accounts SET must_change_password=true WHERE id=2"); err != nil {
		t.Fatal("pending password fixture failed")
	}
	f.rejected(t, f.request(2, "GET", target, ""), 403, "forbidden")
	if _, err := f.p.Exec(f.ctx, "UPDATE auth_accounts SET must_change_password=false WHERE id=2"); err != nil {
		t.Fatal("pending password fixture reset failed")
	}
	// The route serves one method only.
	w = f.serve(t, f.request(2, "POST", target, ""))
	if w.Code != 405 || w.Header().Get("Allow") != "GET" {
		t.Fatalf("the warranty must advertise its method: %d %q", w.Code, w.Header().Get("Allow"))
	}
}

// TestSaleHTTPWarrantyPrintsQRPayment pins S13 over HTTP: the money the branch collected by QR
// is its own row of the warranty, with its own amount, and a sale paid partly in cash and
// partly by QR prints one row per method it used while the total still closes.
func TestSaleHTTPWarrantyPrintsQRPayment(t *testing.T) {
	f := saleFixture(t)
	f.price(t, f.entryOf(t, 1), "85000", "96000", 2)
	onlyQR := saleCreatedWire(t, f.serve(t, f.request(2, "POST", "/api/sales",
		saleSettlementBody(1, 1, `[{"method":"qr","amount":"96000.00"}]`))))
	if onlyQR.PaymentMethod != "qr" || len(onlyQR.Payments) != 1 {
		t.Fatalf("a sale collected by QR must publish its own label: %+v", onlyQR)
	}
	pdf := f.serve(t, f.request(2, "GET", fmt.Sprintf("/api/sales/%d/warranty.pdf", onlyQR.ID), ""))
	if pdf.Code != 200 || pdf.Header().Get("Content-Type") != "application/pdf" {
		t.Fatalf("the warranty must download: %d %s", pdf.Code, pdf.Body.String())
	}
	for _, want := range []string{"QR", "Bs 96.000,00", "Total: Bs 96.000,00"} {
		if !bytes.Contains(pdf.Body.Bytes(), []byte(want)) {
			t.Fatalf("a QR sale must print %q in its warranty", want)
		}
	}

	mixed := saleCreatedWire(t, f.serve(t, f.request(2, "POST", "/api/sales",
		saleSettlementBody(1, 1, `[{"method":"cash","amount":"40000.00"},`+
			`{"method":"qr","amount":"56000.00"}]`))))
	mixedPDF := f.serve(t, f.request(2, "GET", fmt.Sprintf("/api/sales/%d/warranty.pdf", mixed.ID), ""))
	if mixedPDF.Code != 200 {
		t.Fatalf("the warranty must download: %d %s", mixedPDF.Code, mixedPDF.Body.String())
	}
	body := mixedPDF.Body.Bytes()
	// One row per method that paid, each with its amount, QR included, and the stored total.
	for _, want := range []string{"Efectivo", "Bs 40.000,00", "QR", "Bs 56.000,00", "Total: Bs 96.000,00"} {
		if !bytes.Contains(body, []byte(want)) {
			t.Fatalf("a cash-and-QR sale must print %q in its warranty", want)
		}
	}
	if got := bytes.Count(body, []byte("QR")); got != 1 {
		t.Fatalf("the QR payment must be one row, got %d", got)
	}
}

// TestSaleHTTPWarrantyNamesEveryUnit pins S6 over HTTP: the warranty is always issued, every
// physical battery is its own row with its serial and its term or "Sin garantía", and the row
// amounts of the sale still add up to its total.
func TestSaleHTTPWarrantyNamesEveryUnit(t *testing.T) {
	f := saleFixture(t)
	f.price(t, f.entryOf(t, 1), "85000", "96000", 2)
	// Three batteries of one line: the first with a term, the other two without warranty.
	body := `{"payments":[{"method":"cash","amount":"288000.00"}],` +
		`"customer":{"name":"Cliente Mostrador","phone":"700-00000","document":"V-123","address":"Barrio Norte"},` +
		`"lines":[{"variant_id":1,"quantity":3,"unit_price":"96000.00","units":[` +
		`{"serial_number":"SERIE-1","warranty_months":12},` +
		`{"serial_number":"SERIE-2","warranty_months":null},` +
		`{"serial_number":"SERIE-3","warranty_months":null}]}]}`
	created := saleCreatedWire(t, f.serve(t, f.request(2, "POST", "/api/sales", body)))
	if len(created.Lines) != 1 || len(created.Lines[0].Units) != 3 {
		t.Fatalf("the sale must register one unit per battery: %+v", created.Lines)
	}
	w := f.serve(t, f.request(2, "GET", fmt.Sprintf("/api/sales/%d/warranty.pdf", created.ID), ""))
	if w.Code != 200 || w.Header().Get("Content-Type") != "application/pdf" {
		t.Fatalf("the warranty must download: %d %s", w.Code, w.Body.String())
	}
	pdf := w.Body.Bytes()
	for _, want := range []string{"SERIE-1", "SERIE-2", "SERIE-3", "12 meses", "Sin garant\xeda"} {
		if !bytes.Contains(pdf, []byte(want)) {
			t.Fatalf("the warranty must print %q", want)
		}
	}
	// Two of the three units were sold without warranty, so the absence is named twice.
	if got := bytes.Count(pdf, []byte("Sin garant\xeda")); got != 2 {
		t.Fatalf("both units without warranty must be named, got %d", got)
	}
	// The rows are the frozen price of each battery, so they add up to the sale total:
	// three rows of the same amount and a total of three times it.
	if got := bytes.Count(pdf, []byte("Bs 96.000,00")); got != 3 {
		t.Fatalf("one row per physical battery, got %d rows of that amount", got)
	}
	if !bytes.Contains(pdf, []byte("Total: Bs 288.000,00")) {
		t.Fatalf("the rows must close against the stored total")
	}
	// The history less every unit of that sale in one row, without unfolding it (S5).
	page := salePageWire(t, f.serve(t, f.request(2, "GET", "/api/sales", "")))
	if len(page.Sales) != 1 || page.Sales[0].UnitsTotal != 3 || page.Sales[0].UnitsWithWarranty != 1 {
		t.Fatalf("the history row must count the units and their warranties: %+v", page.Sales)
	}
}

// storedLine is one line of a sale written straight into the ledger: the variant, the sold
// pieces, the charged price and the serials registered for it, which may be fewer than the
// pieces or none at all.
type storedLine struct {
	variantID int64
	quantity  int64
	unitPrice string
	serials   []string
}

// storedSale persists a sale the way the ledger can hold but the counter can no longer
// write: the lines handed in and their units, which may be none at all. The database judges
// the unit count of a document at commit (LV012), so this fixture disables that one guard for
// the shortest possible window, exactly as the other fixtures of this repository do. A
// pre-vertical sale and a corrupt one can only be produced this way: today's contract refuses
// to store either, and both are needed to prove the reader separates them.
func (f *saleHTTPFixture) storedSale(t *testing.T, lines ...storedLine) int64 {
	t.Helper()
	enable := func() {
		cleanup, done := context.WithTimeout(context.Background(), 10*time.Second)
		defer done()
		_, _ = f.p.Exec(cleanup, "ALTER TABLE sales ENABLE TRIGGER require_sale_units")
	}
	t.Cleanup(enable)
	if _, err := f.p.Exec(f.ctx, "ALTER TABLE sales DISABLE TRIGGER require_sale_units"); err != nil {
		t.Fatal("stored sale fixture setup failed")
	}
	cents := int64(0)
	for _, line := range lines {
		total, err := sales.LineTotal(sales.Money(line.unitPrice), line.quantity)
		if err != nil {
			enable()
			t.Fatalf("the fixture amount is not canonical money: %v", err)
		}
		part, err := strconv.ParseInt(strings.Replace(string(total), ".", "", 1), 10, 64)
		if err != nil {
			enable()
			t.Fatalf("the fixture amount is not canonical money: %v", err)
		}
		cents += part
	}
	amount := fmt.Sprintf("%d.%02d", cents/100, cents%100)
	// The header, the lines and the units are one transaction: the document's own totals are
	// deferred constraint triggers, so they are judged at this commit and at no other.
	tx, err := f.p.Begin(f.ctx)
	if err != nil {
		enable()
		t.Fatal("stored sale fixture transaction failed")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var id int64
	if err := tx.QueryRow(f.ctx, `INSERT INTO sales(branch_location_id,customer_name,customer_address,
 cash_amount,total,created_by_account_id)
 VALUES(2,'Cliente Mostrador','Av. Colón 1234',$1,$1,2) RETURNING id`, amount).Scan(&id); err != nil {
		enable()
		t.Fatalf("stored sale header insert failed: %v", err)
	}
	for _, line := range lines {
		if _, err := tx.Exec(f.ctx, `INSERT INTO sale_lines(sale_id,variant_id,quantity,unit_price)
 VALUES($1,$2,$3,$4)`, id, int32(line.variantID), line.quantity, line.unitPrice); err != nil {
			enable()
			t.Fatalf("stored sale line insert failed: %v", err)
		}
		for i, serial := range line.serials {
			if _, err := tx.Exec(f.ctx, `INSERT INTO sale_units(sale_id,variant_id,unit_ordinal,serial_number)
 VALUES($1,$2,$3,$4)`, id, int32(line.variantID), int32(i+1), serial); err != nil {
				enable()
				t.Fatalf("stored sale unit insert failed: %v", err)
			}
		}
	}
	if err := tx.Commit(f.ctx); err != nil {
		enable()
		t.Fatalf("stored sale commit failed: %v", err)
	}
	enable()
	return id
}

// TestSaleHistoryShowsThePreVerticalDocument pins T12/S7 end to end: a sale issued before
// this vertical carries lines and no unit at all, so the branch history must keep naming it
// -- zero units, nothing warranted -- instead of a single such sale failing the whole page
// closed. A sale whose units are short of its sold pieces is corrupt and still fails the
// page closed.
func TestSaleHistoryShowsThePreVerticalDocument(t *testing.T) {
	f := saleFixture(t)
	f.price(t, f.entryOf(t, 1), "85000", "96000", 2)
	f.price(t, f.entryOf(t, 3), "85000", "96000", 2)
	// The sale the branch issued before the sold unit existed: two batteries, no series.
	old := f.storedSale(t, storedLine{variantID: 1, quantity: 2, unitPrice: "96000.00"})
	// One sale the counter registers today, so both shapes share one page.
	created := saleCreatedWire(t, f.serve(t, f.request(2, "POST", "/api/sales", saleBody(1, 2, "96000.00", 12))))
	page := salePageWire(t, f.serve(t, f.request(2, "GET", "/api/sales", "")))
	if page.TotalSales != 2 || len(page.Sales) != 2 || page.Sales[0].ID != created.ID {
		t.Fatalf("the history must hold both sales newest first: %+v", page)
	}
	row := page.Sales[1]
	if row.ID != old || row.Lines != 1 || row.UnitsTotal != 0 || row.UnitsWithWarranty != 0 ||
		row.Total != "192000.00" || row.CustomerName != "Cliente Mostrador" {
		t.Fatalf("the pre-vertical row must be legible with zero units: %+v", row)
	}
	// A corrupt document -- two lines and a unit registered for only one of them -- still
	// fails the page as a whole, exactly as before this correction.
	f.storedSale(t,
		storedLine{variantID: 1, quantity: 1, unitPrice: "96000.00", serials: []string{"PRE-VERTICAL-UNITED-1"}},
		storedLine{variantID: 3, quantity: 1, unitPrice: "85000.00"})
	if w := f.serve(t, f.request(2, "GET", "/api/sales", "")); w.Code != 503 {
		t.Fatalf("a partially united row must still fail the page closed: status=%d body=%s",
			w.Code, w.Body.String())
	}
}

// TestSaleDetailShowsThePreVerticalDocument pins the other half of T12/S7: the document
// read answers a pre-vertical sale with an empty units array per line, keeping its header,
// its prices and its client, while a document whose units are short of its sold pieces is
// still refused.
func TestSaleDetailShowsThePreVerticalDocument(t *testing.T) {
	f := saleFixture(t)
	f.price(t, f.entryOf(t, 1), "85000", "96000", 2)
	old := f.storedSale(t, storedLine{variantID: 1, quantity: 2, unitPrice: "96000.00"})
	w := f.serve(t, f.request(2, "GET", fmt.Sprintf("/api/sales/%d", old), ""))
	if w.Code != 200 {
		t.Fatalf("a pre-vertical document must stay readable: status=%d body=%s", w.Code, w.Body.String())
	}
	var body struct {
		WarrantyNumber string `json:"warranty_number"`
		CustomerName   string `json:"customer_name"`
		Total          string `json:"total"`
		Lines          []struct {
			Quantity int64           `json:"quantity"`
			Units    json.RawMessage `json:"units"`
		} `json:"lines"`
	}
	if json.Unmarshal(w.Body.Bytes(), &body) != nil || len(body.Lines) != 1 ||
		body.Total != "192000.00" || body.CustomerName != "Cliente Mostrador" ||
		body.WarrantyNumber != "2-000001" {
		t.Fatalf("the pre-vertical document does not match the frozen contract: %s", w.Body.String())
	}
	if body.Lines[0].Quantity != 2 || string(body.Lines[0].Units) != "[]" {
		t.Fatalf("a pre-vertical line must answer its empty units array: %s", w.Body.String())
	}
	short := f.storedSale(t, storedLine{variantID: 1, quantity: 2, unitPrice: "96000.00",
		serials: []string{"PRE-VERTICAL-SHORT-1"}})
	if w := f.serve(t, f.request(2, "GET", fmt.Sprintf("/api/sales/%d", short), "")); w.Code != 503 {
		t.Fatalf("a partially united document must fail closed: status=%d body=%s", w.Code, w.Body.String())
	}
}
