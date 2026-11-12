package closings_test

import (
	"errors"
	"strings"
	"testing"

	"luson/api/internal/closings"
)

// amount canonicalizes one amount for the tests below, so every fixture states a value a
// caller could actually type.
func amount(t *testing.T, text string) closings.Money {
	t.Helper()
	value, err := closings.ParseAmount(text)
	if err != nil {
		t.Fatalf("amount %q must be admissible: %v", text, err)
	}
	return value
}

// TestParseAmountCanonicalizesAndRefuses pins the money contract of the vertical (S20):
// two canonical decimals, never a binary float, and an amount of cash may be zero even
// though a price never is.
func TestParseAmountCanonicalizesAndRefuses(t *testing.T) {
	for _, admitted := range []struct{ typed, canonical string }{
		{"0", "0.00"},
		{"0.00", "0.00"},
		{"0.5", "0.50"},
		{"1.5", "1.50"},
		{"85000", "85000.00"},
		{"9999999999.99", "9999999999.99"},
	} {
		value, err := closings.ParseAmount(admitted.typed)
		if err != nil || string(value) != admitted.canonical {
			t.Errorf("ParseAmount(%q) = %q, %v; want %q", admitted.typed, value, err, admitted.canonical)
		}
	}
	for _, refused := range []string{
		"", "-1.00", "+1.00", "1.005", "1.000", ".50", "1.", "00.50", " 1.00", "1.00 ",
		"abc", "1,00", "10000000000.00", "NaN", "1e3",
	} {
		if _, err := closings.ParseAmount(refused); !errors.Is(err, closings.ErrInvalid) {
			t.Errorf("ParseAmount(%q) must be refused with ErrInvalid, got %v", refused, err)
		}
	}
}

// TestParsePercent pins the percentage contract (S20): up to two decimals between 0 and
// 100, canonicalized so one rate has exactly one text.
func TestParsePercent(t *testing.T) {
	for _, admitted := range []struct{ typed, canonical string }{
		{"0", "0.00"},
		{"0.00", "0.00"},
		{"12.5", "12.50"},
		{"12.50", "12.50"},
		{"100", "100.00"},
		{"8.75", "8.75"},
	} {
		value, err := closings.ParsePercent(admitted.typed)
		if err != nil || string(value) != admitted.canonical {
			t.Errorf("ParsePercent(%q) = %q, %v; want %q", admitted.typed, value, err, admitted.canonical)
		}
	}
	for _, refused := range []string{"", "-1", "100.01", "101", "12.345", ".5", "12.", "0012", "abc"} {
		if _, err := closings.ParsePercent(refused); !errors.Is(err, closings.ErrInvalid) {
			t.Errorf("ParsePercent(%q) must be refused with ErrInvalid, got %v", refused, err)
		}
	}
}

// TestCommissionRoundsOnceOnThePeriodTotal pins S20 and S6: the commission is the frozen
// rate times the period total, rounded exactly once, never per sold line. The 0.08 case is
// the one that tells the two readings apart: per line it would be 0.02, once it is 0.01.
func TestCommissionRoundsOnceOnThePeriodTotal(t *testing.T) {
	for _, c := range []struct{ total, rate, want string }{
		{"0.00", "12.50", "0.00"},
		{"100.00", "0.00", "0.00"},
		{"100.00", "100.00", "100.00"},
		{"0.08", "12.50", "0.01"},
		{"0.04", "12.50", "0.01"},
		{"0.01", "50.00", "0.01"},
		{"0.01", "49.99", "0.00"},
		{"100.05", "12.50", "12.51"},
		{"850.00", "8.75", "74.38"},
		{"9999999999.99", "100.00", "9999999999.99"},
	} {
		value, err := closings.Commission(amount(t, c.total), closings.Percent(c.rate))
		if err != nil || string(value) != c.want {
			t.Errorf("Commission(%q, %q) = %q, %v; want %q", c.total, c.rate, value, err, c.want)
		}
	}
	// A rate the caller typed with one decimal is canonicalized, not approximated.
	value, err := closings.Commission(amount(t, "100.00"), closings.Percent("12.5"))
	if err != nil || string(value) != "12.50" {
		t.Errorf("a one-decimal rate must be canonicalized: %q %v", value, err)
	}
	if _, err := closings.Commission("100.005", "12.50"); !errors.Is(err, closings.ErrInvalid) {
		t.Errorf("an over-precision total must be refused, got %v", err)
	}
	if _, err := closings.Commission(amount(t, "100.00"), "12.505"); !errors.Is(err, closings.ErrInvalid) {
		t.Errorf("an over-precision rate must be refused, got %v", err)
	}
}

