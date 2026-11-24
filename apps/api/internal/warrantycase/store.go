package warrantycase

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"luson/api/internal/auth"
)

// Store persists the warranty-claim door of the battery case and reads it back.
type Store struct{ pool *pgxpool.Pool }

// New builds the store over the shared pool.
func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

type querier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

// fail retains cancellation semantics but never driver/config/SQL details.
func fail(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return ErrUnavailable
}

// resolveBranch is the actor-to-branch authority: the branch a case belongs to is the
// account's own provisioned location, never a value from the request. A session of the
// warehouse, a retired account and a retired branch are all refused instead of being
// defaulted to another branch.
func resolveBranch(ctx context.Context, q querier, actor auth.Identity) (int16, error) {
	var branch int16
	err := q.QueryRow(ctx, `SELECT a.location_id FROM auth_accounts a
 JOIN locations l ON l.id=a.location_id AND l.deleted_at IS NULL
 WHERE a.id=$1 AND a.location_id=$2 AND a.deleted_at IS NULL AND a.location_id>$3`,
		actor.AccountID, actor.Location.ID, warehouseLocationID).Scan(&branch)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrForbidden
	}
	if err != nil {
		return 0, fail(ctx)
	}
	return branch, nil
}

// branchClerk admits a completed branch session. The warehouse owns no client and cannot
// open a claim or lend a used battery.
func branchClerk(actor auth.Identity) bool {
	return actor.AccountID > 1 && actor.Location.ID > warehouseLocationID &&
		actor.Location.ID <= maxBranchLocationID && !actor.MustChangePassword
}

// provisioned admits an account with a real location, branch or warehouse, so a journey
// tramo can be recorded by the branch that owns the case or by the warehouse that moves it.
func provisioned(actor auth.Identity) bool {
	return actor.AccountID >= 1 && actor.Location.ID >= warehouseLocationID &&
		actor.Location.ID <= maxBranchLocationID && !actor.MustChangePassword
}

// mayActOn says a branch acts on its own cases and the warehouse acts on every case it
// moves. The branch owes the client the answer; the warehouse only moves the battery (S19).
func mayActOn(actor auth.Identity, branch int) bool {
	return provisioned(actor) && (actor.Location.ID == warehouseLocationID || actor.Location.ID == branch)
}

