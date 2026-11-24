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
	claim, err := readCase(ctx, tx, id)
	if err != nil {
		return Case{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Case{}, mapFailure(ctx, err)
	}
	return claim, nil
}

// OpenStockDefect opens the case of a battery the branch found failed on its own shelf (S1). The
// branch states the variant, the quantity and the motive of the write-off; the database writes the
// units off `inventory_balances` in the admission's own transaction (067) and refuses a quantity the
// branch does not have (LW016) or cannot free (LW017) without storing the case either.
func (s *Store) OpenStockDefect(ctx context.Context, actor auth.Identity, input StockDefectInput) (Case, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Case{}, ErrUnavailable
	}
	// The warehouse owns no shelf: a finding is the branch's own document (S19).
	if !branchClerk(actor) {
		return Case{}, ErrForbidden
	}
	if input.VariantID < 1 || input.VariantID > MaxVariantID {
		return Case{}, ErrInvalid
	}
	if input.Quantity < 1 || input.Quantity > MaxQuantity {
		return Case{}, ErrInvalid
	}
	declaration, ok := canonicalDeclaration(input.DeclaredFailure)
	if !ok {
		return Case{}, ErrInvalid
	}
	reason, ok := canonicalReason(input.Reason)
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
	err = tx.QueryRow(ctx, `INSERT INTO warranty_cases(branch_location_id,origin,variant_id,
  quantity,declared_failure,reason,created_by_account_id)
 VALUES($1,'stock_defect',$2,$3,$4,$5,$6) RETURNING id`,
		branch, int32(input.VariantID), input.Quantity, declaration, reason,
		int64(actor.AccountID)).Scan(&id)
	if err != nil {
		return Case{}, mapFailure(ctx, err)
	}
	finding, err := readCase(ctx, tx, id)
	if err != nil {
		return Case{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Case{}, mapFailure(ctx, err)
	}
	return finding, nil
}

// List reads the tray of a branch: its own cases, newest first, with the phase and the origin of the
// frozen vocabulary as the only filters (S23). The warehouse owns no case and moves every one of
// them, so it reads the cases of every branch and each row states the branch it belongs to (S19).
func (s *Store) List(ctx context.Context, actor auth.Identity, filter ListFilter) ([]Case, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return nil, ErrUnavailable
	}
	if !provisioned(actor) {
		return nil, ErrForbidden
	}
	if filter.Phase != "" && !filter.Phase.Valid() {
		return nil, ErrInvalid
	}
	if filter.Origin != "" && !filter.Origin.Valid() {
		return nil, ErrInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	// The warehouse is location 1: it reads every case, and a branch reads its own tray only.
	warehouse := actor.Location.ID == warehouseLocationID
	rows, err := s.pool.Query(ctx, "SELECT "+caseColumns+` FROM warranty_cases case_row
 WHERE ($1 OR branch_location_id=$2)
   AND ($3='' OR phase=$3) AND ($4='' OR origin=$4)
 ORDER BY id DESC LIMIT $5`,
		warehouse, int16(actor.Location.ID), string(filter.Phase), string(filter.Origin), MaxListed)
	if err != nil {
		return nil, fail(ctx)
	}
	defer rows.Close()
	tray := make([]Case, 0, MaxListed)
	for rows.Next() {
		document, err := scanCaseHeader(ctx, rows)
		if err != nil {
			return nil, err
		}
		tray = append(tray, document)
	}
	if rows.Err() != nil {
		return nil, fail(ctx)
	}
	return tray, nil
}

