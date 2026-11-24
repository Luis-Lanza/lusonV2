package warrantycase_test

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"luson/api/internal/auth"
	"luson/api/internal/warrantycase"
)

// cp1252 is the code page the core font of the document draws: every rune of the fixture's
// text lives in Latin-1, which cp1252 shares, so a value with an accent is asserted in the
// bytes the page actually contains.
func cp1252(value string) string {
	drawn := make([]byte, 0, len(value))
	for _, r := range value {
		if r <= 0xFF {
			drawn = append(drawn, byte(r))
			continue
		}
		drawn = append(drawn, '?')
	}
	return string(drawn)
}

// TestReceiptPrintsWhatTheCasePersisted pins S8 against the real database: the receipt of
// the handed-over used battery is read from the persisted case, its sale and its loans --
// never recalculated -- and a claim that lent nothing has no receipt to print.
func TestReceiptPrintsWhatTheCasePersisted(t *testing.T) {
	f := newFixture(t)
	claim := f.openClaim(t, "RECIBO/1")

	// One refusal before the battery is lent: a claim with no loan has nothing to print.
	if _, err := f.store.Receipt(f.ctx, f.actor(2), claim.ID); !errors.Is(err, warrantycase.ErrNoLoan) {
		t.Fatalf("a claim without a loan must be refused as %v, got %v", warrantycase.ErrNoLoan, err)
	}

	// The persisted sale of the claim: the number and the client the paper prints.
	var warrantyNumber, customerName, customerPhone string
	if err := f.pool.QueryRow(f.ctx, `SELECT warranty_number,customer_name,customer_phone
 FROM sales WHERE id=$1`, *claim.SaleID).Scan(&warrantyNumber, &customerName,
		&customerPhone); err != nil {
		t.Fatalf("the sale of the claim could not be read: %v", err)
	}
	var branchName, sourceName string
	if err := f.pool.QueryRow(f.ctx, `SELECT (SELECT name FROM locations WHERE id=2),
  (SELECT name FROM locations WHERE id=1)`).Scan(&branchName, &sourceName); err != nil {
		t.Fatalf("the locations of the fixture could not be read: %v", err)
	}

	if _, err := f.store.AddLoan(f.ctx, f.actor(2), claim.ID, warrantycase.LoanInput{
		Model: "yuasa np7-12", Quantity: 2, SourceLocationID: 1}); err != nil {
		t.Fatalf("the used battery must be lendable: %v", err)
	}
	// A second loan of the same case is its own row of the paper (S7).
	if _, err := f.store.AddLoan(f.ctx, f.actor(2), claim.ID, warrantycase.LoanInput{
		Model: "WILLARD NS60L", Quantity: 1, SerialNumber: "USADA-2",
		SourceLocationID: 3}); err != nil {
		t.Fatalf("the replacement loan must be lendable: %v", err)
	}
	var given time.Time
	if err := f.pool.QueryRow(f.ctx, `SELECT given_at FROM warranty_case_loans
 WHERE case_id=$1 AND loan_ordinal=2`, claim.ID).Scan(&given); err != nil {
		t.Fatalf("the instant of the second loan could not be read: %v", err)
	}

	// Reading the paper writes nothing: the three tables of the case keep their rows and the
	// shelf of every location stays exactly as it was.
	rows := func() string {
		return fmt.Sprintf("%d/%d/%d %s", f.count(t, "warranty_cases"),
			f.count(t, "warranty_case_loans"), f.count(t, "warranty_case_events"),
			f.balances(t))
	}
	before := rows()
	receipt, err := f.store.Receipt(f.ctx, f.actor(2), claim.ID)
	if err != nil {
		t.Fatalf("the receipt of the case must be readable: %v", err)
	}
	if after := rows(); after != before {
		t.Fatalf("reading the receipt wrote a row: %s became %s", before, after)
	}

	// Every value of the paper is the persisted value and nothing else (S8, S20).
	if receipt.CaseNumber != claim.CaseNumber || receipt.CaseNumber != "C-2-000001" {
		t.Fatalf("the receipt is named by the persisted case number, got %q", receipt.CaseNumber)
	}
	if receipt.BranchName != branchName {
		t.Fatalf("the receipt prints the branch %q, got %q", branchName, receipt.BranchName)
	}
	if receipt.WarrantyNumber != warrantyNumber {
		t.Fatalf("the receipt prints the warranty number %q, got %q", warrantyNumber,
			receipt.WarrantyNumber)
	}
	if receipt.ClaimedSerial != *claim.SerialNumber ||
		receipt.DeclaredFailure != claim.DeclaredFailure {
		t.Fatalf("the receipt prints the claimed battery: %+v", receipt)
	}
	if receipt.CustomerName != customerName || receipt.CustomerPhone != customerPhone {
		t.Fatalf("the receipt prints the client of the sale %q/%q, got %q/%q", customerName,
			customerPhone, receipt.CustomerName, receipt.CustomerPhone)
	}
	if len(receipt.Loans) != 2 {
		t.Fatalf("the receipt lists every loan of the case, got %d", len(receipt.Loans))
	}
	first := receipt.Loans[0]
	if first.Ordinal != 1 || first.Model != "YUASA NP7-12" || first.Quantity != 2 ||
		first.Source != sourceName {
		t.Fatalf("the first loan is printed as persisted: %+v", first)
	}
	second := receipt.Loans[1]
	if second.Ordinal != 2 || second.Model != "WILLARD NS60L" || second.Quantity != 1 ||
		second.Source != "Sucursal B" {
		t.Fatalf("the second loan is printed as persisted: %+v", second)
	}
	// The date of the paper is the instant the database stamped on the handover, never the
	// instant of the read.
	if !receipt.IssuedAt.Equal(given) {
		t.Fatalf("the receipt is dated by the persisted handover %v, got %v", given,
			receipt.IssuedAt)
	}

	// The rendered page carries those persisted values and the conditions of the exchange. The
	// drawn text is cp1252 -- the code page of the core font -- so a persisted value with an
	// accent is asserted in the bytes the page actually draws.
	text := receiptDrawn(renderReceiptOK(t, receipt))
	for _, want := range []string{"C-2-000001", branchName, warrantyNumber,
		claim.CaseNumber, *claim.SerialNumber, claim.DeclaredFailure, customerName,
		customerPhone, "YUASA NP7-12", "WILLARD NS60L", sourceName, "Sucursal B",
		"CONDICIONES DEL CANJE", "no se extiende ni se reinicia"} {
		if !strings.Contains(text, cp1252(want)) {
			t.Fatalf("the printed receipt does not contain %q:\n%s", want, text)
		}
	}

	// The authority is the case's own: the warehouse reads the cases it moves, another
	// branch owns nothing here, and an unknown case is not found.
	if _, err := f.store.Receipt(f.ctx, f.actor(1), claim.ID); err != nil {
		t.Fatalf("the warehouse reads the case it moves: %v", err)
	}
	if _, err := f.store.Receipt(f.ctx, f.actor(3), claim.ID); !errors.Is(err, warrantycase.ErrForbidden) {
		t.Fatalf("another branch cannot print this receipt, got %v", err)
	}
	if _, err := f.store.Receipt(f.ctx, f.actor(2), 999999); !errors.Is(err, warrantycase.ErrNotFound) {
		t.Fatalf("an unknown case has no receipt, got %v", err)
	}
	if _, err := f.store.Receipt(f.ctx, f.actor(2), 0); !errors.Is(err, warrantycase.ErrNotFound) {
		t.Fatalf("a case id below one has no receipt, got %v", err)
	}
	if _, err := f.store.Receipt(f.ctx, f.actor(2), claim.ID); err != nil {
		t.Fatalf("the receipt is readable again: %v", err)
	}
}

