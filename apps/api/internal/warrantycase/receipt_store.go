// This file is the read of the loan receipt: the persisted case, its sale and its loans,
// turned into the document the branch hands to the client (S8). Nothing here is computed --
// the number, the serial, the warranty of the sale, the client, the model and the quantity
// of every loan and the instant of the handover are the values the database stored -- and
// nothing here writes: the read is one read-only transaction over a case that was already
// persisted.

package warrantycase

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"luson/api/internal/auth"
)

// Receipt reads the loan receipt of one persisted case. The authority is the case read's own
// (S19): the branch that owns the case and the warehouse that moves it; any other branch is
// refused. The paper is a claim's, because it names the client of a sale: a finding on the
// shelf has no client to hand it to (ErrClaimOnly), and a claim that has not lent its used
// battery yet has nothing to print (ErrNoLoan).
func (s *Store) Receipt(ctx context.Context, actor auth.Identity, id int64) (Receipt, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Receipt{}, ErrUnavailable
	}
	if !provisioned(actor) {
		return Receipt{}, ErrForbidden
	}
	if id < 1 {
		return Receipt{}, ErrNotFound
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Receipt{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	document, err := readCase(ctx, tx, id)
	if err != nil {
		return Receipt{}, err
	}
	if !mayActOn(actor, document.BranchLocationID) {
		return Receipt{}, ErrForbidden
	}
	// The paper belongs to the client of a sale: a finding on the shelf was never sold and lent
	// no battery to anyone, exactly like its notice and its release (S14, S19).
	if document.Origin != OriginWarrantyClaim {
		return Receipt{}, ErrClaimOnly
	}
	if len(document.Loans) == 0 {
		return Receipt{}, ErrNoLoan
	}
	if document.SerialNumber == nil || document.WarrantyNumber == nil {
		// A claim always states the serial it was opened with and the sale it was judged
		// against (065); a header without them is not what this domain wrote.
		return Receipt{}, ErrUnavailable
	}
	branch, customerName, customerPhone, err := readReceiptHeader(ctx, tx, id)
	if err != nil {
		return Receipt{}, err
	}
	sources, err := readLocationNames(ctx, tx, document.Loans)
	if err != nil {
		return Receipt{}, err
	}
	loans := make([]ReceiptLoan, 0, len(document.Loans))
	for _, loan := range document.Loans {
		source, stated := sources[loan.SourceLocationID]
		if !stated {
			return Receipt{}, ErrUnavailable
		}
		loans = append(loans, ReceiptLoan{Ordinal: loan.Ordinal, Model: loan.Model,
			Quantity: loan.Quantity, Source: source, GivenAt: loan.GivenAt})
	}
	// The paper is dated by the handover it documents: the instant the database stamped on the
	// last loan of the case, which is the one the client is leaving with. Every loan of the case
	// keeps its own date in the table.
	issued := loans[len(loans)-1].GivenAt
	receipt := Receipt{CaseNumber: document.CaseNumber, BranchName: branch, IssuedAt: issued,
		ClaimedSerial: *document.SerialNumber, WarrantyNumber: *document.WarrantyNumber,
		DeclaredFailure: document.DeclaredFailure, CustomerName: customerName,
		CustomerPhone: customerPhone, Loans: loans}
	if err := tx.Commit(ctx); err != nil {
		return Receipt{}, fail(ctx)
	}
	return receipt, nil
}

// readReceiptHeader reads the branch of the case and the client of the sale it was judged
// against. Both are the database's own values; a claim without them is not a document this
// store could have written, so the read fails closed instead of printing an empty client.
func readReceiptHeader(ctx context.Context, q querier, id int64) (string, string, string, error) {
	var branch, name, phone *string
	err := q.QueryRow(ctx, `SELECT branch.name,sale.customer_name,sale.customer_phone
 FROM warranty_cases case_row
 JOIN locations branch ON branch.id=case_row.branch_location_id
 LEFT JOIN sales sale ON sale.id=case_row.sale_id
 WHERE case_row.id=$1`, id).Scan(&branch, &name, &phone)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", "", ErrNotFound
	}
	if err != nil {
		return "", "", "", fail(ctx)
	}
	if branch == nil || name == nil || phone == nil {
		return "", "", "", ErrUnavailable
	}
	return *branch, *name, *phone, nil
}

// readLocationNames reads the name of every location a loan of the case came from (S6): the
// paper states where the used battery was taken from, and a location this installation does
// not have fails the read closed instead of leaving the paper silent.
func readLocationNames(ctx context.Context, q querier, loans []Loan) (map[int]string, error) {
	ids := make([]int16, 0, len(loans))
	seen := make(map[int]bool, len(loans))
	for _, loan := range loans {
		if seen[loan.SourceLocationID] {
			continue
		}
		seen[loan.SourceLocationID] = true
		ids = append(ids, int16(loan.SourceLocationID))
	}
	rows, err := q.Query(ctx, `SELECT id,name FROM locations WHERE id=ANY($1)`, ids)
	if err != nil {
		return nil, fail(ctx)
	}
	defer rows.Close()
	names := make(map[int]string, len(ids))
	for rows.Next() {
		var id int16
		var name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, fail(ctx)
		}
		names[int(id)] = name
	}
	if rows.Err() != nil {
		return nil, fail(ctx)
	}
	return names, nil
}
