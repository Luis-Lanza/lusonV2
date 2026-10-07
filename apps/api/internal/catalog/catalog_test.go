package catalog

import (
	"bytes"
	"luson/api/fixtures"
	"testing"
)

func TestExactCatalog(t *testing.T) {
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Entries) != 95 || c.NonemptyTriplets != 101 || len(c.ExcludedHeaders) != 6 {
		t.Fatalf("wrong source counts: %+v", c)
	}
	brands := map[string]bool{}
	fractional := map[string]string{}
	for _, e := range c.Entries {
		brands[e.Brand] = true
		if e.Capacity == "6.5" {
			fractional[e.Brand] = e.Model
		}
	}
	if len(brands) != 11 || fractional["TOYO_MOTO"] != "12N6,5_3B" || fractional["ULTRON_MOTO"] != "YB6,5_BS" {
		t.Fatal("source spelling or decimals changed")
	}
	if c.SourceSHA != "b48e97ce1abf24304951831cc07498098391a12c3587cda6448fa7aea8faeacf" || c.Sheet != "baae de datos" {
		t.Fatal("wrong provenance")
	}
}
func TestDecimal(t *testing.T) {
	for _, s := range []string{"6.5", "35", "0.1", "0006.500"} {
		d, err := ParseDecimal(s)
		if err != nil || d == "" {
			t.Fatalf("%q: %v", s, err)
		}
	}
	d, _ := ParseDecimal("0006.500")
	if d != "6.5" {
		t.Fatal(d)
	}
	for _, s := range []string{"", "0", "-1", "NaN", "Infinity", "6,5", "1e3", "1.1234567", ".5", "1."} {
		if _, err := ParseDecimal(s); err == nil {
			t.Fatalf("accepted %q", s)
		}
	}
}
func TestBalance(t *testing.T) {
	for _, b := range []Balance{{0, 0}, {10, 4}, {9, 9}} {
		n, err := b.Available()
		if err != nil || n != b.Existing-b.Reserved {
			t.Fatalf("%+v: %v", b, err)
		}
	}
	for _, b := range []Balance{{-1, 0}, {1, -1}, {2, 3}} {
		if _, err := b.Available(); err == nil {
			t.Fatalf("accepted %+v", b)
		}
	}
}
func TestInvalidProvenance(t *testing.T) {
	for _, pair := range [][2]string{{"baae de datos", "wrong sheet"}, {"b48e97ce1abf24304951831cc07498098391a12c3587cda6448fa7aea8faeacf", "bad"}, {"\"B5\"", "\"B999\""}, {"\"capacity_ah\": 35", "\"capacity_ah\": 0"}} {
		corrupted := bytes.Replace(fixtures.Catalog, []byte(pair[0]), []byte(pair[1]), 1)
		if _, err := Decode(corrupted); err == nil {
			t.Fatalf("accepted corrupted %s", pair[0])
		}
	}
}
