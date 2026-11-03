package httpapi

import "luson/api/internal/transfers"

// All bigint evidence stays decimal text; only bounded IDs are JSON numbers.
// Nulls and empty arrays are explicit, never omitted or inferred from today.
// The dispatch reconciliation write flow is retired; these DTOs survive because
// the unified reconciliation snapshot embeds its historical evidence.
type dispatchReconciliationOperationDTO struct {
	OperationKey              string  `json:"operation_key"`
	RequestID                 string  `json:"request_id"`
	VariantID                 int64   `json:"variant_id"`
	ActorLocationID           int     `json:"actor_location_id"`
	Action                    string  `json:"action"`
	ExpectedRevision          string  `json:"expected_revision"`
	DispatchQuantity          *string `json:"dispatch_quantity"`
	Reason                    string  `json:"reason"`
	Revision                  string  `json:"revision"`
	SourceExistingBefore      *string `json:"source_existing_before"`
	SourceExistingAfter       *string `json:"source_existing_after"`
	DestinationExistingBefore *string `json:"destination_existing_before"`
	DestinationExistingAfter  *string `json:"destination_existing_after"`
	RecordedAt                string  `json:"recorded_at"`
}
type dispatchReconciliationApplicationDTO struct {
	OperationKey      string `json:"operation_key"`
	EffectiveDispatch string `json:"effective_dispatch"`
	SourceDelta       string `json:"source_delta"`
	DestinationDelta  string `json:"destination_delta"`
	RecordedAt        string `json:"recorded_at"`
}
type dispatchReconciliationProposalDTO struct {
	Revision                 string                                `json:"revision"`
	OperationKey             string                                `json:"operation_key"`
	InitiatorLocationID      int                                   `json:"initiator_location_id"`
	DispatchQuantity         string                                `json:"dispatch_quantity"`
	BaseDispatch             string                                `json:"base_dispatch"`
	BaseActual               string                                `json:"base_actual"`
	BaseCredit               string                                `json:"base_credit"`
	CountGeneration          string                                `json:"count_generation"`
	RestitutionGeneration    string                                `json:"restitution_generation"`
	ReconciliationGeneration string                                `json:"reconciliation_generation"`
	Reason                   string                                `json:"reason"`
	RecordedAt               string                                `json:"recorded_at"`
	State                    string                                `json:"state"`
	Decision                 *countDecisionDTO                     `json:"decision"`
	Application              *dispatchReconciliationApplicationDTO `json:"application"`
}
type dispatchReconciliationLineDTO struct {
	VariantID                int64                               `json:"variant_id"`
	ExpectedQuantity         string                              `json:"expected_quantity"`
	OriginalActual           string                              `json:"actual_quantity"`
	OriginalCredit           string                              `json:"available_quantity"`
	EffectiveDispatch        string                              `json:"effective_dispatch"`
	EffectiveActual          string                              `json:"effective_actual"`
	EffectiveCredit          string                              `json:"effective_credit"`
	AppliedRetainedQuantity  string                              `json:"applied_retained_quantity"`
	WorkflowRevision         string                              `json:"workflow_revision"`
	AppliedRevision          string                              `json:"applied_revision"`
	CountGeneration          string                              `json:"count_generation"`
	CountAppliedRevision     string                              `json:"count_applied_revision"`
	RestitutionGeneration    string                              `json:"restitution_generation"`
	ReconciliationGeneration string                              `json:"reconciliation_generation"`
	Proposals                []dispatchReconciliationProposalDTO `json:"proposals"`
}
type dispatchReconciliationSnapshotDTO struct {
	RequestID  string                               `json:"request_id"`
	Lines      []dispatchReconciliationLineDTO      `json:"lines"`
	Operations []dispatchReconciliationOperationDTO `json:"operations"`
}