// OpenClaim opens the case of a sold battery the client brought back under warranty. The
// database resolves the sale and the variant from the serial and refuses a serial nobody
// sold, a unit sold without a term and a term that has run out; this store maps each of the
// three refusals to its own error and writes nothing when one of them lands.
func (s *Store) OpenClaim(ctx context.Context, actor auth.Identity, input OpenClaimInput) (Case, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Case{}, ErrUnavailable
	}
	if !branchClerk(actor) {
		return Case{}, ErrForbidden
	}
	serial, ok := CanonicalClaimSerial(input.SerialNumber)
	if !ok {
		return Case{}, ErrInvalid
	}
	declaration, ok := canonicalDeclaration(input.DeclaredFailure)
	if !ok {
		return Case{}, ErrInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Case{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	branch, err := resolveBranch(ctx, tx, actor)
	if err != nil {
		return Case{}, err
	}
	var id int64
	// The branch, the sale, the variant and the case number are the database's own: the
	// client states only the serial it brought and what failed.
	err = tx.QueryRow(ctx, `INSERT INTO warranty_cases(branch_location_id,origin,serial_number,
 declared_failure,created_by_account_id)
 VALUES($1,'warranty_claim',$2,$3,$4) RETURNING id`,
		branch, serial, declaration, int64(actor.AccountID)).Scan(&id)
	if err != nil {
		return Case{}, mapFailure(ctx, err)
	}
	claim, err := readCaseHeader(ctx, tx, id, false)
	if err != nil {
		return Case{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Case{}, mapFailure(ctx, err)
	}
	return claim, nil
}

// Read reads one case with its loans and its append-only history. A branch reads its own
// cases and the warehouse reads the cases it moves; a case of another branch is refused.
func (s *Store) Read(ctx context.Context, actor auth.Identity, id int64) (Case, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Case{}, ErrUnavailable
	}
	if !provisioned(actor) {
		return Case{}, ErrForbidden
	}
	if id < 1 {
		return Case{}, ErrNotFound
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Case{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	document, err := readCase(ctx, tx, id)
	if err != nil {
		return Case{}, err
	}
	if !mayActOn(actor, document.BranchLocationID) {
		return Case{}, ErrForbidden
	}
	if err := tx.Commit(ctx); err != nil {
		return Case{}, fail(ctx)
	}
	return document, nil
}

// AddLoan hands one used battery to the client of a case. The loan names a model and a
// quantity and never a physical battery: its serial is optional free text that keys
// nothing. The source is recorded and nothing moves -- no transfer, no balance, no used
// stock -- because a used battery is not stock anywhere in this repository (S5, S6).
func (s *Store) AddLoan(ctx context.Context, actor auth.Identity, caseID int64, input LoanInput) (Loan, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Loan{}, ErrUnavailable
	}
	if !branchClerk(actor) {
		return Loan{}, ErrForbidden
	}
	model, ok := canonicalLoanModel(input.Model)
	if !ok {
		return Loan{}, ErrInvalid
	}
	if input.Quantity < MinLoanQuantity || input.Quantity > MaxLoanQuantity {
		return Loan{}, ErrInvalid
	}
	serial, ok := canonicalLoanSerial(input.SerialNumber)
	if !ok {
		return Loan{}, ErrInvalid
	}
	if !validSourceLocation(input.SourceLocationID) {
		return Loan{}, ErrInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Loan{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	header, err := readCaseHeader(ctx, tx, caseID, true)
	if err != nil {
		return Loan{}, err
	}
	// The branch that owns the case lends, whatever branch or warehouse the battery comes
	// from: the loan is part of the answer the branch owes its client (S19).
	if actor.Location.ID != header.BranchLocationID {
		return Loan{}, ErrForbidden
	}
	loan, err := scanLoan(ctx, tx.QueryRow(ctx, `INSERT INTO warranty_case_loans(case_id,model,
  quantity,serial_number,source_location_id,given_by_account_id)
 VALUES($1,$2,$3,$4,$5,$6)
 RETURNING case_id,loan_ordinal,model,quantity,serial_number,source_location_id,given_at,
  fate,fate_decided_at,given_by_account_id`,
		caseID, model, input.Quantity, serial, int16(input.SourceLocationID),
		int64(actor.AccountID)))
	if err != nil {
		return Loan{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Loan{}, mapFailure(ctx, err)
	}
	return loan, nil
}

// DecideLoan states what became of one lent battery. A fate once decided is final: a failed
// used battery is replaced by another loan of the same case, never by rewriting the one that
// failed (S7). The instant of the decision is the database's own and is not stated here.
func (s *Store) DecideLoan(ctx context.Context, actor auth.Identity, caseID int64, ordinal int,
	fate LoanFate) (Loan, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Loan{}, ErrUnavailable
	}
	if !branchClerk(actor) {
		return Loan{}, ErrForbidden
	}
	if !fate.Decided() {
		return Loan{}, ErrInvalid
	}
	if ordinal < 1 {
		return Loan{}, ErrNotFound
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Loan{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	header, err := readCaseHeader(ctx, tx, caseID, true)
	if err != nil {
		return Loan{}, err
	}
	if actor.Location.ID != header.BranchLocationID {
		return Loan{}, ErrForbidden
	}
	var current string
	err = tx.QueryRow(ctx, `SELECT fate FROM warranty_case_loans
 WHERE case_id=$1 AND loan_ordinal=$2 FOR UPDATE`, caseID, ordinal).Scan(&current)
	if errors.Is(err, pgx.ErrNoRows) {
		return Loan{}, ErrNotFound
	}
	if err != nil {
		return Loan{}, fail(ctx)
	}
	// A fate that already left open is final, even if the caller repeats it: the decision
	// happened once and the loan is history, not a field to toggle.
	if current != string(LoanOpen) {
		return Loan{}, ErrLoanFateFinal
	}
	loan, err := scanLoan(ctx, tx.QueryRow(ctx, `UPDATE warranty_case_loans SET fate=$3
 WHERE case_id=$1 AND loan_ordinal=$2
 RETURNING case_id,loan_ordinal,model,quantity,serial_number,source_location_id,given_at,
  fate,fate_decided_at,given_by_account_id`, caseID, ordinal, string(fate)))
	if err != nil {
		return Loan{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Loan{}, mapFailure(ctx, err)
	}
	return loan, nil
}

// Advance records one tramo of the journey. The order is the frozen order of S9:
// received, in transit, at the warehouse, at the factory, resolved and closed. `resolved`
// is reached through the resolution and never through a bare transition, the factory
// shipment carries its file number and no other tramo does, and a refused transition
// writes nothing.
func (s *Store) Advance(ctx context.Context, actor auth.Identity, caseID int64,
	input AdvanceInput) (Case, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Case{}, ErrUnavailable
	}
	if !provisioned(actor) {
		return Case{}, ErrForbidden
	}
	if !input.Phase.Valid() {
		return Case{}, ErrInvalid
	}
	note, ok := canonicalNote(input.Note)
	if !ok {
		return Case{}, ErrInvalid
	}
	factoryCaseNumber, ok := canonicalFactoryNumber(input.FactoryCaseNumber)
	if !ok {
		return Case{}, ErrInvalid
	}
	if input.Phase == PhaseAtFactory {
		if factoryCaseNumber == "" {
			return Case{}, ErrFactoryFileRequired
		}
	} else if factoryCaseNumber != "" {
		return Case{}, ErrFactoryFileOnlyOnShipment
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Case{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	// The case row stays locked while the tramo is judged and appended, so two writers cannot
	// both move one case from the same phase.
	header, err := readCaseHeader(ctx, tx, caseID, true)
	if err != nil {
		return Case{}, err
	}
	if !mayActOn(actor, header.BranchLocationID) {
		return Case{}, ErrForbidden
	}
	next, admitted := nextPhase(header.Phase)
	if !admitted || next != input.Phase {
		return Case{}, &PhaseRefusal{From: header.Phase, To: input.Phase}
	}
	if next == PhaseResolved {
		return Case{}, ErrResolutionRequired
	}
	if _, err := insertEvent(ctx, tx, caseID, input.Phase, factoryCaseNumber,
		int64(actor.AccountID), note); err != nil {
		return Case{}, err
	}
	moved, err := readCaseHeader(ctx, tx, caseID, false)
	if err != nil {
		return Case{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Case{}, mapFailure(ctx, err)
	}
	return moved, nil
}

// nextPhase is the one edge the frozen order admits from a phase. The absent edge is the
// terminal `closed`, which never moves again.
func nextPhase(from Phase) (Phase, bool) {
	switch from {
	case PhaseReceived:
		return PhaseInTransit, true
	case PhaseInTransit:
		return PhaseAtWarehouse, true
	case PhaseAtWarehouse:
		return PhaseAtFactory, true
	case PhaseAtFactory:
		return PhaseResolved, true
	case PhaseResolved:
		return PhaseClosed, true
	}
	return "", false
}

// insertEvent appends one tramo and lets the database number it, date it and write the
// phase copy of the case.
func insertEvent(ctx context.Context, tx pgx.Tx, caseID int64, phase Phase,
	factoryCaseNumber string, actor int64, note string) (Event, error) {
	var event Event
	var stored string
	err := tx.QueryRow(ctx, `INSERT INTO warranty_case_events(case_id,phase,factory_case_number,
  actor_account_id,note)
 VALUES($1,$2,$3,$4,$5)
 RETURNING case_id,event_ordinal,phase,factory_case_number,actor_account_id,recorded_at,note`,
		caseID, string(phase), factoryCaseNumber, actor, note).Scan(&event.CaseID,
		&event.Ordinal, &stored, &event.FactoryCaseNumber, &event.ActorAccountID,
		&event.RecordedAt, &event.Note)
	if err != nil {
		return Event{}, mapFailure(ctx, err)
	}
	event.Phase = Phase(stored)
	return event, nil
}

// Resolve records the verdict and the destination of the reported and the lent battery.
// The warehouse refuses before the factory and only with `refused_at_warehouse`, with its
// motive; the factory verdicts arrive at the factory. `not_covered` leaves the loan with the
// client and the damaged unit in the used pool, and a claim never states a stock destination
// (S10, S11). The resolution is final and this store writes no inventory balance.
func (s *Store) Resolve(ctx context.Context, actor auth.Identity, caseID int64,
	input ResolutionInput) (Case, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Case{}, ErrUnavailable
	}
	if !provisioned(actor) {
		return Case{}, ErrForbidden
	}
	if err := judgeResolution(input); err != nil {
		return Case{}, err
	}
	note, ok := canonicalNote(input.Note)
	if !ok {
		return Case{}, ErrInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Case{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	header, err := readCaseHeader(ctx, tx, caseID, true)
	if err != nil {
		return Case{}, err
	}
	if !mayActOn(actor, header.BranchLocationID) {
		return Case{}, ErrForbidden
	}
	// This package owns the claim door: the branch's failed shelf is another document.
	if header.Origin != OriginWarrantyClaim {
		return Case{}, ErrClaimOnly
	}
	if header.Verdict != nil || header.Phase == PhaseResolved || header.Phase == PhaseClosed {
		return Case{}, ErrResolutionFinal
	}
	switch header.Phase {
	case PhaseAtWarehouse:
		// The warehouse's gate before the factory: it can only refuse, and it must say why.
		if input.Verdict != VerdictRefusedAtWarehouse {
			return Case{}, ErrWarehouseVerdict
		}
		if note == "" {
			return Case{}, ErrNoteRequired
		}
	case PhaseAtFactory:
		if input.Verdict == VerdictRefusedAtWarehouse {
			return Case{}, ErrWarehouseVerdict
		}
	default:
		return Case{}, &PhaseRefusal{From: header.Phase, To: PhaseResolved}
	}
	if _, err := tx.Exec(ctx, `UPDATE warranty_cases SET verdict=$2,reported_destination=$3,
 loan_destination=$4 WHERE id=$1`, caseID, string(input.Verdict),
		string(input.ReportedDestination), string(input.LoanDestination)); err != nil {
		return Case{}, mapFailure(ctx, err)
	}
	if _, err := insertEvent(ctx, tx, caseID, PhaseResolved, "", int64(actor.AccountID),
		note); err != nil {
		return Case{}, err
	}
	resolved, err := readCaseHeader(ctx, tx, caseID, false)
	if err != nil {
		return Case{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Case{}, mapFailure(ctx, err)
	}
	return resolved, nil
}

// judgeResolution applies the resolution matrix of a claim: the verdict and both
// destinations are stated, every value is in the frozen vocabulary (S23), and the one
// combination S11 names is enforced -- `not_covered` leaves the lent battery with the
// client and the damaged unit either in the used pool or out of it as scrap. A claim
// states no stock destination at all, so there is nothing to judge there.
func judgeResolution(input ResolutionInput) error {
	if !input.Verdict.Valid() || !input.ReportedDestination.Valid() ||
		!input.LoanDestination.Valid() {
		return ErrInvalid
	}
	if input.Verdict == VerdictNotCovered {
		if input.LoanDestination != DestinationCustomer {
			return ErrMatrix
		}
		if input.ReportedDestination != DestinationStock &&
			input.ReportedDestination != DestinationScrap {
			return ErrMatrix
		}
	}
	return nil
}

// scanLoan rebuilds one persisted loan and maps the database's refusal when the row is not
// there or the guard refuses the write.
func scanLoan(ctx context.Context, row pgx.Row) (Loan, error) {
	var item Loan
	var source int16
	var fate string
	err := row.Scan(&item.CaseID, &item.Ordinal, &item.Model, &item.Quantity,
		&item.SerialNumber, &source, &item.GivenAt, &fate, &item.FateDecidedAt,
		&item.GivenByAccountID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Loan{}, ErrNotFound
	}
	if err != nil {
		return Loan{}, mapFailure(ctx, err)
	}
	item.SourceLocationID = int(source)
	item.Fate = LoanFate(fate)
	return item, nil
}

// readCase reads one case whole: its header, its loans in ordinal order and its history in
// the order the database appended it.
func readCase(ctx context.Context, q querier, id int64) (Case, error) {
	document, err := readCaseHeader(ctx, q, id, false)
	if err != nil {
		return Case{}, err
	}
	if document.Loans, err = readLoans(ctx, q, id); err != nil {
		return Case{}, err
	}
	if document.Events, err = readEvents(ctx, q, id); err != nil {
		return Case{}, err
	}
	return document, nil
}

// readCaseHeader reads one case header. A lock is taken when the caller is about to append
// a tramo or a loan, so the state it judges is the state the write sees.
func readCaseHeader(ctx context.Context, q querier, id int64, lock bool) (Case, error) {
	statement := `SELECT id,branch_location_id,branch_sequence,case_number,origin,phase,
  verdict,reported_destination,loan_destination,stock_destination,sale_id,variant_id,
  serial_number,quantity,declared_failure,created_by_account_id,created_at
 FROM warranty_cases WHERE id=$1`
	if lock {
		statement += " FOR UPDATE"
	}
	var (
		document                       Case
		branch                         int16
		origin, phase                  string
		verdict, reported, loan, stock *string
		serial                         *string
		saleID, quantity               *int64
	)
	err := q.QueryRow(ctx, statement, id).Scan(&document.ID, &branch, &document.BranchSequence,
		&document.CaseNumber, &origin, &phase, &verdict, &reported, &loan, &stock, &saleID,
		&document.VariantID, &serial, &quantity, &document.DeclaredFailure,
		&document.CreatedByAccountID, &document.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Case{}, ErrNotFound
	}
	if err != nil {
		return Case{}, fail(ctx)
	}
	document.BranchLocationID = int(branch)
	document.Origin = Origin(origin)
	document.Phase = Phase(phase)
	document.Verdict = verdictOf(verdict)
	document.ReportedDestination = destinationOf(reported)
	document.LoanDestination = destinationOf(loan)
	document.StockDestination = destinationOf(stock)
	document.SaleID = saleID
	document.SerialNumber = serial
	document.Quantity = quantity
	return document, nil
}

func verdictOf(value *string) *Verdict {
	if value == nil {
		return nil
	}
	verdict := Verdict(*value)
	return &verdict
}

func destinationOf(value *string) *Destination {
	if value == nil {
		return nil
	}
	destination := Destination(*value)
	return &destination
}

// readLoans reads the loans of one case in the order the counter handed them over.
func readLoans(ctx context.Context, q querier, id int64) ([]Loan, error) {
	rows, err := q.Query(ctx, `SELECT case_id,loan_ordinal,model,quantity,serial_number,
  source_location_id,given_at,fate,fate_decided_at,given_by_account_id
 FROM warranty_case_loans WHERE case_id=$1 ORDER BY loan_ordinal`, id)
	if err != nil {
		return nil, fail(ctx)
	}
	defer rows.Close()
	loans := []Loan{}
	for rows.Next() {
		var item Loan
		var source int16
		var fate string
		if err := rows.Scan(&item.CaseID, &item.Ordinal, &item.Model, &item.Quantity,
			&item.SerialNumber, &source, &item.GivenAt, &fate, &item.FateDecidedAt,
			&item.GivenByAccountID); err != nil {
			return nil, fail(ctx)
		}
		item.SourceLocationID = int(source)
		item.Fate = LoanFate(fate)
		loans = append(loans, item)
	}
	if rows.Err() != nil {
		return nil, fail(ctx)
	}
	return loans, nil
}

// readEvents reads the append-only history of one case in its own order.
func readEvents(ctx context.Context, q querier, id int64) ([]Event, error) {
	rows, err := q.Query(ctx, `SELECT case_id,event_ordinal,phase,factory_case_number,
  actor_account_id,recorded_at,note
 FROM warranty_case_events WHERE case_id=$1 ORDER BY event_ordinal`, id)
	if err != nil {
		return nil, fail(ctx)
	}
	defer rows.Close()
	events := []Event{}
	for rows.Next() {
		var item Event
		var phase string
		if err := rows.Scan(&item.CaseID, &item.Ordinal, &phase, &item.FactoryCaseNumber,
			&item.ActorAccountID, &item.RecordedAt, &item.Note); err != nil {
			return nil, fail(ctx)
		}
		item.Phase = Phase(phase)
		events = append(events, item)
	}
	if rows.Err() != nil {
		return nil, fail(ctx)
	}
	return events, nil
}

// mapFailure publishes the database's own decision and nothing else: SQLSTATE is the only
// trusted evidence. The LW codes of this vertical are mapped to the domain refusal they
// state; a code this store already derived means the ledger is not what this domain wrote
// and fails closed instead of being published as a client mistake.
func mapFailure(ctx context.Context, err error) error {
	if err == nil {
		return nil
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return ctxErr
	}
	var pg *pgconn.PgError
	if !errors.As(err, &pg) {
		return ErrUnavailable
	}
	switch pg.Code {
	// LW001: the case belongs to an active branch and is opened by that branch's account.
	case "LW001":
		return ErrForbidden
	// LW002, LW003, LW004: the claim against the sale (S2).
	case "LW002":
		return ErrSerialNotSold
	case "LW003":
		return ErrNoWarranty
	case "LW004":
		return ErrWarrantyExpired
	// LW005: this vertical is about batteries and nothing else.
	case "LW005":
		return ErrInvalid
	// LW006: a tramo that enters the phase the case already holds.
	case "LW006":
		return ErrTransition
	// LW007: the factory file number travels with the factory shipment and nothing else.
	case "LW007":
		return ErrFactoryFileOnlyOnShipment
	// LW008: no persisted case, or a history that exhausted its bound.
	case "LW008":
		return ErrInvalid
	// LW011 and LW012: a loan is frozen and a decided fate is final (S7).
	case "LW011":
		return ErrUnavailable
	case "LW012":
		return ErrLoanFateFinal
	// LW014: a loan requires a persisted case.
	case "LW014":
		return ErrNotFound
	// A refused row shape, an unknown reference or an invalid vocabulary value.
	case "23503", "23514", "22003":
		return ErrInvalid
		// LW009, LW010, LW013 and LW015 restate invariants this store already enforces; reaching
		// them means the ledger is not what this domain wrote.
	}
	return ErrUnavailable
}
