package transfers

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"luson/api/internal/auth"
)

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
	var owned bool
	var lines, operations []byte
	err := s.pool.QueryRow(ctx, dispatchReconciliationSnapshotSQL, id, actor.Location.ID).Scan(&status, &owned, &lines, &operations)
	if errors.Is(err, pgx.ErrNoRows) {
		return DispatchReconciliations{}, ErrNotFound
	}
	if err != nil {
		return DispatchReconciliations{}, fail(ctx)
	}
	if status != "received" {
		return DispatchReconciliations{}, ErrDecisionConflict
	}
	if owned {
		return DispatchReconciliations{}, ErrUnifiedReconciliationRequired
	}
	out := DispatchReconciliations{RequestID: id}
	// Typed int64 decoding rejects overflow/fractional quantities without float64.
	if json.Unmarshal(lines, &out.Lines) != nil || json.Unmarshal(operations, &out.Operations) != nil {
		return DispatchReconciliations{}, ErrUnavailable
	}
	normalizeDispatchSnapshot(&out)
	return out, nil
}

func normalizeDispatchSnapshot(out *DispatchReconciliations) {
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
}

const dispatchReconciliationSnapshotSQL = `SELECT h.status,transfer_unified_owned(h.id),
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
