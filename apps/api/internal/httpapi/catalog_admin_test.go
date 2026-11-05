package httpapi

import (
	"net/http/httptest"
	"strings"
	"testing"

	"luson/api/internal/auth"
	"luson/api/internal/catalog"
	"luson/api/internal/catalogadmin"
)

// The battery body is a canonical flat document: the exact key set, no duplicate
// keys, no aliases, no nulls, no nesting and a bounded body. The single admitted
// array is the polarity list of a creation.
func TestCatalogAdminBatteryBodyDecoding(t *testing.T) {
	decode := func(body string, withPolarities bool) (catalogBatteryBody, error) {
		r := httptest.NewRequest("POST", "/api/catalog/batteries", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		return catalogBatteryFields(r, withPolarities)
	}
	got, err := decode(`{"model":"NS40ZL","brand":"CAR","capacity_ah":"045.0","polarities":["L","R"]}`, true)
	if err != nil || got.brand != "CAR" || got.model != "NS40ZL" || got.capacity != catalog.Decimal("45") ||
		len(got.polarities) != 2 || got.polarities[0] != catalog.Left || got.polarities[1] != catalog.Right {
		t.Fatalf("canonical body %v %v", got, err)
	}
	if got, err = decode(`{"brand":"CAR","model":"NS40ZL","capacity_ah":"45"}`, false); err != nil ||
		got.brand != "CAR" || len(got.polarities) != 0 {
		t.Fatalf("canonical edit body %v %v", got, err)
	}
	for _, c := range []struct {
		name           string
		body           string
		withPolarities bool
	}{
		{"duplicate_key", `{"brand":"A","brand":"B","model":"M","capacity_ah":"45","polarities":["L"]}`, true},
		{"unknown_key", `{"brand":"A","model":"M","capacity_ah":"45","polarities":["L"],"cells":[]}`, true},
		{"missing_brand", `{"model":"M","capacity_ah":"45","polarities":["L"]}`, true},
		{"missing_model", `{"brand":"A","capacity_ah":"45","polarities":["L"]}`, true},
		{"missing_capacity", `{"brand":"A","model":"M","polarities":["L"]}`, true},
		{"missing_polarities", `{"brand":"A","model":"M","capacity_ah":"45"}`, true},
		{"polarities_on_edit", `{"brand":"A","model":"M","capacity_ah":"45","polarities":["L"]}`, false},
		{"empty_polarities", `{"brand":"A","model":"M","capacity_ah":"45","polarities":[]}`, true},
		{"three_polarities", `{"brand":"A","model":"M","capacity_ah":"45","polarities":["L","R","L"]}`, true},
		{"numeric_polarity", `{"brand":"A","model":"M","capacity_ah":"45","polarities":[1]}`, true},
		{"nested_polarity", `{"brand":"A","model":"M","capacity_ah":"45","polarities":[["L"]]}`, true},
		{"polarities_string", `{"brand":"A","model":"M","capacity_ah":"45","polarities":"LR"}`, true},
		{"polarities_null", `{"brand":"A","model":"M","capacity_ah":"45","polarities":null}`, true},
		{"numeric_brand", `{"brand":1,"model":"M","capacity_ah":"45","polarities":["L"]}`, true},
		{"null_brand", `{"brand":null,"model":"M","capacity_ah":"45","polarities":["L"]}`, true},
		{"nested_brand", `{"brand":{"value":"A"},"model":"M","capacity_ah":"45","polarities":["L"]}`, true},
		{"capacity_number", `{"brand":"A","model":"M","capacity_ah":45,"polarities":["L"]}`, true},
		{"capacity_zero", `{"brand":"A","model":"M","capacity_ah":"0","polarities":["L"]}`, true},
		{"trailing_content", `{"brand":"A","model":"M","capacity_ah":"45","polarities":["L"]}{}`, true},
		{"top_level_array", `[{"brand":"A","model":"M","capacity_ah":"45","polarities":["L"]}]`, true},
		{"empty_body", ``, true},
		{"unterminated", `{"brand":"A","model":"M","capacity_ah":"45","polarities":["L"]`, true},
		{"oversized", `{"brand":"A","model":"M","capacity_ah":"45","polarities":["L"],"pad":"` + strings.Repeat("x", 4096) + `"}`, true},
	} {
		t.Run(c.name, func(t *testing.T) {
			if got, err := decode(c.body, c.withPolarities); err == nil {
				t.Fatalf("admitted %q as %v", c.name, got)
			}
		})
	}
	r := httptest.NewRequest("POST", "/api/catalog/batteries", strings.NewReader(`{"brand":"A","model":"M","capacity_ah":"45","polarities":["L"]}`))
	r.Header.Set("Content-Type", "text/plain")
	if _, err := catalogBatteryFields(r, true); err == nil {
		t.Fatal("admitted a non-JSON content type")
	}
	r = httptest.NewRequest("POST", "/api/catalog/batteries", strings.NewReader(`{"brand":"A","model":"M","capacity_ah":"45","polarities":["L"]}`))
	r.Header.Add("Content-Type", "application/json")
	r.Header.Add("Content-Type", "application/json")
	if _, err := catalogBatteryFields(r, true); err == nil {
		t.Fatal("admitted two content type headers")
	}
}

// Only the battery collection and its one-segment identity belong to this
// contract. An ambiguous path is not_found before the handler runs, and the
// catalogue price list is forwarded untouched.
func TestCatalogAdminPathSafety(t *testing.T) {
	for _, c := range []struct {
		target string
		want   bool
	}{
		{"/api/catalog/batteries", true},
		{"/api/catalog/batteries/96", true},
		{"/api/catalog/batteries/96/", true},
		{"/api/catalog/batteries//96", false},
		{"/api/catalog/batteries/./96", false},
		{"/api/catalog/batteries/96/..", false},
		{"/api/catalog/batteries%2F96", false},
		{"/api/catalog/batteries/96%00", false},
		{"/api/catalog/batteries/96\\", false},
		{"/api/catalog/prices", true},
		{"/api/catalog/batteriesX", true},
		{"/api/inventory/1", true},
	} {
		r := httptest.NewRequest("GET", c.target, nil)
		if got := catalogBatteryPath(r); got != c.want {
			t.Fatalf("catalogBatteryPath(%q) = %v, want %v", c.target, got, c.want)
		}
	}
	for _, c := range []struct {
		path string
		want bool
	}{
		{"/api/catalog/batteries", true},
		{"/api/catalog/batteries/96", true},
		{"/api/catalog/batteriesX", false},
		{"/api/catalog/prices", false},
	} {
		if got := catalogBatteryRoute(c.path); got != c.want {
			t.Fatalf("catalogBatteryRoute(%q) = %v, want %v", c.path, got, c.want)
		}
	}
}

func TestCatalogAdminBatteryRecordValidation(t *testing.T) {
	valid := catalogadmin.Battery{
		ID: 96, Brand: "CAR", Model: "NS40ZL", Capacity: "45",
		Variants: []catalogadmin.Variant{
			{ID: 191, Polarity: catalog.Left},
			{ID: 192, Polarity: catalog.Right},
		},
		PricedBranches: 0,
	}
	record, err := catalogBatteryRecord(valid)
	if err != nil {
		t.Fatalf("refused the allocated battery: %v", err)
	}
	if record.ID != 96 || record.Capacity != "45" || len(record.Variants) != 2 ||
		record.Variants[0].Polarity != "L" || record.Variants[1].ID != 192 || record.PricedBranches != 0 {
		t.Fatalf("record %v", record)
	}
	for _, c := range []struct {
		name   string
		mutate func(*catalogadmin.Battery)
	}{
		{"zero_id", func(b *catalogadmin.Battery) { b.ID = 0 }},
		{"empty_brand", func(b *catalogadmin.Battery) { b.Brand = "" }},
		{"blank_model", func(b *catalogadmin.Battery) { b.Model = " " }},
		{"non_canonical_capacity", func(b *catalogadmin.Battery) { b.Capacity = "45.0" }},
		{"padded_capacity", func(b *catalogadmin.Battery) { b.Capacity = "045" }},
		{"unparsable_capacity", func(b *catalogadmin.Battery) { b.Capacity = "fortyfive" }},
		{"no_variants", func(b *catalogadmin.Battery) { b.Variants = nil }},
		{"three_variants", func(b *catalogadmin.Battery) {
			b.Variants = []catalogadmin.Variant{{ID: 1, Polarity: catalog.Left}, {ID: 2, Polarity: catalog.Right}, {ID: 3, Polarity: catalog.Left}}
		}},
		{"unknown_polarity", func(b *catalogadmin.Battery) { b.Variants[0].Polarity = "X" }},
		{"descending_polarities", func(b *catalogadmin.Battery) {
			b.Variants = []catalogadmin.Variant{{ID: 1, Polarity: catalog.Right}, {ID: 2, Polarity: catalog.Left}}
		}},
		{"zero_variant_id", func(b *catalogadmin.Battery) { b.Variants[0].ID = 0 }},
		{"negative_priced_branches", func(b *catalogadmin.Battery) { b.PricedBranches = -1 }},
	} {
		t.Run(c.name, func(t *testing.T) {
			battery := valid
			battery.Variants = append([]catalogadmin.Variant(nil), valid.Variants...)
			c.mutate(&battery)
			if _, err := catalogBatteryRecord(battery); err == nil {
				t.Fatalf("accepted %s", c.name)
			}
		})
	}
}

// The battery contract answers its own refusals with stable codes and keeps the
// administration surface's authentication/authorization refusals byte-identical.
func TestCatalogAdminFailureCodes(t *testing.T) {
	for _, c := range []struct {
		err    error
		status int
		body   string
	}{
		{catalogadmin.ErrHasStock, 409, "{\"error\":\"catalog_battery_has_stock\"}\n"},
		{catalogadmin.ErrHasPending, 409, "{\"error\":\"catalog_battery_has_pending\"}\n"},
		{catalogadmin.ErrNotFound, 404, "{\"error\":\"not_found\"}\n"},
		{catalogadmin.ErrInvalid, 400, "{\"error\":\"invalid_request\"}\n"},
		{catalogadmin.ErrForbidden, 403, "{\"error\":\"forbidden\"}\n"},
		{catalogadmin.ErrConflict, 409, "{\"error\":\"conflict\"}\n"},
		{catalogadmin.ErrUnavailable, 503, "{\"error\":\"service_unavailable\"}\n"},
		{auth.ErrSession, 401, "{\"error\":\"unauthenticated\"}\n"},
		{auth.ErrAdminForbidden, 403, "{\"error\":\"forbidden\"}\n"},
		{auth.ErrAdminNotFound, 404, "{\"error\":\"not_found\"}\n"},
	} {
		w := httptest.NewRecorder()
		catalogBatteryFailure(w, c.err)
		if w.Code != c.status || w.Body.String() != c.body {
			t.Fatalf("%v answered %d %q, want %d %q", c.err, w.Code, w.Body.String(), c.status, c.body)
		}
		if got := w.Header().Get("Content-Type"); got != "application/json" {
			t.Fatalf("refusal content type %q", got)
		}
	}
}
