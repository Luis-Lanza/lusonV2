package auth_test

import (
	"context"
	"luson/api/internal/auth"
	"luson/api/internal/bootstrap"
	"luson/api/internal/config"
	"luson/api/internal/testpg"
	"strconv"
	"testing"
	"time"
)

// The directory is ordered by numeric ID (docs/administration.md: "Lists are
// ordered by numeric ID"). Account IDs are canonical decimal strings, so a
// lexicographic order only agrees with the contract until the first two-digit
// id exists: from then on it publishes 18 before 2 and the panel, which
// decodes the order the contract promises, refuses the whole directory.
func TestAdministrationDirectoryOrdersNumerically(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	p := testpg.Open(t)
	if bootstrap.Initialize(ctx, p, config.LocalTrial) != nil {
		t.Fatal("initialize failed")
	}
	creds := []bootstrap.Credentials{
		{Username: "warehouse", Password: "original warehouse password"},
		{Username: "operator_a", Password: "original operator password"},
		{Username: "operator_b", Password: "another operator password"},
	}
	if bootstrap.Provision(ctx, p, creds) != nil {
		t.Fatal("provision failed")
	}
	s, err := auth.New(p, nil)
	if err != nil {
		t.Fatal("service failed")
	}
	_, token, err := s.Login(ctx, "warehouse", creds[0].Password, "127.0.0.1", "")
	if err != nil {
		t.Fatal("login failed")
	}
	if s.ChangePassword(ctx, token, creds[0].Password, "completed warehouse password") != nil {
		t.Fatal("complete password failed")
	}
	_, token, err = s.Login(ctx, "warehouse", "completed warehouse password", "127.0.0.2", "")
	if err != nil {
		t.Fatal("completed login failed")
	}
	// Nine operators take the allocated ids into two digits, where the two
	// orders stop agreeing.
	for i := 1; i <= 9; i++ {
		created, err := s.CreateOperator(ctx, token, auth.NewOperator{
			Username:          "operator_" + strconv.Itoa(10+i),
			DisplayName:       "Operador " + strconv.Itoa(10+i),
			LocationID:        2,
			TemporaryPassword: "temporary password " + strconv.Itoa(10+i),
		})
		if err != nil {
			t.Fatalf("operator %d: %v", i, err)
		}
		if created.ID == "" {
			t.Fatal("created operator has no id")
		}
	}
	accounts, err := s.ListAccounts(ctx, token)
	if err != nil {
		t.Fatal("directory failed")
	}
	if len(accounts) != 12 {
		t.Fatalf("directory published %d accounts, want 12", len(accounts))
	}
	previous, twoDigits := 0, false
	for index, account := range accounts {
		value, err := strconv.Atoi(account.ID)
		if err != nil || value <= 0 {
			t.Fatalf("account %d has a non-numeric id %q", index, account.ID)
		}
		if value <= previous {
			t.Fatalf("directory is not in ascending numeric order at %d: %q came after %d", index, account.ID, previous)
		}
		previous = value
		if value >= 10 {
			twoDigits = true
		}
	}
	if !twoDigits {
		t.Fatal("fixture did not reach a two-digit id, so the order was never exercised")
	}
}