func dispatchReconciliationOperationRecord(op transfers.DispatchReconciliationOperation) dispatchReconciliationOperationDTO {
	return dispatchReconciliationOperationDTO{
		OperationKey: op.OperationKey, RequestID: countInt(op.RequestID), VariantID: op.VariantID, ActorLocationID: op.ActorLocationID, Action: op.Action,
		ExpectedRevision: countInt(op.ExpectedRevision), DispatchQuantity: restitutionNullable(op.DispatchQuantity), Reason: op.Reason, Revision: countInt(op.Revision),
		SourceExistingBefore: restitutionNullable(op.SourceExistingBefore), SourceExistingAfter: restitutionNullable(op.SourceExistingAfter),
		DestinationExistingBefore: restitutionNullable(op.DestinationExistingBefore), DestinationExistingAfter: restitutionNullable(op.DestinationExistingAfter), RecordedAt: countStamp(op.RecordedAt),
	}
}
func dispatchReconciliationSnapshotRecord(snapshot transfers.DispatchReconciliations) dispatchReconciliationSnapshotDTO {
	out := dispatchReconciliationSnapshotDTO{RequestID: countInt(snapshot.RequestID), Lines: []dispatchReconciliationLineDTO{}, Operations: []dispatchReconciliationOperationDTO{}}
	for _, op := range snapshot.Operations {
		out.Operations = append(out.Operations, dispatchReconciliationOperationRecord(op))
	}
	for _, line := range snapshot.Lines {
		dto := dispatchReconciliationLineDTO{
			VariantID: line.VariantID, ExpectedQuantity: countInt(line.ExpectedQuantity), OriginalActual: countInt(line.OriginalActual), OriginalCredit: countInt(line.OriginalCredit),
			EffectiveDispatch: countInt(line.EffectiveDispatch), EffectiveActual: countInt(line.EffectiveActual), EffectiveCredit: countInt(line.EffectiveCredit), AppliedRetainedQuantity: countInt(line.AppliedRetainedQuantity),
			WorkflowRevision: countInt(line.WorkflowRevision), AppliedRevision: countInt(line.AppliedRevision), CountGeneration: countInt(line.CountGeneration), CountAppliedRevision: countInt(line.CountAppliedRevision),
			RestitutionGeneration: countInt(line.RestitutionGeneration), ReconciliationGeneration: countInt(line.ReconciliationGeneration), Proposals: []dispatchReconciliationProposalDTO{},
		}
		for _, p := range line.Proposals {
			proposal := dispatchReconciliationProposalDTO{
				Revision: countInt(p.Revision), OperationKey: p.OperationKey, InitiatorLocationID: p.InitiatorLocationID, DispatchQuantity: countInt(p.DispatchQuantity),
				BaseDispatch: countInt(p.BaseDispatch), BaseActual: countInt(p.BaseActual), BaseCredit: countInt(p.BaseCredit), CountGeneration: countInt(p.CountGeneration),
				RestitutionGeneration: countInt(p.RestitutionGeneration), ReconciliationGeneration: countInt(p.ReconciliationGeneration), Reason: p.Reason, RecordedAt: countStamp(p.RecordedAt), State: p.State,
			}
			if d := p.Decision; d != nil {
				proposal.Decision = &countDecisionDTO{OperationKey: d.OperationKey, ActorLocationID: d.ActorLocationID, Accepted: d.Accepted, Reason: d.Reason, RecordedAt: countStamp(d.RecordedAt)}
			}
			if ap := p.Application; ap != nil {
				proposal.Application = &dispatchReconciliationApplicationDTO{OperationKey: ap.OperationKey, EffectiveDispatch: countInt(ap.EffectiveDispatch), SourceDelta: countInt(ap.SourceDelta), DestinationDelta: countInt(ap.DestinationDelta), RecordedAt: countStamp(ap.RecordedAt)}
			}
			dto.Proposals = append(dto.Proposals, proposal)
		}
		out.Lines = append(out.Lines, dto)
	}
	return out
}