// Pending counts the cases whose next act is this actor's and never an act the actor cannot
// take (S14, S19). A branch counts the cases it still has to ship (`received`, whichever door
// they came through) and the claims it owes its client an answer: the notice and the delivery
// both wait on a resolved claim. The warehouse counts the battery it is moving -- in transit,
// waiting verification, waiting the factory's verdict -- and the release it may authorise, which
// is the single unit a claim got back for its client, already notified and not released yet. A
// finding on the shelf holds no unit in custody and a battery the factory kept never comes back,
// so neither is ever counted for the warehouse. The count is one aggregate of the read-only
// snapshot: it never loads a case, and a case of another branch is never counted.
func (s *Store) Pending(ctx context.Context, actor auth.Identity) (int64, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return 0, ErrUnavailable
	}
	if !provisioned(actor) {
		return 0, ErrForbidden
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return 0, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	warehouse := actor.Location.ID == warehouseLocationID
	var pending int64
	err = tx.QueryRow(ctx, `SELECT count(*) FROM warranty_cases case_row
 WHERE CASE WHEN $1 THEN
   case_row.phase IN ('in_transit','at_warehouse','at_factory')
   OR (case_row.phase='resolved' AND case_row.origin='warranty_claim'
       AND case_row.reported_destination='customer'
       AND EXISTS (SELECT 1 FROM warranty_case_events noticed
         WHERE noticed.case_id=case_row.id AND noticed.kind='notice')
       AND NOT EXISTS (SELECT 1 FROM warranty_case_events released
         WHERE released.case_id=case_row.id AND released.kind='release'))
 ELSE
   case_row.branch_location_id=$2
   AND (case_row.phase='received'
     OR (case_row.phase='resolved' AND case_row.origin='warranty_claim'))
 END`, warehouse, int16(actor.Location.ID)).Scan(&pending)
	if err != nil {
		return 0, fail(ctx)
	}
	if tx.Commit(ctx) != nil {
		return 0, fail(ctx)
	}
	return pending, nil
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
// nothing. The source is recorded and nothing moves -- no transfer and no balance -- because a
// used battery is not stock of any inventory (S5, S6): what moves is the derived stock of S24,
// which is the sum of the loans themselves. The origin must hold the requested model, and the
// database refuses the loan with LW033 when it does not, under a lock that keeps two loans from
// consuming one unit (S25): a loan never invents the battery it hands over.
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
	if _, err := insertEvent(ctx, tx, caseID, KindPhase, input.Phase, factoryCaseNumber,
		int64(actor.AccountID), note); err != nil {
		return Case{}, err
	}
	moved, err := readCase(ctx, tx, caseID)
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
// phase copy of the case. The kind says whether the tramo moves the case: a notice and a release
// carry the phase the case already holds (S14).
func insertEvent(ctx context.Context, tx pgx.Tx, caseID int64, kind EventKind, phase Phase,
	factoryCaseNumber string, actor int64, note string) (Event, error) {
	var event Event
	var storedPhase, storedKind string
	err := tx.QueryRow(ctx, `INSERT INTO warranty_case_events(case_id,kind,phase,factory_case_number,
  actor_account_id,note)
 VALUES($1,$2,$3,$4,$5,$6)
 RETURNING case_id,event_ordinal,kind,phase,factory_case_number,actor_account_id,recorded_at,note`,
		caseID, string(kind), string(phase), factoryCaseNumber, actor, note).Scan(&event.CaseID,
		&event.Ordinal, &storedKind, &storedPhase, &event.FactoryCaseNumber,
		&event.ActorAccountID, &event.RecordedAt, &event.Note)
	if err != nil {
		return Event{}, mapFailure(ctx, err)
	}
	event.Kind = EventKind(storedKind)
	event.Phase = Phase(storedPhase)
	return event, nil
}

// Resolve records the verdict and the destination of each unit the case has. The warehouse refuses
// before the factory and only with `refused_at_warehouse`, with its motive; the factory verdicts arrive
// at the factory (S10). The two doors resolve by their own matrix: a claim states the reported battery
// and the lent one -- `not_covered` leaves the loan with the client and the damaged unit in the used
// pool, and a claim never states a stock destination -- while a finding states the units of its shelf,
// which come back to its own branch when the verdict returns them repaired or replaced and stay written
// off when it does not (S11). The resolution is final, and the stock it returns is the database's own
// statement in the same transaction (069).
func (s *Store) Resolve(ctx context.Context, actor auth.Identity, caseID int64,
	input ResolutionInput) (Case, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Case{}, ErrUnavailable
	}
	if !provisioned(actor) {
		return Case{}, ErrForbidden
	}
	// The frozen vocabulary is refused before anything is read, exactly as before; which door states which
	// destination is judged once the case's own origin is known.
	if !input.Verdict.Valid() || !input.ReportedDestination.Valid() {
		return Case{}, ErrInvalid
	}
	if input.LoanDestination != "" && !input.LoanDestination.Valid() {
		return Case{}, ErrInvalid
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
	// This package owns both doors, and each resolves by the matrix its units state: the claim by the
	// two batteries it has, the finding by the shelf it wrote off.
	switch header.Origin {
	case OriginWarrantyClaim:
		if err := judgeResolution(input); err != nil {
			return Case{}, err
		}
	case OriginStockDefect:
		if err := judgeStockResolution(input); err != nil {
			return Case{}, err
		}
	default:
		return Case{}, ErrInvalid
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
	// The shelf of a finding is where its units end, and no caller states it: the verdict is what decides
	// whether they come back, and the store states the column the database reads under its lock (069).
	shelf := ""
	if header.Origin == OriginStockDefect {
		if destination, returns := shelfDestination(input.Verdict); returns {
			shelf = string(destination)
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE warranty_cases SET verdict=$2,reported_destination=$3,
 loan_destination=NULLIF($4,''),stock_destination=NULLIF($5,'') WHERE id=$1`, caseID,
		string(input.Verdict), string(input.ReportedDestination), string(input.LoanDestination),
		shelf); err != nil {
		return Case{}, mapFailure(ctx, err)
	}
	if _, err := insertEvent(ctx, tx, caseID, KindPhase, PhaseResolved, "",
		int64(actor.AccountID), note); err != nil {
		return Case{}, err
	}
	resolved, err := readCase(ctx, tx, caseID)
	if err != nil {
		return Case{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Case{}, mapFailure(ctx, err)
	}
	return resolved, nil
}

// RegisterNotice records the notice the branch that receives the unit registers for the client
// (S14). It is a tramo of the same history with a kind of its own: it carries the actor, the instant
// and the words of the counter, and it moves no phase, because notifying the client is not a step of
// the battery's journey. The notice exists once the factory has answered, because before that there is
// no unit to talk about, and the warehouse never registers one: the branch owes the client the answer
// and the warehouse only moves the battery (S19).
func (s *Store) RegisterNotice(ctx context.Context, actor auth.Identity, caseID int64,
	note string) (Case, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Case{}, ErrUnavailable
	}
	if !branchClerk(actor) {
		return Case{}, ErrForbidden
	}
	words, ok := canonicalNote(note)
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
	if actor.Location.ID != header.BranchLocationID {
		return Case{}, ErrForbidden
	}
	// A finding on the shelf has no client to call: the notice of this vertical is the claim's, and the
	// branch that found its own battery failed answers to no one (S14, S19, 069).
	if header.Origin != OriginWarrantyClaim {
		return Case{}, ErrClaimOnly
	}
	if header.Phase != PhaseResolved && header.Phase != PhaseClosed {
		return Case{}, ErrResolutionPending
	}
	if _, err := insertEvent(ctx, tx, caseID, KindNotice, header.Phase, "",
		int64(actor.AccountID), words); err != nil {
		return Case{}, err
	}
	noticed, err := readCase(ctx, tx, caseID)
	if err != nil {
		return Case{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Case{}, mapFailure(ctx, err)
	}
	return noticed, nil
}

// AuthorizeRelease authorises the release of the units the case holds in custody back to the
// branch's sellable stock (S13, S14). The warehouse decides and the branch does not: the branch owes
// the client the answer, the warehouse moves the battery, and the release is the warehouse moving it
// across the boundary in the other direction. It requires the recorded notice, it carries its motive,
// and it happens once; the database states all three as well as this store does.
func (s *Store) AuthorizeRelease(ctx context.Context, actor auth.Identity, caseID int64,
	note string) (Case, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Case{}, ErrUnavailable
	}
	// The release is the warehouse's own tramo: a branch account never authorises one (S19).
	if !provisioned(actor) || actor.Location.ID != warehouseLocationID {
		return Case{}, ErrForbidden
	}
	words, ok := canonicalReason(note)
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
	// A finding holds no unit in custody: its units are the branch's own and came back at its resolution,
	// so a release would move them a second time (S13, S14, 069).
	if header.Origin != OriginWarrantyClaim {
		return Case{}, ErrClaimOnly
	}
	if header.Phase != PhaseResolved && header.Phase != PhaseClosed {
		return Case{}, ErrResolutionPending
	}
	if _, err := insertEvent(ctx, tx, caseID, KindRelease, header.Phase, "",
		int64(actor.AccountID), words); err != nil {
		return Case{}, err
	}
	released, err := readCase(ctx, tx, caseID)
	if err != nil {
		return Case{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Case{}, mapFailure(ctx, err)
	}
	return released, nil
}

// DeliverExchange delivers the battery the factory returned to the client and closes the case (S13,
// S19). The branch delivers, and the counter states what became of the lent battery in the same act:
// the client gave the used one back or kept it. The delivery settles every open loan of the case and
// writes no stock -- the unit leaves the branch with the client, and custody was settled by the
// release or by the delivery itself.
func (s *Store) DeliverExchange(ctx context.Context, actor auth.Identity, caseID int64,
	input DeliveryInput) (Case, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return Case{}, ErrUnavailable
	}
	// The branch answers to the client and the warehouse owns none (S19).
	if !branchClerk(actor) {
		return Case{}, ErrForbidden
	}
	// A delivery decides the loan: the used battery comes back or stays with the client. The three
	// other fates are stated by the counter before the delivery and never by it.
	if input.LoanFate != LoanReturned && input.LoanFate != LoanKeptByCustomer {
		return Case{}, ErrInvalid
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
	if actor.Location.ID != header.BranchLocationID {
		return Case{}, ErrForbidden
	}
	next, admitted := nextPhase(header.Phase)
	if !admitted || next != PhaseClosed {
		return Case{}, &PhaseRefusal{From: header.Phase, To: PhaseClosed}
	}
	// Every loan still open is settled by the delivery itself, and the database stamps the instant: a
	// used battery is either back in the branch or gone with the client (S7, S17).
	if _, err := tx.Exec(ctx, `UPDATE warranty_case_loans SET fate=$2
 WHERE case_id=$1 AND fate='open'`, caseID, string(input.LoanFate)); err != nil {
		return Case{}, mapFailure(ctx, err)
	}
	if _, err := insertEvent(ctx, tx, caseID, KindPhase, PhaseClosed, "",
		int64(actor.AccountID), note); err != nil {
		return Case{}, err
	}
	delivered, err := readCase(ctx, tx, caseID)
	if err != nil {
		return Case{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Case{}, mapFailure(ctx, err)
	}
	return delivered, nil
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

// judgeStockResolution applies the resolution matrix of a finding on the shelf (S11). A finding has no
// client and lends no battery, so it states the units it wrote off and nothing else: a repair and a
// replacement are the branch's own sellable stock again, and a refusal of the factory leaves those
// damaged units in the used pool or out as scrap with the write-off of 067 standing. The shelf's own
// destination is not the caller's either -- it is the verdict's reading, which the database reads under
// its lock (069).
func judgeStockResolution(input ResolutionInput) error {
	if !input.Verdict.Valid() || !input.ReportedDestination.Valid() {
		return ErrInvalid
	}
	// A finding lends no battery, so a loan destination is a value this door could not have written.
	if input.LoanDestination != "" {
		return ErrInvalid
	}
	switch input.Verdict {
	case VerdictRepaired, VerdictReplaced:
		// The units come back repaired or a replacement enters in their place, either way into the
		// branch that found them deficient: a finding has no client to deliver them to.
		if input.ReportedDestination != DestinationStock {
			return ErrMatrix
		}
	case VerdictNotCovered:
		// The factory refused the warranty: the damaged units stay in the used pool or leave as scrap.
		if input.ReportedDestination != DestinationStock &&
			input.ReportedDestination != DestinationScrap {
			return ErrMatrix
		}
	}
	return nil
}

// shelfDestination is where the units of a finding end when its verdict returns them: the branch's own
// sellable stock for a repair and for a replacement, and nowhere for every other verdict, which leaves
// the write-off of the admission standing (S11).
func shelfDestination(verdict Verdict) (Destination, bool) {
	switch verdict {
	case VerdictRepaired, VerdictReplaced:
		return DestinationStock, true
	}
	return "", false
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

// caseColumns is the row of a case as every read of this package publishes it: the header, the
// printed number of the claimed sale (S8) and the motive of a finding on the shelf (S16).
const caseColumns = `id,branch_location_id,branch_sequence,case_number,origin,phase,
  verdict,reported_destination,loan_destination,stock_destination,sale_id,
  (SELECT sale.warranty_number FROM sales sale WHERE sale.id=case_row.sale_id),variant_id,
  serial_number,quantity,declared_failure,reason,created_by_account_id,created_at`

// readCaseHeader reads one case header. A lock is taken when the caller is about to append
// a tramo or a loan, so the state it judges is the state the write sees.
func readCaseHeader(ctx context.Context, q querier, id int64, lock bool) (Case, error) {
	statement := "SELECT " + caseColumns + " FROM warranty_cases case_row WHERE id=$1"
	if lock {
		statement += " FOR UPDATE"
	}
	document, err := scanCaseHeader(ctx, q.QueryRow(ctx, statement, id))
	if err != nil {
		return Case{}, err
	}
	return document, nil
}

// scanCaseHeader rebuilds one persisted header and maps the database's refusal when the row is not
// there: an unknown case is never an empty document.
func scanCaseHeader(ctx context.Context, row pgx.Row) (Case, error) {
	var (
		document                       Case
		branch                         int16
		origin, phase                  string
		verdict, reported, loan, stock *string
		serial, warrantyNumber, reason *string
		saleID, quantity               *int64
	)
	err := row.Scan(&document.ID, &branch, &document.BranchSequence,
		&document.CaseNumber, &origin, &phase, &verdict, &reported, &loan, &stock, &saleID,
		&warrantyNumber, &document.VariantID, &serial, &quantity, &document.DeclaredFailure,
		&reason, &document.CreatedByAccountID, &document.CreatedAt)
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
	document.WarrantyNumber = warrantyNumber
	document.SerialNumber = serial
	document.Quantity = quantity
	document.Reason = reason
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
	rows, err := q.Query(ctx, `SELECT case_id,event_ordinal,kind,phase,factory_case_number,
  actor_account_id,recorded_at,note
 FROM warranty_case_events WHERE case_id=$1 ORDER BY event_ordinal`, id)
	if err != nil {
		return nil, fail(ctx)
	}
	defer rows.Close()
	events := []Event{}
	for rows.Next() {
		var item Event
		var phase, kind string
		if err := rows.Scan(&item.CaseID, &item.Ordinal, &kind, &phase, &item.FactoryCaseNumber,
			&item.ActorAccountID, &item.RecordedAt, &item.Note); err != nil {
			return nil, fail(ctx)
		}
		item.Kind = EventKind(kind)
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
	// LW016 and LW017: the finding on the shelf writes its stock off, and the branch states what it
	// has and has not already promised (S16).
	case "LW016":
		return ErrNoStock
	case "LW017":
		return ErrReservedStock
	// LW019: a case registers its notice and its release once each (S14).
	case "LW019":
		return ErrAlreadyReleased
	// LW033: the origin of a loan does not hold the requested model (S25). The database states the
	// shortage inside the same transaction, so the refused loan leaves no row and no unit lent.
	case "LW033":
		return ErrLoanSourceStock
	// LW020: the release requires a recorded notice, and LW021 states that the factory has not
	// answered yet, so there is nothing to notify and nothing to release.
	case "LW020":
		return ErrNoticeRequired
	case "LW021":
		return ErrResolutionPending
	// LW022, LW023 and LW026: the actor split of S14 and S19 -- the notice and the delivery are the
	// branch's, the release is the warehouse's.
	case "LW022", "LW023", "LW026":
		return ErrForbidden
	// LW030 and LW031: a finding on the shelf registers no notice and authorises no release, because
	// there is no client to call and its units already returned at its resolution (S14, S19, 069).
	case "LW030", "LW031":
		return ErrClaimOnly
	// LW027, LW028, LW029 and LW032 restate what this store writes when it resolves a finding: the
	// verdict, the shelf destination, the balance row and the bound of the units that return. Reaching
	// one of them means the row is not what this domain wrote, so they fail closed instead of inventing
	// a balance.
	case "LW027", "LW028", "LW029", "LW032":
		return ErrUnavailable
	// LW024 restates an invariant the admission of the finding already enforced; reaching it means the
	// balance of the branch is not what this domain wrote, so it fails closed instead of inventing one.
	case "LW024":
		return ErrUnavailable
	// LW025: the case holds no unit to release (S13).
	case "LW025":
		return ErrReleaseUnavailable
	// A refused row shape, an unknown reference or an invalid vocabulary value.
	case "23503", "23514", "22003":
		return ErrInvalid
		// LW009, LW010, LW013 and LW015 restate invariants this store already enforces; reaching
		// them means the ledger is not what this domain wrote.
	}
	return ErrUnavailable
}
