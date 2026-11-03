// Package-internal, test-only simulation of the three legacy audit writers this
// feature retired: count corrections, restitutions and dispatch reconciliations.
//
// What this is: the exact Go entrypoints the product used to expose -
// ProposeCount/DecideCount, ProposeRestitution/DecideRestitution and
// ProposeDispatchReconciliation/DecideDispatchReconciliation - moved here
// verbatim, together with their input types and the private helpers only they
// reach (correctCount, countError, restitute, restitutionError,
// reconcileDispatch, dispatchReconciliationError and
// CheckDispatchReconciliationAccess).
//
// Why it still exists: several surviving tests in this package (unified
// reconciliation, personal activity, action list, dynamic branches, assigned
// identity) need historical evidence that genuinely predates the unified flow,
// produced by the real SQL entrypoints instead of fabricated rows. Those setups
// are exactly what these writers do, so keeping them here preserves that
// coverage without putting retired write paths back into the product.
//
// What it is not: product code. The file is named *_test.go, so it is linked
// only into test binaries; no product path, handler, binary or deploy can reach
// it. The SQL functions it calls (transfer_count_correct, transfer_restitute,
// transfer_dispatch_reconcile) stay in the migrations as historical evidence,
// and the product read side uses the SQL snapshot readers directly.
//
// Exit condition: delete this file only once every setup that calls it has been
// re-seeded through those SQL entrypoints, or dropped. Until then never remove a
// moved symbol here without moving its callers first.
package transfers

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"luson/api/internal/auth"
)

// Count inputs never contain an actor or client-computed credit. OperationKey is
// a global durable identity: retain the entire input for uncertain-write retries.
type CountProposalInput struct {
	VariantID        int64
	OperationKey     string
	ExpectedRevision int64
	Actual           int64
	Reason           string
}
type CountDecisionInput struct {
	VariantID        int64
	OperationKey     string
	ExpectedRevision int64
	Accept           bool
	Reason           string
}

func (s *Store) ProposeCount(ctx context.Context, actor auth.Identity, id int64, in CountProposalInput) (CountOperation, error) {
	actual := in.Actual // Copy caller input; do not trim accepted reason semantics.
	return s.correctCount(ctx, actor, id, in.VariantID, in.OperationKey, "propose", in.ExpectedRevision, &actual, in.Reason)
}
func (s *Store) DecideCount(ctx context.Context, actor auth.Identity, id int64, in CountDecisionInput) (CountOperation, error) {
	action := "reject"
	if in.Accept {
		action = "accept"
	}
	return s.correctCount(ctx, actor, id, in.VariantID, in.OperationKey, action, in.ExpectedRevision, nil, in.Reason)
}