// TestReceiptBelongsToAClaim pins the door of the paper: a finding on the shelf lent no used
// battery to a client, so it has no receipt -- the refusal is the same one its notice and
// its release state -- and a retired account prints nothing at all.
func TestReceiptBelongsToAClaim(t *testing.T) {
	f := newFixture(t)
	finding, err := f.store.OpenStockDefect(f.ctx, f.actor(2), warrantycase.StockDefectInput{
		VariantID: 1, Quantity: 1, DeclaredFailure: "No retiene carga",
		Reason: "Probada en mostrador"})
	if err != nil {
		t.Fatalf("the finding must be admitted: %v", err)
	}
	if _, err := f.store.Receipt(f.ctx, f.actor(2), finding.ID); !errors.Is(err, warrantycase.ErrClaimOnly) {
		t.Fatalf("a finding on the shelf has no receipt, got %v", err)
	}
	// A session that acts from nowhere owns no case, exactly like every other read.
	for _, actor := range []auth.Identity{
		{AccountID: f.accounts[2], Location: auth.Location{ID: 0}},
		{AccountID: 0, Location: auth.Location{ID: 2}},
		{AccountID: f.accounts[2], Location: auth.Location{ID: 2}, MustChangePassword: true},
	} {
		if _, err := f.store.Receipt(f.ctx, actor, finding.ID); !errors.Is(err, warrantycase.ErrForbidden) {
			t.Fatalf("an unprovisioned session must be refused, got %v", err)
		}
	}
}
