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

// Operations retain the original committed balances, even on historical replay.
type DispatchReconciliationOperation struct {
	OperationKey              string    `json:"operation_key"`
	RequestID                 int64     `json:"request_id"`
	VariantID                 int64     `json:"variant_id"`
	ActorLocationID           int       `json:"actor_location_id"`
	Action                    string    `json:"action"`
	ExpectedRevision          int64     `json:"expected_revision"`
	DispatchQuantity          *int64    `json:"dispatch_quantity"`
	Reason                    string    `json:"reason"`
	Revision                  int64     `json:"revision"`
	SourceExistingBefore      *int64    `json:"source_existing_before"`
	SourceExistingAfter       *int64    `json:"source_existing_after"`
	DestinationExistingBefore *int64    `json:"destination_existing_before"`
	DestinationExistingAfter  *int64    `json:"destination_existing_after"`
	RecordedAt                time.Time `json:"recorded_at"`
}
type DispatchReconciliationDecision struct {
	OperationKey    string    `json:"operation_key"`
	ActorLocationID int       `json:"actor_location_id"`
	Accepted        bool      `json:"accepted"`
	Reason          string    `json:"reason"`
	RecordedAt      time.Time `json:"recorded_at"`
}
type DispatchReconciliationApplication struct {
	OperationKey      string    `json:"operation_key"`
	EffectiveDispatch int64     `json:"effective_dispatch"`
	SourceDelta       int64     `json:"source_delta"`
	DestinationDelta  int64     `json:"destination_delta"`
	RecordedAt        time.Time `json:"recorded_at"`
}
type DispatchReconciliationProposal struct {
	Revision                 int64                              `json:"revision"`
	OperationKey             string                             `json:"operation_key"`
	InitiatorLocationID      int                                `json:"initiator_location_id"`
	DispatchQuantity         int64                              `json:"dispatch_quantity"`
	BaseDispatch             int64                              `json:"base_dispatch"`
	BaseActual               int64                              `json:"base_actual"`
	BaseCredit               int64                              `json:"base_credit"`
	CountGeneration          int64                              `json:"count_generation"`
	RestitutionGeneration    int64                              `json:"restitution_generation"`
	ReconciliationGeneration int64                              `json:"reconciliation_generation"`
	Reason                   string                             `json:"reason"`
	RecordedAt               time.Time                          `json:"recorded_at"`
	State                    string                             `json:"state"`
	Decision                 *DispatchReconciliationDecision    `json:"decision"`
	Application              *DispatchReconciliationApplication `json:"application"`
}
type DispatchReconciliationLineState struct {
	VariantID                int64                            `json:"variant_id"`
	ExpectedQuantity         int64                            `json:"expected_quantity"`
	OriginalActual           int64                            `json:"actual_quantity"`
	OriginalCredit           int64                            `json:"available_quantity"`
	EffectiveDispatch        int64                            `json:"effective_dispatch"`
	EffectiveActual          int64                            `json:"effective_actual"`
	EffectiveCredit          int64                            `json:"effective_credit"`
	AppliedRetainedQuantity  int64                            `json:"applied_retained_quantity"`
	WorkflowRevision         int64                            `json:"workflow_revision"`
	AppliedRevision          int64                            `json:"applied_revision"`
	CountGeneration          int64                            `json:"count_generation"`
	CountAppliedRevision     int64                            `json:"count_applied_revision"`
	RestitutionGeneration    int64                            `json:"restitution_generation"`
	ReconciliationGeneration int64                            `json:"reconciliation_generation"`
	Proposals                []DispatchReconciliationProposal `json:"proposals"`
}
type DispatchReconciliations struct {
	RequestID  int64                             `json:"request_id"`
	Lines      []DispatchReconciliationLineState `json:"lines"`
	Operations []DispatchReconciliationOperation `json:"operations"`
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
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
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

// GetDispatchReconciliations reads one committed statement snapshot. Historical
// pins and balances come directly from immutable evidence, never today's D/C.
// The effective-line function owns summed credit across both accounting ledgers.
func (s *Store) GetDispatchReconciliations(ctx context.Context, actor auth.Identity, id int64) (DispatchReconciliations, error) {
	if ctx == nil || s == nil || s.pool == nil {
		return DispatchReconciliations{}, ErrUnavailable
	}
	if !assigned(actor) {
		return DispatchReconciliations{}, ErrForbidden
	}
	if id < 1 {
		return DispatchReconciliations{}, ErrNotFound
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := checkAssignment(ctx, s.pool, actor); err != nil {
		return DispatchReconciliations{}, err
	}
	var status string
	var lines, operations []byte
	err := s.pool.QueryRow(ctx, dispatchReconciliationSnapshotSQL, id, actor.Location.ID).Scan(&status, &lines, &operations)
	if errors.Is(err, pgx.ErrNoRows) {
		return DispatchReconciliations{}, ErrNotFound
	}
	if err != nil {
		return DispatchReconciliations{}, fail(ctx)
	}
	if status != "received" {
		return DispatchReconciliations{}, ErrDecisionConflict
	}
	out := DispatchReconciliations{RequestID: id}
	// Typed int64 decoding rejects overflow/fractional quantities without float64.
	if json.Unmarshal(lines, &out.Lines) != nil || json.Unmarshal(operations, &out.Operations) != nil {
		return DispatchReconciliations{}, ErrUnavailable
	}
	for i := range out.Operations {
		out.Operations[i].RecordedAt = out.Operations[i].RecordedAt.UTC()
	}
	for i := range out.Lines {
		for j := range out.Lines[i].Proposals {
			p := &out.Lines[i].Proposals[j]
			p.RecordedAt = p.RecordedAt.UTC()
			if p.Decision != nil {
				p.Decision.RecordedAt = p.Decision.RecordedAt.UTC()
			}
			if p.Application != nil {
				p.Application.RecordedAt = p.Application.RecordedAt.UTC()
			}
		}
	}
	return out, nil
}

const dispatchReconciliationSnapshotSQL = `SELECT h.status,
 COALESCE((SELECT jsonb_agg(to_jsonb(line) ORDER BY variant_id) FROM (
 SELECT r.variant_id,r.expected_quantity,r.actual_quantity,r.available_quantity,
 state.dispatch AS effective_dispatch,state.actual AS effective_actual,state.credit AS effective_credit,
 state.restored AS applied_retained_quantity,COALESCE(head.revision,0) AS workflow_revision,
 state.reconciliation_revision AS applied_revision,state.count_revision AS count_applied_revision,
 state.count_generation,state.restitution_generation,state.reconciliation_generation,
 COALESCE((SELECT jsonb_agg(to_jsonb(history) ORDER BY revision) FROM (
 SELECT p.*,to_jsonb(d) AS decision,to_jsonb(a) AS application,
 CASE WHEN d.accepted THEN 'applied' WHEN d.accepted=false THEN 'rejected'
 WHEN p.revision=head.revision THEN 'pending' ELSE 'superseded' END AS state
 FROM transfer_dispatch_proposals p
 LEFT JOIN transfer_dispatch_decisions d USING(request_id,variant_id,revision)
 LEFT JOIN transfer_dispatch_applications a USING(request_id,variant_id,revision)
 WHERE p.request_id=r.request_id AND p.variant_id=r.variant_id
 ) history),'[]'::jsonb) AS proposals
 FROM transfer_receipt_lines r
 CROSS JOIN LATERAL transfer_effective_line(r.request_id,r.variant_id) state
 LEFT JOIN LATERAL (SELECT revision FROM transfer_dispatch_proposals p WHERE p.request_id=r.request_id AND p.variant_id=r.variant_id ORDER BY revision DESC LIMIT 1) head ON true
 WHERE r.request_id=h.id AND r.expected_quantity>0
 ) line),'[]'::jsonb),
 COALESCE((SELECT jsonb_agg(to_jsonb(o) ORDER BY revision,variant_id,recorded_at,operation_key)
 FROM transfer_dispatch_operations o WHERE o.request_id=h.id),'[]'::jsonb)
 FROM transfer_requests h WHERE h.id=$1 AND $2 IN(h.origin_location_id,h.destination_location_id)`
