// Package catalog models the immutable source catalog and integer stock quantities.
package catalog

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"

	"luson/api/fixtures"
)

// Decimal is a canonical positive decimal, never a binary float.
// The schema supports at most six integral and six fractional digits.
type Decimal string

var decimalPattern = regexp.MustCompile(`^[0-9]+(\.[0-9]{1,6})?$`)

func ParseDecimal(s string) (Decimal, error) {
	if !decimalPattern.MatchString(s) {
		return "", errors.New("capacity must be a positive decimal")
	}
	parts := strings.SplitN(s, ".", 2)
	whole := strings.TrimLeft(parts[0], "0")
	if whole == "" {
		whole = "0"
	}
	if len(whole) > 6 {
		return "", errors.New("capacity exceeds numeric precision")
	}
	fraction := ""
	if len(parts) == 2 {
		fraction = strings.TrimRight(parts[1], "0")
	}
	if whole == "0" && fraction == "" {
		return "", errors.New("capacity must be positive")
	}
	if fraction != "" {
		whole += "." + fraction
	}
	return Decimal(whole), nil
}
func (d *Decimal) UnmarshalJSON(data []byte) error {
	value, err := ParseDecimal(string(data))
	if err == nil {
		*d = value
	}
	return err
}
func (d Decimal) MarshalJSON() ([]byte, error) {
	value, err := ParseDecimal(string(d))
	if err != nil {
		return nil, err
	}
	return []byte(value), nil
}

type Entry struct {
	ID       int      `json:"id"`
	Brand    string   `json:"brand"`
	Model    string   `json:"model"`
	Capacity Decimal  `json:"capacity_ah"`
	Cells    []string `json:"cells"`
}
type Catalog struct {
	SourceSHA        string     `json:"source_sha256"`
	Sheet            string     `json:"sheet"`
	NonemptyTriplets int        `json:"nonempty_triplets"`
	ExcludedHeaders  [][]string `json:"excluded_headers"`
	Entries          []Entry    `json:"entries"`
}

const SourceSHA = "b48e97ce1abf24304951831cc07498098391a12c3587cda6448fa7aea8faeacf"

func Load() (Catalog, error) { return Decode(fixtures.Catalog) }
func Decode(data []byte) (Catalog, error) {
	var c Catalog
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&c); err != nil {
		return c, fmt.Errorf("invalid catalog: %w", err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return c, errors.New("trailing catalog content")
	}
	if c.SourceSHA != SourceSHA || c.Sheet != "baae de datos" || c.NonemptyTriplets != 101 || len(c.ExcludedHeaders) != 6 || len(c.Entries) != 95 {
		return c, errors.New("invalid catalog provenance or counts")
	}
	groups := []string{"BCD", "FGH", "JKL", "NOP"}
	expected := [][]string{}
	for _, row := range []int{22, 31} {
		for i, g := range groups {
			if row == 31 && i > 1 {
				break
			}
			expected = append(expected, cellRefs(g, row))
		}
	}
	for i, refs := range expected {
		if strings.Join(refs, ",") != strings.Join(c.ExcludedHeaders[i], ",") {
			return c, errors.New("invalid header provenance")
		}
	}
	brands := map[string]bool{}
	pairs := map[string]bool{}
	cells := map[string]bool{}
	for i, e := range c.Entries {
		if e.ID != i+1 || e.Brand == "" || e.Model == "" || len(e.Cells) != 3 {
			return c, errors.New("invalid catalog entry")
		}
		if _, err := ParseDecimal(string(e.Capacity)); err != nil {
			return c, err
		}
		valid := false
		for _, g := range groups {
			for row := 5; row <= 42; row++ {
				if row == 22 || row == 31 {
					continue
				}
				if strings.Join(e.Cells, ",") == strings.Join(cellRefs(g, row), ",") {
					valid = true
				}
			}
		}
		key := e.Brand + "\x00" + e.Model
		if !valid || pairs[key] || cells[e.Cells[0]] {
			return c, errors.New("invalid or duplicate source entry")
		}
		brands[e.Brand] = true
		pairs[key] = true
		cells[e.Cells[0]] = true
	}
	if len(brands) != 11 {
		return c, errors.New("invalid brand count")
	}
	return c, nil
}
func cellRefs(group string, row int) []string {
	refs := []string{}
	for _, col := range group {
		refs = append(refs, string(col)+strconv.Itoa(row))
	}
	return refs
}

type Balance struct{ Existing, Reserved int64 }

func (b Balance) Available() (int64, error) {
	if b.Existing < 0 || b.Reserved < 0 || b.Reserved > b.Existing {
		return 0, errors.New("invalid stock quantities")
	}
	return b.Existing - b.Reserved, nil
}

type Polarity string

const (
	Left  Polarity = "L"
	Right Polarity = "R"
)

type Variant struct {
	ID, CatalogID int
	Polarity      Polarity
}
type Location struct {
	ID   int
	Name string
}

func Locations() []Location { return []Location{{1, "Almacén"}, {2, "Sucursal A"}, {3, "Sucursal B"}} }
func (c Catalog) Variants() []Variant {
	result := make([]Variant, 0, len(c.Entries)*2)
	for _, e := range c.Entries {
		for i, p := range []Polarity{Left, Right} {
			result = append(result, Variant{(e.ID-1)*2 + i + 1, e.ID, p})
		}
	}
	return result
}