func (s *Store) correctCount(ctx context.Context, actor auth.Identity, id, variant int64, key, action string, revision int64, actual *int64, reason string) (CountOperation, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return CountOperation{}, ErrUnavailable
	}
	if !assigned(actor) {
		return CountOperation{}, ErrForbidden
	}
	if id < 1 {
		return CountOperation{}, ErrNotFound
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := checkAssignment(ctx, s.pool, actor); err != nil {
		return CountOperation{}, err
	}
	tx, err := s.beginPersonal(ctx, actor)
	if err != nil {
		return CountOperation{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	// Authorize physical participation before even validating retry identity.
	// The SQL entrypoint repeats authorization under its shared lock, owns all
	// effects, and keeps database owners' administrative authority explicit.
	var status string
	err = tx.QueryRow(ctx, `SELECT status FROM transfer_requests WHERE id=$1 AND $2 IN (origin_location_id,destination_location_id)`, id, actor.Location.ID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return CountOperation{}, ErrNotFound
	}
	if err != nil {
		return CountOperation{}, fail(ctx)
	}
	if status != "received" {
		return CountOperation{}, ErrDecisionConflict
	}
	if !validCountInput(variant, key, revision, actual, reason) {
		return CountOperation{}, ErrInvalid
	}
	var op CountOperation
	err = tx.QueryRow(ctx, `SELECT operation_key,request_id,variant_id,actor_location_id,action,expected_revision,actual_quantity,reason,revision,recorded_at
 FROM transfer_count_correct($1,$2::integer,$3::smallint,$4,$5,$6,$7,$8)`, id, variant, actor.Location.ID, key, action, revision, actual, reason).Scan(
		&op.OperationKey, &op.RequestID, &op.VariantID, &op.ActorLocationID, &op.Action, &op.ExpectedRevision, &op.Actual, &op.Reason, &op.Revision, &op.RecordedAt)
	if err != nil {
		return CountOperation{}, countError(ctx, err)
	}
	if err = tx.Commit(ctx); err != nil {
		return CountOperation{}, fail(ctx)
	}
	op.RecordedAt = op.RecordedAt.UTC()
	return op, nil
}

// Only known correction failures become domain conflicts. Unknown constraints,
// isolation mistakes (25000), and operational failures remain unavailable; no
// SQL text, private reason, or driver details cross the Store boundary.
func countError(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if activeLocationRequired(err) {
		return ErrDecisionConflict
	}
	var p *pgconn.PgError
	if !errors.As(err, &p) {
		return fail(ctx)
	}
	switch p.Code {
	case "42501":
		if p.Message == "Correction endpoint unauthorized" || p.Message == "Correction requires a physical endpoint of a received transfer" || p.Message == "Only initiator may replace a pending proposal" || p.Message == "Only exact counterparty may decide" {
			return ErrForbidden
		}
	case "23505":
		if p.Message == "Correction operation identity conflicts" {
			return ErrRetryConflict
		}
	case "23514":
		switch p.Message {
		case "Correction requires persisted receipt membership", "Corrected count must be nonnegative", "Invalid correction action":
			return ErrInvalid
		case "Stale correction revision", "Decision revision is terminal or payload invalid", "Correction predecessor changed", "Correction exceeds debit after restitution":
			return ErrDecisionConflict
		case "Correction requires covered nonoverflowing destination stock":
			return ErrInsufficientStock
		}
	case "25000":
		return ErrUnavailable
	}
	return fail(ctx)
}

type RestitutionProposalInput struct {
	VariantID        int64
	OperationKey     string
	ExpectedRevision int64
	RetainedQuantity int64
	RetainedAtOrigin bool
	Reason           string
}
type RestitutionDecisionInput struct {
	VariantID        int64
	OperationKey     string
	ExpectedRevision int64
	Accept           bool
	Reason           string
}

func (s *Store) ProposeRestitution(ctx context.Context, actor auth.Identity, id int64, in RestitutionProposalInput) (RestitutionOperation, error) {
	q, att := in.RetainedQuantity, in.RetainedAtOrigin
	return s.restitute(ctx, actor, id, in.VariantID, in.OperationKey, "propose", in.ExpectedRevision, &q, &att, in.Reason)
}
func (s *Store) DecideRestitution(ctx context.Context, actor auth.Identity, id int64, in RestitutionDecisionInput) (RestitutionOperation, error) {
	action := "reject"
	if in.Accept {
		action = "accept"
	}
	return s.restitute(ctx, actor, id, in.VariantID, in.OperationKey, action, in.ExpectedRevision, nil, nil, in.Reason)
}

func (s *Store) restitute(ctx context.Context, actor auth.Identity, id, variant int64, key, action string, revision int64, quantity *int64, attested *bool, reason string) (RestitutionOperation, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return RestitutionOperation{}, ErrUnavailable
	}
	if !assigned(actor) {
		return RestitutionOperation{}, ErrForbidden
	}
	if id < 1 {
		return RestitutionOperation{}, ErrNotFound
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := checkAssignment(ctx, s.pool, actor); err != nil {
		return RestitutionOperation{}, err
	}
	tx, err := s.beginPersonal(ctx, actor)
	if err != nil {
		return RestitutionOperation{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	// Fence private membership before examining even malformed payloads. SQL
	// repeats authorization under its lock and owns all eligibility/effects.
	var status string
	err = tx.QueryRow(ctx, `SELECT status FROM transfer_requests WHERE id=$1 AND $2 IN(origin_location_id,destination_location_id)`, id, actor.Location.ID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return RestitutionOperation{}, ErrNotFound
	}
	if err != nil {
		return RestitutionOperation{}, fail(ctx)
	}
	if status != "received" {
		return RestitutionOperation{}, ErrDecisionConflict
	}
	if !validRestitutionInput(variant, key, action, revision, quantity, attested, reason) {
		return RestitutionOperation{}, ErrInvalid
	}
	var op RestitutionOperation
	err = tx.QueryRow(ctx, `SELECT operation_key,request_id,variant_id,actor_location_id,action,expected_revision,retained_quantity,retained_at_origin,reason,revision,source_existing_before,source_existing_after,recorded_at
 FROM transfer_restitute($1,$2::integer,$3::smallint,$4,$5,$6,$7,$8,$9)`, id, variant, actor.Location.ID, key, action, revision, quantity, attested, reason).Scan(&op.OperationKey, &op.RequestID, &op.VariantID, &op.ActorLocationID, &op.Action, &op.ExpectedRevision, &op.RetainedQuantity, &op.RetainedAtOrigin, &op.Reason, &op.Revision, &op.SourceExistingBefore, &op.SourceExistingAfter, &op.RecordedAt)
	if err != nil {
		return RestitutionOperation{}, restitutionError(ctx, err)
	}
	// A deferred constraint failure must never return an apparent operation.
	if err = tx.Commit(ctx); err != nil {
		return RestitutionOperation{}, fail(ctx)
	}
	op.RecordedAt = op.RecordedAt.UTC()
	return op, nil
}
func restitutionError(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if activeLocationRequired(err) {
		return ErrDecisionConflict
	}
	var p *pgconn.PgError
	if !errors.As(err, &p) {
		return fail(ctx)
	}
	switch p.Code {
	case "42501":
		switch p.Message {
		case "Restitution endpoint unauthorized", "Restitution requires a physical endpoint of a received transfer", "Only origin may attest retained stock", "Only exact destination may decide restitution":
			return ErrForbidden
		}
	case "23505":
		if p.Message == "Restitution operation identity conflicts" {
			return ErrRetryConflict
		}
	case "23514":
		switch p.Message {
		case "Restitution requires an expected received line", "Restitution requires explicit positive retention attestation", "Invalid restitution action":
			return ErrInvalid
		case "Stale restitution revision", "Restitution blocked by pending count proposal", "Restitution already applied", "Restitution exceeds outstanding debit", "Restitution decision is terminal or payload invalid", "Restitution predecessor changed":
			return ErrDecisionConflict
		case "Restitution requires covered nonoverflowing origin stock":
			return ErrInsufficientStock
		}
	}
	return fail(ctx)
}

// Inputs contain intent only. Identity and all accounting pins are server owned.
type DispatchReconciliationProposalInput struct {
	VariantID        int64
	OperationKey     string
	ExpectedRevision int64
	DispatchQuantity int64
	Reason           string
}
type DispatchReconciliationDecisionInput struct {
	VariantID        int64
	OperationKey     string
	ExpectedRevision int64
	Accept           bool
	Reason           string
}

// CheckDispatchReconciliationAccess fences HTTP body decoding without reading
// history or evaluating today's eligibility. SQL remains the replay authority.
func (s *Store) CheckDispatchReconciliationAccess(ctx context.Context, actor auth.Identity, id int64) error {
	return s.CheckRestitutionAccess(ctx, actor, id)
}

func (s *Store) ProposeDispatchReconciliation(ctx context.Context, actor auth.Identity, id int64, in DispatchReconciliationProposalInput) (DispatchReconciliationOperation, error) {
	q := in.DispatchQuantity
	return s.reconcileDispatch(ctx, actor, id, in.VariantID, in.OperationKey, "propose", in.ExpectedRevision, &q, in.Reason)
}

func (s *Store) DecideDispatchReconciliation(ctx context.Context, actor auth.Identity, id int64, in DispatchReconciliationDecisionInput) (DispatchReconciliationOperation, error) {
	action := "reject"
	if in.Accept {
		action = "accept"
	}
	return s.reconcileDispatch(ctx, actor, id, in.VariantID, in.OperationKey, action, in.ExpectedRevision, nil, in.Reason)
}

func (s *Store) reconcileDispatch(ctx context.Context, actor auth.Identity, id, variant int64, key, action string, revision int64, quantity *int64, reason string) (DispatchReconciliationOperation, error) {
	if err := s.CheckDispatchReconciliationAccess(ctx, actor, id); err != nil {
		return DispatchReconciliationOperation{}, err
	}
	// Identical integer/key/reason semantics to count corrections. Do not check
	// Q against today's count: an exact old operation must still be replayable.
	if !validCountInput(variant, key, revision, quantity, reason) {
		return DispatchReconciliationOperation{}, ErrInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tx, err := s.beginPersonal(ctx, actor)
	if err != nil {
		return DispatchReconciliationOperation{}, fail(ctx)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = tx.Rollback(cleanup)
	}()
	var raw []byte
	err = tx.QueryRow(ctx, `SELECT to_jsonb(o) FROM transfer_dispatch_reconcile($1,$2::integer,$3::smallint,$4,$5,$6,$7,$8) o`, id, variant, actor.Location.ID, key, action, revision, quantity, reason).Scan(&raw)
	if err != nil {
		return DispatchReconciliationOperation{}, dispatchReconciliationError(ctx, err)
	}
	var op DispatchReconciliationOperation
	if json.Unmarshal(raw, &op) != nil {
		return DispatchReconciliationOperation{}, ErrUnavailable
	}
	if err = tx.Commit(ctx); err != nil {
		return DispatchReconciliationOperation{}, fail(ctx)
	}
	op.RecordedAt = op.RecordedAt.UTC()
	return op, nil
}

// Match only entrypoint/operation errors intentionally owned by this workflow.
// Unknown constraints, driver failures and isolation errors remain redacted.
func dispatchReconciliationError(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if activeLocationRequired(err) {
		return ErrDecisionConflict
	}
	var p *pgconn.PgError
	if !errors.As(err, &p) {
		return fail(ctx)
	}
	switch p.Code {
	case "42501":
		switch p.Message {
		case "Reconciliation endpoint unauthorized", "Reconciliation requires a physical endpoint of a received transfer", "Only initiator may replace a pending reconciliation", "Only exact reconciliation counterparty may decide":
			return ErrForbidden
		}
	case "23505":
		if p.Message == "Reconciliation operation identity conflicts" {
			return ErrRetryConflict
		}
	case "23514":
		switch p.Message {
		case "Reconciliation requires an originally expected variant", "Reconciled dispatch must equal effective received count and change dispatch", "Invalid reconciliation action":
			return ErrInvalid
		case "Stale reconciliation revision", "Reconciliation excluded after restitution", "Reconciliation decision is terminal or payload invalid", "Reconciliation predecessor changed":
			return ErrDecisionConflict
		case "Reconciliation requires covered nonoverflowing endpoint stock", "Reconciliation requires both endpoint balances":
			return ErrInsufficientStock
		}
	}
	return fail(ctx)
}