// TestCommissionRoundsAnExactHalfUp pins the tie-break of S20 instead of leaving it to the
// arithmetic: a fraction of a cent exactly at the half rounds away from zero, so 0.005 becomes
// 0.01 and 0.025 becomes 0.03 — half-up, never half-even and never truncation.
func TestCommissionRoundsAnExactHalfUp(t *testing.T) {
	for _, c := range []struct{ total, rate, want, why string }{
		{"0.04", "12.50", "0.01", "0.005 exactly: up, where truncation would give 0.00"},
		{"0.20", "12.50", "0.03", "0.025 exactly: up, where half-even would give 0.02"},
		{"0.01", "50.00", "0.01", "0.005 exactly: up"},
		{"0.01", "49.99", "0.00", "0.004999: below the half, so down"},
		{"0.03", "12.50", "0.00", "0.00375: below the half, so down"},
	} {
		value, err := closings.Commission(amount(t, c.total), closings.Percent(c.rate))
		if err != nil || string(value) != c.want {
			t.Errorf("Commission(%q, %q) = %q, %v; want %q (%s)", c.total, c.rate, value, err, c.want, c.why)
		}
	}
}

// TestDerivedCashNumbersCarryTheirSign pins S8 and S10: the expected cash is the inherited
// fund plus the cash sales minus the cash expenses, the difference is the counted cash
// against it and it keeps its sign, and what the warehouse takes is the counted cash plus
// the contribution minus the fund left behind. The commission is in none of them.
func TestDerivedCashNumbersCarryTheirSign(t *testing.T) {
	expected, err := closings.ExpectedCash(amount(t, "100.00"), amount(t, "120.00"), amount(t, "20.00"))
	if err != nil || string(expected) != "200.00" {
		t.Fatalf("expected cash must be opening + cash sales - cash expenses: %q %v", expected, err)
	}
	shortage, err := closings.CashDifference(amount(t, "180.00"), expected)
	if err != nil || string(shortage) != "-20.00" || !shortage.Negative() {
		t.Fatalf("a counted cash below the expected one is a signed shortage: %q %v", shortage, err)
	}
	surplus, err := closings.CashDifference(amount(t, "0.00"), expected)
	if err != nil || string(surplus) != "-200.00" {
		t.Fatalf("an empty drawer against a funded period must be exact: %q %v", surplus, err)
	}
	over, err := closings.CashDifference(amount(t, "205.50"), expected)
	if err != nil || string(over) != "5.50" || over.Negative() {
		t.Fatalf("a counted cash above the expected one is a surplus: %q %v", over, err)
	}
	// The drawer at the cut is the counted cash plus the contribution (L13), and the fund
	// left behind is what the next period inherits.
	taken, err := closings.TakenCash(amount(t, "500.00"), amount(t, "500.00"), amount(t, "500.00"))
	if err != nil || string(taken) != "500.00" {
		t.Fatalf("the first settlement takes nothing from an empty drawer: %q %v", taken, err)
	}
	zero, err := closings.TakenCash(amount(t, "300.00"), amount(t, "100.00"), amount(t, "400.00"))
	if err != nil || string(zero) != "0.00" {
		t.Fatalf("a fund equal to the drawer takes nothing: %q %v", zero, err)
	}
	if _, err := closings.ExpectedCash("100.5", amount(t, "1.00"), amount(t, "1.00")); !errors.Is(err, closings.ErrInvalid) {
		t.Errorf("a non-canonical amount must be refused, got %v", err)
	}
	// A derived amount is always canonical two-decimal text with a sign, never a float.
	if text := string(over); strings.ContainsAny(text, "eE") {
		t.Errorf("a derived amount must never render as a float: %q", text)
	}
}
